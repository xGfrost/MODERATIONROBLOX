// scripts/register-commands.mjs
import fetch from "node-fetch";
import "dotenv/config";

const url = `https://discord.com/api/v10/applications/${process.env.DISCORD_APPLICATION_ID}/guilds/${process.env.GUILD_ID}/commands`;

const commands = [
  {
    name: "banname",
    description: "Ban a Roblox user by username",
    options: [
      { name: "username", type: 3, description: "Roblox username", required: true },
      { name: "reason",   type: 3, description: "Reason for ban", required: false }
    ]
  },
  {
    name: "unbanname",
    description: "Unban a Roblox user by username",
    options: [{ name: "username", type: 3, description: "Roblox username", required: true }]
  },
  {
    name: "kickname",
    description: "Kick a Roblox user by username",
    options: [
      { name: "username", type: 3, description: "Roblox username", required: true },
      { name: "reason",   type: 3, description: "Reason (optional)", required: false }
    ]
  },
  {
    name: "checkname",
    description: "Check ban status by username",
    options: [{ name: "username", type: 3, description: "Roblox username", required: true }]
  }
];

for (const cmd of commands) {
  const res = await fetch(url, {
    method: "POST",
    headers: {
      "Authorization": `Bot ${process.env.DISCORD_BOT_TOKEN}`,
      "Content-Type": "application/json"
    },
    body: JSON.stringify(cmd)
  });
  console.log(`Registering ${cmd.name}: ${res.status}`);
  try { console.log(await res.json()); } catch { /* ignore */ }
}
