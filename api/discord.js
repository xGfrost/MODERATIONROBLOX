import { InteractionType, InteractionResponseType, verifyKey } from 'discord-interactions';
import fetch from 'node-fetch';

export default async function handler(req, res) {
  if (req.method !== 'POST') {
    return res.status(405).send('Method Not Allowed');
  }

  const signature = req.headers['x-signature-ed25519'];
  const timestamp = req.headers['x-signature-timestamp'];
  const rawBody = await new Promise(resolve => {
    let data = '';
    req.on('data', chunk => data += chunk);
    req.on('end', () => resolve(data));
  });

  const isValid = verifyKey(rawBody, signature, timestamp, process.env.DISCORD_PUBLIC_KEY);
  if (!isValid) return res.status(401).send('Invalid request signature');

  const interaction = JSON.parse(rawBody);

  // Handle PING (validasi awal)
  if (interaction.type === InteractionType.PING) {
    return res.send({ type: InteractionResponseType.PONG });
  }

  // Ambil command
  if (interaction.type === InteractionType.APPLICATION_COMMAND) {
    const { name, options } = interaction.data;
    const userId = options.find(o => o.name === 'userid')?.value;
    const reason = options.find(o => o.name === 'reason')?.value || '(no reason)';

    if (name === 'ban') {
      await banUser(userId, reason);
      return res.json({ type: 4, data: { content: `🚫 User ${userId} dibanned. Reason: ${reason}` } });
    }

    if (name === 'unban') {
      await unbanUser(userId);
      return res.json({ type: 4, data: { content: `✅ User ${userId} diunban.` } });
    }

    if (name === 'kick') {
      await kickUser(userId, reason);
      return res.json({ type: 4, data: { content: `👢 User ${userId} di-kick. Reason: ${reason}` } });
    }

    if (name === 'check') {
      const status = await checkBanStatus(userId);
      return res.json({ type: 4, data: { content: `🔍 Status User ${userId}: ${status}` } });
    }
  }

  return res.status(400).send('Bad request');
}

// === Roblox Helper Functions ===
async function banUser(userId, reason) {
  const url = `https://apis.roblox.com/datastores/v1/universes/${process.env.ROBLOX_UNIVERSE_ID}/standard-datastores/${encodeURIComponent(process.env.DS_NAME)}/entries/ban_${userId}?scope=global`;

  const payload = {
    banned: true,
    reason,
    moderator: 'DiscordBot',
    ts: new Date().toISOString()
  };

  await fetch(url, {
    method: 'POST',
    headers: {
      'x-api-key': process.env.ROBLOX_API_KEY,
      'Content-Type': 'application/json'
    },
    body: JSON.stringify({ data: payload })
  });

  await publishMessage('BAN', userId, reason);
}

async function unbanUser(userId) {
  const url = `https://apis.roblox.com/datastores/v1/universes/${process.env.ROBLOX_UNIVERSE_ID}/standard-datastores/${encodeURIComponent(process.env.DS_NAME)}/entries/ban_${userId}?scope=global`;

  const payload = { banned: false };

  await fetch(url, {
    method: 'POST',
    headers: {
      'x-api-key': process.env.ROBLOX_API_KEY,
      'Content-Type': 'application/json'
    },
    body: JSON.stringify({ data: payload })
  });

  await publishMessage('UNBAN', userId, '');
}

async function kickUser(userId, reason) {
  await publishMessage('KICK', userId, reason);
}

async function checkBanStatus(userId) {
  const url = `https://apis.roblox.com/datastores/v1/universes/${process.env.ROBLOX_UNIVERSE_ID}/standard-datastores/${encodeURIComponent(process.env.DS_NAME)}/entries/ban_${userId}?scope=global`;

  const resp = await fetch(url, {
    method: 'GET',
    headers: { 'x-api-key': process.env.ROBLOX_API_KEY }
  });
  const data = await resp.json();
  return data?.data?.banned ? `BANNED - Reason: ${data.data.reason}` : 'Not Banned';
}

async function publishMessage(type, userId, reason) {
  const url = `https://apis.roblox.com/messaging-service/v1/universes/${process.env.ROBLOX_UNIVERSE_ID}/topics/${encodeURIComponent(process.env.TOPIC_NAME)}`;
  const message = JSON.stringify({ type, userId, reason, ts: new Date().toISOString() });

  await fetch(url, {
    method: 'POST',
    headers: {
      'x-api-key': process.env.ROBLOX_API_KEY,
      'Content-Type': 'application/json'
    },
    body: JSON.stringify({ message })
  });
}
