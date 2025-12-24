/**
 * ============================================================================
 * commands.js
 * ============================================================================
 *
 * PURPOSE
 * -------
 * This module defines and exports the **command registry** for the Discord bot.
 * It is responsible for:
 *
 *   • Defining all supported `!commands`
 *   • Mapping command names (e.g. "!faq") → handler functions
 *   • Encapsulating command logic away from the Discord event loop
 *
 * The Discord client (`bot.js`) does NOT know how commands work internally.
 * It only:
 *   1. Parses the message into { cmd, rest }
 *   2. Looks up `cmd` in the registry
 *   3. Executes the corresponding handler
 *
 * This keeps the system modular, testable, and easy to extend.
 *
 *
 * ============================================================================
 * HOW COMMANDS FLOW THROUGH THE SYSTEM
 * ============================================================================
 *
 * 1) A Discord message is received in `bot.js`
 * 2) bot.js checks:
 *      - message is in a guild
 *      - author is not a bot
 *      - channel is allowed
 *      - message starts with "!"
 * 3) bot.js parses:
 *      - cmd  → first token (e.g. "!roll")
 *      - rest → remaining text after the command
 * 4) bot.js calls:
 *      registry.get(cmd)?.({ message, cmd, rest })
 *
 * If no handler exists, the message is silently ignored.
 *
 *
 * ============================================================================
 * COMMAND REGISTRY DESIGN
 * ============================================================================
 *
 * Commands are stored in a Map:
 *
 *   Map<string, CommandHandler>
 *
 * where:
 *   key   = command name INCLUDING "!" (lowercase)
 *   value = async handler function
 *
 * Example:
 *
 *   "!roll"   → async ({ message, rest }) => { ... }
 *   "!faq"    → async ({ message, rest }) => { ... }
 *
 *
 * ============================================================================
 * HANDLER FUNCTION SIGNATURE
 * ============================================================================
 *
 * Each command handler is an async function that receives ONE object argument:
 *
 *   async function handler({
 *     message,   // discord.js Message object
 *     cmd,       // command string, e.g. "!roll"
 *     rest       // raw text AFTER the command (may be empty)
 *   })
 *
 * Properties:
 * ------------
 * message:
 *   - Full discord.js Message instance
 *   - Use message.reply(), message.channel.send(), mentions, permissions, etc.
 *
 * cmd:
 *   - Lowercased command token (e.g. "!faq")
 *   - Mostly useful for debugging or generic handlers
 *
 * rest:
 *   - Everything AFTER the command
 *   - Not normalized or modified
 *   - You are responsible for parsing it
 *
 *
 * ============================================================================
 * HOW TO ADD A NEW COMMAND (STEP-BY-STEP)
 * ============================================================================
 *
 * 1) Decide the command name
 *    -----------------------
 *    Example:
 *      "!ping"
 *
 *    ⚠️ Always include the "!" prefix.
 *
 *
 * 2) Add a new register() call
 *    -------------------------
 *
 *    Inside buildCommandRegistry():
 *
 *      register("!ping", async ({ message, rest }) => {
 *        await message.channel.send("pong");
 *      });
 *
 *
 * 3) Parse `rest` if needed
 *    ----------------------
 *
 *    - Use rest.trim() for arguments
 *    - Split with /\s+/ to handle multi-whitespace
 *    - Validate inputs aggressively
 *
 *    Example:
 *
 *      const args = rest.trim().split(/\s+/);
 *
 *
 * 4) Send output
 *    -----------
 *
 *    Use ONE of:
 *
 *      message.reply("text")        // replies to the message
 *      message.channel.send("text") // sends normally in channel
 *
 *    Prefer reply() when responding to a question.
 *
 *
 * 5) Do NOT throw errors
 *    -------------------
 *
 *    - Catch invalid input
 *    - Reply with a helpful message OR silently return
 *    - Never throw from a handler (it bubbles to the event loop)
 *
 *
 * ============================================================================
 * PERMISSIONS & SAFETY
 * ============================================================================
 *
 * For admin-only commands (e.g. "!faqreload"):
 *
 *   - Use message.member.permissions.has(...)
 *   - Return early if unauthorized
 *
 * Example:
 *
 *   if (!canReload(message)) {
 *     await message.reply("You do not have permission.");
 *     return;
 *   }
 *
 *
 * ============================================================================
 * WHERE SHARED LOGIC SHOULD LIVE
 * ============================================================================
 *
 * • Cross-command utilities → commands.js (helpers at top)
 * • FAQ logic (matching, logging, reload) → faq.js
 * • Discord lifecycle / intents → bot.js
 *
 * Do NOT:
 *   ✗ Add Discord client code here
 *   ✗ Read environment variables in handlers directly (prefer config at top)
 *   ✗ Handle raw Discord events here
 *
 *
 * ============================================================================
 * ADDING COMMANDS WITHOUT TOUCHING bot.js
 * ============================================================================
 *
 * This is intentional.
 *
 * To add a command, you ONLY edit this file:
 *
 *   commands.js
 *
 * bot.js never changes.
 *
 *
 * ============================================================================
 * SUMMARY
 * ============================================================================
 *
 * ✔ Commands are explicit and opt-in
 * ✔ Handlers are isolated and composable
 * ✔ Adding commands is low-risk
 * ✔ Complex systems (FAQ, logging) stay modular
 *
 * This file is the "public API" of your bot’s behavior.
 *
 * ============================================================================
 */
import { createFaqService } from "./faq.js";
import { createWikiService } from "./wiki.js";

// Small helpers used by multiple commands
function randIntInclusive(min, max) {
  const lo = Math.ceil(min);
  const hi = Math.floor(max);
  return Math.floor(Math.random() * (hi - lo + 1)) + lo;
}

function targetUserId(message) {
  // If someone is mentioned, use the first mention; else author.
  const first = message.mentions?.users?.first?.();
  return first?.id ?? message.author.id;
}

function mention(id) {
  return `<@${id}>`;
}

function canReload(message) {
  if (!message.member) return false;
  return (
    message.member.permissions?.has("Administrator") ||
    message.member.permissions?.has("ManageGuild")
  );
}

async function wikiSearchTPPC(query, limit = 5) {
  const q = (query ?? "").trim();
  if (!q) return [];

  const endpoint = "https://wiki.tppc.info/api.php";
  const url =
    `${endpoint}?action=opensearch` +
    `&search=${encodeURIComponent(q)}` +
    `&limit=${encodeURIComponent(String(limit))}` +
    `&namespace=0` +
    `&format=json`;

  console.log(url);

  // Node 18+ has global fetch; you're on Node 21 so this is fine.
  const res = await fetch(url, {
    method: "GET",
    headers: {
      // Some wiki setups are pickier without a UA
      "User-Agent": "tppc-faqbot/1.0 (discord bot)"
    }
  });
  console.log(res);

  if (!res.ok) return [];

  const data = await res.json();
  // OpenSearch format: [searchterm, titles[], descriptions[], urls[]]
  const titles = Array.isArray(data?.[1]) ? data[1] : [];
  const urls = Array.isArray(data?.[3]) ? data[3] : [];

  const out = [];
  for (let i = 0; i < Math.min(titles.length, urls.length); i++) {
    const title = titles[i];
    const link = urls[i];
    if (typeof title === "string" && typeof link === "string" && link.startsWith("http")) {
      out.push({ title, link });
    }
  }
  return out;
}

export function buildCommandRegistry() {
  const registry = new Map();

  // Services (FAQ engine etc.)
  const faq = createFaqService();
  const wiki = createWikiService();

  // Config
  const MAX_ROLL_N = Number(process.env.MAX_ROLL_N ?? 50);
  const MAX_ROLL_M = Number(process.env.MAX_ROLL_M ?? 100000);

  // Helper to register commands
  function register(name, handler, help = "", opts = {}) {
    registry.set(name.toLowerCase(), {
      handler,
      help,
      admin: Boolean(opts.admin)
    });
  }

  /* ------------------------------ Commands ------------------------------ */

  register("!awesome", async ({ message }) => {
    const uid = targetUserId(message);
    const x = randIntInclusive(0, 101);
    await message.channel.send(`${mention(uid)} is ${x}% awesome!`);
  }, "!awesome — tells you how awesome someone is (0–101%)");

  register("!roll", async ({ message, rest }) => {
    const arg = rest.trim();
    const m = /^(\d+)d(\d+)$/.exec(arg);
    if (!m) {
      await message.channel.send("Invalid format. Please use a format like `1d100`");
      return;
    }

    const n = Number(m[1]);
    const sides = Number(m[2]);

    if (!Number.isInteger(n) || !Number.isInteger(sides) || n < 1 || sides < 0) {
      await message.channel.send("Invalid format. Please use a format like `1d100`");
      return;
    }

    if (n > MAX_ROLL_N) {
      await message.channel.send(`Too many rolls. Max is ${MAX_ROLL_N}.`);
      return;
    }
    if (sides > MAX_ROLL_M) {
      await message.channel.send(`Range too large. Max m is ${MAX_ROLL_M}.`);
      return;
    }

    const uid = targetUserId(message);
    const rolls = Array.from({ length: n }, () => randIntInclusive(0, sides));
    await message.channel.send(`${mention(uid)} ${rolls.join(", ")}`);
  }, "!roll NdM — rolls N numbers from 0..M (example: !roll 1d100)");

  register("!choose", async ({ message, rest }) => {
    const options = rest.trim().split(/\s+/).filter(Boolean);
    if (options.length < 1) {
      await message.channel.send("Usage: `!choose option1 option2 ...`");
      return;
    }
    const pick = options[randIntInclusive(0, options.length - 1)];
    await message.channel.send(pick);
  }, "!choose a b c — randomly chooses one option");

  register("!faq", async ({ message, rest }) => {
    const qRaw = rest.trim();
    if (!qRaw) return; // no output if no question
    const out = faq.matchAndRender({ message, questionRaw: qRaw });
    if (!out) return; // no output if no confident match
    await message.reply(out);
  }, "!faq <question> — asks the FAQ bot");

  register(
    "!faqreload",
    async ({ message }) => {
      if (!canReload(message)) {
        await message.reply(
          "Nope — you don’t have permission to run that. (Admin/Manage Server only)"
        );
        return;
      }

      try {
        const info = faq.reload();
        await message.reply(
          `Reloaded faq.json ✅ (${info.count} entries${
            info.version ? `, v${info.version}` : ""
          })`
        );
      } catch (e) {
        console.error("faq reload failed:", e);
        await message.reply("Reload failed ❌ (check console + faq.json formatting)");
      }
    },
    "!faqreload — reloads faq.json",
    { admin: true }
  );

  register("!help", async ({ message }) => {
    const isAdmin =
      message.member?.permissions?.has("Administrator") ||
      message.member?.permissions?.has("ManageGuild");

    const lines = [];

    for (const { help, admin } of registry.values()) {
      if (!help) continue;
      if (admin && !isAdmin) continue; // hide admin commands
      lines.push(help);
    }

    if (lines.length === 0) return;

    await message.reply(
      "**Available commands:**\n" +
      lines.sort().map(l => `• ${l}`).join("\n")
    );
  }, "!help — shows this help message");

  register("!wiki", async ({ message, rest }) => {
    const q = rest.trim();
    if (!q) return; // no output

    const results = await wikiSearchTPPC(q, 5);
    if (results.length === 0) return; // no output if nothing found

    // If multiple results, return them all (brief)
    const lines = results.map(r => `• [${r.title}](${r.link})`);
    await message.reply(lines.join("\n"));
  }, "!wiki <term> — links matching TPPC wiki pages");

  register("!wiki", async ({ message, rest }) => {
    const q = rest.trim();
    if (!q) return; // no output

    const results = wiki.search(q);
    if (results.length === 0) return; // no output if no match

    // If multiple results, return them all (brief)
    const lines = results.map(r => `• [${r.title}](${r.url})`);
    await message.reply(lines.join("\n"));
  }, "!wiki <term> — links matching TPPC wiki pages");



  /* ------------------------------ Public API ----------------------------- */

  return {
    get: (name) => registry.get(name.toLowerCase())?.handler,
    list: () => [...registry.keys()].sort()
  };
}
