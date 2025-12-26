import fs from "node:fs";
import path from "node:path";
import Fuse from "fuse.js";
import { createWikiService } from "./wiki.js";

function normalize(text) {
  return (text ?? "")
    .toLowerCase()
    .replace(/[^a-z0-9\s]/g, " ")
    .replace(/\s+/g, " ")
    .trim();
}

// Optional aliases: improves matching without lowering thresholds
function aliasNormalize(norm) {
  norm = String(norm ?? "");
  // Common TPPC synonyms/short-hands
  norm = norm.replace(/\bxe\b/g, "experience");
  norm = norm.replace(/\bxp\b/g, "experience");
  norm = norm.replace(/\bexp\b/g, "experience");
  norm = norm.replace(/\bue\b/g, "ungendered");
  norm = norm.replace(/\bug\b/g, "ungendered");
  norm = norm.replace(/\bng\b/g, "non golden");
  return norm;
}

function readFaq() {
  const filePath = path.join(process.cwd(), "data", "faq.json");
  const raw = fs.readFileSync(filePath, "utf8");
  const json = JSON.parse(raw);

  // Normalize format:
  // - allow either { version, entries:[{id, q, a, ...}] } or [{...}]
  const entries = Array.isArray(json) ? json : Array.isArray(json?.entries) ? json.entries : [];
  const version = Array.isArray(json) ? null : json?.version ?? null;

  const out = [];
  for (const e of entries) {
    if (!e || typeof e !== "object") continue;

    const id = String(e.id ?? "").trim();
    const q = String(e.q ?? e.question ?? "").trim();
    const a = String(e.a ?? e.answer ?? e.response ?? "").trim();

    if (!id || !q || !a) continue;

    const questionNorm = normalize(q);
    const questionAlias = aliasNormalize(questionNorm);

    out.push({
      id,
      q,
      a,
      questionNorm,
      questionAlias,
      // Optional knobs per entry
      threshold: typeof e.threshold === "number" ? e.threshold : null
    });
  }

  return { version, entries: out };
}

function buildFuseIndex(faqData) {
  // We index both the normalized text and an alias-normalized form
  return new Fuse(faqData.entries, {
    includeScore: true,
    shouldSort: true,
    threshold: 0.45, // this is only a candidate threshold; we apply our own confidence gate below
    ignoreLocation: true,
    minMatchCharLength: 3,
    keys: [
      { name: "questionNorm", weight: 0.6 },
      { name: "questionAlias", weight: 0.4 }
    ]
  });
}

function clamp01(x) {
  if (!Number.isFinite(x)) return 0;
  return Math.max(0, Math.min(1, x));
}

function score01FromFuse(score) {
  // Fuse: lower is better (0 perfect). Convert to 0..1 where higher is better.
  const s = Number(score);
  if (!Number.isFinite(s)) return 0;
  return clamp01(1 - s);
}

function pickBestMatch(fuse, qNorm) {
  const results = fuse.search(qNorm);
  if (!results || results.length === 0) return null;

  const best = results[0];
  const second = results.find((r) => r.item?.id !== best.item?.id) || null;

  const best01 = score01FromFuse(best.score);
  const second01 = second ? score01FromFuse(second.score) : 0;

  return {
    entry: best.item,
    score01: best01,
    margin01: best01 - second01
  };
}

// Load NG list ONCE (do not reload per command)
function loadNgsOnce() {
  const filePath = path.join(process.cwd(), "data", "ngs.json");
  const raw = fs.readFileSync(filePath, "utf8");
  const data = JSON.parse(raw);

  // Allow either ["A","B"] or {"ngs":["A","B"]}
  const ngs = Array.isArray(data) ? data : Array.isArray(data?.ngs) ? data.ngs : null;
  if (!ngs) throw new Error("data/ngs.json must be an array of strings, or { ngs: [...] }");

  return ngs.map((x) => String(x).trim()).filter(Boolean);
}

function loadGlossaryOnce() {
  const filePath = path.join(process.cwd(), "data", "glossary.json");
  const raw = fs.readFileSync(filePath, "utf8");
  const data = JSON.parse(raw);

  if (!data || typeof data !== "object" || Array.isArray(data)) {
    throw new Error('data/glossary.json must be an object map: { "key": "definition", ... }');
  }

  // Normalize keys to lowercase trimmed strings
  const map = {};
  for (const [k, v] of Object.entries(data)) {
    if (typeof k !== "string" || typeof v !== "string") continue;
    const kk = k.trim().toLowerCase();
    if (!kk) continue;
    map[kk] = v;
  }
  return map;
}

/**
 * Existing FAQ engine (unchanged): createFaqService()
 */
export function createFaqService() {
  // Config knobs
  const DEFAULT_THRESHOLD = Number(process.env.FAQ_MATCH_THRESHOLD ?? 0.82); // 0..1 (higher is stricter)
  const MIN_MARGIN = Number(process.env.FAQ_MIN_MARGIN ?? 0.06);            // best - 2nd best in 0..1
  const NEAR_MISS_MIN = Number(process.env.FAQ_NEAR_MISS_MIN ?? 0.70);
  const NEAR_MISS_MAX = Number(process.env.FAQ_NEAR_MISS_MAX ?? 0.82);

  const FAQ_RESPONSE_COOLDOWN_SECONDS = Number(process.env.FAQ_RESPONSE_COOLDOWN_SECONDS ?? 12);

  const lastFaqResponseAt = new Map(); // key `${channelId}:${faqId}` -> epochMs

  let faqData = readFaq();
  let fuseIndex = buildFuseIndex(faqData);

  function reload() {
    faqData = readFaq();
    fuseIndex = buildFuseIndex(faqData);
    return { count: faqData.entries.length, version: faqData.version ?? null };
  }

  function nowMs() {
    return Date.now();
  }

  function onCooldown(channelId, faqId) {
    const key = `${channelId}:${faqId}`;
    const t = lastFaqResponseAt.get(key) || 0;
    return nowMs() - t < FAQ_RESPONSE_COOLDOWN_SECONDS * 1000;
  }

  function markResponded(channelId, faqId) {
    lastFaqResponseAt.set(`${channelId}:${faqId}`, nowMs());
  }

  function logNearMiss({ message, questionRaw, questionNorm, match, margin }) {
    // Keep logs lightweight; no PII beyond user id & channel id.
    try {
      const meta = {
        userId: message.author?.id,
        channelId: message.channel?.id,
        guildId: message.guild?.id,
        questionRaw,
        questionNorm,
        matchId: match.entry?.id,
        score01: match.score01,
        margin01: margin
      };
      console.log(`[FAQ][NEAR-MISS] ${JSON.stringify(meta)}`);
    } catch {
      // ignore
    }
  }

  function matchAndRender({ message, questionRaw }) {
    const qNorm = normalize(questionRaw);
    if (!qNorm) return null;

    const match = pickBestMatch(fuseIndex, qNorm);
    if (!match) return null;

    const threshold = match.entry.threshold ?? DEFAULT_THRESHOLD;
    const margin = match.margin01 ?? 0;

    const confident = match.score01 >= threshold && margin >= MIN_MARGIN;

    if (!confident) {
      if (match.score01 >= NEAR_MISS_MIN && match.score01 <= NEAR_MISS_MAX) {
        logNearMiss({ message, questionRaw, questionNorm: qNorm, match, margin });
        console.log(
          `[NEAR-MISS][FAQ] "${questionRaw}" -> ${match.entry.id} score=${match.score01.toFixed(
            3
          )} margin=${margin.toFixed(3)}`
        );
      }
      return null;
    }

    if (onCooldown(message.channelId, match.entry.id)) return null;

    markResponded(message.channelId, match.entry.id);

    console.log(
      `[FAQ] "${questionRaw}" -> ${match.entry.id} score=${match.score01.toFixed(3)} ` +
        `margin=${margin.toFixed(3)}`
    );

    return match.entry.a;
  }

  return {
    reload,
    matchAndRender
  };
}

/**
 * New: registers "info/knowledge" commands that used to live in commands.js
 * - !faq, !faqreload
 * - !wiki
 * - !ng
 * - !rules
 * - !glossary
 */
export function registerInfoCommands(register) {
  const faq = createFaqService();
  const wiki = createWikiService();

  const ngs = loadNgsOnce();
  const glossary = loadGlossaryOnce();

  function isAdmin(message) {
    return (
      message.member?.permissions?.has("Administrator") ||
      message.member?.permissions?.has("ManageGuild")
    );
  }

  register(
    "!faq",
    async ({ message, rest }) => {
      const qRaw = rest.trim();

      if (!qRaw) {
        await message.reply(
          "Please ask a specific question, like: `!faq how do I goldenize?`\n" +
            "You can also browse helpful FAQs here: https://forums.tppc.info/showthread.php?p=11516674#post11516674"
        );
        return;
      }

      const out = faq.matchAndRender({ message, questionRaw: qRaw });
      if (!out) return; // no output if no confident match
      await message.reply(out);
    },
    "!faq <question> — asks the FAQ bot"
  );

  register(
    "!faqreload",
    async ({ message }) => {
      if (!isAdmin(message)) return;

      try {
        const info = faq.reload();
        await message.reply(
          `Reloaded faq.json ✅ (${info.count} entries${info.version ? `, v${info.version}` : ""})`
        );
      } catch (e) {
        console.error("faq reload failed:", e);
        await message.reply("Reload failed ❌ (check console + faq.json formatting)");
      }
    },
    "!faqreload — reloads faq.json (admin)",
    { admin: true }
  );

  // !wiki <term>
  register(
    "!wiki",
    async ({ message, rest }) => {
      const q = rest.trim();
      if (!q) return;

      const results = wiki.search(q);
      if (!results || results.length === 0) return;

      await message.reply(results.map((r) => `• [${r.title}](${r.url})`).join("\n"));
    },
    "!wiki <term> — links matching TPPC wiki pages",
    { aliases: ["!w"] }
  );

  // !ng — show current NG list (first few)
  register(
    "!ng",
    async ({ message }) => {
      if (!ngs.length) return;

      const maxShow = 5;
      const shown = ngs.slice(0, maxShow);
      const extra = ngs.length - shown.length;

      const body =
        shown.map((x) => `• ${x}`).join("\n") + (extra > 0 ? `\n…and ${extra} more.` : "");

      await message.reply(`**Current NGs:**\n${body}`);
    },
    "!ng — shows the current NG list",
    { aliases: ["!ngs"] }
  );

  // !rules <discord/rpg/forums> OR !rules (all)
  register(
    "!rules",
    async ({ message, rest }) => {
      const arg = rest.trim().toLowerCase();

      const links = {
        discord: "https://wiki.tppc.info/Discord%23Rules",
        rpg: "https://forums.tppc.info/forumdisplay.php?f=6",
        forums: "https://forums.tppc.info/showthread.php?t=42"
      };

      if (arg) {
        const url = links[arg];
        if (!url) {
          await message.reply(
            "Invalid argument. Usage: `!rules <discord/rpg/forums>` — returns the corresponding rules link."
          );
          return;
        }
        await message.reply(url);
      } else {
        const allLinks = Object.entries(links)
          .map(([key, url]) => `• **${key}**: ${url}`)
          .join("\n");
        await message.reply(`Here are all the rules links:\n${allLinks}`);
      }
    },
    "!rules <discord/rpg/forums> — returns rules link(s)"
  );

  // !glossary <key> — quick definition lookup
  register(
    "!glossary",
    async ({ message, rest }) => {
      const keyRaw = rest.trim();
      if (!keyRaw) return; // show nothing if user didn't provide a key

      const key = keyRaw.toLowerCase();

      const def = glossary[key];
      if (!def) return; // show nothing if key doesn't exist

      await message.reply(`**${key}** — ${def}`);
    },
    "!glossary <key> — looks up a TPPC term (example: !glossary ul)",
    { aliases: ["!g"] }
  );
}
