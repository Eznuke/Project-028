'use strict';

const { guildCommand, EPHEMERAL } = require('../../utils/builders');
const embeds = require('../../utils/embeds');
const eco = require('../../services/economy');
const { UserError } = require('../../utils/errors');
const { parseAmount } = require('../../utils/amount');
const { formatDuration, ts } = require('../../utils/time');
const { randomInt, pick, formatNumber } = require('../../utils/text');

const wait = (ms) => `Try again in **${formatDuration(ms, 2)}**.`;

const balance = {
  data: guildCommand('balance', 'Show your (or someone else\'s) wallet and bank')
    .addUserOption((o) => o.setName('user').setDescription('Whose balance to show (default: you)'))
    .addBooleanOption((o) => o.setName('history').setDescription('Show the last 15 transactions instead')),
  cooldown: 3,
  async execute(interaction) {
    const g = interaction.guildId;
    eco.assertEnabled(g);
    const user = interaction.options.getUser('user') ?? interaction.user;
    if (user.bot) throw new UserError('Bots do not have accounts.');

    if (interaction.options.getBoolean('history')) {
      if (user.id !== interaction.user.id) throw new UserError('You can only view your own transaction history.');
      const rows = eco.history(g, user.id, 15);
      const lines = rows.map((r) => `${ts(r.created_at, 'd')} \`${r.type}\` **${r.amount >= 0 ? '+' : ''}${formatNumber(r.amount)}**${r.note ? ` — ${r.note}` : ''}`);
      await interaction.reply({
        embeds: [embeds.base('🧾 Transaction history', lines.join('\n') || 'No transactions yet.')],
        flags: EPHEMERAL,
        allowedMentions: { parse: [] },
      });
      return;
    }

    const acc = eco.getAccount(g, user.id);
    const all = eco.leaderboard(g, 1000);
    const rank = all.findIndex((r) => r.user_id === user.id) + 1;
    const e = embeds
      .base(`${eco.cfg(g).currencySymbol} ${user.username}'s balance`)
      .setThumbnail(user.displayAvatarURL({ size: 128 }))
      .addFields(
        { name: 'Wallet', value: eco.money(g, acc.wallet), inline: true },
        { name: 'Bank', value: eco.money(g, acc.bank), inline: true },
        { name: 'Net worth', value: eco.money(g, acc.wallet + acc.bank), inline: true },
      );
    if (rank) e.setFooter({ text: `Server rank #${rank}` });
    await interaction.reply({ embeds: [e] });
  },
};

const daily = {
  data: guildCommand('daily', 'Claim your daily reward (streaks give a bonus)'),
  cooldown: 3,
  async execute(interaction) {
    const g = interaction.guildId;
    eco.assertEnabled(g);
    const r = eco.claimDaily(g, interaction.user.id);
    if (!r.ok) throw new UserError(`You already claimed your daily reward. ${wait(r.remainingMs)}`);
    await interaction.reply({
      embeds: [embeds.success(`You claimed **${eco.money(g, r.amount)}**${r.bonus ? ` (includes a **${eco.money(g, r.bonus)}** streak bonus)` : ''}.\n🔥 Streak: **${r.streak}** day(s)`, 'Daily reward')],
    });
  },
};

const weekly = {
  data: guildCommand('weekly', 'Claim your weekly reward'),
  cooldown: 3,
  async execute(interaction) {
    const g = interaction.guildId;
    eco.assertEnabled(g);
    const amount = eco.cfg(g).weeklyAmount;
    const r = eco.claim(g, interaction.user.id, 'last_weekly', 7 * 86_400_000 - 3_600_000);
    if (!r.ok) throw new UserError(`You already claimed your weekly reward. ${wait(r.remainingMs)}`);
    eco.adjust(g, interaction.user.id, { wallet: amount }, 'weekly');
    await interaction.reply({ embeds: [embeds.success(`You claimed **${eco.money(g, amount)}**.`, 'Weekly reward')] });
  },
};

const JOBS = ['barista', 'pizza courier', 'game tester', 'gardener', 'bus driver', 'web developer', 'librarian', 'street musician', 'dog walker', 'baker', 'mechanic', 'photographer'];

const work = {
  data: guildCommand('work', 'Work a shift to earn coins'),
  cooldown: 3,
  async execute(interaction) {
    const g = interaction.guildId;
    eco.assertEnabled(g);
    const c = eco.cfg(g);
    const r = eco.claim(g, interaction.user.id, 'last_work', c.workCooldownMinutes * 60_000);
    if (!r.ok) throw new UserError(`You are tired. ${wait(r.remainingMs)}`);
    const amount = randomInt(c.workMin, c.workMax);
    eco.adjust(g, interaction.user.id, { wallet: amount }, 'work');
    await interaction.reply({ embeds: [embeds.success(`You worked as a **${pick(JOBS)}** and earned **${eco.money(g, amount)}**.`, 'Shift complete')] });
  },
};

const BEG_YES = ['A kind stranger', 'A passing tourist', 'A shop owner', 'A street performer', 'An old friend'];
const BEG_NO = ['Everyone ignored you.', 'A pigeon stole your hat. Nothing else happened.', 'Someone said "maybe later".', 'It started raining and nobody stopped.'];

const beg = {
  data: guildCommand('beg', 'Beg for a few coins (not always successful)'),
  cooldown: 3,
  async execute(interaction) {
    const g = interaction.guildId;
    eco.assertEnabled(g);
    const c = eco.cfg(g);
    const r = eco.claim(g, interaction.user.id, 'last_beg', c.begCooldownMinutes * 60_000);
    if (!r.ok) throw new UserError(`Slow down. ${wait(r.remainingMs)}`);
    if (Math.random() > c.begSuccessRate) {
      await interaction.reply({ embeds: [embeds.warning(pick(BEG_NO))] });
      return;
    }
    const amount = randomInt(c.begMin, c.begMax);
    eco.adjust(g, interaction.user.id, { wallet: amount }, 'beg');
    await interaction.reply({ embeds: [embeds.success(`${pick(BEG_YES)} gave you **${eco.money(g, amount)}**.`)] });
  },
};

const amountOption = (o, text) => o.setName('amount').setDescription(text).setRequired(true).setMaxLength(20);

const deposit = {
  data: guildCommand('deposit', 'Move coins from your wallet to your bank (safe from robbers)')
    .addStringOption((o) => amountOption(o, 'Amount, e.g. 500, 2k or all')),
  cooldown: 3,
  async execute(interaction) {
    const g = interaction.guildId;
    eco.assertEnabled(g);
    const value = eco.deposit(g, interaction.user.id, parseAmount(interaction.options.getString('amount', true)));
    await interaction.reply({ embeds: [embeds.success(`Deposited **${eco.money(g, value)}** into your bank.`)] });
  },
};

const withdraw = {
  data: guildCommand('withdraw', 'Move coins from your bank to your wallet')
    .addStringOption((o) => amountOption(o, 'Amount, e.g. 500, 2k or all')),
  cooldown: 3,
  async execute(interaction) {
    const g = interaction.guildId;
    eco.assertEnabled(g);
    const value = eco.withdraw(g, interaction.user.id, parseAmount(interaction.options.getString('amount', true)));
    await interaction.reply({ embeds: [embeds.success(`Withdrew **${eco.money(g, value)}** from your bank.`)] });
  },
};

const pay = {
  data: guildCommand('pay', 'Send coins from your wallet to another member')
    .addUserOption((o) => o.setName('user').setDescription('Who gets the coins').setRequired(true))
    .addIntegerOption((o) => o.setName('amount').setDescription('How many coins').setRequired(true).setMinValue(1).setMaxValue(1_000_000_000)),
  cooldown: 5,
  async execute(interaction) {
    const g = interaction.guildId;
    eco.assertEnabled(g);
    const user = interaction.options.getUser('user', true);
    if (user.bot) throw new UserError('You cannot pay a bot.');
    const amount = interaction.options.getInteger('amount', true);
    eco.transfer(g, interaction.user.id, user.id, amount);
    await interaction.reply({
      embeds: [embeds.success(`${interaction.user} paid **${eco.money(g, amount)}** to ${user}.`)],
      allowedMentions: { users: [user.id] },
    });
  },
};

module.exports = [balance, daily, weekly, work, beg, deposit, withdraw, pay];
