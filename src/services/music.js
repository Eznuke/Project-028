'use strict';

const { Readable } = require('node:stream');
const config = require('../config');
const logger = require('../utils/logger');
const { UserError } = require('../utils/errors');
const { assertPublicHttpUrl } = require('../utils/http');

/**
 * OPTIONAL music module (experimental, see README "Music").
 *
 * What it does:  plays DIRECT audio links (mp3 / ogg / aac / radio streams) and Discord audio attachments.
 * What it does NOT do: download or rip YouTube, Spotify or any other streaming platform (that would break
 * their terms of service). For those you would need an official/licensed solution.
 *
 * Requirements: MUSIC_ENABLED=true, `npm i @discordjs/voice opusscript` and `ffmpeg` installed on the host.
 */
const MAX_QUEUE = 25;
const IDLE_LEAVE_MS = 60_000;
const sessions = new Map(); // guildId -> session

let voice = null;
function loadVoice() {
  if (voice) return voice;
  try {
    voice = require('@discordjs/voice');
  } catch {
    throw new UserError('The music module is not installed. The bot owner must run `npm i @discordjs/voice opusscript` and install `ffmpeg` (see README → Music).');
  }
  return voice;
}

function assertEnabled() {
  if (!config.music.enabled) throw new UserError('Music is disabled on this bot. The owner can enable it with `MUSIC_ENABLED=true` (see README → Music).');
  loadVoice();
}

/** Opens an audio stream while validating every redirect hop against the SSRF guard. */
async function openAudioStream(rawUrl) {
  let url = (await assertPublicHttpUrl(rawUrl)).href;
  for (let hop = 0; hop < 4; hop++) {
    const res = await fetch(url, { redirect: 'manual', headers: { 'User-Agent': 'discord-multibot-music/1.0', 'Icy-MetaData': '0' }, signal: AbortSignal.timeout(15_000) });
    if ([301, 302, 303, 307, 308].includes(res.status)) {
      const next = res.headers.get('location');
      if (!next) throw new UserError('The link redirected nowhere.');
      url = (await assertPublicHttpUrl(new URL(next, url).href)).href;
      continue;
    }
    if (!res.ok || !res.body) throw new UserError(`The audio link answered with HTTP ${res.status}.`);
    const type = (res.headers.get('content-type') ?? '').toLowerCase();
    if (!(type.startsWith('audio/') || type.includes('ogg') || type.includes('mpegurl') || type.includes('octet-stream'))) {
      res.body.cancel().catch(() => {});
      throw new UserError('That link is not a direct audio file or stream. (YouTube/Spotify pages are not supported.)');
    }
    return Readable.fromWeb(res.body);
  }
  throw new UserError('The link redirected too many times.');
}

function destroy(guildId) {
  const s = sessions.get(guildId);
  if (!s) return;
  clearTimeout(s.idleTimer);
  try { s.player.stop(true); } catch { /* ignore */ }
  try { s.connection.destroy(); } catch { /* ignore */ }
  sessions.delete(guildId);
}

async function playNext(guildId) {
  const s = sessions.get(guildId);
  if (!s) return;
  clearTimeout(s.idleTimer);
  const track = s.queue.shift();
  if (!track) {
    s.current = null;
    s.idleTimer = setTimeout(() => destroy(guildId), IDLE_LEAVE_MS);
    s.idleTimer.unref?.();
    return;
  }
  const v = loadVoice();
  try {
    const stream = await openAudioStream(track.url);
    const resource = v.createAudioResource(stream, { inputType: v.StreamType.Arbitrary, inlineVolume: true });
    resource.volume?.setVolume(s.volume);
    s.current = { ...track, resource };
    s.player.play(resource);
  } catch (err) {
    logger.warn(`Music: could not play ${track.title}: ${err.message}`);
    s.current = null;
    await playNext(guildId);
  }
}

/** Joins the member's voice channel (if needed), queues the track and starts playing. */
async function enqueue(member, track) {
  assertEnabled();
  const v = loadVoice();
  const channel = member.voice?.channel;
  if (!channel) throw new UserError('Join a voice channel first.');
  const me = member.guild.members.me;
  const perms = channel.permissionsFor(me);
  if (!perms?.has(['ViewChannel', 'Connect', 'Speak'])) throw new UserError(`I need **Connect** and **Speak** in ${channel}.`);

  let s = sessions.get(member.guild.id);
  if (s && s.channelId !== channel.id) throw new UserError(`I am already playing in <#${s.channelId}>. Join that channel to add songs.`);
  if (s && s.queue.length >= MAX_QUEUE) throw new UserError(`The queue is full (${MAX_QUEUE}).`);

  if (!s) {
    const connection = v.joinVoiceChannel({ channelId: channel.id, guildId: member.guild.id, adapterCreator: member.guild.voiceAdapterCreator, selfDeaf: true });
    try {
      await v.entersState(connection, v.VoiceConnectionStatus.Ready, 20_000);
    } catch {
      connection.destroy();
      throw new UserError('I could not connect to the voice channel in time. Check my permissions and try again.');
    }
    const player = v.createAudioPlayer();
    connection.subscribe(player);
    s = { connection, player, queue: [], current: null, volume: 0.5, channelId: channel.id, idleTimer: null };
    sessions.set(member.guild.id, s);

    player.on(v.AudioPlayerStatus.Idle, () => { playNext(member.guild.id).catch((e) => logger.warn('Music next failed:', e.message)); });
    player.on('error', (err) => { logger.warn('Music player error:', err.message); });
    connection.on(v.VoiceConnectionStatus.Disconnected, async () => {
      try {
        await Promise.race([
          v.entersState(connection, v.VoiceConnectionStatus.Signalling, 5_000),
          v.entersState(connection, v.VoiceConnectionStatus.Connecting, 5_000),
        ]);
      } catch {
        destroy(member.guild.id);
      }
    });
  }

  s.queue.push(track);
  if (s.player.state.status === v.AudioPlayerStatus.Idle && !s.current) await playNext(member.guild.id);
  return s;
}

function getSession(guildId, member) {
  const s = sessions.get(guildId);
  if (!s) throw new UserError('Nothing is playing.');
  if (member && member.voice?.channelId !== s.channelId) throw new UserError('Join my voice channel to control the music.');
  return s;
}

const pause = (g, m) => { const s = getSession(g, m); s.player.pause(); };
const resume = (g, m) => { const s = getSession(g, m); s.player.unpause(); };
const skip = (g, m) => { const s = getSession(g, m); s.player.stop(true); };
const stop = (g, m) => { getSession(g, m); destroy(g); };
function setVolume(g, m, percent) {
  const s = getSession(g, m);
  s.volume = Math.max(0, Math.min(1, percent / 100));
  s.current?.resource?.volume?.setVolume(s.volume);
}
const snapshot = (g) => {
  const s = sessions.get(g);
  return s ? { current: s.current, queue: [...s.queue], volume: s.volume, channelId: s.channelId } : null;
};

function shutdownAll() {
  for (const id of [...sessions.keys()]) destroy(id);
}

module.exports = { assertEnabled, enqueue, pause, resume, skip, stop, setVolume, snapshot, shutdownAll, MAX_QUEUE };
