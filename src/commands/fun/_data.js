'use strict';

/** Static content for the fun commands. Files starting with "_" are not loaded as commands. */

const EIGHT_BALL = [
  ['It is certain.', 'yes'], ['Without a doubt.', 'yes'], ['Yes, definitely.', 'yes'], ['You may rely on it.', 'yes'],
  ['As I see it, yes.', 'yes'], ['Most likely.', 'yes'], ['Signs point to yes.', 'yes'], ['Yes.', 'yes'],
  ['Reply hazy, try again.', 'maybe'], ['Ask again later.', 'maybe'], ['Better not tell you now.', 'maybe'],
  ['Cannot predict now.', 'maybe'], ['Concentrate and ask again.', 'maybe'],
  ["Don't count on it.", 'no'], ['My reply is no.', 'no'], ['My sources say no.', 'no'],
  ['Outlook not so good.', 'no'], ['Very doubtful.', 'no'],
];

const JOKES = [
  'Why do programmers prefer dark mode? Because light attracts bugs.',
  'There are 10 kinds of people: those who understand binary and those who do not.',
  'Why did the developer go broke? He used up all his cache.',
  'A SQL query walks into a bar, walks up to two tables and asks: "Can I join you?"',
  'Why do Java developers wear glasses? Because they do not C#.',
  'I would tell you a UDP joke, but you might not get it.',
  'What is a computer\'s favorite snack? Microchips.',
  'Why was the JavaScript developer sad? Because he did not Node how to Express himself.',
  '!false — it is funny because it is true.',
  'How many programmers does it take to change a light bulb? None, that is a hardware problem.',
  'Why did the scarecrow win an award? He was outstanding in his field.',
  'I told my wife she was drawing her eyebrows too high. She looked surprised.',
  'What do you call fake spaghetti? An impasta.',
  'Why don\'t skeletons fight each other? They don\'t have the guts.',
  'What did the ocean say to the beach? Nothing, it just waved.',
  'Why can\'t you trust atoms? They make up everything.',
  'I used to hate facial hair, but then it grew on me.',
  'What do you call a bear with no teeth? A gummy bear.',
  'Why did the coffee file a police report? It got mugged.',
  'My phone battery lasts as long as my motivation on Monday.',
];

const FACTS = [
  'Honey never spoils. Edible honey has been found in ancient Egyptian tombs.',
  'Octopuses have three hearts and blue blood.',
  'A day on Venus is longer than a year on Venus.',
  'Bananas are berries, but strawberries are not.',
  'The Eiffel Tower can grow about 15 cm taller in summer because metal expands in heat.',
  'Sharks are older than trees: they have existed for over 400 million years.',
  'There are more possible chess games than atoms in the observable universe (by common estimates).',
  'Wombat droppings are cube-shaped.',
  'Light from the Sun takes about 8 minutes and 20 seconds to reach Earth.',
  'A group of flamingos is called a flamboyance.',
  'The first computer "bug" was a real moth found in a Harvard Mark II relay in 1947.',
  'Humans share about 60% of their DNA with bananas.',
  'Indonesia has more than 17,000 islands.',
  'Water can boil and freeze at the same time at the triple point.',
  'The shortest war in history lasted about 38 to 45 minutes (Anglo-Zanzibar War, 1896).',
  'Crows can recognise human faces and hold grudges.',
  'The unicode standard has more than 140,000 characters.',
  'A single bolt of lightning is about five times hotter than the surface of the Sun.',
  'Cows have best friends and get stressed when separated.',
  'The first 1 GB hard drive (1980) weighed over 200 kg.',
];

const QUOTES = [
  { text: 'The only thing we have to fear is fear itself.', by: 'Franklin D. Roosevelt' },
  { text: 'I have not failed. I\'ve just found 10,000 ways that won\'t work.', by: 'Thomas Edison (attributed)' },
  { text: 'Be yourself; everyone else is already taken.', by: 'Often attributed to Oscar Wilde' },
  { text: 'It always seems impossible until it\'s done.', by: 'Nelson Mandela (attributed)' },
  { text: 'Whether you think you can, or you think you can\'t — you\'re right.', by: 'Henry Ford (attributed)' },
  { text: 'The journey of a thousand miles begins with a single step.', by: 'Lao Tzu' },
  { text: 'Well done is better than well said.', by: 'Benjamin Franklin' },
  { text: 'Imagination is more important than knowledge.', by: 'Albert Einstein' },
  { text: 'What we think, we become.', by: 'Buddha (attributed)' },
  { text: 'Talk is cheap. Show me the code.', by: 'Linus Torvalds' },
  { text: 'Premature optimization is the root of all evil.', by: 'Donald Knuth' },
  { text: 'Simplicity is the ultimate sophistication.', by: 'Often attributed to Leonardo da Vinci' },
  { text: 'Fall seven times, stand up eight.', by: 'Japanese proverb' },
  { text: 'A smooth sea never made a skilled sailor.', by: 'Proverb' },
  { text: 'Dream big, start small, act now.', by: 'Proverb' },
];

const WOULD_YOU_RATHER = [
  ['Be able to fly', 'Be able to turn invisible'],
  ['Always be 10 minutes late', 'Always be 20 minutes early'],
  ['Have unlimited internet but no games', 'Have unlimited games but slow internet'],
  ['Live without music', 'Live without movies'],
  ['Be a famous streamer', 'Be a famous scientist'],
  ['Know how to speak every language', 'Know how to play every instrument'],
  ['Have a pause button for life', 'Have a rewind button for life'],
  ['Only eat sweet food forever', 'Only eat salty food forever'],
  ['Live in the mountains', 'Live by the sea'],
  ['Have a personal robot assistant', 'Have a personal flying car'],
  ['Never need to sleep', 'Never need to eat'],
  ['Be the smartest person alive', 'Be the funniest person alive'],
  ['Explore space', 'Explore the deep ocean'],
  ['Always have perfect battery life', 'Always have perfect Wi-Fi'],
  ['Time travel to the past', 'Time travel to the future'],
  ['Have a dragon as a pet', 'Have a dinosaur as a pet'],
  ['Code without bugs', 'Debug in five minutes'],
  ['Have 3 extra hours every day', 'Have 3 extra days every week'],
];

const COMPLIMENTS = [
  '{user}, you light up every chat you join.',
  '{user}, your kindness makes this server better.',
  '{user} has the energy of a perfectly timed "good morning".',
  '{user}, you are a legend and everyone knows it.',
  '{user}, your ideas are seriously creative.',
  '{user} makes hard things look easy.',
  '{user}, you are the reason this server is fun.',
  '{user}, you have excellent taste (you are in this server, after all).',
  '{user}, your patience with everyone is impressive.',
  '{user}, you are like a rare drop: valuable and exciting to see.',
];

// Light-hearted only: no appearance, family, background or identity jokes.
const ROASTS = [
  '{user} has the confidence of someone who never tests before pushing to main.',
  '{user} is the kind of person who says "brb" and returns three days later.',
  '{user}\'s Wi-Fi password is probably "password123", and the Wi-Fi still disconnects.',
  '{user} treats "just one more game" as a legally binding contract with no end date.',
  '{user} reads the manual only after something explodes.',
  '{user} opens 47 browser tabs and calls it "research".',
  '{user} has a to-do list longer than a loading screen at 1% battery.',
  '{user} saves files as "final_FINAL_v2_really_final".',
  '{user} types "lol" with a completely straight face.',
  '{user} would lose a staring contest with a loading bar.',
];

const HUGS = ['{a} gives {b} a big warm hug! 🤗', '{a} squeezes {b} in a cozy hug. 💞', '{a} runs over and hugs {b}! 🫂', '{a} wraps {b} in the comfiest hug ever. ☁️'];
const HIGHFIVES = ['{a} high-fives {b}! 🙌', '{a} and {b} share a perfect high five. ✋', '{a} slaps {b} a mighty high five! 💥', '{a} goes for a high five with {b}... and lands it! 🎯'];
const PATS = ['{a} gently pats {b} on the head. 🫶', '{a} gives {b} soft headpats. ✨', '{a} pats {b}. Good human! 🐾', '{a} pats {b} twice. Very nice. 👏'];

/** Trivia: c = index of the correct answer. */
const TRIVIA = [
  { cat: 'Science', q: 'Which planet is the largest in our solar system?', a: ['Saturn', 'Jupiter', 'Neptune', 'Earth'], c: 1 },
  { cat: 'Science', q: 'What is the chemical symbol for gold?', a: ['Ag', 'Gd', 'Au', 'Go'], c: 2 },
  { cat: 'Science', q: 'What is the hardest natural substance on Earth?', a: ['Quartz', 'Diamond', 'Steel', 'Granite'], c: 1 },
  { cat: 'Science', q: 'Which gas do plants absorb from the air for photosynthesis?', a: ['Oxygen', 'Nitrogen', 'Carbon dioxide', 'Helium'], c: 2 },
  { cat: 'Science', q: 'How many bones does an adult human body have?', a: ['196', '206', '216', '256'], c: 1 },
  { cat: 'Science', q: 'Which planet is known as the Red Planet?', a: ['Venus', 'Mars', 'Mercury', 'Jupiter'], c: 1 },
  { cat: 'Science', q: 'What is the largest mammal on Earth?', a: ['African elephant', 'Blue whale', 'Giraffe', 'Great white shark'], c: 1 },
  { cat: 'Science', q: 'At what temperature (°F) does water freeze at sea level?', a: ['0', '12', '32', '100'], c: 2 },
  { cat: 'Science', q: 'Which organ pumps blood through the human body?', a: ['Liver', 'Lungs', 'Heart', 'Kidney'], c: 2 },
  { cat: 'Science', q: 'Which is the closest star to Earth?', a: ['Proxima Centauri', 'Sirius', 'The Sun', 'Polaris'], c: 2 },
  { cat: 'Geography', q: 'What is the capital of Australia?', a: ['Sydney', 'Melbourne', 'Canberra', 'Perth'], c: 2 },
  { cat: 'Geography', q: 'Which ocean is the largest?', a: ['Atlantic', 'Indian', 'Arctic', 'Pacific'], c: 3 },
  { cat: 'Geography', q: 'Jakarta is the capital city of which country?', a: ['Malaysia', 'Indonesia', 'Philippines', 'Thailand'], c: 1 },
  { cat: 'Geography', q: 'What is the capital of Japan?', a: ['Osaka', 'Kyoto', 'Tokyo', 'Nagoya'], c: 2 },
  { cat: 'Geography', q: 'How many continents are there?', a: ['5', '6', '7', '8'], c: 2 },
  { cat: 'Geography', q: 'Which mountain has the highest peak above sea level?', a: ['K2', 'Mount Everest', 'Kilimanjaro', 'Mont Blanc'], c: 1 },
  { cat: 'History', q: 'In which year did World War II end?', a: ['1939', '1943', '1945', '1950'], c: 2 },
  { cat: 'History', q: 'Who wrote the play "Romeo and Juliet"?', a: ['Charles Dickens', 'William Shakespeare', 'Mark Twain', 'Jane Austen'], c: 1 },
  { cat: 'History', q: 'Who painted the Mona Lisa?', a: ['Michelangelo', 'Raphael', 'Leonardo da Vinci', 'Van Gogh'], c: 2 },
  { cat: 'History', q: 'In which year did Indonesia proclaim its independence?', a: ['1942', '1945', '1949', '1950'], c: 1 },
  { cat: 'Tech', q: 'What does HTML stand for?', a: ['HyperText Markup Language', 'High Tech Modern Language', 'Home Tool Markup Language', 'HyperTransfer Mail Link'], c: 0 },
  { cat: 'Tech', q: 'What does CPU stand for?', a: ['Central Processing Unit', 'Computer Personal Unit', 'Core Program Utility', 'Central Program Usage'], c: 0 },
  { cat: 'Tech', q: 'Which language runs natively in every web browser?', a: ['Python', 'Java', 'JavaScript', 'C++'], c: 2 },
  { cat: 'Tech', q: 'What is the binary number 1010 in decimal?', a: ['8', '10', '12', '14'], c: 1 },
  { cat: 'Tech', q: 'Which company created the Android operating system originally?', a: ['Android, Inc. (later bought by Google)', 'Microsoft', 'Apple', 'Nokia'], c: 0 },
  { cat: 'General', q: 'What is the smallest prime number?', a: ['0', '1', '2', '3'], c: 2 },
  { cat: 'General', q: 'What is the square root of 144?', a: ['10', '11', '12', '14'], c: 2 },
  { cat: 'General', q: 'How many sides does a hexagon have?', a: ['5', '6', '7', '8'], c: 1 },
  { cat: 'General', q: 'What is the currency of Japan?', a: ['Won', 'Yuan', 'Yen', 'Baht'], c: 2 },
  { cat: 'General', q: 'Approximately how fast does light travel in a vacuum?', a: ['300 km/s', '3,000 km/s', '300,000 km/s', '3,000,000 km/s'], c: 2 },
];

module.exports = { EIGHT_BALL, JOKES, FACTS, QUOTES, WOULD_YOU_RATHER, COMPLIMENTS, ROASTS, HUGS, HIGHFIVES, PATS, TRIVIA };
