// api/discord.js
import { InteractionType, InteractionResponseType, verifyKey } from 'discord-interactions';
import fetch from 'node-fetch';

const PUBLIC_KEY = process.env.DISCORD_PUBLIC_KEY;

const ROBLOX_UNIVERSE_ID = process.env.ROBLOX_UNIVERSE_ID;
const ROBLOX_API_KEY     = process.env.ROBLOX_API_KEY;

const BANS_DS       = process.env.BANS_DS       || 'BANS_V1';
const BANS_INDEX_DS = process.env.BANS_INDEX_DS || 'BANS_INDEX_V1';
const NAME_INDEX_DS = process.env.NAME_INDEX_DS || '';        // optional
const TOPIC_NAME    = process.env.TOPIC_NAME    || 'moderation';

function j(res, status, body) {
  res.status(status).setHeader('content-type', 'application/json');
  res.send(JSON.stringify(body));
}

export default async function handler(req, res) {
  // Health check
  if (req.method === 'GET') return j(res, 200, { ok: true, route: 'discord' });
  if (req.method !== 'POST') return res.status(405).send('Method Not Allowed');

  // read raw body for signature verification
  const raw = await new Promise((resolve, reject) => {
    let d = ''; req.on('data', c => d += c);
    req.on('end', () => resolve(d)); req.on('error', reject);
  });

  const sig = req.headers['x-signature-ed25519'];
  const ts  = req.headers['x-signature-timestamp'];
  try {
    if (!verifyKey(raw, sig, ts, PUBLIC_KEY)) return res.status(401).send('Invalid request signature');
  } catch { return res.status(401).send('Invalid request signature'); }

  const i = JSON.parse(raw);

  if (i.type === InteractionType.PING) {
    return j(res, 200, { type: InteractionResponseType.PONG });
  }

  if (i.type === InteractionType.APPLICATION_COMMAND) {
    const { name, options = [] } = i.data;
    const userId = String(options.find(o => o.name === 'userid')?.value || '');
    const reason = String(options.find(o => o.name === 'reason')?.value || '(no reason)');
    if (!/^\d+$/.test(userId)) return j(res, 200, { type: 4, data: { content: '❌ Invalid userid' } });

    const byName = i.member?.user?.username ? `${i.member.user.username}#${i.member.user.discriminator ?? ''}`.replace(/#$/, '') : 'DiscordBot';
    try {
      if (name === 'ban') {
        const out = await banUser(userId, reason, byName);
        return j(res, 200, { type: 4, data: { content: `🚫 User ${userId} dibanned.\n${out}` } });
      }
      if (name === 'unban') {
        const out = await unbanUser(userId, byName);
        return j(res, 200, { type: 4, data: { content: `✅ User ${userId} diunban.\n${out}` } });
      }
      if (name === 'kick') {
        const out = await kickUser(userId, reason, byName);
        return j(res, 200, { type: 4, data: { content: `👢 User ${userId} di-kick.\n${out}` } });
      }
      if (name === 'check') {
        const st = await checkBanStatus(userId);
        return j(res, 200, { type: 4, data: { content: `🔍 Status User ${userId}: ${st}` } });
      }
      return j(res, 400, { error: 'Unknown command' });
    } catch (e) {
      return j(res, 200, { type: 4, data: { content: `❌ Error: ${String(e).slice(0, 300)}` } });
    }
  }

  res.status(400).send('Bad request');
}

/* -------- Roblox helpers (BANS_V1 schema) -------- */

const baseDS = (ds) =>
  `https://apis.roblox.com/datastores/v1/universes/${ROBLOX_UNIVERSE_ID}/standard-datastores/${encodeURIComponent(ds)}/entries`;

async function putEntry(ds, key, valueObj) {
  const url = `${baseDS(ds)}/${encodeURIComponent(key)}?scope=global`;
  const resp = await fetch(url, {
    method: 'PUT',
    headers: { 'x-api-key': ROBLOX_API_KEY, 'content-type': 'application/json' },
    body: JSON.stringify({ value: valueObj })
  });
  const text = await resp.text();
  return { status: resp.status, text };
}

async function getEntry(ds, key) {
  const url = `${baseDS(ds)}/${encodeURIComponent(key)}?scope=global`;
  const resp = await fetch(url, { headers: { 'x-api-key': ROBLOX_API_KEY } });
  const text = await resp.text();
  let json = null; try { json = JSON.parse(text); } catch {}
  return { status: resp.status, text, json };
}

/* update one-big "INDEX" map: { [useridStr]=true } */
async function addToIndex(userId) {
  const got = await getEntry(BANS_INDEX_DS, 'INDEX');
  let map = {};
  if (got.status === 200 && got.json && got.json.value) map = got.json.value;
  map[String(userId)] = true;
  return putEntry(BANS_INDEX_DS, 'INDEX', map);
}

async function removeFromIndex(userId) {
  const got = await getEntry(BANS_INDEX_DS, 'INDEX');
  let map = {};
  if (got.status === 200 && got.json && got.json.value) map = got.json.value;
  delete map[String(userId)];
  return putEntry(BANS_INDEX_DS, 'INDEX', map);
}

/* optional name index */
async function updateNameIndex(userId, byName) {
  if (!NAME_INDEX_DS) return { status: 204, text: 'skip name index' };
  const lower = (byName || 'discord').toLowerCase();
  const r1 = await putEntry(NAME_INDEX_DS, `name:${lower}`, { userId: Number(userId) });
  const r2 = await putEntry(NAME_INDEX_DS, `user:${userId}`, { latestName: byName });
  return { status: Math.max(r1.status, r2.status), text: `${r1.status}/${r2.status}` };
}

async function publishMessage(payload) {
  const url = `https://apis.roblox.com/messaging-service/v1/universes/${ROBLOX_UNIVERSE_ID}/topics/${encodeURIComponent(TOPIC_NAME)}`;
  const resp = await fetch(url, {
    method: 'POST',
    headers: { 'x-api-key': ROBLOX_API_KEY, 'content-type': 'application/json' },
    body: JSON.stringify({ message: JSON.stringify(payload) })
  });
  const text = await resp.text();
  return { status: resp.status, text };
}

/* -------- Commands (BANS_V1) -------- */

async function banUser(userId, reason, byName) {
  const now = Math.floor(Date.now()/1000);
  const value = { Active: true, Reason: reason, By: userId, ByName: byName, Time: now };

  const p1 = await putEntry(BANS_DS, userId, value);        // key = "<userId>"
  const p2 = await addToIndex(userId);                      // update "INDEX" map
  const p3 = await updateNameIndex(userId, byName);         // optional
  const p4 = await publishMessage({ type: 'BAN', userId, reason, moderator: byName, ts: new Date().toISOString() });

  return `BANS_V1: ${p1.status}\nINDEX: ${p2.status}\nNAME_IDX: ${p3.status}\nMessaging: ${p4.status}`;
}

async function unbanUser(userId, byName) {
  const now = Math.floor(Date.now()/1000);
  const value = { Active: false, Reason: '', By: userId, ByName: byName, Time: now };

  const p1 = await putEntry(BANS_DS, userId, value);
  const p2 = await removeFromIndex(userId);
  const p4 = await publishMessage({ type: 'UNBAN', userId, reason: '', moderator: byName, ts: new Date().toISOString() });

  return `BANS_V1: ${p1.status}\nINDEX: ${p2.status}\nMessaging: ${p4.status}`;
}

async function kickUser(userId, reason, byName) {
  const p = await publishMessage({ type: 'KICK', userId, reason, moderator: byName, ts: new Date().toISOString() });
  return `Messaging: ${p.status}`;
}

async function checkBanStatus(userId) {
  const got = await getEntry(BANS_DS, userId);
  if (got.status === 404) return 'Not Banned (404)';
  if (got.status !== 200) return `Error DS ${got.status}: ${got.text.slice(0,200)}`;

  const v = got.json?.value;
  if (v && (v.Active === true || v.Active === 'true')) {
    return `BANNED - Reason: ${v.Reason || '(no reason)'} | By: ${v.ByName || v.By || 'Moderator'} | At: ${v.Time || ''}`;
  }
  return 'Not Banned';
}
