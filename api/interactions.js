// api/interactions.js
import nacl from "tweetnacl"; // npm i tweetnacl

const UNIVERSE_ID = process.env.ROBLOX_UNIVERSE_ID;
const API_KEY     = process.env.ROBLOX_API_KEY;
const DS_BANS     = process.env.DS_NAME     || "BANS_V1";
const DS_INDEX    = process.env.DS_INDEX    || "BANS_INDEX_V1";
const DS_NAMEIDX  = process.env.DS_NAMEIDX  || "NAME_INDEX_V1";
const DS_SCOPE    = process.env.DS_SCOPE    || "global";
const TOPIC_NAME  = process.env.TOPIC_NAME  || "moderation";
const PUBLIC_KEY  = process.env.DISCORD_PUBLIC_KEY;

// === ACCESS CONTROL (baru) ===
// Isi di ENV (comma-separated):
// ALLOWED_ROLE_IDS=111111111111111111,222222222222222222,333333333333333333
// (opsional) ALLOWED_USER_IDS=444444444444444444,555555555555555555
const ALLOWED_ROLE_IDS = (process.env.ALLOWED_ROLE_IDS || "")
  .split(",")
  .map(s => s.trim())
  .filter(Boolean);
const ALLOWED_USER_IDS = (process.env.ALLOWED_USER_IDS || "")
  .split(",")
  .map(s => s.trim())
  .filter(Boolean);

function hasAllowedRole(member) {
  if (!member) return false;
  // allow by explicit user whitelist first
  const userId = member.user?.id;
  if (userId && ALLOWED_USER_IDS.includes(userId)) return true;

  // then check roles array (guild member)
  const roles = member.roles || [];
  return roles.some(rid => ALLOWED_ROLE_IDS.includes(String(rid)));
}

// ---------- utils ----------
const te = new TextEncoder();

function verifySig(req, raw) {
  const sig = req.headers["x-signature-ed25519"];
  const ts  = req.headers["x-signature-timestamp"];
  if (!sig || !ts || !PUBLIC_KEY) return false;
  const msg = te.encode(ts + raw);
  const sigBytes = Uint8Array.from(Buffer.from(sig, "hex"));
  const pubBytes = Uint8Array.from(Buffer.from(PUBLIC_KEY, "hex"));
  return nacl.sign.detached.verify(msg, sigBytes, pubBytes);
}

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
  await fetch(url, { method:"POST", headers:{ "x-api-key": API_KEY, "content-type":"application/json" }, body: JSON.stringify(value) });
}

async function publish(topic, payload) {
  const url = `https://apis.roblox.com/messaging-service/v1/universes/${UNIVERSE_ID}/topics/${encodeURIComponent(topic)}`;
  await fetch(url, { method:"POST", headers:{ "x-api-key": API_KEY, "content-type":"application/json" }, body: JSON.stringify({ message: JSON.stringify(payload) }) }).catch(()=>{});
}

async function resolveUserId(username) {
  const r = await fetch("https://users.roblox.com/v1/usernames/users", {
    method:"POST", headers:{ "content-type":"application/json" },
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
  const value = { ...old, Active:true, Reason:reason||"Banned", ByName:moderator||"Discord", Time:Math.floor(Date.now()/1000) };
  await dsSet(DS_BANS, String(uid), value);
  await setIndex(uid, true);
  await upsertNameIndex(uid, uname);
  await publish(TOPIC_NAME, { type:"BAN", userId:uid, reason:value.Reason, moderator, ts:new Date().toISOString() });
  return uid;
}

async function unbanByUsername(uname, moderator) {
  const uid = await resolveUserId(uname);
  const cur = await dsGet(DS_BANS, String(uid));
  let old = (cur.ok && typeof cur.value === "object") ? cur.value : {};
  if (!old || Array.isArray(old)) old = {};
  const value = { ...old, Active:false, Reason:"", ByName:moderator||"Discord", Time:Math.floor(Date.now()/1000) };
  await dsSet(DS_BANS, String(uid), value);
  await setIndex(uid, false);
  await upsertNameIndex(uid, uname);
  return uid;
}

async function kickByUsername(uname, reason, moderator) {
  const uid = await resolveUserId(uname);
  await publish(TOPIC_NAME, { type:"KICK", userId:uid, reason:reason||"", moderator, ts:new Date().toISOString() });
  return uid;
}

async function checkByUsername(uname) {
  const uid = await resolveUserId(uname);
  const got = await dsGet(DS_BANS, String(uid));
  if (got.ok && got.value && got.value.Active === true) {
    return { uid, banned:true, reason:got.value.Reason || "(no reason)", by:got.value.ByName || "Moderator" };
  }
  return { uid, banned:false };
}

// Discord response helpers
const RESP_PONG = { type: 1 };
const ephemeral = (content) => ({ type: 4, data: { content, flags: 64 } });

export default async function handler(req, res) {
  const raw = await getRaw(req);

  if (!verifySig(req, raw)) {
    res.status(401).send("invalid request signature");
    return;
  }

  const body = JSON.parse(raw || "{}");

  // PING
  if (body.type === 1) {
    res.status(200).json(RESP_PONG);
    return;
  }

  if (body.type === 2) {
    const name = body.data?.name;
    const opts = opt(body.data?.options || []);
    const moderator = body.member?.user?.username || "Discord";

    // === ROLE-GATE (baru): hanya role yang diizinkan yang boleh jalan ===
    if (!hasAllowedRole(body.member)) {
      res.status(200).json(ephemeral("❌ Kamu tidak punya role yang diizinkan untuk memakai bot ini."));
      return;
    }

    try {
      if (name === "banname") {
        const uid = await banByUsername(opts.username, opts.reason || "Banned", moderator);
        res.status(200).json(ephemeral(`✅ Banned **${opts.username}** (id: ${uid})`)); return;
      }
      if (name === "unbanname") {
        const uid = await unbanByUsername(opts.username, moderator);
        res.status(200).json(ephemeral(`🟢 Unbanned **${opts.username}** (id: ${uid})`)); return;
      }
      if (name === "kickname") {
        const uid = await kickByUsername(opts.username, opts.reason || "", moderator);
        res.status(200).json(ephemeral(`👢 Kick signal sent to **${opts.username}** (id: ${uid})`)); return;
      }
      if (name === "checkname") {
        const r = await checkByUsername(opts.username);
        res.status(200).json(ephemeral(
          r.banned
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

function getRaw(req) {
  return new Promise((resolve) => {
    let b = "";
    req.setEncoding("utf8");
    req.on("data", (c) => (b += c));
    req.on("end", () => resolve(b || "{}"));
  });
}

function opt(arr) {
  const m = {};
  for (const o of arr) m[o.name] = o.value;
  return m;
}
