import fs from "node:fs";
import path from "node:path";
import Fuse from "fuse.js";
import { createWikiService } from "./wiki.js";
import { isAdminOrPrivileged } from "../auth.js";
import { embedTexts, getDefaultLocalEmbeddingModel } from "../shared/local_embeddings.js";

const DEFAULT_LOCAL_EMBEDDING_MODEL = getDefaultLocalEmbeddingModel();

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
      /\b(i|im|i'm|can|cant|can't|could|would|should|please|plz|the|a|an|to|of|for|on|in|at|is|are|am|do|does|did|what|when|why|how)\b/g,
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
  norm = norm.replace(/\btc\b/g, "training challenge");
  norm = norm.replace(/\birl\b/g, "real life money");
  norm = norm.replace(/\bv9\b/g, "version 9");

  // Server slang
  norm = norm.replace(/\bngs\b/g, "goldens");
  norm = norm.replace(/\bng\b/g, "goldens");
  norm = norm.replace(/\bnew golds\b/g, "goldens");
  norm = norm.replace(/\bnew goldens\b/g, "goldens");
  norm = norm.replace(/\bpokes\b/g, "pokemon");
  norm = norm.replace(/\bpoke\b/g, "pokemon");

  return norm;
}

function uniqueStrings(values) {
  const out = [];
  const seen = new Set();

  for (const value of values || []) {
    const text = String(value ?? "").trim();
    if (!text) continue;
    const key = text.toLowerCase();
    if (seen.has(key)) continue;
    seen.add(key);
    out.push(text);
  }

  return out;
}

function asStringArray(value) {
  return Array.isArray(value) ? value.map((item) => String(item ?? "").trim()).filter(Boolean) : [];
}

function tokenize(norm) {
  return uniqueStrings(String(norm ?? "").split(/\s+/).filter(Boolean));
}

const MEANINGLESS_MATCH_TOKENS = new Set([
  "a",
  "an",
  "and",
  "are",
  "at",
  "best",
  "can",
  "current",
  "currently",
  "did",
  "do",
  "does",
  "for",
  "get",
  "guide",
  "help",
  "how",
  "i",
  "if",
  "in",
  "info",
  "is",
  "it",
  "mean",
  "now",
  "of",
  "official",
  "on",
  "or",
  "people",
  "some",
  "the",
  "there",
  "this",
  "time",
  "to",
  "use",
  "what",
  "when",
  "where",
  "why",
  "with"
]);

function meaningfulTokens(tokens) {
  return uniqueStrings(
    (tokens || []).filter((token) => token && token.length >= 3 && !MEANINGLESS_MATCH_TOKENS.has(token))
  );
}

function meaningfulOverlapCount(entry, query) {
  return intersectCount(meaningfulTokens(entry.aggregateTokens), meaningfulTokens(query.aggregateTokens));
}

function preprocessQuestion(text) {
  const raw = String(text ?? "").trim();
  const norm = normalize(raw);
  const alias = aliasNormalize(norm);
  const stopwordStripped = stripStopwords(norm);
  const aliasStopwordStripped = stripStopwords(alias);
  const searchVariants = uniqueStrings([norm, alias, stopwordStripped, aliasStopwordStripped]);
  const tokenSets = searchVariants.map((variant) => tokenize(variant));
  const aggregateTokens = uniqueStrings(tokenSets.flat());

  return {
    raw,
    norm,
    alias,
    stopwordStripped,
    aliasStopwordStripped,
    searchVariants,
    tokenSets,
    aggregateTokens
  };
}

function buildTokenFrequency(variants) {
  const freq = new Map();

  for (const variant of variants) {
    for (const token of variant.aggregateTokens) {
      freq.set(token, (freq.get(token) || 0) + 1);
    }
  }

  return freq;
}

function normalizeFaqEntry(entry) {
  if (!entry || typeof entry !== "object") return null;

  const id = String(entry.id ?? "").trim();
  if (!id) return null;

  const answer = String(entry.a ?? entry.answer ?? entry.response ?? "").trim();
  if (!answer) return null;

  const triggers = asStringArray(entry.triggers);
  const examples = asStringArray(entry.examples);
  const aliases = asStringArray(entry.aliases);
  const keywords = asStringArray(entry.keywords);
  const denyTerms = asStringArray(entry.denyTerms);
  const intentDescription = String(entry.intentDescription ?? entry.intent ?? "").trim();

  const canonicalQuestion = String(
    entry.q ?? entry.question ?? triggers[0] ?? examples[0] ?? aliases[0] ?? keywords[0] ?? ""
  ).trim();
  if (!canonicalQuestion) return null;

  const allVariants = uniqueStrings([
    canonicalQuestion,
    ...examples,
    ...triggers,
    ...aliases,
    ...keywords
  ]);

  const processedVariants = allVariants
    .map((variant) => preprocessQuestion(variant))
    .filter((variant) => variant.norm);

  if (!processedVariants.length) return null;

  const canonicalProcessed = preprocessQuestion(canonicalQuestion);
  const aggregateTokens = uniqueStrings(processedVariants.flatMap((variant) => variant.aggregateTokens));

  return {
    id,
    q: canonicalQuestion,
    a: answer,
    threshold: typeof entry.threshold === "number" ? entry.threshold : null,
    intentDescription,
    variants: allVariants,
    denyTerms,
    processedVariants,
    canonicalProcessed,
    aggregateTokens,
    tokenFrequency: buildTokenFrequency(processedVariants)
  };
}

function resolveFaqPath(fileName) {
  if (path.isAbsolute(fileName)) return fileName;
  return path.join(process.cwd(), fileName);
}

function readFaqFiles(fileNames) {
  const fileList =
    Array.isArray(fileNames) && fileNames.length ? fileNames : ["data/faq.json"];

  const mergedEntries = new Map();
  let version = null;

  for (const fileName of fileList) {
    const filePath = resolveFaqPath(fileName);
    const raw = fs.readFileSync(filePath, "utf8");
    const json = JSON.parse(raw);
    const entries = Array.isArray(json)
      ? json
      : Array.isArray(json?.entries)
      ? json.entries
        : [];

    if (version == null && json && !Array.isArray(json) && json.version != null) {
      version = json.version;
    }

    for (const entry of entries) {
      const normalized = normalizeFaqEntry(entry);
      if (!normalized) continue;
      mergedEntries.set(normalized.id, normalized);
    }
  }

  return {
    version,
    entries: [...mergedEntries.values()]
  };
}

function buildFuseIndex(entries) {
  const docs = [];

  for (const entry of entries) {
    for (const variant of entry.processedVariants) {
      docs.push({
        id: entry.id,
        q: entry.q,
        variantNorm: variant.norm,
        variantAlias: variant.alias,
        variantSW: variant.stopwordStripped,
        variantAliasSW: variant.aliasStopwordStripped
      });
    }
  }

  return new Fuse(docs, {
    includeScore: true,
    shouldSort: true,
    threshold: 0.42,
    ignoreLocation: true,
    minMatchCharLength: 2,
    keys: [
      { name: "variantNorm", weight: 0.45 },
      { name: "variantAlias", weight: 0.30 },
      { name: "variantSW", weight: 0.15 },
      { name: "variantAliasSW", weight: 0.10 }
    ]
  });
}

function clamp01(x) {
  if (!Number.isFinite(x)) return 0;
  return Math.max(0, Math.min(1, x));
}

function score01FromFuse(score) {
  const s = Number(score);
  if (!Number.isFinite(s)) return 0;
  return clamp01(1 - s);
}

function intersectCount(a, b) {
  if (!a.length || !b.length) return 0;
  const bSet = new Set(b);
  let count = 0;
  for (const item of a) {
    if (bSet.has(item)) count += 1;
  }
  return count;
}

function diceCoefficient(a, b) {
  if (!a.length || !b.length) return 0;
  return (2 * intersectCount(a, b)) / (a.length + b.length);
}

function computeDocumentFrequency(entries) {
  const docFreq = new Map();

  for (const entry of entries) {
    for (const token of entry.aggregateTokens) {
      docFreq.set(token, (docFreq.get(token) || 0) + 1);
    }
  }

  return docFreq;
}

function computeIdfMap(entries) {
  const docFreq = computeDocumentFrequency(entries);
  const totalDocs = Math.max(entries.length, 1);
  const idf = new Map();

  for (const [token, df] of docFreq.entries()) {
    idf.set(token, Math.log(1 + totalDocs / (1 + df)) + 1);
  }

  return idf;
}

function vectorMagnitude(freqMap, idfMap) {
  let sum = 0;

  for (const [token, count] of freqMap.entries()) {
    const weight = count * (idfMap.get(token) || 1);
    sum += weight * weight;
  }

  return Math.sqrt(sum);
}

function cosineSimilarity(queryFreq, queryMagnitude, entryFreq, entryMagnitude, idfMap) {
  if (!queryMagnitude || !entryMagnitude) return 0;

  let dot = 0;
  for (const [token, qCount] of queryFreq.entries()) {
    const eCount = entryFreq.get(token);
    if (!eCount) continue;
    const weight = idfMap.get(token) || 1;
    dot += qCount * eCount * weight * weight;
  }

  return clamp01(dot / (queryMagnitude * entryMagnitude));
}

function buildFaqIndex(faqData) {
  const idfMap = computeIdfMap(faqData.entries);
  const entries = faqData.entries.map((entry) => ({
    ...entry,
    vectorMagnitude: vectorMagnitude(entry.tokenFrequency, idfMap)
  }));

  return {
    entries,
    idfMap,
    fuse: buildFuseIndex(entries)
  };
}

function dotProduct(a, b) {
  let sum = 0;
  const n = Math.min(a.length, b.length);
  for (let i = 0; i < n; i += 1) sum += a[i] * b[i];
  return sum;
}

function vectorNorm(vector) {
  return Math.sqrt(dotProduct(vector, vector));
}

function cosineVectorSimilarity(a, b) {
  if (!Array.isArray(a) || !Array.isArray(b) || !a.length || !b.length) return 0;
  const denom = vectorNorm(a) * vectorNorm(b);
  if (!denom) return 0;
  return clamp01(dotProduct(a, b) / denom);
}

function buildEntryEmbeddingText(entry) {
  return [
    `FAQ: ${entry.q}`,
    ...(entry.intentDescription ? [`Intent: ${entry.intentDescription}`] : []),
    ...entry.variants.slice(0, 16).map((variant) => `Example: ${variant}`)
  ].join("\n");
}

async function buildEmbeddingIndex({ entries, model }) {
  const texts = entries.map((entry) => buildEntryEmbeddingText(entry));
  const embeddings = await embedTexts(texts, { model });
  return new Map(entries.map((entry, index) => [entry.id, embeddings[index]]));
}

function bestFuseScores(fuse, query) {
  const bestById = new Map();

  for (const variant of query.searchVariants) {
    if (!variant) continue;
    const results = fuse.search(variant) || [];

    for (const result of results) {
      const id = result?.item?.id;
      if (!id) continue;
      const score01 = score01FromFuse(result.score);
      const prev = bestById.get(id);
      if (!prev || score01 > prev.score01) {
        bestById.set(id, {
          score01,
          matchedVariant: result.item?.variantNorm || ""
        });
      }
    }
  }

  return bestById;
}

function computePhraseScore(entry, query) {
  let best = 0;

  for (const queryVariant of query.searchVariants) {
    if (!queryVariant) continue;

    for (const entryVariant of entry.processedVariants) {
      const candidates = uniqueStrings([
        entryVariant.norm,
        entryVariant.alias,
        entryVariant.stopwordStripped,
        entryVariant.aliasStopwordStripped
      ]);

      for (const candidate of candidates) {
        if (!candidate) continue;
        if (queryVariant === candidate) return 1;
        if (queryVariant.length >= 4 && candidate.includes(queryVariant)) best = Math.max(best, 0.92);
        if (candidate.length >= 4 && queryVariant.includes(candidate)) best = Math.max(best, 0.88);
      }
    }
  }

  return best;
}

function computeOverlapScore(entry, query) {
  let best = 0;

  for (const tokenSet of query.tokenSets) {
    for (const variant of entry.processedVariants) {
      best = Math.max(best, diceCoefficient(tokenSet, variant.aggregateTokens));
    }
  }

  return clamp01(best);
}

function computeDenyScore(entry, query) {
  const denyTerms = Array.isArray(entry?.denyTerms) ? entry.denyTerms : [];
  if (!denyTerms.length) return 0;

  let best = 0;
  for (const denyTermRaw of denyTerms) {
    const denyTerm = preprocessQuestion(denyTermRaw);
    for (const variant of query.searchVariants) {
      if (!variant) continue;
      for (const denyVariant of denyTerm.searchVariants) {
        if (!denyVariant) continue;
        if (variant === denyVariant) best = Math.max(best, 1);
        else if (denyVariant.length >= 4 && variant.includes(denyVariant)) best = Math.max(best, 0.9);
        else if (variant.length >= 4 && denyVariant.includes(variant)) best = Math.max(best, 0.8);
      }
    }
  }

  return clamp01(best);
}

function buildQueryVector(query) {
  const freq = new Map();
  for (const token of query.aggregateTokens) {
    freq.set(token, (freq.get(token) || 0) + 1);
  }
  return freq;
}

function rankFaqCandidates(index, query, limit = 5) {
  const queryVector = buildQueryVector(query);
  const queryMagnitude = vectorMagnitude(queryVector, index.idfMap);
  const fuseScores = bestFuseScores(index.fuse, query);

  const candidates = index.entries
    .map((entry) => {
      const fuseHit = fuseScores.get(entry.id);
      const fuseScore = fuseHit?.score01 ?? 0;
      const overlapScore = computeOverlapScore(entry, query);
      const semanticScore = cosineSimilarity(
        queryVector,
        queryMagnitude,
        entry.tokenFrequency,
        entry.vectorMagnitude,
        index.idfMap
      );
      const phraseScore = computePhraseScore(entry, query);
      const denyScore = computeDenyScore(entry, query);
      const meaningfulOverlap = meaningfulOverlapCount(entry, query);

      let score01;
      if (phraseScore >= 1) {
        score01 = 1;
      } else {
        score01 = clamp01(
          0.40 * fuseScore +
            0.35 * semanticScore +
            0.20 * overlapScore +
            0.05 * phraseScore -
            0.25 * denyScore
        );
      }

      return {
        entry,
        score01,
        components: {
          fuse: fuseScore,
          semantic: semanticScore,
          overlap: overlapScore,
          phrase: phraseScore,
          deny: denyScore,
          meaningfulOverlap
        },
        matchedVariant: fuseHit?.matchedVariant ?? entry.q
      };
    })
    .sort((a, b) => b.score01 - a.score01 || b.components.phrase - a.components.phrase);

  const best = candidates[0] || null;
  const second = candidates[1] || null;
  const margin01 = best ? best.score01 - (second?.score01 ?? 0) : 0;

  return {
    best: best ? { ...best, margin01 } : null,
    candidates: candidates.slice(0, limit)
  };
}

function rankEmbeddingHybridCandidates({ index, lexicalCandidates, entryEmbeddings, queryEmbedding, limit = 5 }) {
  const lexicalById = new Map(lexicalCandidates.map((candidate) => [candidate.entry.id, candidate]));

  const ranked = index.entries
    .map((entry) => {
      const lexical = lexicalById.get(entry.id);
      const embedding = cosineVectorSimilarity(queryEmbedding, entryEmbeddings.get(entry.id));
      const fuse = lexical?.components?.fuse ?? 0;
      const tfidf = lexical?.components?.semantic ?? 0;
      const overlap = lexical?.components?.overlap ?? 0;
      const phrase = lexical?.components?.phrase ?? 0;
      const deny = lexical?.components?.deny ?? 0;
      const meaningfulOverlap = lexical?.components?.meaningfulOverlap ?? 0;
      const lexicalHybrid = lexical?.score01 ?? 0;
      const score01 = clamp01(
        0.62 * embedding +
          0.18 * fuse +
          0.10 * tfidf +
          0.06 * overlap +
          0.04 * phrase -
          0.25 * deny
      );

      return {
        entry,
        score01,
        components: {
          embedding,
          lexical: lexicalHybrid,
          fuse,
          tfidf,
          overlap,
          phrase,
          deny,
          meaningfulOverlap
        },
        matchedVariant: lexical?.matchedVariant ?? entry.q
      };
    })
    .sort((a, b) => b.score01 - a.score01 || b.components.embedding - a.components.embedding);

  const best = ranked[0] || null;
  const second = ranked[1] || null;
  const margin01 = best ? best.score01 - (second?.score01 ?? 0) : 0;

  return {
    best: best ? { ...best, margin01 } : null,
    candidates: ranked.slice(0, limit)
  };
}

function formatFaqDebug(result) {
  if (!result?.candidates?.length) return "No FAQ candidates found.";

  const lines = result.candidates.map((candidate, index) => {
    const componentText = Object.entries(candidate.components || {})
      .map(([key, value]) =>
        `${key}=${typeof value === "number" ? value.toFixed(3) : String(value)}`
      )
      .join(" | ");
    return [
      `${index + 1}. ${candidate.entry.id}`,
      `score=${candidate.score01.toFixed(3)}`,
      componentText,
      `q="${candidate.entry.q}"`
    ].join(" | ");
  });

  const best = result.best;
  const threshold = best?.entry?.threshold ?? result.defaultThreshold;

  return [
    `Method: ${result.method || "unknown"}`,
    `Query: ${result.questionRaw}`,
    `Normalized: ${result.questionNorm || "(empty)"}`,
    `Decision: ${result.decision?.type || "abstain"}`,
    `Threshold: ${threshold.toFixed(3)}`,
    `Margin: ${(best?.margin01 ?? 0).toFixed(3)}`,
    "",
    ...lines
  ].join("\n");
}

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
export function createFaqService(options = {}) {
  const faqFiles =
    Array.isArray(options.faqFiles) && options.faqFiles.length ? options.faqFiles : ["data/faq.json"];
  const EMBEDDING_MODEL =
    String(process.env.FAQ_LOCAL_EMBEDDING_MODEL || DEFAULT_LOCAL_EMBEDDING_MODEL).trim() ||
    DEFAULT_LOCAL_EMBEDDING_MODEL;

  const NEAR_MISS_MIN =
    envNumber("FAQ_NEAR_MISS_MIN", "NEAR_MISS_MIN") ?? 0.60;

  const FAQ_RESPONSE_COOLDOWN_SECONDS =
    envNumber("FAQ_RESPONSE_COOLDOWN_SECONDS", "RESPONSE_COOLDOWN_SECONDS") ?? 12;

  const FAQ_MIN_MARGIN =
    envNumber("FAQ_MIN_MARGIN", "MIN_MARGIN") ?? 0.035;

  const FAQ_CLARIFY_MIN_MARGIN =
    envNumber("FAQ_CLARIFY_MIN_MARGIN") ?? 0.04;
  const FAQ_MEANINGFUL_OVERLAP_MIN =
    envNumber("FAQ_MEANINGFUL_OVERLAP_MIN") ?? 3;

  const lastFaqResponseAt = new Map(); // key `${channelId}:${faqId}` -> epochMs

  let faqData = readFaqFiles(faqFiles);
  let faqIndex = buildFaqIndex(faqData);
  let embeddingIndexPromise = null;
  let embeddingDisabledReason = null;
  const queryEmbeddingPromiseByText = new Map();

  function reload() {
    faqData = readFaqFiles(faqFiles);
    faqIndex = buildFaqIndex(faqData);
    embeddingIndexPromise = null;
    embeddingDisabledReason = null;
    queryEmbeddingPromiseByText.clear();
    return { count: faqData.entries.length, version: faqData.version ?? null };
  }

  function thresholdForMethod(method) {
    if (method === "local_embedding_hybrid") {
      return envNumber("FAQ_LOCAL_EMBEDDING_THRESHOLD") ?? 0.53;
    }
    return envNumber("FAQ_LEXICAL_THRESHOLD", "FAQ_MATCH_THRESHOLD", "DEFAULT_THRESHOLD") ?? 0.43;
  }

  function clarifyThresholdForMethod(method) {
    if (method === "local_embedding_hybrid") {
      const answerThreshold = thresholdForMethod(method);
      return Math.min(answerThreshold, envNumber("FAQ_LOCAL_EMBEDDING_CLARIFY_THRESHOLD") ?? 0.47);
    }

    const answerThreshold = thresholdForMethod(method);
    return Math.min(answerThreshold, envNumber("FAQ_LEXICAL_CLARIFY_THRESHOLD") ?? 0.40);
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

  async function ensureEmbeddingIndex() {
    if (embeddingDisabledReason) return null;
    if (!embeddingIndexPromise) {
      embeddingIndexPromise = buildEmbeddingIndex({
        entries: faqIndex.entries,
        model: EMBEDDING_MODEL
      }).catch((error) => {
        embeddingDisabledReason = error?.message || "unknown embedding error";
        console.error("[FAQ][EMBEDDINGS] disabled:", error);
        return null;
      });
    }
    return embeddingIndexPromise;
  }

  async function warmup() {
    const [entryEmbeddings] = await Promise.all([
      ensureEmbeddingIndex(),
      getQueryEmbedding("faq warmup")
    ]);
    return Boolean(entryEmbeddings && !embeddingDisabledReason);
  }

  async function getQueryEmbedding(questionRaw) {
    const cacheKey = `${EMBEDDING_MODEL}:${questionRaw}`;
    if (!queryEmbeddingPromiseByText.has(cacheKey)) {
      const promise = embedTexts([questionRaw], {
        model: EMBEDDING_MODEL
      })
        .then((rows) => rows[0] || null)
        .catch((error) => {
          embeddingDisabledReason = error?.message || "unknown query embedding error";
          console.error("[FAQ][EMBEDDINGS] query failed:", error);
          return null;
        });
      queryEmbeddingPromiseByText.set(cacheKey, promise);
    }
    return queryEmbeddingPromiseByText.get(cacheKey);
  }

  function debugMatchLexical({ questionRaw, limit = 5 }) {
    const query = preprocessQuestion(questionRaw);
    if (!query.norm) {
      const result = {
        method: "hybrid_lexical",
        questionRaw,
        questionNorm: "",
        defaultThreshold: thresholdForMethod("hybrid_lexical"),
        decision: { type: "abstain", reason: "empty_query" },
        best: null,
        candidates: []
      };
      return result;
    }

    const ranked = rankFaqCandidates(faqIndex, query, limit);
    const result = {
      method: "hybrid_lexical",
      questionRaw,
      questionNorm: query.norm,
      defaultThreshold: thresholdForMethod("hybrid_lexical"),
      decision: null,
      best: ranked.best,
      candidates: ranked.candidates
    };
    result.decision = classifyDecision(result);
    return result;
  }

  async function debugMatch({ questionRaw, limit = 5 }) {
    const lexical = debugMatchLexical({ questionRaw, limit });
    if (!lexical.questionNorm) return lexical;

    const [entryEmbeddings, queryEmbedding] = await Promise.all([
      ensureEmbeddingIndex(),
      getQueryEmbedding(questionRaw)
    ]);

    if (!entryEmbeddings || !queryEmbedding || embeddingDisabledReason) {
      return lexical;
    }

    const query = preprocessQuestion(questionRaw);
    const lexicalAll = rankFaqCandidates(faqIndex, query);
    const ranked = rankEmbeddingHybridCandidates({
      index: faqIndex,
      lexicalCandidates: lexicalAll.candidates,
      entryEmbeddings,
      queryEmbedding,
      limit
    });

    const result = {
      method: "local_embedding_hybrid",
      questionRaw,
      questionNorm: query.norm,
      defaultThreshold: thresholdForMethod("local_embedding_hybrid"),
      decision: null,
      best: ranked.best,
      candidates: ranked.candidates
    };
    result.decision = classifyDecision(result);
    return result;
  }

  function classifyDecision(result) {
    const match = result?.best;
    if (!match) {
      return { type: "abstain", reason: "no_match" };
    }

    const answerThreshold = match.entry.threshold ?? thresholdForMethod(result.method);
    const clarifyThreshold = Math.min(answerThreshold, clarifyThresholdForMethod(result.method));
    const highConfidence = match.score01 >= Math.min(0.98, answerThreshold + 0.10);

    if (
      match.score01 >= answerThreshold &&
      (match.margin01 >= FAQ_MIN_MARGIN || highConfidence)
    ) {
      return {
        type: "answer",
        answerThreshold,
        clarifyThreshold
      };
    }

    if (
      match.score01 >= clarifyThreshold &&
      match.margin01 >= FAQ_CLARIFY_MIN_MARGIN &&
      ((match.components?.meaningfulOverlap ?? 0) >= FAQ_MEANINGFUL_OVERLAP_MIN || highConfidence)
    ) {
      return {
        type: "clarify",
        answerThreshold,
        clarifyThreshold
      };
    }

    return {
      type: "abstain",
      reason: "below_threshold",
      answerThreshold,
      clarifyThreshold
    };
  }

  function logNearMiss({ message, questionRaw, questionNorm, match, threshold }) {
    try {
      const meta = {
        userId: message?.author?.id,
        channelId: getChannelId(message),
        guildId: message?.guild?.id,
        questionRaw,
        questionNorm,
        matchId: match.entry?.id,
        score01: match.score01,
        margin01: match.margin01,
        threshold,
        components: match.components
      };
      console.log(`[FAQ][NEAR-MISS] ${JSON.stringify(meta)}`);
    } catch {
      // ignore
    }
  }

  async function matchAndRender({ message, questionRaw }) {
    const result = await debugMatch({ questionRaw, limit: 5 });
    const match = result.best;
    if (!match) return null;

    const decision = classifyDecision(result);
    result.decision = decision;

    if (decision.type === "abstain") {
      const threshold = decision.answerThreshold ?? thresholdForMethod(result.method);
      if (match.score01 >= NEAR_MISS_MIN) {
        logNearMiss({
          message,
          questionRaw,
          questionNorm: result.questionNorm,
          match,
          threshold
        });
        console.log(
          `[NEAR-MISS][FAQ] "${questionRaw}" -> ${match.entry.id} score=${match.score01.toFixed(
            3
          )} margin=${match.margin01.toFixed(3)} threshold=${threshold.toFixed(3)}`
        );
      }
      return null;
    }

    if (FAQ_RESPONSE_COOLDOWN_SECONDS > 0 && onCooldown(message, match.entry.id)) return null;

    markResponded(message, match.entry.id);
    const threshold = decision.answerThreshold ?? thresholdForMethod(result.method);

    console.log(
      `[FAQ][${result.method}][${decision.type}] "${questionRaw}" -> ${match.entry.id} score=${match.score01.toFixed(3)} ` +
        `margin=${match.margin01.toFixed(3)} threshold=${threshold.toFixed(3)} ` +
        `cooldownSec=${FAQ_RESPONSE_COOLDOWN_SECONDS}`
    );

    if (decision.type === "clarify") {
      return `Best FAQ match: ${match.entry.q}\n${match.entry.a}`;
    }

    return match.entry.a;
  }

  return {
    reload,
    warmup,
    debugMatch,
    formatDebug: formatFaqDebug,
    matchAndRender
  };
}

function requireFaqQuestion(registerName, questionRaw) {
  if (questionRaw) return null;
  return (
    `Please ask a specific question, like: \`${registerName} how do I goldenize?\`\n` +
    "You can also browse helpful FAQs here: https://forums.tppc.info/showthread.php?p=11516674#post11516674"
  );
}

async function replyOrSend(message, content) {
  try {
    await message.reply(content);
  } catch (error) {
    const code = error?.code;
    const messageText = String(error?.message ?? "");
    const unknownReference =
      code === 50035 && messageText.includes("MESSAGE_REFERENCE_UNKNOWN_MESSAGE");

    if (!unknownReference) throw error;
    await message.channel?.send?.(content);
  }
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

  faq.warmup().catch((error) => {
    console.warn("[FAQ] warmup failed:", error?.message ?? error);
  });

  const ngs = loadNgsOnce();
  const glossary = loadGlossaryOnce();

  register(
    "!faq",
    async ({ message, rest }) => {
      const qRaw = rest.trim();
      const helpText = requireFaqQuestion("!faq", qRaw);
      if (helpText) {
        await replyOrSend(message, helpText);
        return;
      }

      const out = await faq.matchAndRender({ message, questionRaw: qRaw });
      if (!out) return;
      await replyOrSend(message, out);
    },
    "!faq <question> — asks the FAQ bot"
  );

  register(
    "!faqdebug",
    async ({ message, rest }) => {
      if (!isAdminOrPrivileged(message)) return;

      const qRaw = rest.trim();
      const helpText = requireFaqQuestion("!faqdebug", qRaw);
      if (helpText) {
        await message.reply(helpText);
        return;
      }

      const result = await faq.debugMatch({ questionRaw: qRaw, limit: 5 });
      await message.reply("```text\n" + faq.formatDebug(result) + "\n```");
    },
    "!faqdebug <question> — shows FAQ scoring details",
    { admin: true }
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
        await message.reply("Reload failed ❌ (check console + faq JSON formatting)");
      }
    },
    "!faqreload — reloads FAQ data",
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
      if (!keyRaw) return;

      const key = keyRaw.toLowerCase();
      const def = glossary[key];
      if (!def) return;

      await message.reply(`**${key}** — ${def}`);
    },
    "!glossary <key> — looks up a TPPC term (example: !glossary ul)",
    { aliases: ["!g"] }
  );
}
