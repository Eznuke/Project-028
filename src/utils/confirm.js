'use strict';

const { ActionRowBuilder, ButtonBuilder, ButtonStyle, ComponentType } = require('discord.js');
const embeds = require('./embeds');
const { safeReply } = require('./errors');

/**
 * Shows a confirm/cancel prompt and waits for the SAME user to answer.
 * Component IDs start with "~" so the global component router ignores them
 * (they are handled by the collector below).
 *
 * @param {import('discord.js').ChatInputCommandInteraction} interaction
 * @param {{ description: string, title?: string, confirmLabel?: string, danger?: boolean, timeout?: number }} opts
 * @returns {Promise<boolean>} true only when the user pressed Confirm in time.
 */
async function confirm(interaction, opts) {
  const { description, title = 'Please confirm', confirmLabel = 'Confirm', danger = true, timeout = 30_000 } = opts;
  const yesId = `~cf:${interaction.id}:yes`;
  const noId = `~cf:${interaction.id}:no`;

  const row = (disabled = false) =>
    new ActionRowBuilder().addComponents(
      new ButtonBuilder()
        .setCustomId(yesId)
        .setLabel(confirmLabel)
        .setStyle(danger ? ButtonStyle.Danger : ButtonStyle.Success)
        .setDisabled(disabled),
      new ButtonBuilder().setCustomId(noId).setLabel('Cancel').setStyle(ButtonStyle.Secondary).setDisabled(disabled),
    );

  await safeReply(interaction, {
    embeds: [embeds.warning(description, title)],
    components: [row()],
    ephemeral: true,
  });

  const message = await interaction.fetchReply();

  try {
    const pressed = await message.awaitMessageComponent({
      componentType: ComponentType.Button,
      time: timeout,
      filter: (i) => i.user.id === interaction.user.id && (i.customId === yesId || i.customId === noId),
    });
    await pressed.deferUpdate();
    const confirmed = pressed.customId === yesId;
    await interaction.editReply({
      embeds: [embeds.info(confirmed ? 'Confirmed. Working on it…' : 'Cancelled.')],
      components: [],
    });
    return confirmed;
  } catch {
    await interaction
      .editReply({ embeds: [embeds.info('Timed out. Nothing was changed.')], components: [] })
      .catch(() => {});
    return false;
  }
}

module.exports = { confirm };
