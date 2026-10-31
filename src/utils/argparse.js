'use strict';

/**
 * Turns a chat line such as   ban @user 7d "spam"   into the values of a slash command.
 * Works purely on the JSON that SlashCommandBuilder#toJSON() produces, so every slash
 * command is usable with a prefix without writing a second parser.
 *
 * Rules (documented for users in the README and /help):
 *  - Arguments are positional, in the same order as the slash command options.
 *  - Use "double quotes" for values that contain spaces.
 *  - Any option can also be given by name:  duration:7d  reason:"too loud"
 *  - The last text option (or a text option such as `reason`, `text`, `message` that is only
 *    followed by optional options) takes the rest of the line, so quotes are not needed there.
 */

const T = {
  SUB: 1, GROUP: 2, STRING: 3, INTEGER: 4, BOOLEAN: 5, USER: 6, CHANNEL: 7, ROLE: 8, MENTIONABLE: 9, NUMBER: 10, ATTACHMENT: 11,
};

const ENTITY_TYPES = new Set([T.USER, T.CHANNEL, T.ROLE, T.MENTIONABLE, T.ATTACHMENT]);

/** Text options that may swallow the rest of the line when only optional options follow. */
const GREEDY_NAMES = new Set([
  'reason', 'text', 'message', 'question', 'prompt', 'content', 'expression', 'description', 'note', 'task',
  'nickname', 'welcome_message', 'dm_message', 'contains', 'label', 'title',
]);

const TRUE_WORDS = new Set(['true', 'yes', 'y', 'on', '1', 'enable', 'enabled', 'ya', 'iya']);
const FALSE_WORDS = new Set(['false', 'no', 'n', 'off', '0', 'disable', 'disabled', 'tidak', 'nggak', 'ga']);

/** A problem with the typed arguments. The message is shown to the user as-is. */
class ArgError extends Error {
  constructor(message, { showUsage = true } = {}) {
    super(message);
    this.name = 'ArgError';
    this.showUsage = showUsage;
  }
}

const CLOSERS = { '"': '"', '“': '”', '”': '”', '„': '”' };

/**
 * Splits a line into tokens. Double quotes (straight or curly) group words, but only where a
 * token starts (or right after "name:"), so a lone inch mark or apostrophe is never special.
 * @returns {{ text: string, raw: string, sep: string }[]} `sep` is the whitespace that preceded the token.
 */
function tokenize(input) {
  const s = String(input ?? '');
  const tokens = [];
  let i = 0;
  while (i < s.length) {
    const wsStart = i;
    while (i < s.length && /\s/.test(s[i])) i += 1;
    const sep = s.slice(wsStart, i);
    if (i >= s.length) break;

    const start = i;
    let text = '';
    let closer = null;
    while (i < s.length) {
      const ch = s[i];
      if (closer) {
        if (ch === closer) { closer = null; i += 1; continue; }
        text += ch; i += 1; continue;
      }
      if (/\s/.test(ch)) break;
      const atTokenStart = i === start || s[i - 1] === ':';
      if (atTokenStart && CLOSERS[ch] && s.indexOf(CLOSERS[ch], i + 1) !== -1) {
        closer = CLOSERS[ch]; i += 1; continue;
      }
      text += ch; i += 1;
    }
    tokens.push({ text, raw: s.slice(start, i), sep: tokens.length ? sep : '' });
  }
  return tokens;
}

/** Joins tokens back into one string, keeping the user's own spacing and line breaks. */
function joinRaw(tokens) {
  const joined = tokens.map((t, i) => (i ? t.sep : '') + t.raw).join('');
  // A value that is one single quoted phrase is unquoted: reason "too loud" -> too loud
  if (tokens.length === 1 && tokens[0].raw !== tokens[0].text) return tokens[0].text;
  return joined;
}

const isSub = (o) => o.type === T.SUB || o.type === T.GROUP;

/**
 * Finds the (sub)command the line refers to and the options that apply.
 * @returns {{ group: string|null, sub: string|null, options: object[], rest: object[] }}
 */
function resolvePath(json, tokens) {
  let options = json.options ?? [];
  if (!options.some(isSub)) return { group: null, sub: null, options, rest: tokens };

  const names = options.filter(isSub).map((o) => o.name);
  const first = tokens[0]?.text.toLowerCase();
  const node = options.find((o) => isSub(o) && o.name === first);
  if (!node) {
    throw new ArgError(
      first
        ? `Unknown option \`${tokens[0].text}\`. Choose one of: ${names.map((n) => `\`${n}\``).join(', ')}.`
        : `Say what you want to do: ${names.map((n) => `\`${n}\``).join(', ')}.`,
    );
  }
  if (node.type === T.SUB) return { group: null, sub: node.name, options: node.options ?? [], rest: tokens.slice(1) };

  const second = tokens[1]?.text.toLowerCase();
  const inner = (node.options ?? []).find((o) => o.name === second);
  if (!inner) {
    throw new ArgError(`Choose one of: ${(node.options ?? []).map((o) => `\`${node.name} ${o.name}\``).join(', ')}.`);
  }
  return { group: node.name, sub: inner.name, options: inner.options ?? [], rest: tokens.slice(2) };
}

function parseBoolean(text, name) {
  const w = text.trim().toLowerCase();
  if (TRUE_WORDS.has(w)) return true;
  if (FALSE_WORDS.has(w)) return false;
  throw new ArgError(`\`${name}\` must be yes or no.`);
}

function parseNumberText(text) {
  const clean = text.trim().replace(/,/g, '');
  return /^[-+]?(\d+\.?\d*|\.\d+)$/.test(clean) ? Number(clean) : Number.NaN;
}

/** Validates and converts one non-entity value. Entities are returned as { entity, raw } for the caller. */
function convertValue(opt, text) {
  switch (opt.type) {
    case T.STRING: {
      let value = text;
      if (opt.choices?.length) {
        const lower = value.trim().toLowerCase();
        const hit = opt.choices.find((c) => String(c.value).toLowerCase() === lower || String(c.name).toLowerCase() === lower);
        if (!hit) throw new ArgError(`\`${opt.name}\` must be one of: ${opt.choices.map((c) => `\`${c.value}\``).join(', ')}.`);
        value = String(hit.value);
      }
      if (opt.min_length && value.length < opt.min_length) throw new ArgError(`\`${opt.name}\` needs at least ${opt.min_length} characters.`);
      if (opt.max_length && value.length > opt.max_length) throw new ArgError(`\`${opt.name}\` can have at most ${opt.max_length} characters (you wrote ${value.length}).`);
      return value;
    }
    case T.INTEGER:
    case T.NUMBER: {
      let n;
      if (opt.choices?.length) {
        const lower = text.trim().toLowerCase();
        const hit = opt.choices.find((c) => String(c.value) === lower || String(c.name).toLowerCase() === lower);
        if (!hit) throw new ArgError(`\`${opt.name}\` must be one of: ${opt.choices.map((c) => `\`${c.value}\``).join(', ')}.`);
        n = Number(hit.value);
      } else {
        n = parseNumberText(text);
      }
      if (!Number.isFinite(n)) throw new ArgError(`\`${opt.name}\` must be a number.`);
      if (opt.type === T.INTEGER && !Number.isInteger(n)) throw new ArgError(`\`${opt.name}\` must be a whole number.`);
      if (opt.type === T.INTEGER && !Number.isSafeInteger(n)) throw new ArgError(`\`${opt.name}\` is too large.`);
      if (opt.min_value !== undefined && n < opt.min_value) throw new ArgError(`\`${opt.name}\` must be at least ${opt.min_value}.`);
      if (opt.max_value !== undefined && n > opt.max_value) throw new ArgError(`\`${opt.name}\` must be at most ${opt.max_value}.`);
      return n;
    }
    case T.BOOLEAN:
      return parseBoolean(text, opt.name);
    default:
      return { entity: opt.type, raw: text };
  }
}

/**
 * Parses the text after the command name.
 * @param {object} json   command.data.toJSON()
 * @param {string} argText everything after the command name
 * @returns {{ group: string|null, sub: string|null, values: Map<string, any>, options: object[] }}
 */
function parseArguments(json, argText) {
  const { group, sub, options, rest } = resolvePath(json, tokenize(argText));
  const byName = new Map(options.map((o) => [o.name, o]));

  // 1. name:value tokens (matched on the raw text, so a quoted "note: x" is never mistaken for one)
  const named = new Map();
  const positional = [];
  for (const token of rest) {
    const m = /^([A-Za-z][\w-]*):(.+)$/s.exec(token.raw);
    const opt = m && byName.get(m[1].toLowerCase());
    if (opt && !named.has(opt.name)) {
      named.set(opt.name, token.text.slice(m[1].length + 1));
    } else {
      positional.push(token);
    }
  }

  // 2. positional values in schema order
  const values = new Map();
  let at = 0;
  options.forEach((opt, index) => {
    if (named.has(opt.name)) {
      values.set(opt.name, convertValue(opt, named.get(opt.name)));
      return;
    }
    // Attachments come from the message itself, not from the typed text.
    if (opt.type === T.ATTACHMENT) {
      values.set(opt.name, { entity: T.ATTACHMENT, raw: '' });
      return;
    }
    if (at >= positional.length) {
      if (opt.required) throw new ArgError(`Missing \`${opt.name}\`.`);
      return;
    }
    const later = options.slice(index + 1).filter((o) => !named.has(o.name));
    const greedy = opt.type === T.STRING
      && (later.length === 0 || (GREEDY_NAMES.has(opt.name) && later.every((o) => !o.required)));
    if (greedy) {
      values.set(opt.name, convertValue(opt, joinRaw(positional.slice(at))));
      at = positional.length;
    } else {
      values.set(opt.name, convertValue(opt, positional[at].text));
      at += 1;
    }
  });

  if (at < positional.length && options.length) {
    throw new ArgError(`Too many arguments. Put values that contain spaces in "quotes".`);
  }
  return { group, sub, values, options };
}

// ---- usage text ----------------------------------------------------------------

function optionLabel(o) {
  return o.required ? `<${o.name}>` : `[${o.name}]`;
}

/**
 * Every usable form of a command as { usage, description }.
 * `prefix` is "!" for chat usage or "/" for slash usage.
 */
function usageLines(json, prefix) {
  const out = [];
  const line = (path, opts, description) => {
    const args = (opts ?? []).map(optionLabel).join(' ');
    out.push({ usage: `${prefix}${path}${args ? ` ${args}` : ''}`, description });
  };
  const opts = json.options ?? [];
  if (!opts.some(isSub)) {
    line(json.name, opts, json.description);
    return out;
  }
  for (const node of opts) {
    if (node.type === T.SUB) line(`${json.name} ${node.name}`, node.options, node.description);
    else for (const inner of node.options ?? []) line(`${json.name} ${node.name} ${inner.name}`, inner.options, inner.description);
  }
  return out;
}

/** The usage of the one (sub)command a parse error refers to. Falls back to all forms. */
function usageFor(json, prefix, argText) {
  const all = usageLines(json, prefix);
  if (all.length <= 1) return all;
  const tokens = tokenize(argText).map((t) => t.text.toLowerCase());
  const match = all.filter((l) => {
    const w = l.usage.slice(prefix.length).split(' ');
    if (w[1] !== tokens[0]) return false;
    if (w[2] && !/^[<[]/.test(w[2])) return w[2] === tokens[1]; // sub-command group form
    return true;
  });
  return match.length ? match.slice(0, 3) : all;
}

module.exports = { T, ENTITY_TYPES, ArgError, tokenize, parseArguments, usageLines, usageFor, optionLabel, GREEDY_NAMES };
