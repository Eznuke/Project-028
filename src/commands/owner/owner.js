'use strict';

const os = require('node:os');
const fs = require('node:fs');
const path = require('node:path');
const { version: djsVersion } = require('discord.js');
const { guildCommand, EPHEMERAL } = require('../../utils/builders');
const embeds = require('../../utils/embeds');
const config = require('../../config');
const db = require('../../database');
const audit = require('../../services/audit');
const logger = require('../../utils/logger');
const { loadCommands, loadComponents, walk } = require('../../utils/loader');
const { UserError } = require('../../utils/errors');
const { confirm } = require('../../utils/confirm');
const { formatDuration, ts } = require('../../utils/time');
const { formatNumber, truncate } = require('../../utils/text');

const mb = (n) => `${(n / 1024 / 1024).toFixed(1)} MB`;

const owner = {
  // Permission 0n hides the command from everyone except server administrators; the real check is ownerOnly.
  data: guildCommand('owner', 'Bot owner tools', 0n)
    .addSubcommand((s) => s.setName('stats').setDescription('Show bot statistics'))
    .addSubcommand((s) => s.setName('reload').setDescription('Reload command code without restarting (schema changes need npm run deploy)'))
    .addSubcommand((s) => s.setName('maintenance').setDescription('Turn maintenance mode on or off')
      .addBooleanOption((o) => o.setName('enabled').setDescription('true = only owners can use the bot').setRequired(true)))
    .addSubcommand((s) => s.setName('blacklist').setDescription('Block a user from using the bot')
      .addUserOption((o) => o.setName('user').setDescription('User to block').setRequired(true))
      .addStringOption((o) => o.setName('reason').setDescription('Reason (for your records)').setMaxLength(200)))
    .addSubcommand((s) => s.setName('unblacklist').setDescription('Allow a blocked user again')
      .addUserOption((o) => o.setName('user').setDescription('User to unblock').setRequired(true))),
  ownerOnly: true,
  cooldown: 2,

  async execute(interaction, client) {
    const sub = interaction.options.getSubcommand();

    if (sub === 'stats') {
      const mem = process.memoryUsage();
      let dbSize = 0;
      try { dbSize = fs.statSync(config.dbPath).size; } catch { /* in-memory or missing */ }
      const top = db.all('SELECT name, count FROM command_usage ORDER BY count DESC LIMIT 5');
      const e = embeds.base('📊 Bot statistics')
        .addFields(
          { name: 'Servers', value: formatNumber(client.guilds.cache.size), inline: true },
          { name: 'Cached users', value: formatNumber(client.users.cache.size), inline: true },
          { name: 'Commands run', value: formatNumber(client.stats.commandsRun), inline: true },
          { name: 'Uptime', value: formatDuration(Date.now() - (client.stats.readyAt ?? Date.now())), inline: true },
          { name: 'Ping', value: `${Math.round(client.ws.ping)} ms`, inline: true },
          { name: 'Maintenance', value: client.maintenance ? '🟠 on' : '🟢 off', inline: true },
          { name: 'Memory', value: `${mb(mem.rss)} RSS • ${mb(mem.heapUsed)} heap`, inline: true },
          { name: 'Database', value: mb(dbSize), inline: true },
          { name: 'Blacklisted', value: String(db.get('SELECT COUNT(*) AS n FROM blacklist').n), inline: true },
          { name: 'Runtime', value: `Node ${process.version} • discord.js ${djsVersion}\n${os.platform()} ${os.arch()}`, inline: false },
          { name: 'Top commands', value: top.map((t) => `\`/${t.name}\` ${formatNumber(t.count)}`).join('\n') || 'none yet', inline: false },
        );
      await interaction.reply({ embeds: [e], flags: EPHEMERAL });
      return;
    }

    if (sub === 'reload') {
      const ok = await confirm(interaction, { description: 'Reload all command modules now? Running collectors are not affected.', danger: false, confirmLabel: 'Reload' });
      if (!ok) return;
      const dir = path.join(__dirname, '..');
      try {
        for (const file of walk(dir)) delete require.cache[require.resolve(file)];
        const commands = loadCommands(dir);
        const components = loadComponents(path.join(__dirname, '..', '..', 'components'), commands);
        client.commands = commands;
        client.components = components;
      } catch (err) {
        logger.error('Reload failed:', err);
        await interaction.editReply({ embeds: [embeds.error(`Reload failed, the old commands stay active:\n\`${truncate(err.message, 300)}\``)], components: [] });
        return;
      }
      audit.record(null, interaction.user.id, 'owner.reload');
      await interaction.editReply({ embeds: [embeds.success(`Reloaded **${client.commands.size}** commands. New or changed command *definitions* still need \`npm run deploy\`.`)], components: [] });
      return;
    }

    if (sub === 'maintenance') {
      const on = interaction.options.getBoolean('enabled', true);
      if (on) {
        const ok = await confirm(interaction, { description: 'Turn maintenance mode ON? Everyone except bot owners is locked out until you turn it off.', confirmLabel: 'Enable' });
        if (!ok) return;
      }
      client.maintenance = on;
      db.setMeta('maintenance', on ? '1' : '0');
      audit.record(null, interaction.user.id, 'owner.maintenance', null, String(on));
      const payload = { embeds: [embeds.success(`Maintenance mode is now **${on ? 'ON' : 'OFF'}**.`)], components: [] };
      if (on) await interaction.editReply(payload);
      else await interaction.reply({ ...payload, flags: EPHEMERAL });
      return;
    }

    const user = interaction.options.getUser('user', true);
    if (sub === 'blacklist') {
      if (config.isOwner(user.id)) throw new UserError('You cannot blacklist a bot owner.');
      if (user.id === client.user.id) throw new UserError('You cannot blacklist the bot itself.');
      const ok = await confirm(interaction, { description: `Block **${user.username}** (${user.id}) from using the bot everywhere?`, confirmLabel: 'Blacklist' });
      if (!ok) return;
      const reason = interaction.options.getString('reason') ?? null;
      db.run(
        'INSERT INTO blacklist (user_id, reason, added_by, created_at) VALUES (?, ?, ?, ?) ON CONFLICT(user_id) DO UPDATE SET reason = excluded.reason, added_by = excluded.added_by',
        user.id, reason, interaction.user.id, Date.now(),
      );
      audit.record(null, interaction.user.id, 'owner.blacklist', user.id, reason);
      await interaction.editReply({ embeds: [embeds.success(`**${user.username}** is now blacklisted (${ts(Date.now(), 'R')}).`)], components: [] });
      return;
    }

    // unblacklist
    const res = db.run('DELETE FROM blacklist WHERE user_id = ?', user.id);
    if (!res.changes) throw new UserError('That user is not blacklisted.');
    audit.record(null, interaction.user.id, 'owner.unblacklist', user.id);
    await interaction.reply({ embeds: [embeds.success(`**${user.username}** was removed from the blacklist.`)], flags: EPHEMERAL });
  },
};

module.exports = [owner];
