'use strict';

const { Events, PermissionFlagsBits } = require('discord.js');
const prefix = require('../services/prefix');
const embeds = require('../utils/embeds');
const logger = require('../utils/logger');
const { ArgError, usageFor } = require('../utils/argparse');
const { PrefixInteraction } = require('../utils/prefixInteraction');
const { handleInteractionError, safeReply } = require('../utils/errors');
const { runCommand } = require('../services/commandRunner');
const { checkCooldown } = require('../utils/ratelimit');
const { truncate } = require('../utils/text');

const canSpeak = (message) =>
  !message.guild
  || message.channel.permissionsFor(message.guild.members.me)?.has([PermissionFlagsBits.ViewChannel, PermissionFlagsBits.SendMessages]);

const quiet = { parse: [], repliedUser: false };

async function sendTemporary(message, payload, seconds = 20) {
  const sent = await message.reply({ ...payload, allowedMentions: quiet, failIfNotExists: false }).catch(() => null);
  if (sent) setTimeout(() => sent.delete().catch(() => {}), seconds * 1000).unref?.();
}

async function replyArgError(ia, invocation, err) {
  const p = prefix.prefixSettings(ia.guildId);
  const json = invocation.command.data.toJSON();
  const usage = usageFor(json, p.value, ia.argText).slice(0, 3).map((l) => `\`${l.usage}\``).join('\n');
  const embed = embeds.error(err.message);
  if (err.showUsage !== false && usage) embed.addFields({ name: 'Usage', value: truncate(usage, 1000) });
  embed.setFooter({ text: '<required> [optional] · "quotes" for text with spaces · or write option:value' });
  await safeReply(ia, { embeds: [embed], ephemeral: true });
}

module.exports = {
  name: Events.MessageCreate,
  async execute(message, client) {
    if (message.author.bot || message.webhookId || message.system || message.partial) return;
    const invocation = prefix.parseInvocation(message, client);
    if (!invocation) return;
    if (!canSpeak(message)) return;

    if (invocation.bareMention) {
      if (checkCooldown('mention-info', message.author.id, 15) > 0) return;
      const p = prefix.prefixSettings(message.guildId);
      const how = p.enabled ? `My prefix here is \`${p.value}\`. Try \`${p.value}help\` or \`/help\`.` : 'Chat commands are off in this server. Use `/help`.';
      await sendTemporary(message, { content: `👋 ${how}` }, 30);
      return;
    }

    const { command } = invocation;
    if (command.prefix === false) {
      await sendTemporary(message, { content: `\`${command.data.name}\` only works as a slash command. Type \`/${command.data.name}\`.` });
      return;
    }

    const ia = new PrefixInteraction(message, command, invocation.args, client);
    try {
      await runCommand(ia, client, command, { prepare: () => ia.prepare() });
    } catch (err) {
      if (err instanceof ArgError) {
        await replyArgError(ia, invocation, err).catch((e) => logger.debug('Could not send usage:', e.message));
      } else {
        await handleInteractionError(ia, err);
      }
    }
  },
};
