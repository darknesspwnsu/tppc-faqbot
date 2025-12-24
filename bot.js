import "dotenv/config";
import process from "node:process";
import { Client, GatewayIntentBits, Partials } from "discord.js";
import { buildCommandRegistry } from "./commands.js";

function mustEnv(name) {
  const v = process.env[name];
  if (!v) throw new Error(`Missing required env var: ${name}`);
  return v;
}

const TOKEN = mustEnv("DISCORD_TOKEN");

// Optional: restrict to certain channels. If empty, bot works anywhere it can see.
const ALLOWED_CHANNEL_IDS = (process.env.ALLOWED_CHANNEL_IDS || "")
  .split(",")
  .map((s) => s.trim())
  .filter(Boolean);

function inAllowedChannel(channelId) {
  if (ALLOWED_CHANNEL_IDS.length === 0) return true;
  return ALLOWED_CHANNEL_IDS.includes(channelId);
}

const client = new Client({
  intents: [
    GatewayIntentBits.Guilds,
    GatewayIntentBits.GuildMessages,
    GatewayIntentBits.MessageContent
  ],
  partials: [Partials.Channel]
});

const commands = buildCommandRegistry({ client });

client.once("ready", () => {
  console.log(`Logged in as ${client.user?.tag}`);
  console.log(
    ALLOWED_CHANNEL_IDS.length
      ? `Allowed channels: ${ALLOWED_CHANNEL_IDS.join(", ")}`
      : "Allowed channels: (all visible channels)"
  );
  console.log(`Loaded commands: ${commands.list().join(", ")}`);
});

client.on("messageCreate", async (message) => {
  try {
    if (!message.guild) return;
    if (message.author?.bot) return;
    if (!inAllowedChannel(message.channelId)) return;

    const content = (message.content ?? "").trim();
    if (!content.startsWith("!")) return;

    // Parse: "!cmd rest..."
    const spaceIdx = content.indexOf(" ");
    const cmd = (spaceIdx === -1 ? content : content.slice(0, spaceIdx)).toLowerCase();
    const rest = spaceIdx === -1 ? "" : content.slice(spaceIdx + 1);

    const handler = commands.get(cmd);
    if (!handler) return; // ignore unknown commands

    await handler({ message, cmd, rest });
  } catch (err) {
    console.error("messageCreate error:", err);
  }
});

client.login(TOKEN);
