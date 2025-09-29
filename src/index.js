// src/index.js
import { Client, GatewayIntentBits } from "discord.js";
import "dotenv/config";
import { banByUsername, unbanByUsername, kickByUsername, checkBanByUsername } from "../api/discord.js";

const bot = new Client({ intents: [GatewayIntentBits.Guilds] });
bot.once("ready", () => console.log("Bot ready:", bot.user.tag));

bot.on("interactionCreate", async (i) => {
  if (!i.isChatInputCommand()) return;
  try {
    if (i.commandName === "banname") {
      const username = i.options.getString("username", true);
      const reason   = i.options.getString("reason") ?? "Banned";
      await i.deferReply({ ephemeral: true });              // <- penting agar tidak timeout
      const r = await banByUsername(username, reason, i.user.username);
      await i.editReply(`✅ Banned **${r.username}** (id: ${r.userId})`);
      return;
    }
    if (i.commandName === "unbanname") {
      const username = i.options.getString("username", true);
      await i.deferReply({ ephemeral: true });
      const r = await unbanByUsername(username, i.user.username);
      await i.editReply(`🟢 Unbanned **${r.username}** (id: ${r.userId})`);
      return;
    }
    if (i.commandName === "kickname") {
      const username = i.options.getString("username", true);
      const reason   = i.options.getString("reason") ?? "";
      await i.deferReply({ ephemeral: true });
      const r = await kickByUsername(username, reason, i.user.username);
      await i.editReply(`👢 Kick signal sent to **${r.username}** (id: ${r.userId})`);
      return;
    }
    if (i.commandName === "checkname") {
      const username = i.options.getString("username", true);
      await i.deferReply({ ephemeral: true });
      const r = await checkBanByUsername(username);
      await i.editReply(
        r.status === "BANNED"
          ? `🚫 **${r.username}** (id: ${r.userId}) is **BANNED** — Reason: ${r.reason} (By: ${r.by})`
          : `✅ **${r.username}** (id: ${r.userId}) is **NOT banned**`
      );
      return;
    }
  } catch (e) {
    console.error("Interaction error:", e);
    if (i.deferred || i.replied) await i.editReply(`❌ ${String(e?.message || e)}`);
    else await i.reply({ content: `❌ ${String(e?.message || e)}`, ephemeral: true });
  }
});

bot.login(process.env.DISCORD_BOT_TOKEN);
