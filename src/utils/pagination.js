'use strict';

const { ActionRowBuilder, ButtonBuilder, ButtonStyle, ComponentType } = require('discord.js');
const { safeReply } = require('./errors');

/**
 * Sends an array of embeds with Previous/Next buttons. Only the user who ran
 * the command can flip pages. Buttons use "~" IDs, so they are collector-only.
 *
 * @param {import('discord.js').ChatInputCommandInteraction} interaction
 * @param {import('discord.js').EmbedBuilder[]} pages
 * @param {{ ephemeral?: boolean, timeout?: number }} [opts]
 */
async function paginate(interaction, pages, opts = {}) {
  const { ephemeral = false, timeout = 120_000 } = opts;
  if (pages.length === 0) throw new Error('paginate() needs at least one page');

  let index = 0;
  const prevId = `~pg:${interaction.id}:prev`;
  const nextId = `~pg:${interaction.id}:next`;

  const withFooter = (i) => {
    const page = pages[i];
    page.setFooter({ text: `Page ${i + 1}/${pages.length}` });
    return page;
  };

  const buttons = (disabled = false) =>
    new ActionRowBuilder().addComponents(
      new ButtonBuilder()
        .setCustomId(prevId)
        .setLabel('◀')
        .setStyle(ButtonStyle.Secondary)
        .setDisabled(disabled || index === 0),
      new ButtonBuilder()
        .setCustomId(nextId)
        .setLabel('▶')
        .setStyle(ButtonStyle.Secondary)
        .setDisabled(disabled || index === pages.length - 1),
    );

  if (pages.length === 1) {
    await safeReply(interaction, { embeds: [withFooter(0)], ephemeral });
    return;
  }

  await safeReply(interaction, { embeds: [withFooter(index)], components: [buttons()], ephemeral });
  const message = await interaction.fetchReply();

  const collector = message.createMessageComponentCollector({
    componentType: ComponentType.Button,
    time: timeout,
    filter: (i) => i.user.id === interaction.user.id && (i.customId === prevId || i.customId === nextId),
  });

  collector.on('collect', async (i) => {
    index += i.customId === nextId ? 1 : -1;
    index = Math.min(Math.max(index, 0), pages.length - 1);
    await i.update({ embeds: [withFooter(index)], components: [buttons()] }).catch(() => {});
  });

  collector.on('end', () => {
    interaction.editReply({ components: [buttons(true)] }).catch(() => {});
  });
}

module.exports = { paginate };
