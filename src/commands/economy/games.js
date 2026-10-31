'use strict';

const { guildCommand } = require('../../utils/builders');
const embeds = require('../../utils/embeds');
const eco = require('../../services/economy');
const { UserError } = require('../../utils/errors');
const { formatDuration } = require('../../utils/time');

const rob = {
  data: guildCommand('rob', 'Try to steal coins from another member\'s wallet (risky!)')
    .addUserOption((o) => o.setName('user').setDescription('Your target').setRequired(true)),
  cooldown: 5,
  async execute(interaction) {
    const g = interaction.guildId;
    eco.assertEnabled(g);
    const target = interaction.options.getUser('user', true);
    if (target.bot) throw new UserError('You cannot rob a bot.');
    const r = eco.rob(g, interaction.user.id, target.id);
    if (r.cooldown) throw new UserError(`The police are watching you. Try again in **${formatDuration(r.remainingMs, 2)}**.`);
    if (r.success) {
      await interaction.reply({
        embeds: [embeds.success(`You snuck up on ${target} and stole **${eco.money(g, r.amount)}**!`, 'Robbery successful')],
        allowedMentions: { parse: [] },
      });
    } else {
      await interaction.reply({
        embeds: [embeds.error(`You got caught trying to rob ${target} and paid a fine of **${eco.money(g, r.amount)}**.`, 'Robbery failed')],
        allowedMentions: { parse: [] },
      });
    }
  },
};

// Slot machine: weights and 3-of-a-kind multipliers give roughly an 89% return to player.
const REELS = [
  { s: '🍒', w: 30, x: 6 },
  { s: '🍋', w: 25, x: 8 },
  { s: '🍇', w: 20, x: 10 },
  { s: '🔔', w: 12, x: 15 },
  { s: '⭐', w: 7, x: 25 },
  { s: '💎', w: 4, x: 50 },
  { s: '7️⃣', w: 2, x: 150 },
];
const TOTAL_W = REELS.reduce((a, r) => a + r.w, 0);

function spinReel() {
  let n = Math.random() * TOTAL_W;
  for (const r of REELS) {
    n -= r.w;
    if (n < 0) return r;
  }
  return REELS[0];
}

const slots = {
  data: guildCommand('slots', 'Spin the slot machine with virtual coins')
    .addIntegerOption((o) => o.setName('bet').setDescription('Coins to bet').setRequired(true).setMinValue(1).setMaxValue(1_000_000_000)),
  cooldown: 4,
  async execute(interaction) {
    const g = interaction.guildId;
    eco.assertEnabled(g);
    const bet = eco.validateBet(g, interaction.user.id, interaction.options.getInteger('bet', true));
    const result = [spinReel(), spinReel(), spinReel()];
    const symbols = result.map((r) => r.s);

    let returned = 0;
    let verdict = 'No match. Better luck next time.';
    if (symbols[0] === symbols[1] && symbols[1] === symbols[2]) {
      returned = bet * result[0].x;
      verdict = `🎉 **JACKPOT!** Three of a kind pays **×${result[0].x}**.`;
    } else if (symbols[0] === symbols[1] || symbols[1] === symbols[2] || symbols[0] === symbols[2]) {
      returned = bet;
      verdict = 'Two of a kind: you get your bet back.';
    }
    const after = eco.settleBet(g, interaction.user.id, bet, returned, 'slots');
    const net = returned - bet;
    const e = (net > 0 ? embeds.success : net === 0 ? embeds.info : embeds.error)(
      `${verdict}\n\n**[ ${symbols.join(' | ')} ]**\n\n${net >= 0 ? 'Net' : 'Lost'}: **${eco.money(g, Math.abs(net))}** • Wallet: **${eco.money(g, after.wallet)}**`,
      '🎰 Slots',
    );
    await interaction.reply({ embeds: [e] });
  },
};

module.exports = [rob, slots];
