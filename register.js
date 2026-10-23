/* Registers the slash commands with Discord. You only need this for the very first
   setup: after that, the Worker keeps every server's command list current by itself,
   using the bot token it already holds, whenever anybody uses the bot.

   Usage:
     DISCORD_TOKEN=... DISCORD_APP_ID=... DISCORD_GUILD_ID=... node register.js
*/
import { COMMANDS as commands } from "./src/commands.js";

const token = process.env.DISCORD_TOKEN;
const appId = process.env.DISCORD_APP_ID;
const guildId = process.env.DISCORD_GUILD_ID;

if (!token || !appId) {
  console.error("Set DISCORD_TOKEN and DISCORD_APP_ID.");
  process.exit(1);
}

const url = guildId
  ? `https://discord.com/api/v10/applications/${appId}/guilds/${guildId}/commands`
  : `https://discord.com/api/v10/applications/${appId}/commands`;

const res = await fetch(url, {
  method: "PUT",
  headers: { authorization: `Bot ${token}`, "content-type": "application/json" },
  body: JSON.stringify(commands)
});

if (!res.ok) {
  console.error(`Failed: ${res.status}`, await res.text());
  process.exit(1);
}
console.log(guildId
  ? `Registered ${commands.length} commands to guild ${guildId}. Live now.`
  : `Registered ${commands.length} global commands. Global registration can take up to an hour to appear.`);
