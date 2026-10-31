'use strict';

const { PermissionFlagsBits } = require('discord.js');
const { guildCommand, EPHEMERAL } = require('../../utils/builders');
const embeds = require('../../utils/embeds');
const eco = require('../../services/economy');
const audit = require('../../services/audit');
const db = require('../../database');
const { UserError } = require('../../utils/errors');
const { canManageRole } = require('../../utils/permissions');
const { truncate } = require('../../utils/text');

const P = PermissionFlagsBits;

async function itemAutocomplete(interaction) {
  const focused = String(interaction.options.getFocused()).toLowerCase();
  const items = eco.listItems(interaction.guildId)
    .filter((i) => i.name.toLowerCase().includes(focused))
    .slice(0, 25)
    .map((i) => ({ name: truncate(`${i.name} — ${i.price}`, 100), value: i.name }));
  await interaction.respond(items);
}

function requireItem(guildId, name) {
  const item = eco.findItem(guildId, name);
  if (!item) throw new UserError('That item does not exist. Use `/shop view` to see what is for sale.');
  return item;
}

const shop = {
  data: guildCommand('shop', 'Browse the server shop or (admins) manage it')
    .addSubcommand((s) => s.setName('view').setDescription('Show the items for sale'))
    .addSubcommand((s) =>
      s.setName('add').setDescription('Add an item to the shop (Manage Server)')
        .addStringOption((o) => o.setName('name').setDescription('Item name').setRequired(true).setMaxLength(40))
        .addIntegerOption((o) => o.setName('price').setDescription('Price in coins').setRequired(true).setMinValue(1).setMaxValue(1_000_000_000))
        .addStringOption((o) => o.setName('description').setDescription('What the item is').setMaxLength(150))
        .addRoleOption((o) => o.setName('role').setDescription('Role granted when bought'))
        .addIntegerOption((o) => o.setName('stock').setDescription('Limited stock (empty = unlimited)').setMinValue(1).setMaxValue(100000))
        .addBooleanOption((o) => o.setName('sellable').setDescription('Can players sell it back? (default yes)')))
    .addSubcommand((s) =>
      s.setName('remove').setDescription('Remove an item from the shop (Manage Server)')
        .addStringOption((o) => o.setName('name').setDescription('Item name').setRequired(true).setAutocomplete(true))),
  cooldown: 3,
  autocomplete: itemAutocomplete,

  async execute(interaction) {
    const g = interaction.guildId;
    eco.assertEnabled(g);
    const sub = interaction.options.getSubcommand();

    if (sub === 'view') {
      const items = eco.listItems(g);
      const text = items.length
        ? items.map((i) => `**${i.name}** — ${eco.money(g, i.price)}${i.stock !== null ? ` *(stock: ${i.stock})*` : ''}${i.role_id ? ` 🏷️ <@&${i.role_id}>` : ''}\n${i.description ?? '*No description*'}`).join('\n\n')
        : 'The shop is empty. Admins can add items with `/shop add`.';
      await interaction.reply({ embeds: [embeds.base('🛒 Shop', truncate(text, 4000)).setFooter({ text: 'Buy with /buy' })], allowedMentions: { parse: [] } });
      return;
    }

    if (!interaction.memberPermissions.has(P.ManageGuild)) throw new UserError('You need the **Manage Server** permission to edit the shop.');

    if (sub === 'add') {
      const role = interaction.options.getRole('role');
      if (role) {
        const check = canManageRole(interaction.guild, interaction.member, role);
        if (!check.ok) throw new UserError(check.reason);
        if (role.permissions.has(P.Administrator) || role.permissions.has(P.ManageGuild) || role.permissions.has(P.ManageRoles)) {
          throw new UserError('For safety, shop items cannot grant roles with Administrator, Manage Server or Manage Roles.');
        }
      }
      const name = interaction.options.getString('name', true).trim();
      const id = eco.addItem(g, {
        name,
        description: interaction.options.getString('description'),
        price: interaction.options.getInteger('price', true),
        roleId: role?.id,
        stock: interaction.options.getInteger('stock'),
        sellable: interaction.options.getBoolean('sellable'),
      });
      audit.record(g, interaction.user.id, 'shop.add', id, name);
      await interaction.reply({ embeds: [embeds.success(`Added **${name}** to the shop.`)], flags: EPHEMERAL });
      return;
    }

    const name = interaction.options.getString('name', true);
    if (!eco.removeItem(g, name)) throw new UserError('That item does not exist.');
    audit.record(g, interaction.user.id, 'shop.remove', null, name);
    await interaction.reply({ embeds: [embeds.success(`Removed **${name}** from the shop. Owned copies were deleted too.`)], flags: EPHEMERAL });
  },
};

const buy = {
  data: guildCommand('buy', 'Buy an item from the shop')
    .addStringOption((o) => o.setName('item').setDescription('Item name').setRequired(true).setAutocomplete(true))
    .addIntegerOption((o) => o.setName('quantity').setDescription('How many (default 1)').setMinValue(1).setMaxValue(100)),
  cooldown: 3,
  autocomplete: itemAutocomplete,
  async execute(interaction) {
    const g = interaction.guildId;
    eco.assertEnabled(g);
    const item = requireItem(g, interaction.options.getString('item', true));
    const quantity = interaction.options.getInteger('quantity') ?? 1;

    let role = null;
    if (item.role_id) {
      role = interaction.guild.roles.cache.get(item.role_id);
      if (!role) throw new UserError('The role for that item no longer exists. Ask an admin to fix the shop.');
      if (interaction.member.roles.cache.has(role.id)) throw new UserError('You already have that role.');
      const check = canManageRole(interaction.guild, null, role); // bot hierarchy only
      if (!check.ok) throw new UserError(check.reason);
    }

    const total = eco.buy(g, interaction.user.id, item, quantity);

    if (role) {
      try {
        await interaction.member.roles.add(role, `Bought "${item.name}" in the shop`);
      } catch (err) {
        // Roll the purchase back so nobody pays for a role they did not get.
        db.run('UPDATE inventory SET quantity = quantity - ? WHERE guild_id = ? AND user_id = ? AND item_id = ?', quantity, g, interaction.user.id, item.id);
        if (item.stock !== null) db.run('UPDATE shop_items SET stock = stock + ? WHERE id = ?', quantity, item.id);
        eco.adjust(g, interaction.user.id, { wallet: total }, 'refund', `role grant failed: ${item.name}`);
        throw err;
      }
    }
    await interaction.reply({ embeds: [embeds.success(`You bought **${quantity}× ${item.name}** for **${eco.money(g, total)}**.${role ? `\nYou received ${role}.` : ''}`)], allowedMentions: { parse: [] } });
  },
};

const sell = {
  data: guildCommand('sell', 'Sell an item from your inventory back to the shop')
    .addStringOption((o) => o.setName('item').setDescription('Item name').setRequired(true).setAutocomplete(true))
    .addIntegerOption((o) => o.setName('quantity').setDescription('How many (default 1)').setMinValue(1).setMaxValue(1000)),
  cooldown: 3,
  autocomplete: async (interaction) => {
    const focused = String(interaction.options.getFocused()).toLowerCase();
    const owned = eco.inventory(interaction.guildId, interaction.user.id)
      .filter((i) => i.name.toLowerCase().includes(focused))
      .slice(0, 25)
      .map((i) => ({ name: truncate(`${i.name} (x${i.quantity})`, 100), value: i.name }));
    await interaction.respond(owned);
  },
  async execute(interaction) {
    const g = interaction.guildId;
    eco.assertEnabled(g);
    const item = requireItem(g, interaction.options.getString('item', true));
    const quantity = interaction.options.getInteger('quantity') ?? 1;
    const refund = eco.sell(g, interaction.user.id, item, quantity);
    if (item.role_id && interaction.member.roles.cache.has(item.role_id)) {
      const role = interaction.guild.roles.cache.get(item.role_id);
      if (role && canManageRole(interaction.guild, null, role).ok) {
        await interaction.member.roles.remove(role, `Sold "${item.name}"`).catch(() => {});
      }
    }
    await interaction.reply({ embeds: [embeds.success(`Sold **${quantity}× ${item.name}** for **${eco.money(g, refund)}**.`)] });
  },
};

const inventory = {
  data: guildCommand('inventory', 'Show the items you own')
    .addUserOption((o) => o.setName('user').setDescription('Whose inventory (default: you)')),
  cooldown: 3,
  async execute(interaction) {
    const g = interaction.guildId;
    eco.assertEnabled(g);
    const user = interaction.options.getUser('user') ?? interaction.user;
    const items = eco.inventory(g, user.id);
    const text = items.length ? items.map((i) => `**${i.name}** × ${i.quantity} — worth ${eco.money(g, i.price)} each`).join('\n') : 'Nothing here yet. Try `/shop view`.';
    await interaction.reply({ embeds: [embeds.base(`🎒 ${user.username}'s inventory`, truncate(text, 4000))] });
  },
};

module.exports = [shop, buy, sell, inventory];
