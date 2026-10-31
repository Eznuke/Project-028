'use strict';

const { PermissionFlagsBits, PermissionsBitField } = require('discord.js');
const { UserError } = require('./errors');

/** "BanMembers" -> "Ban Members" */
function permissionName(flagName) {
  return flagName.replace(/([a-z])([A-Z])/g, '$1 $2');
}

function permissionNames(bitfield) {
  return new PermissionsBitField(BigInt(bitfield)).toArray().map(permissionName);
}

/** Throws a UserError if the bot lacks any of the permissions in a channel (or guild). */
function requireBotPermissions(guild, channel, perms) {
  const me = guild.members.me;
  if (!me) throw new UserError('I could not load my own member data. Try again in a moment.');
  const have = channel ? channel.permissionsFor(me) : me.permissions;
  const missing = perms.filter((p) => !have?.has(p));
  if (missing.length) {
    const names = missing.map((p) => permissionName(new PermissionsBitField(p).toArray()[0] ?? 'Unknown'));
    throw new UserError(`I am missing these permissions${channel ? ' in that channel' : ''}: **${names.join(', ')}**.`);
  }
}

/**
 * Checks whether `actor` may moderate `target` and whether the bot can too.
 * Returns { ok: true } or { ok: false, reason }.
 */
function canModerate(guild, actor, target) {
  const me = guild.members.me;
  if (!target) return { ok: false, reason: 'That user is not in this server.' };
  if (target.id === actor.id) return { ok: false, reason: 'You cannot do that to yourself.' };
  if (target.id === guild.client.user.id) return { ok: false, reason: 'I cannot do that to myself.' };
  if (target.id === guild.ownerId) return { ok: false, reason: 'The server owner cannot be moderated.' };
  if (actor.id !== guild.ownerId && target.roles.highest.position >= actor.roles.highest.position) {
    return { ok: false, reason: 'That member has the same or a higher role than you.' };
  }
  if (me && target.roles.highest.position >= me.roles.highest.position) {
    return { ok: false, reason: 'That member has the same or a higher role than me. Move my role higher.' };
  }
  return { ok: true };
}

/**
 * Checks whether `actor` may assign/remove `role` and whether the bot can.
 * Enforces: never grant roles at or above the bot's highest role.
 */
function canManageRole(guild, actor, role) {
  const me = guild.members.me;
  if (!role) return { ok: false, reason: 'That role does not exist.' };
  if (role.id === guild.id) return { ok: false, reason: 'The @everyone role cannot be assigned.' };
  if (role.managed) return { ok: false, reason: 'That role is managed by an integration and cannot be assigned manually.' };
  if (!me?.permissions.has(PermissionFlagsBits.ManageRoles)) {
    return { ok: false, reason: 'I need the **Manage Roles** permission.' };
  }
  if (role.position >= me.roles.highest.position) {
    return { ok: false, reason: `I cannot manage ${role} because it is at or above my highest role.` };
  }
  if (actor && actor.id !== guild.ownerId && role.position >= actor.roles.highest.position) {
    return { ok: false, reason: `You cannot manage ${role} because it is at or above your highest role.` };
  }
  return { ok: true };
}

/** Role-based staff check using a list of role IDs, falling back to a Discord permission. */
function isStaff(member, roleIds = [], fallbackPermission = PermissionFlagsBits.ManageGuild) {
  if (!member) return false;
  if (member.guild.ownerId === member.id) return true;
  if (member.permissions.has(PermissionFlagsBits.Administrator)) return true;
  if (roleIds.some((id) => member.roles.cache.has(id))) return true;
  return fallbackPermission ? member.permissions.has(fallbackPermission) : false;
}

module.exports = {
  PermissionFlagsBits,
  permissionName,
  permissionNames,
  requireBotPermissions,
  canModerate,
  canManageRole,
  isStaff,
};
