'use strict';

const { ChannelType } = require('discord.js');
const { T, ArgError, parseArguments } = require('./argparse');
const { UserError } = require('./errors');
const { truncate } = require('./text');

/**
 * Lets the existing slash-command code run for a chat message ("!ban @user spam").
 * It offers the same members of an interaction that commands use (options, reply, editReply,
 * followUp, deferReply, fetchReply, user, member, guild, channel, permissions...), so no command
 * needs a second implementation.
 *
 * Differences a chat message cannot avoid:
 *  - There are no private ("ephemeral") replies. They are sent as a normal reply that deletes itself
 *    after EPHEMERAL_TTL_MS, and never carry buttons that anyone else could press (see SAFE_PREFIXES).
 *  - There are no modals. Commands that open one tell the user to use the slash command.
 */

const EPHEMERAL_TTL_MS = 120_000;
/** Component handlers whose controls check permissions themselves, so a public message is harmless. */
const SAFE_PREFIXES = new Set(['help', 'cfg']);
const EPHEMERAL_BIT = 64n;

function isEphemeral(payload) {
  if (payload.ephemeral) return true;
  const f = payload.flags;
  if (f === undefined || f === null) return false;
  try {
    return (BigInt(typeof f === 'object' && f.bitfield !== undefined ? f.bitfield : f) & EPHEMERAL_BIT) !== 0n;
  } catch {
    return false;
  }
}

function customIdsOf(payload) {
  const ids = [];
  for (const row of payload.components ?? []) {
    const json = typeof row.toJSON === 'function' ? row.toJSON() : row;
    for (const c of json.components ?? []) if (c.custom_id) ids.push(String(c.custom_id));
  }
  return ids;
}

/** Converts an interaction reply payload into a message payload. */
function toMessagePayload(input) {
  const payload = typeof input === 'string' ? { content: input } : { ...input };
  const ephemeral = isEphemeral(payload);
  delete payload.ephemeral;
  delete payload.flags;
  delete payload.fetchReply;
  delete payload.withResponse;
  payload.allowedMentions = { ...(payload.allowedMentions ?? { parse: [] }), repliedUser: false };
  payload.failIfNotExists = false;
  return { payload, ephemeral };
}

class PrefixOptions {
  constructor(parsed, resolved) {
    this._sub = parsed.sub;
    this._group = parsed.group;
    this._values = resolved;
    this.data = [];
  }

  _get(name, required, accepts) {
    const v = this._values.get(name);
    const value = v === undefined || v === null ? null : v;
    if (value !== null && accepts && !accepts(value)) return null;
    if (required && value === null) throw new Error(`Option "${name}" is required but was not provided.`);
    return value;
  }

  getString(name, required = false) { return this._get(name, required, (v) => typeof v === 'string'); }
  getInteger(name, required = false) { return this._get(name, required, (v) => typeof v === 'number'); }
  getNumber(name, required = false) { return this._get(name, required, (v) => typeof v === 'number'); }
  getBoolean(name, required = false) { return this._get(name, required, (v) => typeof v === 'boolean'); }
  getUser(name, required = false) { return this._get(name, required, (v) => v.user)?.user ?? null; }
  getMember(name) { return this._get(name, false, (v) => v.user)?.member ?? null; }
  getRole(name, required = false) { return this._get(name, required, (v) => v.role)?.role ?? null; }
  getChannel(name, required = false) { return this._get(name, required, (v) => v.channel)?.channel ?? null; }
  getAttachment(name, required = false) { return this._get(name, required, (v) => v.attachment)?.attachment ?? null; }
  getMentionable(name, required = false) { const v = this._get(name, required); return v?.user ?? v?.role ?? null; }
  getSubcommand(required = true) {
    if (this._sub === null && required) throw new Error('No subcommand was given.');
    return this._sub;
  }
  getSubcommandGroup(required = false) {
    if (this._group === null && required) throw new Error('No subcommand group was given.');
    return this._group;
  }
  getFocused() { return ''; }
}

class PrefixInteraction {
  /**
   * @param {import('discord.js').Message} message
   * @param {object} command  the matching slash command module
   * @param {string} args     text after the command word
   */
  constructor(message, command, args, client) {
    this.isPrefixCommand = true;
    this.message = message; // note: only for the adapter; commands should not rely on it
    this.client = client;
    this.command = command;
    this.argText = args;
    this.id = message.id;
    this.createdTimestamp = message.createdTimestamp;
    this.commandName = command.data.name;
    this.user = message.author;
    this.member = message.member;
    this.guild = message.guild;
    this.guildId = message.guildId;
    this.channel = message.channel;
    this.channelId = message.channelId;
    this.replied = false;
    this.deferred = false;
    this.options = new PrefixOptions({ sub: null, group: null }, new Map());
    this._reply = null;
    this._ephemeral = false;
    this._temp = new Set();
    this._timer = null;
  }

  // ---- state a command can read ---------------------------------------------------
  get memberPermissions() { return this.member?.permissions ?? null; }
  get appPermissions() {
    if (!this.guild) return null;
    return this.channel?.permissionsFor?.(this.guild.members.me) ?? null;
  }
  inGuild() { return Boolean(this.guild); }
  isChatInputCommand() { return true; }
  isAutocomplete() { return false; }
  isMessageComponent() { return false; }
  isModalSubmit() { return false; }

  // ---- argument handling ------------------------------------------------------------

  /** Parses the typed text and looks up users, roles and channels. Throws UserError when something is wrong. */
  async prepare() {
    const json = this.command.data.toJSON();
    let parsed;
    try {
      parsed = parseArguments(json, this.argText);
      this.options = new PrefixOptions(parsed, await this._resolve(parsed));
    } catch (err) {
      if (err instanceof ArgError) err.argText = this.argText;
      throw err;
    }
    if (this.guild && !this.member) {
      this.member = await this.guild.members.fetch(this.user.id).catch(() => null);
    }
  }

  async _resolve(parsed) {
    const out = new Map();
    const attachments = [...(this.message.attachments?.values?.() ?? [])];
    let nextAttachment = 0;
    for (const opt of parsed.options) {
      const v = parsed.values.get(opt.name);
      if (v === undefined) continue;
      if (v === null || typeof v !== 'object' || v.entity === undefined) { out.set(opt.name, v); continue; }

      switch (v.entity) {
        case T.USER: {
          const user = await this._user(v.raw, opt.name);
          const member = this.guild ? await this.guild.members.fetch(user.id).catch(() => null) : null;
          out.set(opt.name, { user, member });
          break;
        }
        case T.ROLE:
          out.set(opt.name, { role: this._role(v.raw, opt.name) });
          break;
        case T.CHANNEL:
          out.set(opt.name, { channel: this._channel(v.raw, opt) });
          break;
        case T.MENTIONABLE: {
          const role = /^<@&\d+>$/.test(v.raw.trim()) ? this._role(v.raw, opt.name) : null;
          if (role) out.set(opt.name, { role });
          else out.set(opt.name, { user: await this._user(v.raw, opt.name), member: null });
          break;
        }
        case T.ATTACHMENT: {
          const attachment = attachments[nextAttachment];
          nextAttachment += 1;
          if (attachment) out.set(opt.name, { attachment });
          else if (opt.required) throw new ArgError(`Attach a file to your message for \`${opt.name}\`.`);
          break;
        }
        default:
          break;
      }
    }
    return out;
  }

  async _user(raw, name) {
    const text = raw.trim();
    const id = /^<@!?(\d{15,25})>$/.exec(text)?.[1] ?? (/^\d{15,25}$/.test(text) ? text : null);
    if (id) {
      const user = await this.client.users.fetch(id).catch(() => null);
      if (!user) throw new ArgError(`I could not find a user with the ID \`${id}\`.`);
      return user;
    }
    if (this.guild) {
      const query = text.replace(/^@/, '');
      const lower = query.toLowerCase();
      const cached = this.guild.members.cache.find((m) => m.user.username.toLowerCase() === lower || m.displayName.toLowerCase() === lower);
      if (cached) return cached.user;
      const found = await this.guild.members.search({ query, limit: 1 }).catch(() => null);
      if (found?.size) return found.first().user;
    }
    throw new ArgError(`I could not find a user for \`${name}\` matching \`${truncate(text, 40)}\`. Mention them (@name) or use their ID.`);
  }

  _role(raw, name) {
    const text = raw.trim();
    const id = /^<@&(\d{15,25})>$/.exec(text)?.[1] ?? (/^\d{15,25}$/.test(text) ? text : null);
    const roles = this.guild?.roles.cache;
    if (!roles) throw new ArgError('Roles only exist inside a server.');
    const role = id ? roles.get(id) : roles.find((r) => r.name.toLowerCase() === text.replace(/^@/, '').toLowerCase());
    if (!role) throw new ArgError(`I could not find a role for \`${name}\` matching \`${truncate(text, 40)}\`. Mention it or use its exact name (in "quotes" if it has spaces).`);
    return role;
  }

  _channel(raw, opt) {
    const text = raw.trim();
    const id = /^<#(\d{15,25})>$/.exec(text)?.[1] ?? (/^\d{15,25}$/.test(text) ? text : null);
    const channels = this.guild?.channels.cache;
    if (!channels) throw new ArgError('Channels only exist inside a server.');
    const wanted = text.replace(/^#/, '').toLowerCase();
    const channel = id ? channels.get(id) : channels.find((c) => c.name?.toLowerCase() === wanted && c.type !== ChannelType.GuildCategory)
      ?? channels.find((c) => c.name?.toLowerCase() === wanted);
    if (!channel) throw new ArgError(`I could not find a channel for \`${opt.name}\` matching \`${truncate(text, 40)}\`. Mention it with # or use its ID.`);
    if (opt.channel_types?.length && !opt.channel_types.includes(channel.type)) {
      throw new ArgError(`${channel} is not a valid kind of channel for \`${opt.name}\`.`);
    }
    return channel;
  }

  // ---- replying ----------------------------------------------------------------------

  _prepareSend(input, inherit = false) {
    const { payload, ephemeral: asked } = toMessagePayload(input);
    const ephemeral = asked || inherit;
    if (ephemeral) {
      const unsafe = customIdsOf(payload).some((id) => !id.startsWith('~') && !SAFE_PREFIXES.has(id.split(':')[0]));
      if (unsafe) {
        throw new UserError(`\`${this.commandName}\` shows controls that must stay private. Please use the slash command \`/${this.commandName}\` for this.`);
      }
    }
    return { payload, ephemeral };
  }

  _track(message, ephemeral) {
    if (!ephemeral || !message || this.command.prefixPublic) return;
    this._temp.add(message);
    clearTimeout(this._timer);
    this._timer = setTimeout(() => {
      for (const m of this._temp) m.delete().catch(() => {});
      this._temp.clear();
    }, EPHEMERAL_TTL_MS);
    this._timer.unref?.();
  }

  async reply(input) {
    if (this.replied) return this.followUp(input);
    const { payload, ephemeral } = this._prepareSend(input);
    this._ephemeral = ephemeral;
    this._reply = await this.message.reply(payload).catch(async (err) => {
      if (this.channel?.send && (err?.code === 50035 || err?.code === 10008)) return this.channel.send(payload);
      throw err;
    });
    this.replied = true;
    this._track(this._reply, ephemeral);
    return this._reply;
  }

  async deferReply(options = {}) {
    this.deferred = true;
    this._ephemeral = isEphemeral(options);
    await this.channel?.sendTyping?.().catch(() => {});
  }

  async editReply(input) {
    if (!this._reply) return this.reply(input);
    const { payload } = this._prepareSend(input, this._ephemeral);
    delete payload.failIfNotExists;
    this._reply = await this._reply.edit(payload);
    this._track(this._reply, this._ephemeral);
    return this._reply;
  }

  async followUp(input) {
    const { payload, ephemeral } = this._prepareSend(input);
    const sent = await this.message.reply(payload).catch(async (err) => {
      if (this.channel?.send && (err?.code === 50035 || err?.code === 10008)) return this.channel.send(payload);
      throw err;
    });
    this._track(sent, ephemeral);
    return sent;
  }

  async fetchReply() {
    if (!this._reply) throw new Error('There is no reply to fetch yet.');
    return this._reply;
  }

  async deleteReply() {
    if (this._reply) await this._reply.delete().catch(() => {});
    this._reply = null;
  }

  async showModal() {
    throw new UserError(`\`${this.commandName}\` opens a form, which chat commands cannot do. Please use the slash command \`/${this.commandName}\`.`);
  }
}

module.exports = { PrefixInteraction, PrefixOptions, toMessagePayload, isEphemeral, EPHEMERAL_TTL_MS };
