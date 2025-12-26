import "dotenv/config";
import process from "node:process";
import { Client, GatewayIntentBits, Partials, Events } from "discord.js";
import { buildCommandRegistry } from "./commands.js";
import { initDb } from "./db.js";

function mustEnv(name) {
  const v = process.env[name];
  if (!v) throw new Error(`Missing required env var: ${name}`);
  return v;
}

async function initDbWithRetry(tries = 15, delayMs = 1000) {
  for (let i = 1; i <= tries; i++) {
    try {
      await initDb();
      return;
    } catch (e) {
      const code = e?.code ? ` (${e.code})` : "";
      console.error(`[DB] init failed attempt ${i}/${tries}${code}:`, e?.message ?? e);
      if (i === tries) throw e;
      await new Promise((r) => setTimeout(r, delayMs));
    }
  }
}

const TOKEN = mustEnv("DISCORD_TOKEN");

// Optional: restrict to certain channels. If empty, bot works anywhere it can see.
const ALLOWED_CHANNEL_IDS = (process.env.ALLOWED_CHANNEL_IDS || "")
  .split(",")
  .map((s) => s.trim())
  .filter(Boolean);

// Trading / DB-backed profile commands are enabled only for guilds in this allowlist.
// If empty, trading features are disabled everywhere and we skip DB init entirely.
const TRADING_GUILD_ALLOWLIST = (process.env.TRADING_GUILD_ALLOWLIST || "")
  .split(",")
  .map((s) => s.trim())
  .filter(Boolean);

const TRADING_ENABLED_ANYWHERE = TRADING_GUILD_ALLOWLIST.length > 0;

if (TRADING_ENABLED_ANYWHERE) {
  await initDbWithRetry();
  console.log(`DB ready ✅ (trading enabled for guilds: ${TRADING_GUILD_ALLOWLIST.join(", ")})`);
} else {
  console.log("DB disabled — TRADING_GUILD_ALLOWLIST empty (trading commands disabled everywhere).");
}

function inAllowedChannel(channelId) {
  if (ALLOWED_CHANNEL_IDS.length === 0) return true;
  return ALLOWED_CHANNEL_IDS.includes(channelId);
}

const client = new Client({
  intents: [
    GatewayIntentBits.Guilds,
    GatewayIntentBits.GuildMessages,
    GatewayIntentBits.GuildMessageReactions,
    GatewayIntentBits.MessageContent
  ],
  partials: [
    Partials.Channel,
    Partials.Message,   
    Partials.Reaction,  
    Partials.User       
  ]
});

const commands = buildCommandRegistry({ client });

client.once(Events.ClientReady, () => {
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
