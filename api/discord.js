// api/discord.js
// Discord ↔ Roblox (Open Cloud) moderation helpers
// FIXES: correct Open Cloud endpoints + support username-based ops

import fetch from "node-fetch";

const UNIVERSE_ID = process.env.ROBLOX_UNIVERSE_ID;
const API_KEY     = process.env.ROBLOX_API_KEY;

// DataStore names & scope (samakan dengan yang di Studio)
const DS_BANS    = process.env.DS_NAME     || "BANS_V1";
const DS_INDEX   = process.env.DS_INDEX    || "BANS_INDEX_V1";
const DS_NAMEIDX = process.env.DS_NAMEIDX  || "NAME_INDEX_V1";
const SCOPE      = process.env.DS_SCOPE    || "global";

// Messaging topic (untuk kick realtime)
const TOPIC_NAME = process.env.TOPIC_NAME  || "moderation";

// -------------------- Open Cloud helpers --------------------
function ocDSUrl(path, qs) {
  const base = `https://apis.roblox.com/datastores/v1/universes/${UNIVERSE_ID}/standard-datastores`;
  const u = new URL(base + path);
  if (qs) Object.entries(qs).forEach(([k,v]) => u.searchParams.set(k, v));
  return u.toString();
}

// SET/GET entry (Open Cloud v1) — body adalah nilai langsung (BUKAN {value:{...}})
async function putEntry(datastoreName, entryKey, valueObj, scope = SCOPE) {
  const url = ocDSUrl("/datastore/entries/entry", {
    datastoreName, scope, entryKey
  });
  const resp = await fetch(url, {
    method: "POST",
    headers: {
      "x-api-key": API_KEY,
      "content-type": "application/json",
    },
    body: JSON.stringify(valueObj ?? null),
  });
  const text = await resp.text();
  return { ok: resp.ok, status: resp.status, text };
}

async function getEntry(datastoreName, entryKey, scope = SCOPE) {
  const url = ocDSUrl("/datastore/entries/entry", {
    datastoreName, scope, entryKey
  });
  const resp = await fetch(url, {
    method: "GET",
    headers: { "x-api-key": API_KEY }
  });
  const text = await resp.text();
  let value = null;
  try { value = JSON.parse(text); } catch { /* raw text */ }
  return { ok: resp.ok, status: resp.status, value, raw: text };
}

// MessagingService publish
async function publishMessage(topic, messageObj) {
  const url = `https://apis.roblox.com/messaging-service/v1/universes/${UNIVERSE_ID}/topics/${encodeURIComponent(topic)}`;
  const resp = await fetch(url, {
    method: "POST",
    headers: {
      "x-api-key": API_KEY,
      "content-type": "application/json"
    },
    body: JSON.stringify({ message: JSON.stringify(messageObj || {}) })
  });
  const text = await resp.text();
  return { ok: resp.ok, status: resp.status, text };
}

// -------------------- Username → userId --------------------
async function resolveUserId(username) {
  const res = await fetch("https://users.roblox.com/v1/usernames/users", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ usernames: [String(username)], excludeBannedUsers: false })
  });
  if (!res.ok) throw new Error(`resolve fail (${res.status})`);
  const data = await res.json();
  const id = data?.data?.[0]?.id;
  if (!id) throw new Error("username not found");
  return Number(id);
}

// keep NAME_INDEX_V1 in sync (optional tapi bagus)
async function upsertNameIndex(userId, username) {
  const lower = String(username).toLowerCase();
  await putEntry(DS_NAMEIDX, `name:${lower}`, Number(userId));
  await putEntry(DS_NAMEIDX, `user:${userId}`, String(username));
}

// index KEY list untuk panel (BANS_INDEX_V1)
async function setIndex(userId, on) {
  // read-modify-write sederhana
  const key = "INDEX";
  const cur = await getEntry(DS_INDEX, key);
  let idx = (cur.ok && typeof cur.value === "object") ? cur.value : {};
  if (!idx || Array.isArray(idx)) idx = {};
  if (on) idx[String(userId)] = true; else delete idx[String(userId)];
  await putEntry(DS_INDEX, key, idx);
}

// -------------------- Public API (username-based) --------------------
export async function banByUsername(username, reason, moderatorName = "DiscordBot") {
  const userId = await resolveUserId(username);
  // merge existing record (best effort)
  const cur = await getEntry(DS_BANS, String(userId));
  let old = (cur.ok && typeof cur.value === "object") ? cur.value : {};
  if (!old || Array.isArray(old)) old = {};
  const value = {
    ...old,
    Active: true,
    Reason: reason || "(no reason)",
    ByName: moderatorName,
    Time: Math.floor(Date.now() / 1000)
  };
  const put = await putEntry(DS_BANS, String(userId), value);
  await setIndex(userId, true);
  await upsertNameIndex(userId, username);
  // realtime kick
  await publishMessage(TOPIC_NAME, { type: "BAN", userId, reason: value.Reason, moderator: moderatorName, ts: new Date().toISOString() }).catch(()=>{});
  return { userId, username, dsStatus: put.status, dsText: put.text.slice(0,200) };
}

export async function unbanByUsername(username, moderatorName = "DiscordBot") {
  const userId = await resolveUserId(username);
  const cur = await getEntry(DS_BANS, String(userId));
  let old = (cur.ok && typeof cur.value === "object") ? cur.value : {};
  if (!old || Array.isArray(old)) old = {};
  const value = {
    ...old,
    Active: false,
    Reason: "",
    ByName: moderatorName,
    Time: Math.floor(Date.now() / 1000)
  };
  const put = await putEntry(DS_BANS, String(userId), value);
  await setIndex(userId, false);
  await upsertNameIndex(userId, username);
  return { userId, username, dsStatus: put.status, dsText: put.text.slice(0,200) };
}

export async function kickByUsername(username, reason, moderatorName = "DiscordBot") {
  const userId = await resolveUserId(username);
  const pub = await publishMessage(TOPIC_NAME, { type: "KICK", userId, reason: reason || "", moderator: moderatorName, ts: new Date().toISOString() });
  return { userId, username, msgStatus: pub.status, msgText: pub.text.slice(0,200) };
}

export async function checkBanByUsername(username) {
  const userId = await resolveUserId(username);
  const got = await getEntry(DS_BANS, String(userId));
  if (got.ok) {
    const v = got.value;
    if (v && typeof v === "object" && v.Active === true) {
      return { userId, username, status: "BANNED", reason: v.Reason || "(no reason)", by: v.ByName || "Moderator" };
    }
    return { userId, username, status: "NOT_BANNED" };
  }
  if (got.status === 404) return { userId, username, status: "NOT_BANNED" };
  return { userId, username, status: "ERROR", detail: `${got.status} ${got.raw?.slice?.(0,200)}` };
}
