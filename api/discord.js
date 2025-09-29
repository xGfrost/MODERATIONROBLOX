// api/discord.js
import { InteractionType, InteractionResponseType, verifyKey } from 'discord-interactions';
import fetch from 'node-fetch';

const PUBLIC_KEY = process.env.DISCORD_PUBLIC_KEY;
const ROBLOX_UNIVERSE_ID = process.env.ROBLOX_UNIVERSE_ID;
const ROBLOX_API_KEY = process.env.ROBLOX_API_KEY;
const DS_NAME = process.env.DS_NAME || 'ModerationDatastore';
const TOPIC_NAME = process.env.TOPIC_NAME || 'moderation';

function jsonRes(res, status, body) {
  res.status(status).setHeader('Content-Type', 'application/json');
  res.send(JSON.stringify(body));
}

export default async function handler(req, res) {
  if (req.method !== 'POST') return res.status(405).send('Method Not Allowed');

  // read raw body (needed for verifyKey)
  const rawBody = await new Promise((resolve, reject) => {
    let data = '';
    req.on('data', chunk => data += chunk);
    req.on('end', () => resolve(data));
    req.on('error', err => reject(err));
  });

  const signature = req.headers['x-signature-ed25519'];
  const timestamp = req.headers['x-signature-timestamp'];

  // verify signature
  try {
    const valid = verifyKey(rawBody, signature, timestamp, PUBLIC_KEY);
    if (!valid) return res.status(401).send('Invalid request signature');
  } catch (err) {
    console.error('verifyKey err', err);
    return res.status(401).send('Invalid request signature');
  }

  let interaction;
  try {
    interaction = JSON.parse(rawBody);
  } catch (err) {
    console.error('Bad JSON body', err);
    return res.status(400).send('Bad request');
  }

  // handle PING
  if (interaction.type === InteractionType.PING) {
    return jsonRes(res, 200, { type: InteractionResponseType.PONG });
  }

  // handle commands
  if (interaction.type === InteractionType.APPLICATION_COMMAND) {
    const { name, options = [] } = interaction.data;
    const userId = options.find(o => o.name === 'userid')?.value;
    const reason = options.find(o => o.name === 'reason')?.value || '(no reason)';

    // basic validation
    if (!userId || !/^\d+$/.test(String(userId))) {
      return jsonRes(res, 200, { type: 4, data: { content: '❌ Invalid userid' } });
    }

    try {
      if (name === 'ban') {
        const result = await banUser(String(userId), String(reason));
        return jsonRes(res, 200, { type: 4, data: { content: `🚫 User ${userId} dibanned.\n${result}` } });
      }

      if (name === 'unban') {
        const result = await unbanUser(String(userId));
        return jsonRes(res, 200, { type: 4, data: { content: `✅ User ${userId} diunban.\n${result}` } });
      }

      if (name === 'kick') {
        const result = await kickUser(String(userId), String(reason));
        return jsonRes(res, 200, { type: 4, data: { content: `👢 User ${userId} di-kick.\n${result}` } });
      }

      if (name === 'check') {
        const status = await checkBanStatus(String(userId));
        return jsonRes(res, 200, { type: 4, data: { content: `🔍 Status User ${userId}: ${status}` } });
      }

      return jsonRes(res, 400, { error: 'Unknown command' });
    } catch (err) {
      console.error('command handler error', err);
      return jsonRes(res, 200, { type: 4, data: { content: `❌ Error: ${String(err).slice(0,300)}` } });
    }
  }

  return res.status(400).send('Bad request');
}


// ---------------- Roblox helpers ----------------
async function robloxPutEntry(key, valueObj) {
  const url = `https://apis.roblox.com/datastores/v1/universes/${ROBLOX_UNIVERSE_ID}/standard-datastores/${encodeURIComponent(DS_NAME)}/entries/${encodeURIComponent(key)}?scope=global`;

  const body = JSON.stringify({ value: valueObj });

  const resp = await fetch(url, {
    method: 'PUT',
    headers: {
      'x-api-key': ROBLOX_API_KEY,
      'Content-Type': 'application/json'
    },
    body
  });

  const text = await resp.text();
  let parsed = null;
  try { parsed = JSON.parse(text); } catch(_) { /* not JSON */ }

  return { status: resp.status, bodyText: text, body: parsed };
}

async function robloxGetEntry(key) {
  const url = `https://apis.roblox.com/datastores/v1/universes/${ROBLOX_UNIVERSE_ID}/standard-datastores/${encodeURIComponent(DS_NAME)}/entries/${encodeURIComponent(key)}?scope=global`;
  const resp = await fetch(url, {
    method: 'GET',
    headers: { 'x-api-key': ROBLOX_API_KEY }
  });
  const text = await resp.text();
  let parsed = null;
  try { parsed = JSON.parse(text); } catch(_) { /* ignore */ }
  return { status: resp.status, bodyText: text, body: parsed };
}

async function robloxPublishMessage(messageObj) {
  const url = `https://apis.roblox.com/messaging-service/v1/universes/${ROBLOX_UNIVERSE_ID}/topics/${encodeURIComponent(TOPIC_NAME)}`;
  const resp = await fetch(url, {
    method: 'POST',
    headers: {
      'x-api-key': ROBLOX_API_KEY,
      'Content-Type': 'application/json'
    },
    body: JSON.stringify({ message: JSON.stringify(messageObj) })
  });
  const text = await resp.text();
  let parsed = null;
  try { parsed = JSON.parse(text); } catch(_) {}
  return { status: resp.status, bodyText: text, body: parsed };
}

// ban
async function banUser(userId, reason) {
  const key = `ban_${userId}`;
  const value = { banned: true, reason, moderator: 'DiscordBot', ts: new Date().toISOString() };

  const put = await robloxPutEntry(key, value);
  const pub = await robloxPublishMessage({ type: 'BAN', userId, reason, moderator: 'DiscordBot', ts: new Date().toISOString() });

  return `DataStore: ${put.status} ${put.bodyText ? put.bodyText.slice(0,300) : ''}\nMessaging: ${pub.status} ${pub.bodyText ? pub.bodyText.slice(0,300) : ''}`;
}

// unban: set banned=false (or you can delete entry using admin key with delete permission)
async function unbanUser(userId) {
  const key = `ban_${userId}`;
  const value = { banned: false, reason: '', moderator: 'DiscordBot', ts: new Date().toISOString() };

  const put = await robloxPutEntry(key, value);
  const pub = await robloxPublishMessage({ type: 'UNBAN', userId, reason: '', moderator: 'DiscordBot', ts: new Date().toISOString() });

  return `DataStore: ${put.status} ${put.bodyText ? put.bodyText.slice(0,300) : ''}\nMessaging: ${pub.status} ${pub.bodyText ? pub.bodyText.slice(0,300) : ''}`;
}

// kick
async function kickUser(userId, reason) {
  const pub = await robloxPublishMessage({ type: 'KICK', userId, reason, moderator: 'DiscordBot', ts: new Date().toISOString() });
  return `Messaging: ${pub.status} ${pub.bodyText ? pub.bodyText.slice(0,300) : ''}`;
}

// check
async function checkBanStatus(userId) {
  const key = `ban_${userId}`;
  const got = await robloxGetEntry(key);
  if (got.status === 200 && got.body && got.body.value) {
    const v = got.body.value;
    if (v && v.banned) return `BANNED - Reason: ${v.reason || '(no reason)'} | By: ${v.moderator || 'Moderator'}`;
    return 'Not Banned';
  }
  if (got.status === 404) return 'Not Banned (404)';
  return `Error reading DataStore: ${got.status} ${got.bodyText ? got.bodyText.slice(0,300) : ''}`;
}
