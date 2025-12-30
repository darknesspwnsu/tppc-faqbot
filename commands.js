/**
 * commands.js
 *
 * Unified registry for:
 *  - Bang commands: "!cmd ..."
 *  - Slash commands: "/cmd ..."
 *  - Component interactions (buttons/select menus) via customId prefix routing
 *  - Slash syncing (global or guild-scoped)
 *
 * Modules should register commands via the provided `register` function,
 * which is ALSO a "namespace" for slash + components + message listeners:
 *
 *   register("!foo", handler, help, opts)
 *   register.slash({ name, description, options? }, handler)
 *   register.component("prefix:", handler)
 *   register.onMessage(handler)   // passive listener for all messages
 *   register.listener(handler)    // alias of onMessage (more explicit name)
 *
 * Handlers:
 *  - Bang: handler({ message, cmd, rest })
 *  - Slash: handler({ interaction })
 *  - Component: handler({ interaction })
 *  - onMessage/listener: handler({ message })
 */

import { REST, Routes } from "discord.js";

import { registerContests } from "./contests/contests.js";
import { registerTrades } from "./trades.js";
import { registerGames } from "./games/games.js";

import { registerInfoCommands } from "./faq.js";
import { registerTools } from "./tools.js";
import { registerToybox } from "./toybox.js";

import { registerHelpbox } from "./helpbox.js";
import { registerVerification } from "./verification/verification_module.js";

import { handleRarityInteraction } from "./rarity.js";

/* --------------------------------- config -------------------------------- */

// Used only to decide whether to register trading commands at all.
// Enforcement should still happen inside trading module too.
const TRADING_GUILD_ALLOWLIST = (process.env.TRADING_GUILD_ALLOWLIST || "")
  .split(",")
  .map((s) => s.trim())
  .filter(Boolean);

const TRADING_ENABLED_ANYWHERE = TRADING_GUILD_ALLOWLIST.length > 0;

const ENABLE_FLAREON_COMMANDS = process.env.ENABLE_FLAREON_COMMANDS === "true";

console.log(
  `[COMMANDS] Experimental (? commands): ${ENABLE_FLAREON_COMMANDS ? "ENABLED" : "DISABLED"}`
);

/* ------------------------------- registry core ------------------------------ */

export function buildCommandRegistry({ client } = {}) {
  // Bang commands
  const bang = new Map(); // nameLower -> entry

  // Slash commands
  const slash = new Map(); // nameLower -> { def, handler }

  // Component handlers (buttons/select menus), matched by customId prefix
  const components = []; // { prefix, handler }

  // Message hooks (passive listeners for normal chat input, games, triggers, etc.)
  const messageHooks = []; // handler({ message })

  function registerOnMessage(handler) {
    if (typeof handler !== "function") {
      throw new Error("register.onMessage requires a function");
    }
    messageHooks.push(handler);
  }

  // Alias for clarity: "listener" reads better than "onMessage" for passive triggers
  function registerListener(handler) {
    return registerOnMessage(handler);
  }

  function registerBang(name, handler, help = "", opts = {}) {
    const key = String(name).toLowerCase();
    if (bang.has(key)) {
      throw new Error(`[COMMANDS] Duplicate bang command registered: "${key}"`);
    }

    const entry = {
      handler,
      help,
      admin: Boolean(opts.admin),
      canonical: true,
      category: opts.category || "Other",
      hideFromHelp: Boolean(opts.hideFromHelp),
      helpTier: opts.helpTier || "normal", // "primary" | "normal"
    };

    bang.set(key, entry);

    if (Array.isArray(opts.aliases)) {
      for (const alias of opts.aliases) {
        const akey = String(alias).toLowerCase();
        if (bang.has(akey)) {
          throw new Error(
            `[COMMANDS] Duplicate bang alias registered: "${akey}" (alias of "${key}")`
          );
        }
        bang.set(akey, { ...entry, canonical: false });
      }
    }
  }

  function registerSlash(def, handler) {
    if (!def || !def.name) throw new Error("register.slash requires a { name, description } def");
    const key = String(def.name).toLowerCase();
    if (slash.has(key)) {
      throw new Error(`[COMMANDS] Duplicate slash command registered: "/${key}"`);
    }
    slash.set(key, { def, handler });
  }

  function registerComponent(prefix, handler) {
    if (!prefix) throw new Error("register.component requires a customId prefix string");
    const p = String(prefix);

    if (components.some((c) => c.prefix === p)) {
      throw new Error(`[COMMANDS] Duplicate component prefix registered: "${p}"`);
    }

    components.push({ prefix: p, handler });
    // Ensure most specific prefixes win if someone registers overlapping ones.
    components.sort((a, b) => b.prefix.length - a.prefix.length);
  }

  // The public `register` function modules already expect:
  function register(name, handler, help = "", opts = {}) {
    return registerBang(name, handler, help, opts);
  }
  register.slash = registerSlash;
  register.component = registerComponent;
  register.onMessage = registerOnMessage;
  register.listener = registerListener;

  function withCategory(baseRegister, category) {
    const wrapped = (name, handler, help = "", opts = {}) => {
      const merged = { ...opts };
      if (!merged.category) merged.category = category;
      return baseRegister(name, handler, help, merged);
    };

    // Preserve slash/component/message methods.
    wrapped.slash = baseRegister.slash;
    wrapped.component = baseRegister.component;
    wrapped.onMessage = baseRegister.onMessage;
    wrapped.listener = baseRegister.listener;

    return wrapped;
  }

  function helpModel() {
    const byCat = new Map();
    const catOrder = [];

    for (const { help, admin, canonical, category, hideFromHelp, helpTier } of bang.values()) {
      if (!canonical) continue;
      if (!help) continue;
      if (admin) continue;
      if (hideFromHelp) continue;

      const cat = category || "Other";
      if (String(cat).toLowerCase() === "games") {
        if (helpTier !== "primary") continue;
      }
      if (!byCat.has(cat)) {
        byCat.set(cat, []);
        catOrder.push(cat);
      }
      byCat.get(cat).push(help);
    }

    return catOrder.map((cat) => ({
      category: cat,
      lines: (byCat.get(cat) || []).sort()
    }));
  }

  /* ------------------------------ Module wiring ------------------------------ */

  // Trading lists + IDs (?ft/?lf/?id etc.) behind allowlist
  if (TRADING_ENABLED_ANYWHERE) {
    registerTrades(withCategory(register, "Trading"));
  }

  // Tools hub + organizer link + calculator (!calc) (collated in tools.js)
  registerTools(withCategory(register, "Tools"));

  // FAQ / Wiki / NG / Rules / Glossary (moved into faq.js)
  registerInfoCommands(withCategory(register, "Info"));
  
  // Verification
  registerVerification(withCategory(register, "Info"));

  // Core / fun / contests
  registerContests(withCategory(register, "Contests"));

  // Games registry (exploding voltorbs etc.)
  registerGames(withCategory(register, "Games"));

  // Toybox fun commands
  registerToybox(withCategory(register, "Fun"));

  // Helpbox (registers /help + help buttons + !help)
  registerHelpbox(withCategory(register, "Info"), { helpModel });


  /* ------------------------------- dispatchers ------------------------------ */

  async function dispatchMessage(message) {
    const content = (message.content ?? "").trim();
    const isBang = content.startsWith("!");
    const isQ = content.startsWith("?");

    // Passive listeners run for ALL messages (not just !/? commands)
    if (messageHooks.length) {
      for (const h of messageHooks) {
        try {
          await h({ message });
        } catch (e) {
          // Keep failures isolated; do not block command dispatch
        }
      }
    }

    if (!isBang && !isQ) return;
    if (isQ && !ENABLE_FLAREON_COMMANDS) return;

    // Parse: "!cmd rest..."
    const spaceIdx = content.indexOf(" ");
    const cmd = (spaceIdx === -1 ? content : content.slice(0, spaceIdx)).toLowerCase();
    const rest = spaceIdx === -1 ? "" : content.slice(spaceIdx + 1);

    const entry = bang.get(cmd);
    if (!entry?.handler) return; // ignore unknown commands

    await entry.handler({ message, cmd, rest });
  }

  async function dispatchInteraction(interaction) {
    // Slash commands
    if (interaction.isChatInputCommand?.()) {
      const key = String(interaction.commandName).toLowerCase();
      const entry = slash.get(key);
      if (!entry?.handler) return;
      await entry.handler({ interaction });
      return;
    }

    // Modal submits route by customId prefix (same as buttons/selects)
    if (interaction.isModalSubmit?.()) {
      const customId = interaction.customId ? String(interaction.customId) : "";
      if (!customId) return;

      const match = components.find((c) => customId.startsWith(c.prefix));
      if (match?.handler) {
        await match.handler({ interaction });
      }
      return;
    }

    // Components: buttons, selects, etc.
    const customId = interaction.customId ? String(interaction.customId) : "";
    if (customId) {
      // Special-case rarity "did you mean" buttons.
      if (customId.startsWith("rarity_retry:")) {
        const rerun = await handleRarityInteraction(interaction);
        if (rerun && rerun.cmd) {
          const entry = bang.get(String(rerun.cmd).toLowerCase());
          if (entry?.handler) {
            // Build a lightweight "message-like" object for existing bang handlers.
            const messageLike = {
              guild: interaction.guild,
              channel: interaction.channel,
              author: interaction.user,
              member: interaction.member,
              // reply() should create a normal follow-up message
              reply: (payload) => interaction.followUp(payload),
            };

            await entry.handler({
              message: messageLike,
              cmd: rerun.cmd,
              rest: rerun.rest ?? ""
            });
          }
        }
        return;
      }

      const match = components.find((c) => customId.startsWith(c.prefix));
      if (match?.handler) {
        await match.handler({ interaction });
      }
    }
  }

  /* ------------------------------ slash syncing ------------------------------ */

  function slashDefs() {
    // Return raw defs in a stable order
    return [...slash.values()]
      .map((x) => x.def)
      .sort((a, b) => String(a.name).localeCompare(String(b.name)));
  }

  async function syncSlashCommands({ token, appId, guildId = null }) {
    const rest = new REST({ version: "10" }).setToken(token);
    const body = slashDefs();

    if (guildId) {
      await rest.put(Routes.applicationGuildCommands(appId, guildId), { body });
    } else {
      await rest.put(Routes.applicationCommands(appId), { body });
    }
  }

  /* ------------------------------ Public API ------------------------------ */

  return {
    // Dispatch
    dispatchMessage,
    dispatchInteraction,

    // Lists
    listBang: () =>
      [...bang.entries()]
        .filter(([, v]) => v?.canonical)
        .map(([k]) => k)
        .sort(),
    listSlash: () => [...slash.keys()].sort(),

    // Help model
    helpModel,

    // Slash sync
    slashDefs,
    syncSlashCommands
  };
}
