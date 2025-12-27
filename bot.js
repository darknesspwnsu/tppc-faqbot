import "dotenv/config";
import process from "node:process";
import { Client, GatewayIntentBits, Partials, Events, REST, Routes } from "discord.js";
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
const ENABLE_FLAREON_COMMANDS =
  String(process.env.ENABLE_FLAREON_COMMANDS || "").toLowerCase() === "true";

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

// Register /help (guild if DISCORD_GUILD_ID is set; global otherwise)
async function registerSlashCommands() {
  const clientId = mustEnv("DISCORD_CLIENT_ID");
  const guildId = process.env.DISCORD_GUILD_ID;

  const rest = new REST({ version: "10" }).setToken(TOKEN);

  const slashDefs = [
    {
      name: "help",
      description: "Show a private, categorized help menu"
    }
  ];

  if (guildId) {
    await rest.put(Routes.applicationGuildCommands(clientId, guildId), { body: slashDefs });
    console.log(`[SLASH] Registered guild slash commands for guild ${guildId}`);
  } else {
    await rest.put(Routes.applicationCommands(clientId), { body: slashDefs });
    console.log("[SLASH] Registered global slash commands");
  }
}

const client = new Client({
  intents: [
    GatewayIntentBits.Guilds, // required for slash commands
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

client.once(Events.ClientReady, async () => {
  console.log(`Logged in as ${client.user?.tag}`);
  console.log(
    ALLOWED_CHANNEL_IDS.length
      ? `Allowed channels: ${ALLOWED_CHANNEL_IDS.join(", ")}`
      : "Allowed channels: (all visible channels)"
  );
  console.log(`Loaded commands: ${commands.list().join(", ")}`);
  console.log(`Experimental (? commands): ${ENABLE_FLAREON_COMMANDS ? "ENABLED" : "DISABLED"}`);

  // Register slash commands on startup
  try {
    await registerSlashCommands();
  } catch (e) {
    console.error("[SLASH] registration failed:", e?.message ?? e);
  }
});

client.on("messageCreate", async (message) => {
  try {
    if (!message.guild) return;
    if (message.author?.bot) return;
    if (!inAllowedChannel(message.channelId)) return;

    const content = (message.content ?? "").trim();
    const isBang = content.startsWith("!");
    const isQuestion = content.startsWith("?");

    if (!isBang && !isQuestion) return;

    // Gate experimental ? commands
    if (isQuestion && !ENABLE_FLAREON_COMMANDS) return;

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

// Slash commands + buttons
client.on(Events.InteractionCreate, async (interaction) => {
  try {
    // /help
    if (interaction.isChatInputCommand() && interaction.commandName === "help") {
      // commands.js should expose helpModel() that returns:
      // [{ category: "Tools", lines: ["!calc ...", ...] }, ...]
      const pages = typeof commands.helpModel === "function" ? commands.helpModel() : [];

      if (!pages.length) {
        await interaction.reply({ content: "No commands available.", ephemeral: true });
        return;
      }

      const embedFor = (i) => ({
        title: pages[i].category,
        description: pages[i].lines.map((l) => `• ${l}`).join("\n"),
        footer: { text: `Page ${i + 1} / ${pages.length}` }
      });

      const i = 0;

      const components =
        pages.length <= 1
          ? []
          : [
              {
                type: 1,
                components: [
                  {
                    type: 2,
                    style: 2,
                    label: "Prev",
                    custom_id: `help:${i - 1}`,
                    disabled: true
                  },
                  {
                    type: 2,
                    style: 2,
                    label: "Next",
                    custom_id: `help:${i + 1}`,
                    disabled: pages.length <= 1
                  }
                ]
              }
            ];

      await interaction.reply({
        ephemeral: true,
        embeds: [embedFor(i)],
        components
      });
      return;
    }

    // Buttons for /help pagination
    if (interaction.isButton()) {
      const id = String(interaction.customId || "");
      if (!id.startsWith("help:")) return;

      const pages = typeof commands.helpModel === "function" ? commands.helpModel() : [];
      if (!pages.length) {
        await interaction.update({ content: "No commands available.", embeds: [], components: [] });
        return;
      }

      let idx = Number(id.split(":")[1]);
      if (!Number.isFinite(idx)) idx = 0;
      idx = Math.max(0, Math.min(pages.length - 1, idx));

      const embed = {
        title: pages[idx].category,
        description: pages[idx].lines.map((l) => `• ${l}`).join("\n"),
        footer: { text: `Page ${idx + 1} / ${pages.length}` }
      };

      const row =
        pages.length <= 1
          ? []
          : [
              {
                type: 1,
                components: [
                  {
                    type: 2,
                    style: 2,
                    label: "Prev",
                    custom_id: `help:${idx - 1}`,
                    disabled: idx <= 0
                  },
                  {
                    type: 2,
                    style: 2,
                    label: "Next",
                    custom_id: `help:${idx + 1}`,
                    disabled: idx >= pages.length - 1
                  }
                ]
              }
            ];

      await interaction.update({ embeds: [embed], components: row });
      return;
    }
  } catch (err) {
    console.error("interactionCreate error:", err);
    try {
      if (interaction.isRepliable() && !interaction.replied && !interaction.deferred) {
        await interaction.reply({ content: "Something went wrong.", ephemeral: true });
      }
    } catch {
      // ignore
    }
  }
});

client.login(TOKEN);
