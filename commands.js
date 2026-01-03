/**
 * commands.js
 *
 * Unified registry for:
 *  - Bang commands: "!cmd ..."
 *  - Q commands: "?cmd ..." (legacy / collision-avoidance)
 *  - Slash commands: "/cmd ..."
 *  - Component interactions (buttons/select menus) via customId prefix routing
 *  - Passive message hooks
 *
 * Modules should register commands via the provided `register` function:
 *
 *   register("!foo", handler, help, opts)
 *   register.slash({ name, description, options? }, handler)
 *   register.component("prefix:", handler)
 *   register.onMessage(handler)   // passive listener
 *   register.listener(handler)    // alias of onMessage
 *   register.expose({ logicalId, name, handler, help?, opts? }) // !/? exposure per guild
 *
 * Handlers:
 *  - Bang/Q: handler({ message, cmd, rest })
 *  - Slash: handler({ interaction })
 *  - Component: handler({ interaction })
 *  - onMessage/listener: handler({ message })
 */

import { REST, Routes } from "discord.js";

import { registerContests } from "./contests/contests.js";
import { registerTrades } from "./trades/trades.js";
import { registerGames } from "./games/games.js";
import { registerRpg } from "./rpg/rpg.js";

import { registerInfo } from "./info/info.js";
import { registerTools } from "./tools/tools.js";
import { registerToybox } from "./toybox.js";

import { registerVerification } from "./verification/verification.js";

import { handleRarityInteraction } from "./tools/rarity.js";
import { handleLeaderboardInteraction } from "./rpg/leaderboard.js";
import { handlePokedexInteraction } from "./rpg/pokedex.js";
import { isAdminOrPrivileged } from "./auth.js";
import {
  DEFAULT_EXPOSURE,
  DEFAULT_SLASH_EXPOSURE,
  COMMAND_EXPOSURE_BY_GUILD,
  COMMAND_CHANNEL_POLICY_BY_GUILD,
  SLASH_EXPOSURE_BY_GUILD,
} from "./configs/command_exposure.js";


/* --------------------------------- config -------------------------------- */

const VALID_EXPOSURES = new Set(["bang", "q", "off"]);
if (!VALID_EXPOSURES.has(DEFAULT_EXPOSURE)) {
  console.warn(
    `[COMMANDS] Invalid DEFAULT_EXPOSURE="${DEFAULT_EXPOSURE}" (expected bang|q|off). Using "bang".`
  );
}

const VALID_SLASH_EXPOSURES = new Set(["on", "off"]);
if (!VALID_SLASH_EXPOSURES.has(DEFAULT_SLASH_EXPOSURE)) {
  console.warn(
    `[COMMANDS] Invalid DEFAULT_SLASH_EXPOSURE="${DEFAULT_SLASH_EXPOSURE}" (expected on|off). Using "on".`
  );
}


/* ------------------------------- registry core ------------------------------ */

export function buildCommandRegistry({ client } = {}) {
  // Bang commands (includes ? commands too; they’re both routed by dispatchMessage)
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

  function registerListener(handler) {
    return registerOnMessage(handler);
  }

  function registerBang(name, handler, help = "", opts = {}) {
    const key = String(name).toLowerCase();
    if (bang.has(key)) {
      throw new Error(`[COMMANDS] Duplicate bang command registered: "${key}"`);
    }

    const entry = {
      name: key,
      handler,
      help,
      admin: Boolean(opts.admin),
      canonical: true,
      category: opts.category || "Other",
      hideFromHelp: Boolean(opts.hideFromHelp),
      helpTier: opts.helpTier || "normal", // "primary" | "normal"
      exposeMeta: opts._exposeMeta || null, // { logicalId, baseName } when registered via register.expose
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
        // Copy the entry but mark canonical=false so we don't duplicate in help
        bang.set(akey, { ...entry, canonical: false });
      }
    }
  }

  function exposureFor(guildId, logicalId) {
    const g = COMMAND_EXPOSURE_BY_GUILD[String(guildId)];
    const exp = g?.[logicalId] ?? DEFAULT_EXPOSURE;
    return VALID_EXPOSURES.has(exp) ? exp : "bang";
  }

  function slashExposureFor(guildId, commandName) {
    const g = SLASH_EXPOSURE_BY_GUILD?.[String(guildId)];
    const exp = g?.[String(commandName)] ?? DEFAULT_SLASH_EXPOSURE;
    return VALID_SLASH_EXPOSURES.has(exp) ? exp : "on";
  }


  function channelPolicyFor(guildId, logicalId) {
    const g = COMMAND_CHANNEL_POLICY_BY_GUILD?.[String(guildId)];
    const p = g?.[logicalId];
    if (!p) return null;

    const allow = Array.isArray(p.allow) ? p.allow.map(String) : null;
    const deny = Array.isArray(p.deny) ? p.deny.map(String) : null;
    const silent = p.silent === undefined ? true : Boolean(p.silent);

    return {
      allow: allow && allow.length ? allow : null,
      deny: deny && deny.length ? deny : null,
      silent,
    };
  }

  function allowedInChannel(message, logicalId) {
    const gid = message?.guildId;
    const cid = message?.channelId;
    if (!gid || !cid) return { ok: true, silent: false };

    const p = channelPolicyFor(gid, logicalId);
    if (!p) return { ok: true, silent: false };

    if (p.deny && p.deny.includes(String(cid))) return { ok: false, silent: p.silent };
    if (p.allow && !p.allow.includes(String(cid))) return { ok: false, silent: p.silent };

    return { ok: true, silent: p.silent };
  }

  /**
   * Register a logical command that may be exposed as !cmd or ?cmd or disabled,
   * depending on guild policy.
   *
   * Requirements:
   * - Wrong prefix should be SILENT.
   * - "off" does not respond with anything.
   * - Aliases MUST mirror the canonical prefix (so we create !alias and ?alias too).
   *
   * Aliases should be supplied as bare names:
   *   opts.aliases: ["a", "aw"]
   * We also accept "!a"/"?a" and strip the prefix for backward compatibility.
   */
  function registerExposable({ logicalId, name, handler, help = "", opts = {} }) {
    const bangName = `!${name}`;
    const qName = `?${name}`;

    const rawAliases = Array.isArray(opts.aliases) ? opts.aliases : [];
    const aliasesBare = rawAliases
      .map((s) => String(s || "").trim())
      .filter(Boolean)
      .map((s) => (s.startsWith("!") || s.startsWith("?") ? s.slice(1) : s))
      .filter(Boolean);

    const bangAliases = aliasesBare.map((a) => `!${a}`);
    const qAliases = aliasesBare.map((a) => `?${a}`);

    const exposeMeta = { logicalId, baseName: name };

    // Register bang side with the help string (help is rewritten per-guild at render time)
    registerBang(
      bangName,
      async (ctx) => {
        const exp = exposureFor(ctx.message?.guildId, logicalId);
        if (exp === "bang") {
          const gate = allowedInChannel(ctx.message, logicalId);
          if (!gate.ok) {
            if (!gate.silent) {
              await ctx.message?.reply("This command isn’t allowed in this channel.");
            }
            return;
          }
          return handler(ctx);
        }
        return; // silent for q + off
      },
      help,
      { ...opts, aliases: bangAliases, _exposeMeta: exposeMeta }
    );

    // Register q side hidden from help; help renderer will rewrite the bang-side line per guild.
    registerBang(
      qName,
      async (ctx) => {
        const exp = exposureFor(ctx.message?.guildId, logicalId);
        if (exp === "q") {
          const gate = allowedInChannel(ctx.message, logicalId);
          if (!gate.ok) {
            if (!gate.silent) {
              await ctx.message?.reply("This command isn’t allowed in this channel.");
            }
            return;
          }
          return handler(ctx);
        }
        return; // silent for bang + off
      },
      "",
      { ...opts, aliases: qAliases, hideFromHelp: true, _exposeMeta: exposeMeta }
    );
  }

  function registerSlash(def, handler, opts = {}) {
    if (!def || !def.name) throw new Error("register.slash requires a { name, description } def");
    const key = String(def.name).toLowerCase();
    if (slash.has(key)) {
      throw new Error(`[COMMANDS] Duplicate slash command registered: "/${key}"`);
    }

    slash.set(key, {
      def,
      handler,
      autocomplete: typeof opts.autocomplete === "function" ? opts.autocomplete : null,
      meta: {
        admin: Boolean(opts.admin),
        category: opts.category || "Other",
        hideFromHelp: Boolean(opts.hideFromHelp),
        helpTier: opts.helpTier || "normal", // "primary" | "normal"
      },
    });
  }

  function registerComponent(prefix, handler) {
    if (!prefix) throw new Error("register.component requires a customId prefix string");
    const p = String(prefix);

    if (components.some((c) => c.prefix === p)) {
      throw new Error(`[COMMANDS] Duplicate component prefix registered: "${p}"`);
    }

    components.push({ prefix: p, handler });
    components.sort((a, b) => b.prefix.length - a.prefix.length);
  }

  // Public `register` function (modules expect this)
  function register(name, handler, help = "", opts = {}) {
    return registerBang(name, handler, help, opts);
  }
  register.slash = registerSlash;
  register.component = registerComponent;
  register.onMessage = registerOnMessage;
  register.listener = registerListener;
  register.expose = registerExposable;

  function withCategory(baseRegister, category) {
    const wrapped = (name, handler, help = "", opts = {}) => {
      const merged = { ...opts };
      if (!merged.category) merged.category = category;
      return baseRegister(name, handler, help, merged);
    };

    wrapped.slash = (def, handler, opts = {}) => {
      const merged = { ...(opts || {}) };
      if (!merged.category) merged.category = category;
      return baseRegister.slash(def, handler, merged);
    };
    wrapped.component = baseRegister.component;
    wrapped.onMessage = baseRegister.onMessage;
    wrapped.listener = baseRegister.listener;

    // Crucial: apply category default to expose() too
    wrapped.expose = (payload) => {
      const next = { ...(payload || {}) };
      const o = { ...(next.opts || {}) };
      if (!o.category) o.category = category;
      next.opts = o;
      return baseRegister.expose(next);
    };

    return wrapped;
  }

  function escapeRegex(s) {
    return String(s).replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  }

  /**
   * Build categorized help for a specific guild.
   * - Exposed commands are rewritten to show the correct prefix for that guild.
   * - "off" commands are hidden for that guild.
   *
   * If guildId is null (e.g. DMs), we treat it as DEFAULT_EXPOSURE.
   */
  function helpModel(guildId = null, viewerMessageLike = null) {
    const gid = guildId ? String(guildId) : null;
    const includeAdmin = viewerMessageLike ? isAdminOrPrivileged(viewerMessageLike) : false;

    // cat -> { userLines: [], adminLines: [] }
    const byCat = new Map();
    const catOrder = [];

    function formatCategoryName(name) {
      const raw = String(name || "").trim();
      if (!raw) return "Other";
      const isAllCaps = raw === raw.toUpperCase();
      if (!isAllCaps) return raw;
      const lower = raw.toLowerCase();
      return lower.charAt(0).toUpperCase() + lower.slice(1);
    }

    function ensureCat(cat) {
      const key = String(cat || "Other").toLowerCase();
      if (!byCat.has(key)) {
        byCat.set(key, { userLines: [], adminLines: [], category: formatCategoryName(cat) });
        catOrder.push(key);
      } else {
        const entry = byCat.get(key);
        if (entry && entry.category === entry.category.toUpperCase() && cat !== cat.toUpperCase()) {
          entry.category = String(cat || entry.category);
        }
      }
      return byCat.get(key);
    }

    function pushLine(cat, line, isAdminLine) {
      const bucket = ensureCat(cat);
      if (isAdminLine) bucket.adminLines.push(line);
      else bucket.userLines.push(line);
    }

    // -------------------------
    // Bang/Q commands
    // -------------------------
    for (const entry of bang.values()) {
      const { help, admin, canonical, category, hideFromHelp, helpTier } = entry;

      if (!canonical) continue;
      if (!help) continue;
      if (hideFromHelp) continue;

      // Hide admin commands unless viewer can see them
      if (admin && !includeAdmin) continue;

      const cat = category || "Other";

      // Games category shows only primary commands
      if (String(cat).toLowerCase() === "games") {
        if (helpTier !== "primary") continue;
      }

      let line = String(help);

      // If exposable, rewrite based on guild policy (and hide if off)
      if (entry.exposeMeta) {
        const { logicalId, baseName } = entry.exposeMeta;
        const exp = exposureFor(gid, logicalId);

        if (exp === "off") continue;

        const displayCmd = exp === "q" ? `?${baseName}` : `!${baseName}`;
        const re = new RegExp(`[!?]${escapeRegex(baseName)}\\b`, "g");
        line = line.replace(re, displayCmd);
      }

      const baseName = entry.name.startsWith("!") ? entry.name.slice(1) : entry.name;
      if (!entry.exposeMeta && gid && exposureFor(gid, baseName) === "off") {
        continue;
      }

      pushLine(cat, line, Boolean(admin));
    }

    // -------------------------
    // Slash commands
    // -------------------------
    for (const { def, meta } of slash.values()) {
      const name = String(def?.name || "").trim();
      const desc = String(def?.description || "").trim();
      if (!name || !desc) continue;
      if (gid && slashExposureFor(gid, name) === "off") continue;

      const admin = Boolean(meta?.admin);
      const hideFromHelp = Boolean(meta?.hideFromHelp);
      const cat = (meta?.category || "Other");
      const helpTier = meta?.helpTier || "normal";

      if (hideFromHelp) continue;
      if (admin && !includeAdmin) continue;

      // Same rule: Games category shows only primary commands
      if (String(cat).toLowerCase() === "games") {
        if (helpTier !== "primary") continue;
      }

      const line = `/${name} — ${desc}`;
      pushLine(cat, line, admin);
    }

    // -------------------------
    // Finalize per-category lines:
    // - sort user lines
    // - then "Admin:" + sorted admin lines (only if includeAdmin)
    // -------------------------
    return catOrder.map((cat) => {
      const bucket = byCat.get(cat) || { userLines: [], adminLines: [], category: cat };
      const userLines = (bucket.userLines || []).slice().sort();
      const adminLines = (bucket.adminLines || []).slice().sort();

      const lines = [...userLines];
      if (includeAdmin && adminLines.length) {
        lines.push("Admin:");
        lines.push(...adminLines);
      }

      return { category: bucket.category || cat, lines };
    });
  }

  /* ------------------------------ Module wiring ------------------------------ */

  // Admin/privileged: show command collision policy for THIS guild
  register(
    "!cmdpolicy",
    async ({ message }) => {
      if (!message.guildId) return;
      if (!isAdminOrPrivileged(message)) return;

      const gid = String(message.guildId);
      const policy = COMMAND_EXPOSURE_BY_GUILD[gid];

      if (!policy || Object.keys(policy).length === 0) {
        await message.reply(
          `**Command Policy**\n` +
            `Guild: ${gid}\n` +
            `No overrides set.\n` +
            `Default exposure: **${DEFAULT_EXPOSURE}**`
        );
        return;
      }

      const lines = Object.entries(policy)
        .sort(([a], [b]) => a.localeCompare(b))
        .map(([logicalId, exp]) => `• \`${logicalId}\` → **${exp}**`);

      await message.reply(
        `**Command Policy**\n` +
          `Guild: ${gid}\n` +
          `Default: **${DEFAULT_EXPOSURE}**\n\n` +
          lines.join("\n")
      );
    },
    "!cmdpolicy — show per-guild command exposure overrides (admin/privileged)",
    { admin: true, hideFromHelp: true, category: "Info" }
  );

  // Trading now registers everywhere; policy controls off/q/bang per guild.
  registerTrades(withCategory(register, "Trading"));

  registerTools(withCategory(register, "Tools"));
  // Info registry must call helpModel(guildId) per-request (see info/helpbox.js).
  registerInfo(withCategory(register, "Info"), { helpModel });
  registerVerification(withCategory(register, "Info"));
  registerRpg(withCategory(register, "Rpg"));
  registerContests(withCategory(register, "Contests"));
  registerGames(withCategory(register, "Games"));
  registerToybox(withCategory(register, "Fun"));

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
        } catch (err) {
          console.error("[COMMANDS] message hook error:", err);
        }
      }
    }

    if (!isBang && !isQ) return;

    const spaceIdx = content.indexOf(" ");
    const cmd = (spaceIdx === -1 ? content : content.slice(0, spaceIdx)).toLowerCase();
    const rest = spaceIdx === -1 ? "" : content.slice(spaceIdx + 1);

    const entry = bang.get(cmd);
    if (!entry?.handler) return;

    if (cmd.startsWith("!") && !entry.exposeMeta) {
      const base = cmd.slice(1);
      if (message.guildId && exposureFor(message.guildId, base) === "off") {
        await message.reply("This command isn’t allowed in this server.");
        return;
      }
    }

    try {
      await entry.handler({ message, cmd, rest });
    } catch (err) {
      console.error("[COMMANDS] bang handler error:", err);
    }
  }

  async function dispatchInteraction(interaction) {
    if (interaction.isAutocomplete?.()) {
      const key = String(interaction.commandName).toLowerCase();
      const entry = slash.get(key);
      if (!entry?.autocomplete) return;
      if (interaction.guildId && slashExposureFor(interaction.guildId, key) === "off") {
        await interaction.respond([]);
        return;
      }
      try {
        await entry.autocomplete({ interaction });
      } catch (err) {
        console.error("[COMMANDS] autocomplete handler error:", err);
      }
      return;
    }

    // Slash commands
    if (interaction.isChatInputCommand?.()) {
      const key = String(interaction.commandName).toLowerCase();
      const entry = slash.get(key);
      if (!entry?.handler) return;
      if (interaction.guildId && slashExposureFor(interaction.guildId, key) === "off") {
        await interaction.reply({
          content: "This command isn’t allowed in this server.",
          ephemeral: true,
        });
        return;
      }
      try {
        await entry.handler({ interaction });
      } catch (err) {
        console.error("[COMMANDS] slash handler error:", err);
      }
      return;
    }

    // Modal submits route by customId prefix
    if (interaction.isModalSubmit?.()) {
      const customId = interaction.customId ? String(interaction.customId) : "";
      if (!customId) return;

      const match = components.find((c) => customId.startsWith(c.prefix));
      if (match?.handler) {
        try {
          await match.handler({ interaction });
        } catch (err) {
          console.error("[COMMANDS] modal handler error:", err);
        }
      }
      return;
    }

    // Components
    const customId = interaction.customId ? String(interaction.customId) : "";
    if (customId) {
      // Special-case rarity "did you mean" buttons.
      if (customId.startsWith("rarity_retry:")) {
        try {
          const rerun = await handleRarityInteraction(interaction);
          if (rerun && rerun.cmd) {
            const entry = bang.get(String(rerun.cmd).toLowerCase());
            if (entry?.handler) {
              const messageLike = {
                guild: interaction.guild,
                guildId: interaction.guildId,
                channel: interaction.channel,
                channelId: interaction.channelId,
                author: interaction.user,
                member: interaction.member,
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
        } catch (err) {
          console.error("[COMMANDS] rarity retry handler error:", err);
        }
      }

      // Special-case leaderboard "did you mean" buttons.
      if (customId.startsWith("lb_retry:")) {
        try {
          const rerun = await handleLeaderboardInteraction(interaction);
          if (rerun && rerun.cmd) {
            const entry = bang.get(String(rerun.cmd).toLowerCase());
            if (entry?.handler) {
              const messageLike = {
                guild: interaction.guild,
                guildId: interaction.guildId,
                channel: interaction.channel,
                channelId: interaction.channelId,
                author: interaction.user,
                member: interaction.member,
                reply: (payload) => interaction.followUp(payload),
              };

              await entry.handler({
                message: messageLike,
                cmd: rerun.cmd,
                rest: rerun.rest ?? "",
              });
            }
          }
          return;
        } catch (err) {
          console.error("[COMMANDS] leaderboard retry handler error:", err);
        }
      }

      // Special-case pokedex "did you mean" buttons.
      if (customId.startsWith("pokedex_retry:")) {
        try {
          const rerun = await handlePokedexInteraction(interaction);
          if (rerun && rerun.cmd) {
            const entry = bang.get(String(rerun.cmd).toLowerCase());
            if (entry?.handler) {
              const messageLike = {
                guild: interaction.guild,
                guildId: interaction.guildId,
                channel: interaction.channel,
                channelId: interaction.channelId,
                author: interaction.user,
                member: interaction.member,
                reply: (payload) => interaction.followUp(payload),
              };

              await entry.handler({
                message: messageLike,
                cmd: rerun.cmd,
                rest: rerun.rest ?? "",
              });
            }
          }
          return;
        } catch (err) {
          console.error("[COMMANDS] pokedex retry handler error:", err);
        }
      }

      const match = components.find((c) => customId.startsWith(c.prefix));
      if (match?.handler) {
        try {
          await match.handler({ interaction });
        } catch (err) {
          console.error("[COMMANDS] component handler error:", err);
        }
      }
    }
  }

  /* ------------------------------ slash syncing ------------------------------ */

  function slashDefs() {
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

  return {
    dispatchMessage,
    dispatchInteraction,

    listBang: () =>
      [...bang.entries()]
        .filter(([, v]) => v?.canonical)
        .map(([k]) => k)
        .sort(),
    listSlash: () => [...slash.keys()].sort(),

    helpModel,

    slashDefs,
    syncSlashCommands
  };
}
