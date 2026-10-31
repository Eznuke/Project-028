'use strict';

const { EmbedBuilder } = require('discord.js');

const COLORS = {
  primary: 0x5865f2,
  success: 0x57f287,
  warning: 0xfee75c,
  danger: 0xed4245,
  info: 0x3498db,
  neutral: 0x2b2d31,
};

/** Accepts "#RRGGBB", "RRGGBB" or a number. Returns a number or the fallback. */
function parseColor(input, fallback = COLORS.primary) {
  if (typeof input === 'number' && Number.isFinite(input)) return input;
  if (typeof input === 'string') {
    const m = input.trim().match(/^#?([0-9a-fA-F]{6})$/);
    if (m) return Number.parseInt(m[1], 16);
  }
  return fallback;
}

function isHexColor(input) {
  return typeof input === 'string' && /^#?[0-9a-fA-F]{6}$/.test(input.trim());
}

const success = (description, title) =>
  new EmbedBuilder().setColor(COLORS.success).setDescription(`✅ ${description}`).setTitle(title ?? null);

const error = (description, title) =>
  new EmbedBuilder().setColor(COLORS.danger).setDescription(`❌ ${description}`).setTitle(title ?? null);

const warning = (description, title) =>
  new EmbedBuilder().setColor(COLORS.warning).setDescription(`⚠️ ${description}`).setTitle(title ?? null);

const info = (description, title) =>
  new EmbedBuilder().setColor(COLORS.info).setDescription(description).setTitle(title ?? null);

const base = (title, description, color = COLORS.primary) => {
  const e = new EmbedBuilder().setColor(color);
  if (title) e.setTitle(title);
  if (description) e.setDescription(description);
  return e;
};

module.exports = { COLORS, parseColor, isHexColor, success, error, warning, info, base };
