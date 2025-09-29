// api/interactions.js
// Vercel serverless: Discord Interactions (tanpa gateway) + Roblox Open Cloud

// === CONFIG from env ===
const UNIVERSE_ID = process.env.ROBLOX_UNIVERSE_ID;
const API_KEY     = process.env.ROBLOX_API_KEY;
const DS_BANS     = process.env.DS_NAME     || "BANS_V1";
const DS_INDEX    = process.env.DS_INDEX    || "BANS_INDEX_V1";
const DS_NAMEIDX  = process.env.DS_NAMEIDX  || "NAME_INDEX_V1";
const DS_SCOPE    = process.env.DS_SCOPE    || "global";
const TOPIC_NAME  = process.env.TOPIC_NAME  || "moderation";
const PUBLIC_KEY  = process.env.DISCORD_PUBLIC_KEY; // dari Developer Portal

// --- util: Discord signature verify (tanpa lib tambahan) ---
import crypto from "node:crypto";
function verifySignature(req, rawBody) {
  const sig = req.headers["x-signature-ed25519"];
  const ts  = req.headers["x-signature-timestamp"];
  if (!sig || !ts) return false;
  const msg = Buffer.from(ts + rawBody);
  const sigBuf = Buffer.from(sig, "hex");
  const pubKeyBuf = Buffer.from(PUBLIC_KEY, "hex");
  try {
    return crypto.verify(
      null,
      msg,
      crypto.createPublicKey({ key: Buffer.concat([
        Buffer.from("302a300506032b6570032100","hex"), pubKeyBuf
      ]), format: "der", type: "spki" }),
      sigBuf
    );
  } catch {
    return false;
  }
}

// --- tiny helpers (Open Cloud) ---
function ocDS(path, qs) {
  const u = new URL(`https://apis.roblox.com/datastores/v1/universes/${UNIVERSE_ID}/standard-datastores` + path);
  Object.entries(qs || {}).forEach(([k,v]) => u.searchParams.set(k, v));
  return u.toString();
}
async function dsGet(store, key) {
  const url = ocDS("/datastore/entries/entry", { datastoreName: store, scope: DS_SCOPE, entryKey: key });
  const r = await fetch(url, { headers: { "x-api-key": API_KEY } });
  if (!r.ok) return { ok:false, status:r.status };
  return { ok:true, value: await r.json() };
}
async function dsSet(store, key, value) {
  const url = ocDS("/datastore/entries/entry", { datastoreName: store, scope: DS_SCOPE, entryKey: key });
  const r = await fetch(url, { method:"POST", headers: { "x-api-key": API_KEY, "content-type":"application/json" }, body: JSON.stringify(value) });
  return r.ok;
}
async function publish(topic, obj) {
  const url = `https://apis.roblox.com/messaging-service/v1/universes/${UNIVERSE_ID}/topics/${encodeURIComponent(topic)}`;
  await fetch(url, { method:"POST", headers:{ "x-api-key": API_KEY, "content-type":"application/json" }, body: JSON.stringify({ message: JSON.stringify(obj) }) }).catch(()=>{});
}

// username -> userId
async function resolveUserId(username) {
  const r = await fetch("https://users.roblox.com/v1/usernames/users", {
    method:"POST", headers:{"content-type":"application/json"},
    body: JSON.stringify({ usernames:[String(username)], excludeBannedUsers:false })
  });
  if (!r.ok) throw new Error("username resolve failed");
  const d = await r.json();
  const id = d?.data?.[0]?.id;
  if (!id) throw new Error("username not found");
  return Number(id);
}
async function upsertNameIndex(uid, uname) {
  const lower = String(uname).toLowerCase();
  await dsSet(DS_NAMEIDX, `name:${lower}`, Number(uid));
  await dsSet(DS_NAMEIDX, `user:${uid}`, String(uname));
}
async function setIndex(uid, on) {
  const cur = await dsGet(DS_INDEX, "INDEX");
  let idx = (cur.ok && typeof cur.value === "object") ? cur.value : {};
  if (!idx || Array.isArray(idx)) idx = {};
  if (on) idx[String(uid)] = true; else delete idx[String(uid)];
  await dsSet(DS_INDEX, "INDEX", idx);
}

// actions
async function banByUsername(uname, reason, moderator) {
  const uid = await resolveUserId(uname);
  const cur = await dsGet(DS_BANS, String(uid));
  let old = (cur.ok && typeof cur.value === "object") ? cur.value : {};
  if (!old || Array.isArray(old)) old = {};
  const value = { ...old, Active:true, Reason:reason||"Banned", ByName:moderator||"Discord", Time: Math.floor(Date.now()/1000) };
  await dsSet(DS_BANS, String(uid), value);
  await setIndex(uid, true);
  await upsertNameIndex(uid, uname);
  await publish(TOPIC_NAME, { type:"BAN", userId:uid, reason:value.Reason, moderator, ts:new Date().toISOString() });
  return { uid };
}
async function unbanByUsername(uname, moderator) {
  const uid = await resolveUserId(uname);
  const cur = await dsGet(DS_BANS, String(uid));
  let old = (cur.ok && typeof cur.value === "object") ? cur.value : {};
  if (!old || Array.isArray(old)) old = {};
  const value = { ...old, Active:false, Reason:"", ByName:moderator||"Discord", Time: Math.floor(Date.now()/1000) };
  await dsSet(DS_BANS, String(uid), value);
  await setIndex(uid, false);
  await upsertNameIndex(uid, uname);
  return { uid };
}
async function kickByUsername(uname, reason, moderator) {
  const uid = await resolveUserId(uname);
  await publish(TOPIC_NAME, { type:"KICK", userId:uid, reason:reason||"", moderator, ts:new Date().toISOString() });
  return { uid };
}
async function checkByUsername(uname) {
  const uid = await resolveUserId(uname);
  const got = await dsGet(DS_BANS, String(uid));
  if (!got.ok) return { uid, status:"NOT_BANNED" };
  const v = got.value;
  if (v && typeof v === "object" && v.Active === true) return { uid, status:"BANNED", reason:v.Reason||"(no reason)", by:v.ByName||"Moderator" };
  return { uid, status:"NOT_BANNED" };
}

// Discord responses
const RESP_PONG   = { type: 1 };
const ephemeral   = (content) => ({ type: 4, data: { content, flags: 64 } }); // flags 64 = ephemeral

export default async function handler(req, res) {
  const raw = await getRawBody(req);
  if (!verifySignature(req, raw)) { res.status(401).send("bad sig"); return; }

  const body = JSON.parse(raw);

  // PING
  if (body.type === 1) { res.status(200).json(RESP_PONG); return; }

  if (body.type === 2) {
    const name = body.data?.name;
    const opts = optMap(body.data?.options || []);
    try {
      const moderator = body.member?.user?.username || "Discord";

      if (name === "banname") {
        const { uid } = await banByUsername(opts.username, opts.reason || "Banned", moderator);
        res.status(200).json(ephemeral(`✅ Banned **${opts.username}** (id: ${uid})`)); return;
      }
      if (name === "unbanname") {
        const { uid } = await unbanByUsername(opts.username, moderator);
        res.status(200).json(ephemeral(`🟢 Unbanned **${opts.username}** (id: ${uid})`)); return;
      }
      if (name === "kickname") {
        const { uid } = await kickByUsername(opts.username, opts.reason || "", moderator);
        res.status(200).json(ephemeral(`👢 Kick signal sent to **${opts.username}** (id: ${uid})`)); return;
      }
      if (name === "checkname") {
        const r = await checkByUsername(opts.username);
        res.status(200).json(ephemeral(
          r.status === "BANNED"
            ? `🚫 **${opts.username}** (id: ${r.uid}) is **BANNED** — Reason: ${r.reason} (By: ${r.by})`
            : `✅ **${opts.username}** (id: ${r.uid}) is **NOT banned**`
        )); return;
      }

      res.status(200).json(ephemeral("Unknown command."));
    } catch (e) {
      res.status(200).json(ephemeral(`❌ ${String(e?.message || e)}`));
    }
    return;
  }

  res.status(400).send("bad request");
}

// helpers for Vercel raw body
function getRawBody(req) {
  return new Promise((resolve) => {
    let buf = "";
    req.setEncoding("utf8");
    req.on("data", (c) => (buf += c));
    req.on("end", () => resolve(buf || "{}"));
  });
}
function optMap(arr) {
  const m = {};
  for (const o of arr) m[o.name] = o.value;
  return m;
}
