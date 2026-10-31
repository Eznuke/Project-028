'use strict';

const {
  PermissionFlagsBits, ChannelType, ActionRowBuilder, ButtonBuilder, ButtonStyle, StringSelectMenuBuilder, MessageFlags,
} = require('discord.js');
const { guildCommand, EPHEMERAL } = require('../../utils/builders');
const embeds = require('../../utils/embeds');
const db = require('../../database');
const settings = require('../../services/settings');
const audit = require('../../services/audit');
const { UserError } = require('../../utils/errors');
const { canManageRole } = require('../../utils/permissions');
const { chunk, truncate } = require('../../utils/text');

const P = PermissionFlagsBits;
const DANGEROUS = [P.Administrator, P.ManageGuild, P.ManageRoles, P.ManageChannels, P.BanMembers, P.KickMembers, P.ModerateMembers, P.ManageMessages, P.MentionEveryone];
const MAX_ROLES = 10;

/** Throws unless `role` may safely be handed out by a panel. Used when creating AND when clicking. */
function assertAssignable(guild, actor, role) {
  const check = canManageRole(guild, actor, role);
  if (!check.ok) throw new UserError(check.reason);
  if (DANGEROUS.some((p) => role.permissions.has(p))) {
    throw new UserError(`${role} has moderation/admin permissions, so a self-role panel cannot hand it out.`);
  }
}

function panelPayload(panel, roles) {
  const e = embeds.base(`🏷️ ${panel.title}`, `${panel.description ? `${panel.description}\n\n` : ''}${roles.map((r) => `• <@&${r.role_id}>${r.description ? ` — ${r.description}` : ''}`).join('\n')}\n\n*${panel.exclusive ? 'You can pick one role.' : 'Press a button or choose roles to toggle them.'}*`);
  if (panel.type === 'select') {
    const menu = new StringSelectMenuBuilder()
      .setCustomId(`rp:s:${panel.id}`)
      .setPlaceholder('Choose your roles')
      .setMinValues(0)
      .setMaxValues(panel.exclusive ? 1 : roles.length)
      .addOptions(roles.map((r) => ({ label: truncate(r.label, 100), value: r.role_id, description: r.description ? truncate(r.description, 100) : undefined })));
    return { embeds: [e], components: [new ActionRowBuilder().addComponents(menu)], allowedMentions: { parse: [] } };
  }
  const buttons = roles.map((r) => new ButtonBuilder().setCustomId(`rp:t:${panel.id}:${r.role_id}`).setLabel(truncate(r.label, 80)).setStyle(ButtonStyle.Secondary));
  return { embeds: [e], components: chunk(buttons, 5).map((part) => new ActionRowBuilder().addComponents(part)), allowedMentions: { parse: [] } };
}

const rolepanel = {
  data: (() => {
    const b = guildCommand('rolepanel', 'Self-role panels and verification', P.ManageRoles)
      .addSubcommand((s) => {
        s.setName('create').setDescription('Create a self-role panel with buttons or a select menu')
          .addStringOption((o) => o.setName('title').setDescription('Panel title').setRequired(true).setMaxLength(100))
          .addStringOption((o) => o.setName('style').setDescription('Buttons or a select menu').setRequired(true).addChoices({ name: 'Buttons', value: 'buttons' }, { name: 'Select menu', value: 'select' }))
          .addRoleOption((o) => o.setName('role1').setDescription('First role').setRequired(true));
        for (let i = 2; i <= MAX_ROLES; i++) s.addRoleOption((o) => o.setName(`role${i}`).setDescription(`Role ${i} (optional)`));
        s.addStringOption((o) => o.setName('description').setDescription('Text shown above the roles').setMaxLength(500))
          .addBooleanOption((o) => o.setName('exclusive').setDescription('Members can hold only one role of this panel'))
          .addChannelOption((o) => o.setName('channel').setDescription('Where to post it (default: here)').addChannelTypes(ChannelType.GuildText, ChannelType.GuildAnnouncement));
        return s;
      })
      .addSubcommand((s) => s.setName('verify').setDescription('Post a verification panel that gives a role')
        .addRoleOption((o) => o.setName('role').setDescription('Role given after verifying').setRequired(true))
        .addStringOption((o) => o.setName('message').setDescription('Text shown on the panel').setMaxLength(500))
        .addChannelOption((o) => o.setName('channel').setDescription('Where to post it (default: here)').addChannelTypes(ChannelType.GuildText, ChannelType.GuildAnnouncement)))
      .addSubcommand((s) => s.setName('list').setDescription('List the self-role panels of this server'))
      .addSubcommand((s) => s.setName('delete').setDescription('Delete a panel and its message')
        .addIntegerOption((o) => o.setName('id').setDescription('Panel ID from /rolepanel list').setRequired(true).setMinValue(1)));
    return b;
  })(),
  cooldown: 5,
  userPermissions: [P.ManageRoles],
  botPermissions: [P.ManageRoles],

  async execute(interaction) {
    const g = interaction.guildId;
    const sub = interaction.options.getSubcommand();

    if (sub === 'create') {
      const roles = [];
      for (let i = 1; i <= MAX_ROLES; i++) {
        const r = interaction.options.getRole(`role${i}`);
        if (r && !roles.some((x) => x.id === r.id)) roles.push(r);
      }
      for (const r of roles) assertAssignable(interaction.guild, interaction.member, r);
      const style = interaction.options.getString('style', true);
      if (style === 'select' && roles.length < 1) throw new UserError('Choose at least one role.');
      const channel = interaction.options.getChannel('channel') ?? interaction.channel;
      if (!channel.permissionsFor(interaction.guild.members.me)?.has([P.ViewChannel, P.SendMessages, P.EmbedLinks])) throw new UserError(`I cannot post in ${channel}.`);

      const panelId = db.run(
        'INSERT INTO role_panels (guild_id, type, title, description, exclusive, created_by, created_at) VALUES (?, ?, ?, ?, ?, ?, ?)',
        g, style, interaction.options.getString('title', true), interaction.options.getString('description'),
        interaction.options.getBoolean('exclusive') ? 1 : 0, interaction.user.id, Date.now(),
      ).lastInsertRowid;
      for (const r of roles) {
        db.run('INSERT INTO role_panel_roles (panel_id, role_id, label) VALUES (?, ?, ?)', panelId, r.id, truncate(r.name, 80));
      }
      const panel = db.get('SELECT * FROM role_panels WHERE id = ?', panelId);
      const rows = db.all('SELECT * FROM role_panel_roles WHERE panel_id = ?', panelId);
      try {
        const message = await channel.send(panelPayload(panel, rows));
        db.run('UPDATE role_panels SET channel_id = ?, message_id = ? WHERE id = ?', channel.id, message.id, panelId);
      } catch (err) {
        db.run('DELETE FROM role_panels WHERE id = ?', panelId);
        throw err;
      }
      audit.record(g, interaction.user.id, 'rolepanel.create', panelId, roles.map((r) => r.id).join(','));
      await interaction.reply({ embeds: [embeds.success(`Panel **#${panelId}** posted in ${channel}.`)], flags: EPHEMERAL });
      return;
    }

    if (sub === 'verify') {
      const role = interaction.options.getRole('role', true);
      assertAssignable(interaction.guild, interaction.member, role);
      const channel = interaction.options.getChannel('channel') ?? interaction.channel;
      if (!channel.permissionsFor(interaction.guild.members.me)?.has([P.ViewChannel, P.SendMessages, P.EmbedLinks])) throw new UserError(`I cannot post in ${channel}.`);
      await channel.send({
        embeds: [embeds.base('✅ Verification', interaction.options.getString('message') ?? 'Press the button below to verify and gain access to the server.', embeds.COLORS.success)],
        components: [new ActionRowBuilder().addComponents(new ButtonBuilder().setCustomId(`rp:v:${role.id}`).setLabel('Verify').setEmoji('✅').setStyle(ButtonStyle.Success))],
      });
      settings.set(g, 'roles.verificationRoleId', role.id);
      audit.record(g, interaction.user.id, 'rolepanel.verify', role.id);
      await interaction.reply({ embeds: [embeds.success(`Verification panel posted in ${channel}. Members get ${role}.`)], flags: EPHEMERAL, allowedMentions: { parse: [] } });
      return;
    }

    if (sub === 'list') {
      const panels = db.all('SELECT * FROM role_panels WHERE guild_id = ? ORDER BY id', g);
      const text = panels.length
        ? panels.map((p) => `**#${p.id}** ${p.type} — ${truncate(p.title, 50)} ${p.channel_id ? `in <#${p.channel_id}>` : ''}`).join('\n')
        : 'No panels yet. Create one with `/rolepanel create`.';
      await interaction.reply({ embeds: [embeds.base('🏷️ Role panels', text)], flags: EPHEMERAL, allowedMentions: { parse: [] } });
      return;
    }

    const id = interaction.options.getInteger('id', true);
    const panel = db.get('SELECT * FROM role_panels WHERE id = ? AND guild_id = ?', id, g);
    if (!panel) throw new UserError('Panel not found.');
    if (panel.channel_id && panel.message_id) {
      const channel = interaction.guild.channels.cache.get(panel.channel_id);
      const message = await channel?.messages.fetch(panel.message_id).catch(() => null);
      await message?.delete().catch(() => {});
    }
    db.run('DELETE FROM role_panels WHERE id = ?', id);
    audit.record(g, interaction.user.id, 'rolepanel.delete', id);
    await interaction.reply({ embeds: [embeds.success(`Panel #${id} deleted.`)], flags: EPHEMERAL });
  },

  components: {
    async rp(interaction, args) {
      const [action] = args;
      const guild = interaction.guild;
      const member = interaction.member;
      const reply = (text) => interaction.reply({ content: text, flags: MessageFlags.Ephemeral });

      if (action === 'v') {
        const roleId = args[1];
        // Only the role configured by /rolepanel verify may be handed out.
        if (settings.view(guild.id).roles.verificationRoleId !== roleId) return reply('This verification panel is outdated.');
        const role = guild.roles.cache.get(roleId);
        if (!role) return reply('The verification role no longer exists.');
        if (member.roles.cache.has(roleId)) return reply('You are already verified. ✅');
        assertAssignable(guild, null, role);
        await member.roles.add(role, 'Verification panel');
        return reply(`✅ You are verified and received **${role.name}**!`);
      }

      const panel = db.get('SELECT * FROM role_panels WHERE id = ? AND guild_id = ?', Number(args[1]), guild.id);
      if (!panel) return reply('This panel no longer exists.');
      const panelRoles = db.all('SELECT * FROM role_panel_roles WHERE panel_id = ?', panel.id).map((r) => r.role_id);

      if (action === 't') {
        const roleId = args[2];
        if (!panelRoles.includes(roleId)) return reply('That role is not part of this panel any more.');
        const role = guild.roles.cache.get(roleId);
        if (!role) return reply('That role no longer exists.');
        assertAssignable(guild, null, role);
        if (member.roles.cache.has(roleId)) {
          await member.roles.remove(role, 'Self-role panel');
          return reply(`Removed **${role.name}**.`);
        }
        if (panel.exclusive) {
          const others = panelRoles.filter((id) => id !== roleId && member.roles.cache.has(id));
          if (others.length) await member.roles.remove(others, 'Self-role panel (exclusive)');
        }
        await member.roles.add(role, 'Self-role panel');
        return reply(`You now have **${role.name}**.`);
      }

      if (action === 's') {
        const wanted = new Set(interaction.values.filter((id) => panelRoles.includes(id)));
        const toAdd = [];
        const toRemove = [];
        for (const id of panelRoles) {
          const role = guild.roles.cache.get(id);
          if (!role) continue;
          const has = member.roles.cache.has(id);
          if (wanted.has(id) && !has) { assertAssignable(guild, null, role); toAdd.push(role); }
          if (!wanted.has(id) && has) toRemove.push(role);
        }
        if (toRemove.length) await member.roles.remove(toRemove, 'Self-role panel');
        if (toAdd.length) await member.roles.add(toAdd, 'Self-role panel');
        return reply(`Updated your roles: ${toAdd.length ? `added ${toAdd.map((r) => `**${r.name}**`).join(', ')}` : ''}${toAdd.length && toRemove.length ? '; ' : ''}${toRemove.length ? `removed ${toRemove.map((r) => `**${r.name}**`).join(', ')}` : ''}${!toAdd.length && !toRemove.length ? 'nothing changed' : ''}.`);
      }
      return undefined;
    },
  },
};

module.exports = [rolepanel];
