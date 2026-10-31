'use strict';

const { guildCommand } = require('../../utils/builders');
const embeds = require('../../utils/embeds');
const config = require('../../config');
const logger = require('../../utils/logger');
const { evaluate, formatResult } = require('../../utils/calc');
const { convert, allUnits } = require('../../utils/convert');
const { assertPublicHttpUrl, request } = require('../../utils/http');
const { UserError } = require('../../utils/errors');
const { stripMentions, escapeMarkdown, truncate } = require('../../utils/text');

const calculator = {
  data: guildCommand('calculator', 'Evaluate a math expression safely')
    .addStringOption((o) => o.setName('expression').setDescription('e.g. 2*(3+4), sqrt(144), 15/100*80').setRequired(true).setMaxLength(200)),
  cooldown: 2,
  async execute(interaction) {
    const expression = interaction.options.getString('expression', true);
    let result;
    try {
      result = evaluate(expression);
    } catch (err) {
      throw new UserError(`I could not calculate that: ${err.message}`);
    }
    await interaction.reply({
      embeds: [embeds.base('🧮 Calculator', `\`${truncate(expression, 150).replace(/`/g, "'")}\`\n= **${formatResult(result)}**`)],
    });
  },
};

const convertCmd = {
  data: guildCommand('convert', 'Convert between units (length, mass, volume, speed, area, time, data, temperature)')
    .addNumberOption((o) => o.setName('value').setDescription('The number to convert').setRequired(true))
    .addStringOption((o) => o.setName('from').setDescription('Unit to convert from, e.g. km, lb, c').setRequired(true).setAutocomplete(true))
    .addStringOption((o) => o.setName('to').setDescription('Unit to convert to, e.g. mi, kg, f').setRequired(true).setAutocomplete(true)),
  cooldown: 2,
  async autocomplete(interaction) {
    const q = String(interaction.options.getFocused()).toLowerCase();
    const list = allUnits().filter((u) => u.unit.includes(q) || u.category.includes(q)).slice(0, 25);
    await interaction.respond(list.map((u) => ({ name: `${u.unit} (${u.category})`, value: u.unit })));
  },
  async execute(interaction) {
    const value = interaction.options.getNumber('value', true);
    let r;
    try {
      r = convert(value, interaction.options.getString('from', true), interaction.options.getString('to', true));
    } catch (err) {
      throw new UserError(err.message);
    }
    await interaction.reply({
      embeds: [embeds.base(`🔄 ${r.category[0].toUpperCase()}${r.category.slice(1)} conversion`, `**${formatResult(value)} ${r.from}** = **${formatResult(r.result)} ${r.to}**`)],
    });
  },
};

// ---------------------------------------------------------------- translate

const LANGUAGES = {
  en: 'English', id: 'Indonesian', ms: 'Malay', jv: 'Javanese', es: 'Spanish', fr: 'French', de: 'German', it: 'Italian', pt: 'Portuguese',
  nl: 'Dutch', ru: 'Russian', ja: 'Japanese', ko: 'Korean', zh: 'Chinese', ar: 'Arabic', hi: 'Hindi', tr: 'Turkish', th: 'Thai',
  vi: 'Vietnamese', pl: 'Polish', sv: 'Swedish', uk: 'Ukrainian', el: 'Greek', he: 'Hebrew', fil: 'Filipino',
};

async function translateText(text, from, to) {
  const t = config.translate;
  if (t.provider === 'libretranslate') {
    if (!t.url) throw new UserError('Translation is not configured: set `TRANSLATE_API_URL` for LibreTranslate.');
    const res = await request(`${t.url.replace(/\/$/, '')}/translate`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ q: text, source: from, target: to, format: 'text', ...(t.key ? { api_key: t.key } : {}) }),
      timeoutMs: 15_000,
    });
    const body = await res.json();
    if (!body.translatedText) throw new Error('empty response');
    return body.translatedText;
  }
  // MyMemory (free, no key, small daily quota)
  const pair = `${from === 'auto' ? 'Autodetect' : from}|${to}`;
  const url = `${t.url || 'https://api.mymemory.translated.net/get'}?q=${encodeURIComponent(text)}&langpair=${encodeURIComponent(pair)}`;
  const res = await request(url, { timeoutMs: 15_000 });
  const body = await res.json();
  if (Number(body.responseStatus) !== 200 || !body.responseData?.translatedText) {
    throw new Error(`provider status ${body.responseStatus}`);
  }
  return body.responseData.translatedText;
}

const languageAutocomplete = async (interaction) => {
  const q = String(interaction.options.getFocused()).toLowerCase();
  const list = Object.entries(LANGUAGES).filter(([code, name]) => code.includes(q) || name.toLowerCase().includes(q)).slice(0, 25);
  await interaction.respond(list.map(([code, name]) => ({ name: `${name} (${code})`, value: code })));
};

const translate = {
  data: guildCommand('translate', 'Translate text with the configured translation provider')
    .addStringOption((o) => o.setName('text').setDescription('Text to translate (max 450 characters)').setRequired(true).setMaxLength(450))
    .addStringOption((o) => o.setName('to').setDescription('Target language code, e.g. en, id, ja').setRequired(true).setAutocomplete(true))
    .addStringOption((o) => o.setName('from').setDescription('Source language code (default: detect automatically)').setAutocomplete(true)),
  cooldown: 8,
  autocomplete: languageAutocomplete,
  async execute(interaction) {
    const to = interaction.options.getString('to', true).trim().toLowerCase();
    const from = (interaction.options.getString('from') ?? 'auto').trim().toLowerCase();
    if (!LANGUAGES[to]) throw new UserError('Unknown target language. Choose one from the autocomplete list.');
    if (from !== 'auto' && !LANGUAGES[from]) throw new UserError('Unknown source language. Choose one from the autocomplete list.');
    const text = interaction.options.getString('text', true);

    await interaction.deferReply();
    let out;
    try {
      out = await translateText(text, from, to);
    } catch (err) {
      if (err instanceof UserError) throw err;
      logger.warn('Translation failed:', err.message);
      throw new UserError('The translation service did not answer correctly. Try again later (free providers have daily limits).');
    }
    await interaction.editReply({
      embeds: [embeds.base(`🌐 ${from === 'auto' ? 'Auto' : LANGUAGES[from]} → ${LANGUAGES[to]}`)
        .addFields({ name: 'Original', value: truncate(escapeMarkdown(stripMentions(text)), 1000) }, { name: 'Translation', value: truncate(escapeMarkdown(stripMentions(out)), 1000) })],
      allowedMentions: { parse: [] },
    });
  },
};

// ---------------------------------------------------------------- shorten

const shorten = {
  data: guildCommand('shorten', 'Shorten a link through the bot owner\'s trusted shortener')
    .addStringOption((o) => o.setName('url').setDescription('The link to shorten (http/https)').setRequired(true).setMaxLength(1000)),
  cooldown: 15,
  async execute(interaction) {
    const template = config.shortener.template;
    if (!template || !template.includes('{url}')) throw new UserError('Link shortening is disabled. The bot owner must set `SHORTENER_URL_TEMPLATE`.');

    let target;
    try {
      target = await assertPublicHttpUrl(interaction.options.getString('url', true).trim());
    } catch (err) {
      throw new UserError(err.message);
    }
    await interaction.deferReply();
    let short;
    try {
      const res = await request(template.replace('{url}', encodeURIComponent(target.href)), { timeoutMs: 10_000 });
      short = (await res.text()).trim();
    } catch (err) {
      logger.warn('Shortener request failed:', err.message);
      throw new UserError('The link shortener is not responding. Try again later.');
    }
    if (!/^https?:\/\/\S{4,200}$/.test(short)) throw new UserError('The shortener returned an unexpected answer, so I did not post it.');
    await interaction.editReply({ embeds: [embeds.success(`**${short}**\n\nOriginal: <${truncate(target.href, 200)}>`, '🔗 Link shortened')] });
  },
};

module.exports = [calculator, convertCmd, translate, shorten];
