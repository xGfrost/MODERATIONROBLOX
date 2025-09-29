// ---- Roblox helpers (legacy schema used by your BANS_V1) ----
const DS_NAME = process.env.DS_NAME || 'BANS_V1';
const TOPIC_NAME = process.env.TOPIC_NAME || 'moderation';

async function robloxPutEntry(key, valueObj) {
  const url = `https://apis.roblox.com/datastores/v1/universes/${process.env.ROBLOX_UNIVERSE_ID}/standard-datastores/${encodeURIComponent(DS_NAME)}/entries/${encodeURIComponent(key)}?scope=global`;
  const resp = await fetch(url, {
    method: 'PUT',
    headers: {
      'x-api-key': process.env.ROBLOX_API_KEY,
      'Content-Type': 'application/json'
    },
    // Open Cloud expects { "value": <any> }
    body: JSON.stringify({ value: valueObj }),
  });
  return { status: resp.status, text: await resp.text() };
}

async function robloxGetEntry(key) {
  const url = `https://apis.roblox.com/datastores/v1/universes/${process.env.ROBLOX_UNIVERSE_ID}/standard-datastores/${encodeURIComponent(DS_NAME)}/entries/${encodeURIComponent(key)}?scope=global`;
  const resp = await fetch(url, {
    method: 'GET',
    headers: { 'x-api-key': process.env.ROBLOX_API_KEY }
  });
  const text = await resp.text();
  let json = null; try { json = JSON.parse(text); } catch {}
  return { status: resp.status, text, json };
}

async function robloxPublishMessage(messageObj) {
  const url = `https://apis.roblox.com/messaging-service/v1/universes/${process.env.ROBLOX_UNIVERSE_ID}/topics/${encodeURIComponent(TOPIC_NAME)}`;
  const resp = await fetch(url, {
    method: 'POST',
    headers: {
      'x-api-key': process.env.ROBLOX_API_KEY,
      'Content-Type': 'application/json'
    },
    body: JSON.stringify({ message: JSON.stringify(messageObj) })
  });
  return { status: resp.status, text: await resp.text() };
}

// BAN: key = tostring(userId), value = legacy fields
export async function banUser(userId, reason) {
  const key = String(userId);
  const value = {
    Active: true,
    Reason: reason || '(no reason)',
    ByName: 'DiscordBot',
    Time: Math.floor(Date.now() / 1000)
  };
  const put = await robloxPutEntry(key, value);
  const pub = await robloxPublishMessage({ type: 'BAN', userId, reason, moderator: 'DiscordBot', ts: new Date().toISOString() });
  return `DS ${put.status} ${put.text.slice(0,200)} | MSG ${pub.status} ${pub.text.slice(0,200)}`;
}

// UNBAN: set Active=false (tetap di key yang sama)
export async function unbanUser(userId) {
  const key = String(userId);
  const value = {
    Active: false,
    Reason: '',
    ByName: 'DiscordBot',
    Time: Math.floor(Date.now() / 1000)
  };
  const put = await robloxPutEntry(key, value);
  const pub = await robloxPublishMessage({ type: 'UNBAN', userId, reason: '', moderator: 'DiscordBot', ts: new Date().toISOString() });
  return `DS ${put.status} ${put.text.slice(0,200)} | MSG ${pub.status} ${pub.text.slice(0,200)}`;
}

export async function kickUser(userId, reason) {
  const pub = await robloxPublishMessage({ type: 'KICK', userId, reason, moderator: 'DiscordBot', ts: new Date().toISOString() });
  return `MSG ${pub.status} ${pub.text.slice(0,200)}`;
}

export async function checkBanStatus(userId) {
  const key = String(userId);
  const got = await robloxGetEntry(key);
  if (got.status === 200 && got.json && got.json.value) {
    const v = got.json.value;
    // legacy schema
    if (typeof v === 'object' && v.Active === true) {
      return `BANNED - Reason: ${v.Reason || '(no reason)'} | By: ${v.ByName || 'Moderator'}`;
    }
    return 'Not Banned';
  }
  if (got.status === 404) return 'Not Banned (404)';
  return `Error reading DS: ${got.status} ${got.text.slice(0,200)}`;
}
