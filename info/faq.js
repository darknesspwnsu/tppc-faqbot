import fs from "node:fs";
import path from "node:path";
import Fuse from "fuse.js";
import { createWikiService } from "./wiki.js";
import { isAdminOrPrivileged } from "../auth.js";

/**
 * Read numeric env var from the first key that exists and parses as a number.
 */
function envNumber(...keys) {
  for (const k of keys) {
    const v = process.env[k];
    if (v !== undefined && v !== "") {
      const n = Number(v);
      if (!Number.isNaN(n)) return n;
    }
  }
  return undefined;
}

function normalize(text) {
  return (text ?? "")
    .toLowerCase()
    .replace(/[^a-z0-9\s]/g, " ")
    .replace(/\s+/g, " ")
    .trim();
}

// Keep list conservative. Do NOT remove "not", "no", etc.
function stripStopwords(norm) {
  return String(norm ?? "")
    .replace(
      /\b(i|im|i'm|can|cant|can't|could|would|should|please|plz|the|a|an|to|of|for|on|in|at|is|are|am|do|does|did)\b/g,
      " "
    )
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

  // Server slang (you asked for permissive matching here)
  // NOTE: this maps "ng"/"ngs" -> "goldens". If you ever need "ng" to mean "non-golden",
  // change this back and rely on explicit triggers instead.
  norm = norm.replace(/\bngs\b/g, "goldens");
  norm = norm.replace(/\bng\b/g, "goldens");
  norm = norm.replace(/\bnew golds\b/g, "goldens");
  norm = norm.replace(/\bnew goldens\b/g, "goldens");

  return norm;
}

function readFaq() {
  const filePath = path.join(process.cwd(), "data", "faq.json");
  const raw = fs.readFileSync(filePath, "utf8");
  const json = JSON.parse(raw);

  // Normalize format:
  // - allow either { version, entries:[...] } or [...]
  const entries = Array.isArray(json)
    ? json
    : Array.isArray(json?.entries)
      ? json.entries
      : [];
  const version = Array.isArray(json) ? null : json?.version ?? null;

  const out = [];

  for (const e of entries) {
    if (!e || typeof e !== "object") continue;

    const id = String(e.id ?? "").trim();
    if (!id) continue;

    // -------- NEW FORMAT: { id, q, a } (or question/answer) --------
    const q1 = String(e.q ?? e.question ?? "").trim();
    const a1 = String(e.a ?? e.answer ?? e.response ?? "").trim();
    if (q1 && a1) {
      const questionNorm = normalize(q1);
      const questionAlias = aliasNormalize(questionNorm);
      const questionSW = stripStopwords(questionNorm);
      const questionAliasSW = stripStopwords(questionAlias);

      out.push({
        id,
        q: q1,
        a: a1,
        questionNorm,
        questionAlias,
        questionSW,
        questionAliasSW,
        threshold: typeof e.threshold === "number" ? e.threshold : null
      });
      continue;
    }

    // -------- OLD FORMAT: { id, triggers:[...], response } --------
    const resp = String(e.response ?? e.a ?? e.answer ?? "").trim();
    const triggers = Array.isArray(e.triggers) ? e.triggers : null;

    if (resp && triggers && triggers.length) {
      for (const t of triggers) {
        const q = String(t ?? "").trim();
        if (!q) continue;

        const questionNorm = normalize(q);
        const questionAlias = aliasNormalize(questionNorm);
        const questionSW = stripStopwords(questionNorm);
        const questionAliasSW = stripStopwords(questionAlias);

        out.push({
          id, // keep base id for cooldown + logging
          q,
          a: resp,
          questionNorm,
          questionAlias,
          questionSW,
          questionAliasSW,
          threshold: typeof e.threshold === "number" ? e.threshold : null
        });
      }
    }
  }

  return { version, entries: out };
}

function buildFuseIndex(faqData) {
  // We index both the normalized text and an alias-normalized form (+ stopword-stripped variants)
  return new Fuse(faqData.entries, {
    includeScore: true,
    shouldSort: true,
    threshold: 0.45, // candidate threshold; we apply our own confidence gate below
    ignoreLocation: true,
    minMatchCharLength: 3,
    keys: [
      { name: "questionNorm", weight: 0.45 },
      { name: "questionAlias", weight: 0.35 },
      { name: "questionSW", weight: 0.10 },
      { name: "questionAliasSW", weight: 0.10 }
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
  const qAlias = aliasNormalize(qNorm);
  const qSW = stripStopwords(qNorm);
  const qAliasSW = stripStopwords(qAlias);

  const queries = [];
  const pushQ = (s) => {
    s = String(s || "").trim();
    if (!s) return;
    if (!queries.includes(s)) queries.push(s);
  };

  pushQ(qNorm);
  if (qAlias && qAlias !== qNorm) pushQ(qAlias);
  if (qSW && qSW !== qNorm) pushQ(qSW);
  if (qAliasSW && qAliasSW !== qAlias && qAliasSW !== qSW) pushQ(qAliasSW);

  // Merge results across query variants, keep best score per FAQ id
  const bestById = new Map();

  for (const q of queries) {
    const res = fuse.search(q) || [];
    for (const r of res) {
      const id = r?.item?.id;
      if (!id) continue;
      const prev = bestById.get(id);
      if (!prev || (r.score ?? 999) < (prev.score ?? 999)) bestById.set(id, r);
    }
  }

  const merged = [...bestById.values()].sort(
    (a, b) => (a.score ?? 999) - (b.score ?? 999)
  );
  if (merged.length === 0) return null;

  const best = merged[0];
  const second = merged[1] || null;

  const best01 = score01FromFuse(best.score);
  const second01 = second ? score01FromFuse(second.score) : 0;

  return {
    entry: best.item,
    score01: best01,
    // keep margin for logging only (NOT used for confidence)
    margin01: best01 - second01
  };
}

// Load NG list ONCE (do not reload per command)
function loadNgsOnce() {
  const filePath = path.join(process.cwd(), "data", "ngs.json");
  const raw = fs.readFileSync(filePath, "utf8");
  const data = JSON.parse(raw);

  // Allow either ["A","B"] or {"ngs":["A","B"]}
  const ngs = Array.isArray(data)
    ? data
    : Array.isArray(data?.ngs)
      ? data.ngs
      : null;
  if (!ngs) {
    throw new Error("data/ngs.json must be an array of strings, or { ngs: [...] }");
  }

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
 * FAQ engine
 */
export function createFaqService() {
  // Read BOTH your legacy env keys and newer FAQ_* keys.
  // (You said you want to remove MIN_MARGIN completely — done.)
  const DEFAULT_THRESHOLD =
    envNumber("FAQ_MATCH_THRESHOLD", "DEFAULT_THRESHOLD") ?? 0.82;

  const NEAR_MISS_MIN =
    envNumber("FAQ_NEAR_MISS_MIN", "NEAR_MISS_MIN") ?? 0.70;

  const NEAR_MISS_MAX =
    envNumber("FAQ_NEAR_MISS_MAX", "NEAR_MISS_MAX") ?? 0.82;

  const FAQ_RESPONSE_COOLDOWN_SECONDS =
    envNumber("FAQ_RESPONSE_COOLDOWN_SECONDS", "RESPONSE_COOLDOWN_SECONDS") ?? 12;

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

  function getChannelId(message) {
    return message?.channelId ?? message?.channel?.id ?? "unknown";
  }

  function onCooldown(message, faqId) {
    const channelId = getChannelId(message);
    const key = `${channelId}:${faqId}`;
    const t = lastFaqResponseAt.get(key) || 0;
    return nowMs() - t < FAQ_RESPONSE_COOLDOWN_SECONDS * 1000;
  }

  function markResponded(message, faqId) {
    const channelId = getChannelId(message);
    lastFaqResponseAt.set(`${channelId}:${faqId}`, nowMs());
  }

  function logNearMiss({ message, questionRaw, questionNorm, match }) {
    try {
      const meta = {
        userId: message?.author?.id,
        channelId: getChannelId(message),
        guildId: message?.guild?.id,
        questionRaw,
        questionNorm,
        matchId: match.entry?.id,
        score01: match.score01,
        margin01: match.margin01
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

    // NO MIN_MARGIN: confidence is purely based on score vs threshold
    const confident = match.score01 >= threshold;

    if (!confident) {
      if (match.score01 >= NEAR_MISS_MIN && match.score01 <= NEAR_MISS_MAX) {
        logNearMiss({ message, questionRaw, questionNorm: qNorm, match });
        console.log(
          `[NEAR-MISS][FAQ] "${questionRaw}" -> ${match.entry.id} score=${match.score01.toFixed(
            3
          )} (threshold=${threshold})`
        );
      }
      return null;
    }

    if (FAQ_RESPONSE_COOLDOWN_SECONDS > 0 && onCooldown(message, match.entry.id)) return null;

    markResponded(message, match.entry.id);

    console.log(
      `[FAQ] "${questionRaw}" -> ${match.entry.id} score=${match.score01.toFixed(3)} ` +
        `threshold=${threshold}` +
        ` cooldownSec=${FAQ_RESPONSE_COOLDOWN_SECONDS}`
    );

    return match.entry.a;
  }

  return {
    reload,
    matchAndRender
  };
}

/**
 * Registers "info/knowledge" commands:
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
      if (!isAdminOrPrivileged(message)) return;

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
    "!faqreload — reloads faq.json",
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
