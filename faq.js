import fs from "node:fs";
import path from "node:path";
import Fuse from "fuse.js";

function normalize(text) {
  return (text ?? "")
    .toLowerCase()
    .replace(/[^a-z0-9\s]/g, " ")
    .replace(/\s+/g, " ")
    .trim();
}

// Optional aliases: improves matching without lowering thresholds
function aliasNormalize(norm) {
  norm = norm
    .replace(/\bwhatre\b/g, "what are")
    .replace(/\bwhats\b/g, "what is")
    .replace(/\bgolds\b/g, "goldens")
    .replace(/\bgoldenise\b/g, "goldenize");
  return norm.replace(/\s+/g, " ").trim();
}

function ensureLogDirExists(filePath) {
  const dir = path.dirname(filePath);
  if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
}

export function createFaqService() {
  const DEFAULT_THRESHOLD = Number(process.env.DEFAULT_THRESHOLD ?? 0.95);
  const MIN_MARGIN = Number(process.env.MIN_MARGIN ?? 0.05);

  const FAQ_RESPONSE_COOLDOWN_SECONDS = Number(
    process.env.FAQ_RESPONSE_COOLDOWN_SECONDS ?? 1
  );

  const NEAR_MISS_MIN = Number(process.env.NEAR_MISS_MIN ?? 0.85);
  const NEAR_MISS_MAX = Number(process.env.NEAR_MISS_MAX ?? 0.94);
  const NEAR_MISS_LOG_FILE =
    process.env.NEAR_MISS_LOG_FILE ?? "logs/near_miss.log";

  let faqData = null;
  let fuseIndex = null;

  const lastFaqResponseAt = new Map(); // key: `${channelId}:${faqId}` -> epoch ms

  function readFaq() {
    const p = path.join(process.cwd(), "data", "faq.json");
    const raw = fs.readFileSync(p, "utf8");
    const data = JSON.parse(raw);

    if (!data.entries || !Array.isArray(data.entries)) {
      throw new Error("faq.json invalid: expected { entries: [...] }");
    }

    data.defaultThreshold =
      typeof data.defaultThreshold === "number"
        ? data.defaultThreshold
        : DEFAULT_THRESHOLD;

    for (const e of data.entries) {
      if (!e.id || typeof e.id !== "string") {
        throw new Error("faq.json invalid: each entry needs string 'id'");
      }
      if (!Array.isArray(e.triggers) || e.triggers.length === 0) {
        throw new Error(`faq.json invalid: entry '${e.id}' needs triggers[]`);
      }
      if (typeof e.response !== "string") {
        throw new Error(`faq.json invalid: entry '${e.id}' needs 'response'`);
      }
    }

    return data;
  }

  function buildFuseIndex(data) {
    const rows = [];
    for (const entry of data.entries) {
      for (const trigger of entry.triggers) {
        rows.push({
          entry,
          trigger,
          triggerNorm: aliasNormalize(normalize(trigger))
        });
      }
    }

    return new Fuse(rows, {
      keys: ["triggerNorm"],
      includeScore: true,
      threshold: 0.5, // internal; real gating is score>=threshold
      distance: 100,
      minMatchCharLength: 4,
      ignoreLocation: true
    });
  }

  function ensureLoaded() {
    if (faqData && fuseIndex) return;
    faqData = readFaq();
    fuseIndex = buildFuseIndex(faqData);
  }

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

  // Important: compute "second best" among DIFFERENT FAQ entries
  // so ties within the same entry don't block responses.
  function bestFaqMatch(questionNorm) {
    const results = fuseIndex.search(questionNorm);
    if (!results || results.length === 0) return null;

    const best = results[0];
    const bestEntryId = best.item.entry.id;

    let second = null;
    for (let i = 1; i < results.length; i++) {
      if (results[i].item.entry.id !== bestEntryId) {
        second = results[i];
        break;
      }
    }

    const score01 = 1 - (best.score ?? 1);
    const secondScore01 = second ? 1 - (second.score ?? 1) : 0;

    return {
      entry: best.item.entry,
      bestTrigger: best.item.trigger,
      score01,
      secondScore01
    };
  }

  function logNearMiss({ message, questionRaw, questionNorm, match, margin }) {
    try {
      ensureLogDirExists(NEAR_MISS_LOG_FILE);
      const line = JSON.stringify({
        ts: new Date().toISOString(),
        guildId: message.guildId,
        channelId: message.channelId,
        authorId: message.author?.id,
        authorTag: message.author?.tag,
        raw: message.content,
        questionRaw,
        questionNorm,
        matchedFaqId: match.entry.id,
        bestTrigger: match.bestTrigger,
        score: Number(match.score01.toFixed(3)),
        secondScore: Number(match.secondScore01.toFixed(3)),
        margin: Number(margin.toFixed(3))
      });
      fs.appendFileSync(NEAR_MISS_LOG_FILE, line + "\n", "utf8");
    } catch (e) {
      console.error("Near-miss logging failed:", e);
    }
  }

  // Returns response string or null
  function matchAndRender({ message, questionRaw }) {
    ensureLoaded();

    const qNorm = aliasNormalize(normalize(questionRaw));
    if (!qNorm) return null;

    const match = bestFaqMatch(qNorm);
    if (!match) return null;

    const threshold = Number(
      match.entry.threshold ?? faqData.defaultThreshold ?? DEFAULT_THRESHOLD
    );

    const margin = match.score01 - match.secondScore01;
    const confident = match.score01 >= threshold && margin >= MIN_MARGIN;

    if (!confident) {
      if (match.score01 >= NEAR_MISS_MIN && match.score01 <= NEAR_MISS_MAX) {
        logNearMiss({ message, questionRaw, questionNorm: qNorm, match, margin });
        console.log(
          `[NEAR-MISS][FAQ] "${questionRaw}" -> ${match.entry.id} score=${match.score01.toFixed(
            3
          )} margin=${margin.toFixed(3)} trigger="${match.bestTrigger}"`
        );
      }
      return null;
    }

    if (onCooldown(message.channelId, match.entry.id)) return null;

    markResponded(message.channelId, match.entry.id);

    console.log(
      `[FAQ] "${questionRaw}" -> ${match.entry.id} score=${match.score01.toFixed(3)} ` +
        `margin=${margin.toFixed(3)} trigger="${match.bestTrigger}"`
    );

    return match.entry.response;
  }

  return {
    reload,
    matchAndRender
  };
}
