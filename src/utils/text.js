'use strict';

/** Replaces {key} placeholders. Unknown keys are left untouched. */
function fill(template, values) {
  return String(template ?? '').replace(/\{(\w+)\}/g, (whole, key) =>
    Object.prototype.hasOwnProperty.call(values, key) ? String(values[key]) : whole,
  );
}

/** Placeholder map for a guild member (welcome / goodbye / level messages). */
function memberPlaceholders(member, extra = {}) {
  const user = member.user ?? member;
  return {
    user: `<@${user.id}>`,
    username: user.username,
    tag: user.tag ?? user.username,
    id: user.id,
    server: member.guild?.name ?? '',
    memberCount: member.guild?.memberCount ?? '',
    ...extra,
  };
}

function truncate(text, max, suffix = '…') {
  const s = String(text ?? '');
  return s.length <= max ? s : s.slice(0, Math.max(0, max - suffix.length)) + suffix;
}

/** Escapes Discord markdown so user text cannot break formatting. */
function escapeMarkdown(text) {
  return String(text ?? '').replace(/([\\*_`~|>])/g, '\\$1');
}

/** Neutralises @everyone/@here and role pings inside user supplied text. */
function stripMentions(text) {
  return String(text ?? '').replace(/@(everyone|here)/g, '@​$1').replace(/<@&(\d+)>/g, '<@​&$1>');
}

function pluralize(n, one, many = `${one}s`) {
  return `${n} ${n === 1 ? one : many}`;
}

function formatNumber(n) {
  return Number(n).toLocaleString('en-US');
}

function chunk(array, size) {
  const out = [];
  for (let i = 0; i < array.length; i += size) out.push(array.slice(i, i + size));
  return out;
}

function randomInt(min, max) {
  const lo = Math.ceil(Math.min(min, max));
  const hi = Math.floor(Math.max(min, max));
  return Math.floor(Math.random() * (hi - lo + 1)) + lo;
}

function pick(array) {
  return array[Math.floor(Math.random() * array.length)];
}

/** Escapes characters that matter for RegExp. */
function escapeRegex(text) {
  return String(text).replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

module.exports = {
  fill,
  memberPlaceholders,
  truncate,
  escapeMarkdown,
  stripMentions,
  pluralize,
  formatNumber,
  chunk,
  randomInt,
  pick,
  escapeRegex,
};
