import "dotenv/config";
import process from "node:process";
import { Client, GatewayIntentBits, Partials, Events } from "discord.js";
import { buildCommandRegistry } from "./commands.js";
import { initDb } from "./db.js";
import { startSchedulers } from "./schedulers.js";

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

await initDbWithRetry();
console.log("DB ready ✅");

// If set, slash commands are registered ONLY to this guild (recommended for dev).
// If empty, slash commands are registered globally.
const SLASH_GUILD_ID = (process.env.SLASH_GUILD_ID || "").trim();

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
  partials: [Partials.Channel, Partials.Message, Partials.Reaction, Partials.User]
});

const commands = buildCommandRegistry({ client });

client.once(Events.ClientReady, async () => {
  console.log(`Logged in as ${client.user?.tag}`);
  console.log(
    ALLOWED_CHANNEL_IDS.length
      ? `Allowed channels: ${ALLOWED_CHANNEL_IDS.join(", ")}`
      : "Allowed channels: (all visible channels)"
  );
  console.log(`Loaded bang commands: ${commands.listBang().join(", ")}`);
  console.log(`Loaded slash commands: ${commands.listSlash().join(", ")}`);

  // Slash sync: global if SLASH_GUILD_ID not set; otherwise guild-only.
  try {
    const appId = client.application?.id || client.user?.id;
    if (!appId) throw new Error("Could not determine application ID for slash registration.");

    await commands.syncSlashCommands({
      token: TOKEN,
      appId,
      guildId: SLASH_GUILD_ID || null
    });

    console.log(
      SLASH_GUILD_ID
        ? `Slash commands synced ✅ (guild: ${SLASH_GUILD_ID})`
        : "Slash commands synced ✅ (global)"
    );
  } catch (e) {
    console.error("Slash sync failed:", e?.message ?? e);
  }

  startSchedulers({ client });
});

client.on("messageCreate", async (message) => {
  try {
    if (!message.guild) return;
    if (message.author?.bot) {
      if (message.author.id === client.user?.id && inAllowedChannel(message.channelId)) {
        await commands.dispatchMessageHooks?.(message);
      }
      return;
    }
    if (!inAllowedChannel(message.channelId)) return;

    await commands.dispatchMessage(message);
  } catch (err) {
    console.error("messageCreate error:", err);
  }
});

client.on(Events.InteractionCreate, async (interaction) => {
  try {
    // Let the registry decide what to do with it.
    await commands.dispatchInteraction(interaction);
  } catch (err) {
    console.error("interactionCreate error:", err);
  }
});

client.login(TOKEN);
