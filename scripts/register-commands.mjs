import fetch from 'node-fetch';
import 'dotenv/config';

const url = `https://discord.com/api/v10/applications/${process.env.DISCORD_APPLICATION_ID}/guilds/${process.env.GUILD_ID}/commands`;

const commands = [
  {
    name: 'ban',
    description: 'Ban a Roblox user',
    options: [
      { name: 'userid', type: 3, description: 'Roblox UserId', required: true },
      { name: 'reason', type: 3, description: 'Reason for ban', required: false }
    ]
  },
  {
    name: 'unban',
    description: 'Unban a Roblox user',
    options: [{ name: 'userid', type: 3, description: 'Roblox UserId', required: true }]
  },
  {
    name: 'kick',
    description: 'Kick a Roblox user',
    options: [
      { name: 'userid', type: 3, description: 'Roblox UserId', required: true },
      { name: 'reason', type: 3, description: 'Reason for kick', required: false }
    ]
  },
  {
    name: 'check',
    description: 'Check ban status',
    options: [{ name: 'userid', type: 3, description: 'Roblox UserId', required: true }]
  }
];

for (const cmd of commands) {
  const res = await fetch(url, {
    method: 'POST',
    headers: {
      'Authorization': `Bot ${process.env.DISCORD_BOT_TOKEN}`,
      'Content-Type': 'application/json'
    },
    body: JSON.stringify(cmd)
  });

  console.log(`Registering ${cmd.name}: ${res.status}`);
  const data = await res.json();
  console.log(data);
}
