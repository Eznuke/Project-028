'use strict';

const crypto = require('node:crypto');
const { guildCommand } = require('../../utils/builders');
const embeds = require('../../utils/embeds');
const { UserError } = require('../../utils/errors');
const { pick, randomInt, fill, stripMentions, truncate, escapeMarkdown } = require('../../utils/text');
const data = require('./_data');

const hashNumber = (text, mod) => crypto.createHash('sha1').update(text).digest().readUInt32BE(0) % mod;

const eightball = {
  data: guildCommand('8ball', 'Ask the magic 8-ball a yes/no question')
    .addStringOption((o) => o.setName('question').setDescription('Your question').setRequired(true).setMaxLength(200)),
  cooldown: 3,
  async execute(interaction) {
    const question = stripMentions(interaction.options.getString('question', true));
    const [answer, tone] = pick(data.EIGHT_BALL);
    const color = tone === 'yes' ? embeds.COLORS.success : tone === 'no' ? embeds.COLORS.danger : embeds.COLORS.warning;
    await interaction.reply({
      embeds: [embeds.base('🎱 Magic 8-ball', `**Q:** ${escapeMarkdown(question)}\n**A:** ${answer}`, color)],
      allowedMentions: { parse: [] },
    });
  },
};

const choose = {
  data: guildCommand('choose', 'Let me pick one of your options')
    .addStringOption((o) => o.setName('options').setDescription('Options separated by | or , (e.g. pizza | burger | sushi)').setRequired(true).setMaxLength(400)),
  cooldown: 3,
  async execute(interaction) {
    const raw = interaction.options.getString('options', true);
    const options = [...new Set(raw.split(/[|,]/).map((s) => s.trim()).filter(Boolean))];
    if (options.length < 2) throw new UserError('Give me at least two different options separated by `|` or `,`.');
    if (options.length > 20) throw new UserError('That is too many options (max 20).');
    await interaction.reply({
      embeds: [embeds.base('🤔 I choose…', `**${escapeMarkdown(truncate(stripMentions(pick(options)), 200))}**`)],
      allowedMentions: { parse: [] },
    });
  },
};

const random = {
  data: guildCommand('random', 'Random numbers, members and colors')
    .addSubcommand((s) => s.setName('number').setDescription('A random whole number')
      .addIntegerOption((o) => o.setName('min').setDescription('Lowest (default 1)').setMinValue(-1_000_000_000).setMaxValue(1_000_000_000))
      .addIntegerOption((o) => o.setName('max').setDescription('Highest (default 100)').setMinValue(-1_000_000_000).setMaxValue(1_000_000_000)))
    .addSubcommand((s) => s.setName('member').setDescription('Pick a random member of this server'))
    .addSubcommand((s) => s.setName('color').setDescription('A random color')),
  cooldown: 3,
  async execute(interaction) {
    const sub = interaction.options.getSubcommand();
    if (sub === 'number') {
      const min = interaction.options.getInteger('min') ?? 1;
      const max = interaction.options.getInteger('max') ?? 100;
      if (min > max) throw new UserError('`min` must not be greater than `max`.');
      await interaction.reply({ embeds: [embeds.base('🎲 Random number', `**${randomInt(min, max)}** (between ${min} and ${max})`)] });
    } else if (sub === 'member') {
      const members = interaction.guild.members.cache.filter((m) => !m.user.bot);
      if (!members.size) throw new UserError('I do not have enough member data cached yet. Try again later.');
      const m = members.random();
      await interaction.reply({ embeds: [embeds.base('🎯 Random member', `${m}`)], allowedMentions: { parse: [] } });
    } else {
      const value = randomInt(0, 0xffffff);
      const hex = `#${value.toString(16).padStart(6, '0').toUpperCase()}`;
      await interaction.reply({ embeds: [embeds.base('🎨 Random color', `**${hex}**\nRGB: ${(value >> 16) & 255}, ${(value >> 8) & 255}, ${value & 255}`, value)] });
    }
  },
};

const joke = {
  data: guildCommand('joke', 'Tell a random joke'),
  cooldown: 3,
  async execute(interaction) { await interaction.reply({ embeds: [embeds.base('😂 Joke', pick(data.JOKES))] }); },
};

const fact = {
  data: guildCommand('fact', 'Share a random fun fact'),
  cooldown: 3,
  async execute(interaction) { await interaction.reply({ embeds: [embeds.base('🧠 Did you know?', pick(data.FACTS))] }); },
};

const quote = {
  data: guildCommand('quote', 'Show a random quote'),
  cooldown: 3,
  async execute(interaction) {
    const q = pick(data.QUOTES);
    await interaction.reply({ embeds: [embeds.base('💬 Quote', `“${q.text}”\n— *${q.by}*`)] });
  },
};

const ship = {
  data: guildCommand('ship', 'Check the (totally scientific) compatibility of two members')
    .addUserOption((o) => o.setName('user').setDescription('First person').setRequired(true))
    .addUserOption((o) => o.setName('other').setDescription('Second person (default: you)')),
  cooldown: 3,
  async execute(interaction) {
    const a = interaction.options.getUser('user', true);
    const b = interaction.options.getUser('other') ?? interaction.user;
    if (a.id === b.id) throw new UserError('Pick two different people.');
    const key = [a.id, b.id].sort().join(':');
    const percent = hashNumber(`ship:${key}`, 101);
    const filled = Math.round(percent / 10);
    const label = percent >= 85 ? 'Soulmates! 💞' : percent >= 60 ? 'Great match! 💖' : percent >= 40 ? 'Could work 🙂' : percent >= 20 ? 'Just friends 🤝' : 'Not a match 💔';
    const name = a.username.slice(0, Math.ceil(a.username.length / 2)) + b.username.slice(Math.floor(b.username.length / 2));
    await interaction.reply({
      embeds: [embeds.base(`💘 ${escapeMarkdown(name)}`, `${a} × ${b}\n\n\`${'█'.repeat(filled)}${'░'.repeat(10 - filled)}\` **${percent}%**\n${label}`, 0xff69b4)],
      allowedMentions: { parse: [] },
    });
  },
};

const rate = {
  data: guildCommand('rate', 'Rate anything out of 10')
    .addStringOption((o) => o.setName('thing').setDescription('What should I rate?').setRequired(true).setMaxLength(100)),
  cooldown: 3,
  async execute(interaction) {
    const thing = stripMentions(interaction.options.getString('thing', true).trim());
    const score = hashNumber(`rate:${thing.toLowerCase()}`, 11);
    await interaction.reply({
      embeds: [embeds.base('⭐ Rating', `I rate **${escapeMarkdown(thing)}** a **${score}/10**.\n${'⭐'.repeat(score)}${'▫️'.repeat(10 - score)}`)],
      allowedMentions: { parse: [] },
    });
  },
};

const compliment = {
  data: guildCommand('compliment', 'Give someone a compliment')
    .addUserOption((o) => o.setName('user').setDescription('Who deserves it?').setRequired(true)),
  cooldown: 5,
  async execute(interaction) {
    const user = interaction.options.getUser('user', true);
    await interaction.reply({ embeds: [embeds.base('💐 Compliment', fill(pick(data.COMPLIMENTS), { user: `${user}` }), 0xf1c40f)], allowedMentions: { parse: [] } });
  },
};

const roast = {
  data: guildCommand('roast', 'A friendly, light-hearted roast')
    .addUserOption((o) => o.setName('user').setDescription('Who to roast').setRequired(true)),
  cooldown: 5,
  async execute(interaction, client) {
    const user = interaction.options.getUser('user', true);
    const text = user.id === client.user.id
      ? 'Roast me? Bold. I run on a phone-sized budget and still beat you at uptime. 😎'
      : fill(pick(data.ROASTS), { user: `${user}` });
    await interaction.reply({ embeds: [embeds.base('🔥 Friendly roast', `${text}\n\n*All in good fun!*`, 0xe67e22)], allowedMentions: { parse: [] } });
  },
};

function socialCommand(name, description, lines, emoji, selfLine) {
  return {
    data: guildCommand(name, description)
      .addUserOption((o) => o.setName('user').setDescription('Who?').setRequired(true)),
    cooldown: 4,
    async execute(interaction) {
      const target = interaction.options.getUser('user', true);
      const text = target.id === interaction.user.id
        ? selfLine
        : fill(pick(lines), { a: `**${escapeMarkdown(interaction.user.username)}**`, b: `${target}` });
      await interaction.reply({ embeds: [embeds.base(`${emoji} ${name[0].toUpperCase()}${name.slice(1)}`, text, 0xff9ff3)], allowedMentions: { parse: [] } });
    },
  };
}

const hug = socialCommand('hug', 'Give someone a hug', data.HUGS, '🤗', 'You hug yourself. Self-care matters! 💞');
const highfive = socialCommand('highfive', 'High-five someone', data.HIGHFIVES, '🙌', 'You high-five yourself in the mirror. Nice one! ✋');
const pat = socialCommand('pat', 'Pat someone on the head', data.PATS, '🫶', 'You pat yourself on the back. Well done! 🐾');

module.exports = [eightball, choose, random, joke, fact, quote, ship, rate, compliment, roast, hug, highfive, pat];
