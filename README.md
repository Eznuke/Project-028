# Discord Multibot

A modular, multifunction Discord bot: **discord.js v14**, **Node.js 22.13+**, **SQLite** (Node's built-in `node:sqlite`, so there is **no native module to compile**, which matters on Android/Termux).

100 commands that work as **slash commands and as chat commands** (`/ban` and `!ban`) · buttons, select menus and modals · persistent data · moderation, leveling, economy, tickets, suggestions, giveaways, join-to-create voice rooms, staff applications, logging, self-roles, optional AI chat and music.

> **Honest status.** The database layer, economy, leveling math, calculator, unit converter, time zones, URL safety checks, the chat-command argument parser and the chat-command adapter (tested with fake Discord objects) have automated tests that pass (`npm test`). The Discord-facing code (commands, buttons, modals, events) was written against the discord.js v14 API and checked for syntax, imports and slash-command schema rules, but **could not be run against the live Discord API** while it was written. Run `npm run check` after installing, then test in a private server first (section 7). Music and AI chat are optional and depend on external pieces; see their sections.

---

## 1. Project structure

```
discord-bot/
├─ package.json · .env.example · .gitignore · start.sh · README.md
├─ data/                      SQLite database lives here (created automatically)
├─ scripts/check.js           pre-flight check (npm run check)
├─ tests/                     automated tests (npm test)
└─ src/
   ├─ index.js                entry point: client, loaders, graceful shutdown
   ├─ deploy-commands.js      registers slash commands with Discord
   ├─ config/                 index.js (env vars) · defaults.js (per-server defaults)
   ├─ database/               index.js (node:sqlite wrapper) · migrations.js (versioned schema)
   ├─ commands/<category>/    one or more commands per file (general, moderation, leveling, economy,
   │                          fun, utility, tickets, suggestions, config, roles, music, ai, owner)
   ├─ events/                 interactionCreate, prefixCommands, messageEvents, logEvents, memberEvents, moderationEvents, ready
   ├─ services/               commandRunner (shared checks), prefix (chat-command lookup), settings, moderation, automod, antiraid, leveling, economy, tickets,
   │                          suggestions, polls, welcome, logging, audit, ai, music, userprefs, scheduler
   ├─ jobs/                   background jobs: reminders, polls, temp bans
   └─ utils/                  argparse + prefixInteraction (chat commands), loader, embeds, errors, confirm, pagination, permissions, ratelimit, text, time, zone,
                              calc (safe math), convert, http (SSRF guard), amount, logger
```

How it fits together:

* **Chat commands** reuse the slash-command code: `utils/argparse.js` reads the typed text using each command's own option list and `utils/prefixInteraction.js` wraps the message so `execute()` runs unchanged. See section 5.
* **Commands** export `{ data, execute, cooldown, userPermissions, botPermissions, autocomplete?, components? }`. Files can export one command or an array. Files starting with `_` are helpers and are not loaded.
* **Buttons / select menus / modals** use `customId = "prefix:arg:arg"`. The prefix is routed to the handler declared in the command's `components` object. IDs starting with `~` belong to temporary collectors (confirmations, pagination, games).
* **Settings** are stored per server as JSON in SQLite and merged over `src/config/defaults.js`, so new settings appear automatically for old servers.
* **Migrations** run at startup (`PRAGMA user_version`). Never edit a shipped migration; append a new one.

---

## 2. Installation (step by step)

### Requirements
* **Node.js 22.13 or newer** (`node -v`). Older versions lack `node:sqlite`.
* A Discord account and a server where you may add bots.

### Steps
```bash
git clone <your repo> discord-bot     # or copy the folder
cd discord-bot
npm install
cp .env.example .env                  # then edit .env (token, client id, owner id)
npm run check                         # validates every command schema + database
npm test                              # automated tests
npm run deploy:guild                  # registers commands in GUILD_ID (instant)  — or —
npm run deploy                        # registers globally (up to ~1 hour to appear)
npm start
```

### `.env` values
| Variable | Needed | Meaning |
|---|---|---|
| `DISCORD_TOKEN` | yes | Bot token (Developer Portal → Bot → Reset Token). Never share or commit it. |
| `CLIENT_ID` | yes | Application ID (General Information). |
| `OWNER_ID` | recommended | Your Discord user ID (comma-separate several). Enables `/owner`. |
| `GUILD_ID` | for testing | Test server ID for `npm run deploy:guild`. |
| `SUPPORT_SERVER_URL` | no | Link shown by `/support`. |
| `DB_PATH` | no | Default `data/bot.db`. |
| `DEFAULT_PREFIX` | no | Starting chat prefix, default `!` (each server can change it with `/config prefix`). Also used in DMs. |
| `AI_*` | no | See section 9. |
| `TRANSLATE_*`, `SHORTENER_URL_TEMPLATE` | no | See section 10. |
| `MUSIC_ENABLED` | no | See section 8. |

To copy IDs, enable **Developer Mode** in Discord (Settings → Advanced), then long-press a user/server → *Copy ID*.

---

## 3. Discord Developer Portal checklist

1. https://discord.com/developers/applications → **New Application**.
2. **Bot** tab → **Reset Token** → copy it into `.env` as `DISCORD_TOKEN`.
3. Same tab → **Privileged Gateway Intents** → enable:
   * **Server Members Intent** (welcome, autoroles, anti-raid, member logs)
   * **Message Content Intent** (leveling, AutoMod, AFK, AI chat)
   * *Presence Intent* is **not** needed.
4. **OAuth2 → URL Generator** (or use `/invite` once the bot runs):
   * **Scopes:** `bot` and `applications.commands`
   * **Bot permissions (minimum):** View Channels, Send Messages, Embed Links, Attach Files, Read Message History, Add Reactions, Manage Messages, Manage Channels, Manage Roles, Manage Nicknames, Kick Members, Ban Members, Moderate Members, **Move Members** (temporary voice rooms). For music add Connect and Speak.
   * The generated permission number in this project is `config.invitePermissions`.
5. Open the generated URL and add the bot to your server.
6. **Role order matters:** in *Server Settings → Roles* drag the bot's role **above** every role it must manage (autoroles, level roles, shop roles, self-roles, ticket support roles). The bot refuses to grant roles at or above its own highest role.

**Intents used in code:** Guilds, GuildMembers, GuildMessages, MessageContent, GuildModeration, GuildVoiceStates.

---

## 4. Running on Android

### Termux (recommended)
Install Termux from **F-Droid** (the Play Store build is outdated).
```bash
pkg update && pkg upgrade
pkg install nodejs git nano        # check: node -v  must be >= 22.13
termux-setup-storage               # optional, lets you reach phone files
git clone <your repo> discord-bot && cd discord-bot
npm install
cp .env.example .env && nano .env
npm run check && npm run deploy:guild
bash start.sh                      # auto-restart loop; Ctrl+C to stop
```
* If `pkg install nodejs` gives a version below 22.13, run `pkg upgrade` or install `nodejs-lts`/`nodejs` again; Termux usually ships a current Node.
* Keep the project in Termux's home (`~/discord-bot`), **not** in shared storage (`/sdcard`): SQLite's WAL files misbehave there.
* Edit files comfortably with `nano`, or use the **Acode** / **Termux:Widget**-friendly editors and point them at `~/discord-bot`.
* Stop Android from killing Termux: run `termux-wake-lock` (or tap *Acquire wakelock* in the Termux notification) and disable battery optimisation for Termux.

### Online IDE alternatives
Replit, Codespaces, Glitch or similar work if they offer **Node 22+**. Set the variables from `.env.example` in the platform's *Secrets* panel instead of a `.env` file.

### Hosting reality check (24/7)
* A phone running Termux works for testing and small servers, but Android may pause it, the connection drops when you leave Wi-Fi, and a full battery cycle is not a hosting plan.
* Free tiers of cloud platforms usually **sleep** or **limit** processes and often wipe the disk, which would delete the SQLite file. Check persistence before relying on one.
* Realistic always-on options: a small **VPS** (a few USD/month) with `pm2` or `systemd`, a Raspberry Pi at home, or a platform with a **persistent volume** for `data/`.
* Always back up `data/bot.db` (copy it while the bot is stopped, or use `sqlite3 data/bot.db ".backup backup.db"`).

Example `pm2` setup on a VPS:
```bash
npm i -g pm2
pm2 start "npm start" --name multibot
pm2 save && pm2 startup
```

---

## 5. Chat commands (prefix) and slash commands

Every command works **both ways**. Pick whichever you prefer, even per message:

| Way | Example |
|---|---|
| Slash | `/timeout user:@Asa duration:10m reason:spam` |
| Prefix | `!timeout @Asa 10m spam` |
| Mention | `@Bot timeout @Asa 10m spam` |
| Short name | `!bal`, `!lb`, `!inv`, `!calc 2+2`, `!mute @Asa 10m` (see `/help <command>` for aliases) |

**Rules for typing arguments**
1. Values go in the **same order as the slash options** (`!help ban` shows the exact order). `<name>` is required, `[name]` optional.
2. The last text option, or a text option like `reason`, `message`, `text`, takes the **rest of the line**: `!warn @Asa please stop spamming`.
3. Other text with spaces goes in **"double quotes"**: `!shop add "Golden Ticket" 500`.
4. Skip optional options by **naming** them: `!ban @Asa spam duration:7d`, `!shop add Sword 250 role:@Warrior`, `!reason 12 reason:"updated reason"`.
5. Sub-commands are plain words: `!shop view`, `!level role-add 10 @Veteran`, `!automod words add badword`, `!config prefix value:?`.
6. Users, roles and channels can be mentions, IDs or (exact) names. Yes/no options accept `yes/no/on/off/true/false`. Amounts like `2k` still work where the slash command allows them.
7. Mistakes get a short usage hint, not a stack trace, and **do not start the cooldown**.

**Setting the prefix** (needs Manage Server): `/config prefix value:?`, switch chat commands off with `/config prefix enabled:false`, allow or block `@Bot command` with `allow_mention`. Allowed: 1-5 characters, no spaces, none of `` ` @ # * _ ~ | \ / < > ``. If you forget it, mention the bot alone and it tells you.

**Everything is checked the same way as for slash commands**: permissions, role hierarchy, cooldowns, blacklist, maintenance mode, rate limits, confirmation prompts. Blacklisted users are ignored silently in chat. Unknown `!words` are ignored, so other bots' prefixes never trigger errors. Chat commands do not give XP and are not answered by AI chat.

**What chat cannot do (honest limits)**
* **No private replies.** Slash commands can answer "only you can see this"; a message cannot. Those answers are posted as a reply that **deletes itself after 2 minutes**, and commands whose private answer carries buttons refuse and ask you to use the slash command instead.
* **Slash only**: `/confession` (anonymous: a chat message would show who wrote it), `/embedbuilder` (needs a form), `/note` and `/todo` (private data). `/ticket`, `/suggestion` and similar still work, but any step that opens a form tells you to use the slash command.
* **No autocomplete** while typing in chat; use `!help` instead.
* Needs the **Message Content** intent (already on the checklist).

## 6. Command reference

"Perm" is the Discord permission needed (enforced by Discord **and** re-checked in code). Everyone = no special permission. Many commands also check **role hierarchy** (you and the bot must outrank the target).

### General
`/help [command|category]` (home page, category menu, how-to guide, per-command details with chat usage, aliases and permissions; `!help ban`, `!help economy`) · `/ping` · `/about` · `/botinfo` · `/uptime` · `/invite` · `/support` · `/userinfo [user]` · `/avatar` · `/banner` · `/serverinfo` · `/servericon` · `/membercount` · `/roleinfo` · `/channelinfo` · `/emojiinfo` · `/permissions [user] [channel]` · `/firstmessage [channel]` · `/memberjoined [user | position]` — Everyone.

### Moderation
| Command | Perm | Notes |
|---|---|---|
| `/kick` · `/ban` (optional temp duration) · `/unban` | Kick / Ban Members | Confirmation prompt, DM to the user (configurable), case created |
| `/timeout` · `/untimeout` · `/warn` · `/clearwarnings` | Moderate Members | Warn thresholds can auto-timeout/kick (`/config moderation`) |
| `/warnings [user]` | Everyone (own) / staff (others) | |
| `/modlogs` · `/case` · `/reason` | Moderate Members | Full case history and editable reasons |
| `/report` | Everyone | Sends a report to the moderation log channel |
| `/purge` | Manage Messages | Max 100, newer than 14 days, confirmation |
| `/slowmode` · `/lock` · `/unlock` · `/hide` · `/unhide` | Manage Channels | |
| `/nick` | Manage Nicknames | |
| `/roleadd` · `/roleremove` · `/massrole` | Manage Roles | `/massrole` has a member limit and confirmation |
| `/automod` | Manage Server | Sub-commands below |

**`/anti-spam`, `/anti-link`, `/anti-raid` are sub-commands of `/automod`** (`/automod spam`, `/automod links`, `/automod raid`, plus `invites`, `mentions`, `caps`, `words`, `ignore`, `status`, `toggle`, `punishment`). Discord allows at most **100** global slash commands and this bot uses all 100 (no free slot is left), so these three could not be separate top-level commands. New features since then (temporary voice rooms, staff applications) therefore live under `/config` instead of new commands. Blocked words, invite filter, mention limit and repeated-message detection are all in `/automod`.

### Welcome, goodbye, autorole — `/config welcome|goodbye|autorole` (Manage Server)
Placeholders: `{user}` `{username}` `{tag}` `{id}` `{server}` `{memberCount}`. Options include channel, embed on/off, title, message, hex color, optional large image (https), avatar thumbnail, welcome DM, and `test:true` for a preview. Join/leave events are also written to the members log.

### Leveling
`/rank [user]` · `/leaderboard [type: xp|economy]` · `/level view|roles` — Everyone. `/level role-add|role-remove|set-xp|reset` — Manage Server. XP per message with cooldown, minimum length, duplicate/emoji-only detection and an hourly cap against farming. Configure with `/config leveling`.

### Economy (virtual currency only)
`/balance [history]` · `/daily` (streak bonus) · `/weekly` · `/work` · `/beg` · `/deposit` · `/withdraw` · `/pay` · `/shop view|add|remove` (add/remove: Manage Server) · `/buy` · `/sell` · `/inventory` · `/rob` · `/slots` · `/coinflip [bet]` · `/dice [bet]` · `/leaderboard type:economy`. Configure with `/config economy`. Shop items can grant roles (never roles with admin/moderation permissions).

### Fun and social
`/8ball` `/choose` `/random number|member|color` `/joke` `/fact` `/quote` `/ship` `/rate` `/compliment` `/roast` `/hug` `/highfive` `/pat` `/coinflip` `/dice` `/rps [opponent]` `/wouldyourather` `/trivia` `/quiz` · `/poll create|end` (persistent votes, optional auto-close) · `/suggestion` · `/confession`.
Jokes, facts, quotes and trivia are built in (no external API). Roasts are deliberately mild. `/confession` posts anonymously, but the author ID is stored in the database for the **bot host's** abuse handling; staff cannot see it through the bot.

### Utility
`/remindme set|list|delete` (persistent) · `/timer` · `/countdown` · `/timezone set|view|reset` · `/calculator` (safe parser, no `eval`) · `/convert` (offline units) · `/translate` · `/shorten` · `/embedbuilder` (Manage Messages; modal editor + channel picker) · `/afk` · `/note` · `/todo`.

### Tickets — `/ticket setup|panel|close|reopen|add|remove|claim`
Setup and panel need Manage Server; claim/add/remove/reopen need a configured support role (or Manage Channels). Private channels with explicit permission overwrites, categories (select menu), duplicate prevention, claim/release, text **transcripts** posted to the transcript/log channel, reopen and delete buttons. `/config tickets` accepts the same options as `/ticket setup`.

### Giveaways — `/giveaway start|end|cancel|reroll|list` (Manage Server)
`/giveaway start prize:"Nitro" duration:2d winners:2 required_role:@Member min_level:5` posts an embed with an **Enter** button (press again to leave). Optional requirements: a role and/or a chat level (checked on entering **and** again when the winners are drawn, so someone who left the server or lost the role cannot win). Winners are drawn with a cryptographic random generator when the time is up, also if the bot was offline at that moment (it catches up within 15 seconds of starting). `end` finishes early, `cancel` ends without winners, `reroll` picks new winners and never repeats a previous one. Up to 10 running giveaways per server, 1 minute to 30 days. Entries and winners are stored in the database, so a restart loses nothing. In chat: `!giveaway start "Nitro" 2d 2`.

### Temporary voice rooms — `/config tempvoice` (Manage Server)
Join-to-create: `/config tempvoice enabled:true lobby:#Create-a-room category:Voice name_template:"{user}'s room" default_limit:0 max_rooms:30`. When a member joins the lobby, I create a voice channel in the category, move them into it and post a **control panel** in the room's text chat: lock/unlock, hide/show, rename, user limit, kick-and-block, transfer owner, claim (if the owner left). Only the room owner can use it; the owner never gets Manage Channels, so they cannot delete or change anything outside their room. The room is deleted as soon as only bots (or nobody) remain, and a minute-by-minute cleanup also removes rooms left behind by a crash. Needs **Manage Channels**, **Move Members**, View Channel and Connect for the bot in that category; `/config tempvoice` tells you what is missing. Discord allows only 2 renames per 10 minutes per channel, so renaming has a 5-minute wait.

### Staff applications — `/config applications` (Manage Server)
1. `/config applications review_channel:#staff-review title:"Moderator application" question1:"Why do you want to join?" question2:"Your age and timezone?" staff_role:@Admins enabled:true` (up to 5 questions; `question2:none` removes one).
2. Optional: `accept_role:@Trial-Mod` (given automatically on accept, never roles with moderation/admin permissions or above my highest role), `cooldown_hours:48` (wait after a rejection), `dm_applicant:true`.
3. `post_panel:#apply-here` posts the **Apply** button. Members fill a form; the answers appear in the review channel with **Accept** / **Reject** buttons (reviewers: the listed roles and admins; a short note to the applicant is optional). One pending application per person, the first reviewer to decide wins, the applicant gets a DM (or the reviewer is told if DMs are closed). Everything is logged in the audit log.

### Suggestions — `/suggestion submit|panel|history`
Panel button → modal → posted with 👍/👎 voting buttons (changeable votes) and Approve/Reject/Implemented buttons for staff (modal asks for a note). Every status change is stored in an audit history (`/suggestion history`). Configure with `/config suggestions`.

### Logging — `/config logs`
Categories: messages (edit/delete/bulk), members (join/leave), roles (role and nickname changes), channels (create/delete), voice, moderation, tickets. Message text is truncated, attachments are listed by name only, bot messages are ignored, and individual channels can be excluded.

### Server configuration — `/config` (Manage Server)
`welcome` `goodbye` `logs` `moderation` `leveling` `economy` `tickets` `suggestions` `autorole` `confessions` `prefix` (chat prefix) `appearance` (accent color) `tempvoice` `applications` `ai` `timezone` `view` `reset` and `panel` (interactive menu with toggle buttons).

### Roles — `/rolepanel create|verify|list|delete` (Manage Roles)
Self-role panels with **buttons** or a **select menu**, optional "exclusive" mode, a verification button that grants a role, and **hierarchy checks both when creating and when clicking**: the bot never assigns a role at or above its own, managed roles, or roles with admin/moderation permissions.

### Music — `/music play|pause|resume|skip|stop|queue|volume` (optional, section 8)
### AI — `/ai ask|reset|status` (optional, section 9)
### Owner — `/owner stats|reload|maintenance|blacklist|unblacklist` (only `OWNER_ID`, hidden from non-admins, confirmation prompts)

---

## 7. Testing checklist (do this before inviting people)

1. `npm run check` → must print `All checks passed`.
2. `npm test` → all tests pass.
3. In a **private test server** (with `GUILD_ID` set and `npm run deploy:guild`):
   * `/ping`, `/help`, `/botinfo`, then the same in chat: `!ping`, `!help moderation`, `!bal`, `@Bot help`
   * `/config prefix value:?` then `?ping` works and `!ping` no longer does (change it back afterwards)
   * `/config panel`, then `/config logs category:all channel:#logs`
   * `/config welcome channel:#welcome enabled:true test:true`
   * Moderation on a spare account: `/warn`, `/timeout`, `/case`, `/ban` (confirm prompt)
   * `/ticket setup …`, `/ticket panel`, open → claim → close → check the transcript
   * `/rolepanel create`, click the buttons with a spare account (move the bot role above the target roles first)
   * `/daily`, `/slots`, `/shop add`, `/buy`
   * `/giveaway start prize:test duration:1m`, press Enter with a spare account, wait a minute, then `/giveaway reroll`
   * `/config tempvoice enabled:true lobby:…`, join the lobby with a spare account, try Lock / Rename / Limit, leave and check the room disappears
   * `/config applications …` + `post_panel`, apply with a spare account, accept it and check the role and DM
   * `/remindme set in:1m message:test` then wait, then restart the bot with a pending reminder
4. When satisfied: `npm run deploy` for global commands.

---

## 8. Music (optional, experimental)

**Investigation result.** Discord now requires **end-to-end encrypted voice (DAVE)** for bots. `@discordjs/voice` supports it through `@snazzah/davey`, which it installs itself; that is a prebuilt native binary which may not exist for every platform (Android/Termux in particular is unverified). Playing from YouTube/Spotify by scraping or ripping violates those platforms' terms and is **deliberately not implemented**. Legal options are: direct audio files/streams you have the rights to (implemented here), an official platform SDK, or a self-hosted Lavalink with properly licensed sources.

**What is implemented:** `/music play` for **direct audio URLs** (mp3/ogg/aac, Icecast/radio streams) and uploaded audio attachments, with queue, pause/resume, skip, stop, volume, auto-leave after 60 s idle. URLs must be public `http(s)` (private/loopback addresses and redirects to them are blocked).

**To enable:**
```bash
npm install @discordjs/voice opusscript     # (add sodium-native only if your Node lacks aes-256-gcm)
# install ffmpeg:  Termux: pkg install ffmpeg   Debian/Ubuntu: sudo apt install ffmpeg
echo "MUSIC_ENABLED=true" >> .env
```
Without these the commands answer with a clear explanation instead of failing. **This module was not run against a live voice connection during development**: treat it as experimental and test it first; on a phone it may not work.

---

## 9. AI chat (optional)

Works with any **OpenAI-compatible chat-completions API** (Groq, OpenAI, OpenRouter, a local server...).
```env
AI_ENABLED=true
AI_API_URL=https://api.groq.com/openai/v1/chat/completions
AI_API_KEY=your-key
AI_MODEL=llama-3.3-70b-versatile
```
Then an admin runs `/config ai enabled:true` and optionally `channel_add:#ai-chat` (the bot answers every message there; elsewhere it answers when mentioned or via `/ai ask`). Per-user cooldown (`AI_COOLDOWN_SECONDS`) and hourly limit (`AI_HOURLY_LIMIT`), input length cap, 30 s timeout, friendly errors for bad key / rate limit / outage, mentions neutralised in answers. Conversation memory is RAM-only (last few turns). With `AI_ENABLED=false` (default) or no key, everything else runs normally. Messages are sent to the provider you configure; tell your members.

---

## 10. Translate and shorten

* `/translate`: default provider **MyMemory** (free, no key, small daily quota). For LibreTranslate set `TRANSLATE_PROVIDER=libretranslate`, `TRANSLATE_API_URL=https://your-instance`, optional `TRANSLATE_API_KEY`.
* `/shorten`: disabled unless `SHORTENER_URL_TEMPLATE` is set (an `{url}` placeholder, response must be the short URL as plain text). The default in `.env.example` uses is.gd; remove the line to disable.

---

## 11. Security and reliability notes

* Secrets only in environment variables; the logger redacts the token and API keys; users never see stack traces (they get a short reference code that matches the log line).
* Permissions are validated **server-side in code** in addition to Discord's command visibility; destructive actions ask for confirmation; role hierarchy is checked for every moderation and role action.
* Global rate limit per user (`GLOBAL_RATE_MAX` per 10 s), per-command cooldowns, blacklist and maintenance mode. discord.js queues requests to respect Discord's rate limits.
* No `eval`, no shell execution of user input. The calculator is a hand-written parser. Outgoing requests triggered by users (shorten, music) go through an SSRF guard.
* Event listeners are registered once; the process shuts down gracefully on SIGINT/SIGTERM (stops jobs and music, closes Discord and the database).
* Data stored: settings, moderation cases/warnings, XP, economy, tickets (with channel IDs, not message contents; transcripts are posted to your log channel, not stored), suggestions, reminders, notes/todos, confession text and author ID. Message content in logs is truncated and not stored in the database.

---

## 12. Troubleshooting

| Symptom | Fix |
|---|---|
| `Used disallowed intents` on login | Enable **Server Members** and **Message Content** intents (section 3). |
| `An invalid token was provided` | Wrong/old `DISCORD_TOKEN`; reset it in the portal, no quotes or spaces in `.env`. |
| Slash commands do not appear | Run `npm run deploy:guild` (instant) or `npm run deploy` (≤1 h). Re-invite with the `applications.commands` scope. Restart Discord. |
| `Missing Access` / `Missing Permissions` / "role higher than me" | Give the bot the permission and move its role above the target roles. |
| `Cannot find module 'node:sqlite'` or `Node.js 22.13 or newer is required` | Upgrade Node (`pkg upgrade nodejs` in Termux). |
| `npm run check` fails | The message names the command/option; fix it, rerun. |
| Bot goes offline on the phone | `termux-wake-lock`, disable battery optimisation, keep Termux in the foreground, or move to a VPS. |
| Welcome/logs not posting | The bot needs View Channel, Send Messages and Embed Links in that channel; check `/config view`. |
| Level roles/autoroles not given | Bot role too low, or the role has admin/moderation permissions (refused on purpose). |
| `/translate` says service problem | MyMemory daily quota; try later or use LibreTranslate. |
| `database is locked` | Only one bot process may use `data/bot.db`; stop duplicates. |
| Music: "module is not installed" | Section 8. |
| AI: "enabled but no API key" | Set `AI_API_KEY` and restart. |
| `!command` does nothing | Check Message Content intent (section 3); `/config view section:prefix` (is it on? which prefix?); the bot needs View Channel + Send Messages there. Unknown words are ignored on purpose. Try `@Bot help`. |
| `!command` says "slash command only" / "controls must stay private" | By design (section 5): use the `/` version. |
| Forgot the prefix | Mention the bot alone, or use `/config view section:prefix`. |

---

## 13. Updating and backups
* `git pull && npm install && npm run check`, then restart. New migrations apply automatically.
* If you change a command's name/options, run `npm run deploy` again. `/owner reload` only reloads code, not Discord's command definitions.
* Remove all slash commands: `npm run undeploy` (add `-- --guild` for the test server).

License: MIT.
