'use strict';

const {
  ActionRowBuilder, ButtonBuilder, ButtonStyle, StringSelectMenuBuilder, ComponentType, MessageFlags,
} = require('discord.js');
const { guildCommand } = require('../../utils/builders');
const embeds = require('../../utils/embeds');
const eco = require('../../services/economy');
const { UserError } = require('../../utils/errors');
const { pick, randomInt, escapeMarkdown } = require('../../utils/text');
const data = require('./_data');

const shuffle = (arr) => {
  const a = [...arr];
  for (let i = a.length - 1; i > 0; i--) {
    const j = Math.floor(Math.random() * (i + 1));
    [a[i], a[j]] = [a[j], a[i]];
  }
  return a;
};

// ---------------------------------------------------------------- coinflip / dice

const coinflip = {
  data: guildCommand('coinflip', 'Flip a coin, optionally betting virtual coins')
    .addStringOption((o) => o.setName('side').setDescription('Your guess (needed when betting)').addChoices({ name: 'Heads', value: 'heads' }, { name: 'Tails', value: 'tails' }))
    .addIntegerOption((o) => o.setName('bet').setDescription('Virtual coins to bet').setMinValue(1).setMaxValue(1_000_000_000)),
  cooldown: 4,
  async execute(interaction) {
    const side = interaction.options.getString('side');
    const bet = interaction.options.getInteger('bet');
    const result = Math.random() < 0.5 ? 'heads' : 'tails';
    const icon = result === 'heads' ? '🪙' : '🌑';

    if (bet === null) {
      await interaction.reply({ embeds: [embeds.base('🪙 Coin flip', `${icon} It landed on **${result}**!${side ? `\nYour guess: ${side} — ${side === result ? '✅ correct' : '❌ wrong'}` : ''}`)] });
      return;
    }
    const g = interaction.guildId;
    eco.assertEnabled(g);
    if (!side) throw new UserError('Choose `side` (heads or tails) when you place a bet.');
    eco.validateBet(g, interaction.user.id, bet);
    const won = side === result;
    const after = eco.settleBet(g, interaction.user.id, bet, won ? bet * 2 : 0, 'coinflip');
    await interaction.reply({
      embeds: [(won ? embeds.success : embeds.error)(`${icon} It landed on **${result}**. You ${won ? `won **${eco.money(g, bet)}**` : `lost **${eco.money(g, bet)}**`}!\nWallet: **${eco.money(g, after.wallet)}**`, 'Coin flip')],
    });
  },
};

const dice = {
  data: guildCommand('dice', 'Roll dice, or duel the bot for virtual coins')
    .addIntegerOption((o) => o.setName('sides').setDescription('Sides per die (default 6)').setMinValue(2).setMaxValue(1000))
    .addIntegerOption((o) => o.setName('count').setDescription('How many dice (default 1, ignored when betting)').setMinValue(1).setMaxValue(10))
    .addIntegerOption((o) => o.setName('bet').setDescription('Duel the bot: higher roll wins double').setMinValue(1).setMaxValue(1_000_000_000)),
  cooldown: 4,
  async execute(interaction) {
    const sides = interaction.options.getInteger('sides') ?? 6;
    const bet = interaction.options.getInteger('bet');

    if (bet !== null) {
      const g = interaction.guildId;
      eco.assertEnabled(g);
      eco.validateBet(g, interaction.user.id, bet);
      const mine = randomInt(1, sides);
      const theirs = randomInt(1, sides);
      const returned = mine > theirs ? bet * 2 : mine === theirs ? bet : 0;
      const after = eco.settleBet(g, interaction.user.id, bet, returned, 'dice');
      const verdict = mine > theirs ? `You won **${eco.money(g, bet)}**!` : mine === theirs ? 'A tie: your bet is returned.' : `You lost **${eco.money(g, bet)}**.`;
      await interaction.reply({
        embeds: [(mine > theirs ? embeds.success : mine === theirs ? embeds.info : embeds.error)(`🎲 You rolled **${mine}**, I rolled **${theirs}** (d${sides}).\n${verdict}\nWallet: **${eco.money(g, after.wallet)}**`, 'Dice duel')],
      });
      return;
    }

    const count = interaction.options.getInteger('count') ?? 1;
    const rolls = Array.from({ length: count }, () => randomInt(1, sides));
    const total = rolls.reduce((a, b) => a + b, 0);
    await interaction.reply({ embeds: [embeds.base('🎲 Dice', `${count}d${sides}: ${rolls.join(', ')}${count > 1 ? `\n**Total: ${total}**` : ''}`)] });
  },
};

// ---------------------------------------------------------------- rock paper scissors

const MOVES = { rock: '🪨', paper: '📄', scissors: '✂️' };
const BEATS = { rock: 'scissors', paper: 'rock', scissors: 'paper' };
const duel = (a, b) => (a === b ? 0 : BEATS[a] === b ? 1 : -1);

const rps = {
  data: guildCommand('rps', 'Play rock-paper-scissors against me or another member')
    .addUserOption((o) => o.setName('opponent').setDescription('Challenge a member (default: me)')),
  cooldown: 5,
  async execute(interaction, client) {
    const opponent = interaction.options.getUser('opponent');
    if (opponent && (opponent.bot && opponent.id !== client.user.id)) throw new UserError('Bots cannot play (except me).');
    if (opponent?.id === interaction.user.id) throw new UserError('You cannot challenge yourself.');
    const versusUser = opponent && opponent.id !== client.user.id;

    const row = (disabled = false) => new ActionRowBuilder().addComponents(
      Object.entries(MOVES).map(([move, emoji]) =>
        new ButtonBuilder().setCustomId(`~rps:${interaction.id}:${move}`).setEmoji(emoji).setLabel(move).setStyle(ButtonStyle.Primary).setDisabled(disabled)),
    );

    const intro = versusUser
      ? `${interaction.user} challenged ${opponent}! Both of you: pick a move (your choice stays secret).`
      : `${interaction.user}, pick your move!`;
    await interaction.reply({ embeds: [embeds.base('✊ Rock Paper Scissors', intro)], components: [row()], allowedMentions: { users: opponent ? [opponent.id] : [] } });
    const message = await interaction.fetchReply();

    const players = new Set([interaction.user.id, ...(versusUser ? [opponent.id] : [])]);
    const choices = new Map();
    const collector = message.createMessageComponentCollector({
      componentType: ComponentType.Button,
      time: 60_000,
      filter: (i) => i.customId.startsWith(`~rps:${interaction.id}:`) && players.has(i.user.id),
    });

    collector.on('collect', async (i) => {
      const move = i.customId.split(':')[2];
      if (!MOVES[move]) return;
      if (!versusUser) {
        const botMove = pick(Object.keys(MOVES));
        const r = duel(move, botMove);
        const text = `You: ${MOVES[move]} **${move}**\nMe: ${MOVES[botMove]} **${botMove}**\n\n${r === 0 ? "It's a tie!" : r === 1 ? 'You win! 🎉' : 'I win! 😎'}`;
        await i.update({ embeds: [embeds.base('✊ Rock Paper Scissors', text, r === 1 ? embeds.COLORS.success : r === 0 ? embeds.COLORS.warning : embeds.COLORS.danger)], components: [row(true)] });
        collector.stop('done');
        return;
      }
      if (choices.has(i.user.id)) {
        await i.reply({ content: 'You already chose.', flags: MessageFlags.Ephemeral });
        return;
      }
      choices.set(i.user.id, move);
      await i.reply({ content: `You chose ${MOVES[move]} **${move}**. Waiting for the other player…`, flags: MessageFlags.Ephemeral });
      if (choices.size === 2) {
        const [aId, bId] = [interaction.user.id, opponent.id];
        const r = duel(choices.get(aId), choices.get(bId));
        const result = r === 0 ? "It's a tie!" : `<@${r === 1 ? aId : bId}> wins! 🎉`;
        await interaction.editReply({
          embeds: [embeds.base('✊ Rock Paper Scissors', `<@${aId}>: ${MOVES[choices.get(aId)]} **${choices.get(aId)}**\n<@${bId}>: ${MOVES[choices.get(bId)]} **${choices.get(bId)}**\n\n${result}`)],
          components: [row(true)],
        });
        collector.stop('done');
      }
    });

    collector.on('end', (_c, reason) => {
      if (reason !== 'done') {
        interaction.editReply({ embeds: [embeds.warning('Nobody finished the game in time.')], components: [row(true)] }).catch(() => {});
      }
    });
  },
};

// ---------------------------------------------------------------- would you rather

const wouldyourather = {
  data: guildCommand('wouldyourather', 'Start a would-you-rather vote'),
  cooldown: 10,
  async execute(interaction) {
    const [a, b] = pick(data.WOULD_YOU_RATHER);
    const votes = new Map(); // userId -> 'a' | 'b'
    const counts = () => [...votes.values()].reduce((acc, v) => { acc[v] += 1; return acc; }, { a: 0, b: 0 });
    const render = (closed = false) => {
      const c = counts();
      const total = c.a + c.b || 1;
      return embeds.base('🤷 Would you rather…', `🅰️ **${a}**\n${'█'.repeat(Math.round((c.a / total) * 10))} ${c.a} vote(s)\n\n🅱️ **${b}**\n${'█'.repeat(Math.round((c.b / total) * 10))} ${c.b} vote(s)${closed ? '\n\n*Voting closed.*' : ''}`);
    };
    const row = (disabled = false) => new ActionRowBuilder().addComponents(
      new ButtonBuilder().setCustomId(`~wyr:${interaction.id}:a`).setLabel('A').setStyle(ButtonStyle.Primary).setDisabled(disabled),
      new ButtonBuilder().setCustomId(`~wyr:${interaction.id}:b`).setLabel('B').setStyle(ButtonStyle.Danger).setDisabled(disabled),
    );
    await interaction.reply({ embeds: [render()], components: [row()] });
    const message = await interaction.fetchReply();
    const collector = message.createMessageComponentCollector({ componentType: ComponentType.Button, time: 120_000, filter: (i) => i.customId.startsWith(`~wyr:${interaction.id}:`) });
    collector.on('collect', async (i) => {
      votes.set(i.user.id, i.customId.endsWith(':a') ? 'a' : 'b');
      await i.update({ embeds: [render()], components: [row()] }).catch(() => {});
    });
    collector.on('end', () => { interaction.editReply({ embeds: [render(true)], components: [row(true)] }).catch(() => {}); });
  },
};

// ---------------------------------------------------------------- trivia (stateless buttons)

const answered = new Set(); // message ids already answered (blocks double rewards)
const lastReward = new Map(); // userId -> timestamp
const LETTERS = ['A', 'B', 'C', 'D'];

const trivia = {
  data: guildCommand('trivia', 'Answer a random trivia question')
    .addStringOption((o) => o.setName('category').setDescription('Pick a category (default: random)')
      .addChoices(...['Science', 'Geography', 'History', 'Tech', 'General'].map((c) => ({ name: c, value: c })))),
  cooldown: 8,
  async execute(interaction) {
    const category = interaction.options.getString('category');
    const pool = data.TRIVIA.map((q, index) => ({ q, index })).filter((x) => !category || x.q.cat === category);
    const { q, index } = pick(pool);
    const order = shuffle([0, 1, 2, 3]); // order[position] = original answer index
    const buttons = order.map((orig, pos) =>
      new ButtonBuilder().setCustomId(`trivia:${index}:${orig}:${interaction.user.id}`).setLabel(`${LETTERS[pos]}. ${q.a[orig]}`.slice(0, 80)).setStyle(ButtonStyle.Secondary));
    await interaction.reply({
      embeds: [embeds.base(`❓ Trivia — ${q.cat}`, `**${q.q}**\n\nOnly ${interaction.user} can answer.`)],
      components: [new ActionRowBuilder().addComponents(buttons)],
      allowedMentions: { parse: [] },
    });
  },

  components: {
    async trivia(interaction, args) {
      const [qIndex, picked, ownerId] = args;
      const q = data.TRIVIA[Number(qIndex)];
      if (!q) return interaction.reply({ content: 'That question is no longer available.', flags: MessageFlags.Ephemeral });
      if (interaction.user.id !== ownerId) return interaction.reply({ content: 'This question is for someone else. Use `/trivia` to get your own!', flags: MessageFlags.Ephemeral });
      if (answered.has(interaction.message.id)) return interaction.reply({ content: 'Already answered.', flags: MessageFlags.Ephemeral });
      answered.add(interaction.message.id);
      if (answered.size > 5000) answered.clear();

      const correct = Number(picked) === q.c;
      let bonus = '';
      if (correct && interaction.inGuild() && eco.cfg(interaction.guildId).enabled) {
        const now = Date.now();
        if (now - (lastReward.get(interaction.user.id) ?? 0) >= 60_000) {
          lastReward.set(interaction.user.id, now);
          eco.adjust(interaction.guildId, interaction.user.id, { wallet: 20 }, 'trivia');
          bonus = `\n+${eco.money(interaction.guildId, 20)} reward!`;
        }
      }
      const e = (correct ? embeds.success : embeds.error)(
        `${correct ? 'Correct!' : 'Wrong.'} The answer was **${q.a[q.c]}**.${bonus}`,
        `❓ ${q.q}`,
      );
      await interaction.update({ embeds: [e], components: [] });
      return undefined;
    },
  },
};

// ---------------------------------------------------------------- quiz (select menus)

const quiz = {
  data: guildCommand('quiz', 'A 5-question quiz answered with select menus'),
  cooldown: 30,
  async execute(interaction) {
    const questions = shuffle(data.TRIVIA).slice(0, 5);
    const menuId = `~quiz:${interaction.id}`;
    let score = 0;
    let feedback = '';

    const payload = (i) => {
      const q = questions[i];
      const order = shuffle([0, 1, 2, 3]);
      const menu = new StringSelectMenuBuilder().setCustomId(menuId).setPlaceholder('Choose your answer').addOptions(
        order.map((orig) => ({ label: q.a[orig].slice(0, 100), value: String(orig) })),
      );
      return {
        embeds: [embeds.base(`🧩 Quiz ${i + 1}/5 — ${q.cat}`, `**${q.q}**\n\n${feedback}`).setFooter({ text: `Score: ${score} • 20 seconds per question` })],
        components: [new ActionRowBuilder().addComponents(menu)],
      };
    };

    await interaction.reply(payload(0));
    const message = await interaction.fetchReply();

    for (let i = 0; i < questions.length; i++) {
      if (i > 0) await interaction.editReply(payload(i));
      const q = questions[i];
      try {
        const sel = await message.awaitMessageComponent({
          componentType: ComponentType.StringSelect,
          time: 20_000,
          filter: (c) => c.user.id === interaction.user.id && c.customId === menuId,
        });
        await sel.deferUpdate();
        if (Number(sel.values[0]) === q.c) { score++; feedback = `✅ Previous answer was correct.`; }
        else feedback = `❌ Previous answer was wrong (it was **${escapeMarkdown(q.a[q.c])}**).`;
      } catch {
        await interaction.editReply({ embeds: [embeds.warning(`Time is up! Final score: **${score}/5** (stopped at question ${i + 1}).`, '🧩 Quiz')], components: [] }).catch(() => {});
        return;
      }
    }
    const verdict = score === 5 ? 'Perfect! 🏆' : score >= 3 ? 'Nice work! 🎉' : 'Keep practising! 📚';
    await interaction.editReply({ embeds: [embeds.base('🧩 Quiz finished', `${feedback}\n\nFinal score: **${score}/5** — ${verdict}`, score >= 3 ? embeds.COLORS.success : embeds.COLORS.warning)], components: [] });
  },
};

module.exports = [coinflip, dice, rps, wouldyourather, trivia, quiz];
