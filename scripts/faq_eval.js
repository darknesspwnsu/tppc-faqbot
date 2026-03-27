import fs from "node:fs";
import path from "node:path";
import Fuse from "fuse.js";
import { embedTexts, getDefaultLocalEmbeddingModel } from "../shared/local_embeddings.js";

const DEFAULT_CORPUS_FILES = ["data/faq.json"];
const DEFAULT_EVAL_FILE = "data/faq_eval.json";
const DEFAULT_NEGATIVE_EVAL_FILE = "data/faq_negative_eval.json";
const DEFAULT_EMBEDDING_MODEL =
  process.env.FAQ_LOCAL_EMBEDDING_MODEL || getDefaultLocalEmbeddingModel();

function normalize(text) {
  return (text ?? "")
    .toLowerCase()
    .replace(/[^a-z0-9\s]/g, " ")
    .replace(/\s+/g, " ")
    .trim();
}

function stripStopwords(norm) {
  return String(norm ?? "")
    .replace(
      /\b(i|im|i'm|can|cant|can't|could|would|should|please|plz|the|a|an|to|of|for|on|in|at|is|are|am|do|does|did|what|when|why|how)\b/g,
      " "
    )
    .replace(/\s+/g, " ")
    .trim();
}

function aliasNormalize(norm) {
  norm = String(norm ?? "");
  norm = norm.replace(/\bxe\b/g, "experience");
  norm = norm.replace(/\bxp\b/g, "experience");
  norm = norm.replace(/\bexp\b/g, "experience");
  norm = norm.replace(/\bue\b/g, "ungendered");
  norm = norm.replace(/\bug\b/g, "ungendered");
  norm = norm.replace(/\btc\b/g, "training challenge");
  norm = norm.replace(/\birl\b/g, "real life money");
  norm = norm.replace(/\bv9\b/g, "version 9");
  norm = norm.replace(/\bngs\b/g, "goldens");
  norm = norm.replace(/\bng\b/g, "goldens");
  norm = norm.replace(/\bnew golds\b/g, "goldens");
  norm = norm.replace(/\bnew goldens\b/g, "goldens");
  norm = norm.replace(/\bpokes\b/g, "pokemon");
  norm = norm.replace(/\bpoke\b/g, "pokemon");
  norm = norm.replace(/\bmon\b/g, "pokemon");
  norm = norm.replace(/\bmons\b/g, "pokemon");
  norm = norm.replace(/\beta\b/g, "release date");
  norm = norm.replace(/\bautoclicker\b/g, "automate clicking");
  norm = norm.replace(/\bmacroing\b/g, "macro");
  norm = norm.replace(/\bscammer\b/g, "scammed");
  norm = norm.replace(/\bpaypal\b/g, "real life money");
  norm = norm.replace(/\birl money\b/g, "real life money");
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

function readJson(filePath) {
  return JSON.parse(fs.readFileSync(path.join(process.cwd(), filePath), "utf8"));
}

function asStringArray(value) {
  return Array.isArray(value) ? value.map((item) => String(item ?? "").trim()).filter(Boolean) : [];
}

function buildTokenFrequency(processedVariants) {
  const freq = new Map();
  for (const variant of processedVariants) {
    for (const token of variant.aggregateTokens) {
      freq.set(token, (freq.get(token) || 0) + 1);
    }
  }
  return freq;
}

function normalizeFaqEntry(entry) {
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

  const variants = uniqueStrings([canonicalQuestion, ...examples, ...triggers, ...aliases, ...keywords]);
  const processedVariants = variants.map((variant) => preprocessQuestion(variant)).filter((variant) => variant.norm);
  const aggregateTokens = uniqueStrings(processedVariants.flatMap((variant) => variant.aggregateTokens));

  return {
    id,
    q: canonicalQuestion,
    a: answer,
    variants,
    intentDescription,
    denyTerms,
    processedVariants,
    aggregateTokens,
    tokenFrequency: buildTokenFrequency(processedVariants)
  };
}

function loadFaqCorpus(fileNames = DEFAULT_CORPUS_FILES) {
  const merged = new Map();

  for (const fileName of fileNames) {
    const json = readJson(fileName);
    const entries = Array.isArray(json) ? json : Array.isArray(json?.entries) ? json.entries : [];
    for (const entry of entries) {
      const normalized = normalizeFaqEntry(entry);
      if (!normalized) continue;
      merged.set(normalized.id, normalized);
    }
  }

  return [...merged.values()];
}

function loadEvalSet(fileName = DEFAULT_EVAL_FILE) {
  const json = readJson(fileName);
  const entries = Array.isArray(json) ? json : Array.isArray(json?.entries) ? json.entries : [];

  return entries.map((entry, index) => ({
    index,
    question: String(entry.question ?? "").trim(),
    expectedId: entry.expectedId == null ? null : String(entry.expectedId),
    tags: uniqueStrings(entry.tags ?? []).map((tag) => String(tag))
  }));
}

function loadNegativeEvalSet(fileName = DEFAULT_NEGATIVE_EVAL_FILE) {
  const json = readJson(fileName);
  const entries = Array.isArray(json) ? json : Array.isArray(json?.entries) ? json.entries : [];

  return entries.map((entry, index) => ({
    index,
    question: String(entry.question ?? "").trim(),
    tags: uniqueStrings(entry.tags ?? []).map((tag) => String(tag))
  }));
}

function score01FromFuse(score) {
  const s = Number(score);
  if (!Number.isFinite(s)) return 0;
  return Math.max(0, Math.min(1, 1 - s));
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

function computeIdfMap(entries) {
  const docFreq = new Map();

  for (const entry of entries) {
    for (const token of entry.aggregateTokens) {
      docFreq.set(token, (docFreq.get(token) || 0) + 1);
    }
  }

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

function cosineSimilarity(freqA, magA, freqB, magB, idfMap) {
  if (!magA || !magB) return 0;
  let dot = 0;
  for (const [token, countA] of freqA.entries()) {
    const countB = freqB.get(token);
    if (!countB) continue;
    const weight = idfMap.get(token) || 1;
    dot += countA * countB * weight * weight;
  }
  return Math.max(0, Math.min(1, dot / (magA * magB)));
}

function buildQueryVector(tokens) {
  const freq = new Map();
  for (const token of tokens) {
    freq.set(token, (freq.get(token) || 0) + 1);
  }
  return freq;
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

function buildLexicalIndex(entries) {
  const idfMap = computeIdfMap(entries);
  const fuse = buildFuseIndex(entries);
  const entryMap = new Map();

  for (const entry of entries) {
    entryMap.set(entry.id, {
      ...entry,
      vectorMagnitude: vectorMagnitude(entry.tokenFrequency, idfMap)
    });
  }

  return {
    entries: [...entryMap.values()],
    entryMap,
    idfMap,
    fuse
  };
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
        bestById.set(id, { score01, matchedVariant: result.item?.variantNorm || "" });
      }
    }
  }

  return bestById;
}

function computeOverlapScore(entry, query) {
  let best = 0;
  for (const tokenSet of query.tokenSets) {
    for (const variant of entry.processedVariants) {
      best = Math.max(best, diceCoefficient(tokenSet, variant.aggregateTokens));
    }
  }
  return Math.max(0, Math.min(1, best));
}

function computePhraseScore(entry, query) {
  let best = 0;

  for (const queryVariant of query.searchVariants) {
    if (!queryVariant) continue;

    for (const variant of entry.processedVariants) {
      const candidates = uniqueStrings([
        variant.norm,
        variant.alias,
        variant.stopwordStripped,
        variant.aliasStopwordStripped
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

  return Math.max(0, Math.min(1, best));
}

function rankLexicalCandidates(index, query) {
  const queryVector = buildQueryVector(query.aggregateTokens);
  const queryMagnitude = vectorMagnitude(queryVector, index.idfMap);
  const fuseScores = bestFuseScores(index.fuse, query);

  return index.entries
    .map((entry) => {
      const fuseHit = fuseScores.get(entry.id);
      const fuseScore = fuseHit?.score01 ?? 0;
      const tfidfScore = cosineSimilarity(
        queryVector,
        queryMagnitude,
        entry.tokenFrequency,
        entry.vectorMagnitude,
        index.idfMap
      );
      const overlapScore = computeOverlapScore(entry, query);
      const phraseScore = computePhraseScore(entry, query);
      const denyScore = computeDenyScore(entry, query);
      const meaningfulOverlap = meaningfulOverlapCount(entry, query);
      const hybridScore =
        phraseScore >= 1
          ? 1
          : Math.max(
              0,
              Math.min(
                1,
                0.40 * fuseScore +
                  0.35 * tfidfScore +
                  0.20 * overlapScore +
                  0.05 * phraseScore -
                  0.25 * denyScore
              )
            );

      return {
        entry,
        scores: {
          fuse: fuseScore,
          tfidf: tfidfScore,
          overlap: overlapScore,
          phrase: phraseScore,
          deny: denyScore,
          meaningfulOverlap,
          hybrid: hybridScore
        }
      };
    })
    .sort((a, b) => b.scores.hybrid - a.scores.hybrid);
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
  const denom = vectorNorm(a) * vectorNorm(b);
  if (!denom) return 0;
  return Math.max(0, Math.min(1, dotProduct(a, b) / denom));
}

function buildEntryEmbeddingText(entry) {
  return [
    `FAQ: ${entry.q}`,
    ...(entry.intentDescription ? [`Intent: ${entry.intentDescription}`] : []),
    ...entry.variants.slice(0, 16).map((variant) => `Example: ${variant}`)
  ].join("\n");
}

async function buildEmbeddingIndex(entries, model = DEFAULT_EMBEDDING_MODEL) {
  const texts = entries.map((entry) => buildEntryEmbeddingText(entry));
  const vectors = await embedTexts(texts, { model });
  const entryVectors = new Map(entries.map((entry, index) => [entry.id, vectors[index]]));
  return { model, entryVectors };
}

function rankEmbeddingCandidates(entries, embeddingIndex, queryEmbedding) {
  return entries
    .map((entry) => ({
      entry,
      score: cosineVectorSimilarity(queryEmbedding, embeddingIndex.entryVectors.get(entry.id))
    }))
    .sort((a, b) => b.score - a.score);
}

function pickTop(entries, getScore, scoreName) {
  return entries
    .map((row) => ({
      entry: row.entry,
      score: getScore(row),
      scores: row.scores || { [scoreName]: getScore(row) }
    }))
    .sort((a, b) => b.score - a.score);
}

function evaluateMethod(methodName, evalEntries, ranker, options = {}) {
  const rows = [];
  let correct = 0;
  let top3Correct = 0;

  for (const item of evalEntries) {
    const ranked = ranker(item.question);
    const top1 = ranked[0]?.entry?.id ?? null;
    const top3 = ranked.slice(0, 3).map((candidate) => candidate.entry.id);
    const ok = top1 === item.expectedId;
    const okTop3 = top3.includes(item.expectedId);
    if (ok) correct += 1;
    if (okTop3) top3Correct += 1;
    rows.push({
      ...item,
      method: methodName,
      ok,
      okTop3,
      top1,
      top3,
      ranked
    });
  }

  const summary = {
    method: methodName,
    total: evalEntries.length,
    correct,
    top3Correct,
    accuracy: correct / Math.max(evalEntries.length, 1),
    top3Accuracy: top3Correct / Math.max(evalEntries.length, 1),
    rows,
    byTag: {}
  };

  const tags = new Set(evalEntries.flatMap((item) => item.tags));
  for (const tag of tags) {
    const tagged = rows.filter((row) => row.tags.includes(tag));
    if (!tagged.length) continue;
    const taggedCorrect = tagged.filter((row) => row.ok).length;
    const taggedTop3Correct = tagged.filter((row) => row.okTop3).length;
    summary.byTag[tag] = {
      total: tagged.length,
      correct: taggedCorrect,
      top3Correct: taggedTop3Correct,
      accuracy: taggedCorrect / tagged.length,
      top3Accuracy: taggedTop3Correct / tagged.length
    };
  }

  return summary;
}

function evaluateNegativeMethod(methodName, evalEntries, ranker) {
  const rows = [];

  for (const item of evalEntries) {
    const ranked = ranker(item.question);
    const top1 = ranked[0]?.entry?.id ?? null;
    const top1Score = ranked[0]?.score ?? 0;
    rows.push({
      ...item,
      method: methodName,
      top1,
      top1Score,
      ranked
    });
  }

  const summary = {
    method: methodName,
    total: evalEntries.length,
    rows,
    byTag: {}
  };

  const tags = new Set(evalEntries.flatMap((item) => item.tags));
  for (const tag of tags) {
    const tagged = rows.filter((row) => row.tags.includes(tag));
    if (!tagged.length) continue;
    summary.byTag[tag] = {
      total: tagged.length
    };
  }

  return summary;
}

function sweepThresholds({ methodName, positiveSummary, negativeSummary, thresholdMin = 0.30, thresholdMax = 0.80, step = 0.01 }) {
  const points = [];

  for (let t = thresholdMin; t <= thresholdMax + 1e-9; t += step) {
    const threshold = Number(t.toFixed(2));
    const positiveRows = positiveSummary.rows;
    const negativeRows = negativeSummary.rows;

    let positiveCorrectAnswered = 0;
    let positiveWrongAnswered = 0;
    let positiveAbstained = 0;

    for (const row of positiveRows) {
      const top1 = row.ranked[0];
      const answered = (top1?.score ?? 0) >= threshold;
      if (!answered) {
        positiveAbstained += 1;
      } else if (row.top1 === row.expectedId) {
        positiveCorrectAnswered += 1;
      } else {
        positiveWrongAnswered += 1;
      }
    }

    let negativeCorrectAbstained = 0;
    let negativeFalsePositive = 0;
    for (const row of negativeRows) {
      const answered = (row.top1Score ?? 0) >= threshold;
      if (answered) negativeFalsePositive += 1;
      else negativeCorrectAbstained += 1;
    }

    const total = positiveRows.length + negativeRows.length;
    const combinedCorrect = positiveCorrectAnswered + negativeCorrectAbstained;
    const answeredTotal = positiveCorrectAnswered + positiveWrongAnswered + negativeFalsePositive;
    const precision =
      answeredTotal > 0 ? positiveCorrectAnswered / answeredTotal : 1;
    const positiveRecall =
      positiveRows.length > 0 ? positiveCorrectAnswered / positiveRows.length : 0;
    const negativeSpecificity =
      negativeRows.length > 0 ? negativeCorrectAbstained / negativeRows.length : 0;

    points.push({
      method: methodName,
      threshold,
      combinedAccuracy: combinedCorrect / total,
      positiveCorrectAnswered,
      positiveWrongAnswered,
      positiveAbstained,
      negativeCorrectAbstained,
      negativeFalsePositive,
      precision,
      positiveRecall,
      negativeSpecificity
    });
  }

  points.sort((a, b) =>
    b.combinedAccuracy - a.combinedAccuracy ||
    a.negativeFalsePositive - b.negativeFalsePositive ||
    b.precision - a.precision ||
    b.positiveCorrectAnswered - a.positiveCorrectAnswered ||
    b.threshold - a.threshold
  );

  return {
    best: points[0] || null,
    points
  };
}

function printSummary(summary, maxMisses = 8) {
  console.log(`\n## ${summary.method}`);
  console.log(
    `Top-1: ${(summary.accuracy * 100).toFixed(1)}% (${summary.correct}/${summary.total}) | ` +
      `Top-3: ${(summary.top3Accuracy * 100).toFixed(1)}% (${summary.top3Correct}/${summary.total})`
  );

  for (const [tag, stats] of Object.entries(summary.byTag)) {
    console.log(
      `  ${tag}: ${(stats.accuracy * 100).toFixed(1)}% (${stats.correct}/${stats.total}) | ` +
        `top3 ${(stats.top3Accuracy * 100).toFixed(1)}%`
    );
  }

  const misses = summary.rows.filter((row) => !row.ok).slice(0, maxMisses);
  if (!misses.length) {
    console.log("  misses: none");
    return;
  }

  console.log("  misses:");
  for (const miss of misses) {
    console.log(
      `    expected=${miss.expectedId} got=${miss.top1} | q="${miss.question}" | top3=${miss.top3.join(", ")}`
    );
  }
}

function printThresholdSweep(title, sweep, maxRows = 8) {
  if (!sweep?.best) return;

  console.log(`\n## ${title}`);
  console.log(
    `Recommended threshold: ${sweep.best.threshold.toFixed(2)} | ` +
      `combined ${(sweep.best.combinedAccuracy * 100).toFixed(1)}% | ` +
      `precision ${(sweep.best.precision * 100).toFixed(1)}% | ` +
      `positive recall ${(sweep.best.positiveRecall * 100).toFixed(1)}% | ` +
      `negative specificity ${(sweep.best.negativeSpecificity * 100).toFixed(1)}%`
  );
  console.log(
    `  positives answered correctly=${sweep.best.positiveCorrectAnswered}, ` +
      `positives wrong=${sweep.best.positiveWrongAnswered}, positives abstained=${sweep.best.positiveAbstained}`
  );
  console.log(
    `  negatives abstained=${sweep.best.negativeCorrectAbstained}, negatives false-positive=${sweep.best.negativeFalsePositive}`
  );

  console.log("  top thresholds:");
  for (const row of sweep.points.slice(0, maxRows)) {
    console.log(
      `    t=${row.threshold.toFixed(2)} | combined ${(row.combinedAccuracy * 100).toFixed(1)}% | ` +
        `FP=${row.negativeFalsePositive} | precision ${(row.precision * 100).toFixed(1)}% | ` +
        `recall ${(row.positiveRecall * 100).toFixed(1)}%`
    );
  }
}

function buildPolicy(methodName) {
  if (methodName === "local_embedding_hybrid") {
    return {
      methodName,
      answerThreshold: 0.53,
      answerMinMargin: 0.035,
      clarifyThreshold: 0.47,
      clarifyMinMargin: 0.04,
      meaningfulOverlapMin: 3
    };
  }

  return {
    methodName,
    answerThreshold: 0.43,
    answerMinMargin: 0.035,
    clarifyThreshold: 0.40,
    clarifyMinMargin: 0.045,
    meaningfulOverlapMin: 2
  };
}

function applyDecisionPolicy(ranked, policy) {
  const top1 = ranked[0] || null;
  const top2 = ranked[1] || null;
  const margin = top1 ? top1.score - (top2?.score ?? 0) : 0;

  if (!top1) {
    return { type: "abstain", margin, top1 };
  }

  const highConfidence = top1.score >= Math.min(0.98, policy.answerThreshold + 0.10);

  if (
    top1.score >= policy.answerThreshold &&
    (margin >= policy.answerMinMargin || highConfidence)
  ) {
    return { type: "answer", margin, top1 };
  }

  if (
    top1.score >= Math.min(policy.answerThreshold, policy.clarifyThreshold) &&
    margin >= policy.clarifyMinMargin &&
    ((top1?.scores?.meaningfulOverlap ?? 0) >= policy.meaningfulOverlapMin || highConfidence)
  ) {
    return { type: "clarify", margin, top1 };
  }

  return { type: "abstain", margin, top1 };
}

function evaluatePolicy({ methodName, positiveSummary, negativeSummary, policy }) {
  const positiveRows = positiveSummary.rows.map((row) => {
    const decision = applyDecisionPolicy(row.ranked, policy);
    const correct = row.top1 === row.expectedId;
    return {
      ...row,
      decision,
      success: correct && (decision.type === "answer" || decision.type === "clarify")
    };
  });

  const negativeRows = negativeSummary.rows.map((row) => ({
    ...row,
    decision: applyDecisionPolicy(row.ranked, policy)
  }));

  const answered = positiveRows.filter((row) => row.decision.type === "answer" && row.top1 === row.expectedId).length;
  const clarified = positiveRows.filter((row) => row.decision.type === "clarify" && row.top1 === row.expectedId).length;
  const wrongPositive = positiveRows.filter((row) => row.decision.type !== "abstain" && row.top1 !== row.expectedId).length;
  const positiveAbstained = positiveRows.filter((row) => row.decision.type === "abstain").length;
  const negativeAbstained = negativeRows.filter((row) => row.decision.type === "abstain").length;
  const negativeFalsePositive = negativeRows.length - negativeAbstained;

  const total = positiveRows.length + negativeRows.length;
  const weightedCoverage = answered + clarified * 0.85;
  const combinedCorrect = answered + clarified + negativeAbstained;

  return {
    policy,
    total,
    positiveTotal: positiveRows.length,
    negativeTotal: negativeRows.length,
    answered,
    clarified,
    wrongPositive,
    positiveAbstained,
    negativeAbstained,
    negativeFalsePositive,
    combinedAccuracy: combinedCorrect / Math.max(total, 1),
    weightedCoverage,
    positiveRows,
    negativeRows
  };
}

function sweepPolicies({ methodName, positiveSummary, negativeSummary }) {
  const candidates = [];
  const answerThresholds = methodName === "local_embedding_hybrid"
    ? [0.53, 0.54, 0.55, 0.56]
    : [0.42, 0.43, 0.44, 0.45];
  const clarifyThresholds = methodName === "local_embedding_hybrid"
    ? [0.47, 0.48, 0.49, 0.50, 0.51]
    : [0.37, 0.38, 0.39, 0.40, 0.41];
  const answerMargins = [0.03, 0.035, 0.04, 0.05];
  const clarifyMargins = [0.04, 0.045, 0.05, 0.06];
  const meaningfulOverlapMins = [1, 2, 3];

  for (const answerThreshold of answerThresholds) {
    for (const clarifyThreshold of clarifyThresholds) {
      if (clarifyThreshold > answerThreshold) continue;
      for (const answerMinMargin of answerMargins) {
        for (const clarifyMinMargin of clarifyMargins) {
          for (const meaningfulOverlapMin of meaningfulOverlapMins) {
            const policy = {
              methodName,
              answerThreshold,
              answerMinMargin,
              clarifyThreshold,
              clarifyMinMargin,
              meaningfulOverlapMin
            };
            candidates.push(evaluatePolicy({ methodName, positiveSummary, negativeSummary, policy }));
          }
        }
      }
    }
  }

  candidates.sort((a, b) =>
    a.negativeFalsePositive - b.negativeFalsePositive ||
    a.wrongPositive - b.wrongPositive ||
    b.weightedCoverage - a.weightedCoverage ||
    b.answered - a.answered ||
    b.clarified - a.clarified ||
    b.combinedAccuracy - a.combinedAccuracy ||
    b.policy.answerThreshold - a.policy.answerThreshold
  );

  return {
    best: candidates[0] || null,
    candidates
  };
}

function printPolicySweep(title, sweep, maxRows = 8) {
  if (!sweep?.best) return;

  const best = sweep.best;
  console.log(`\n## ${title}`);
  console.log(
    `Best policy: answer>=${best.policy.answerThreshold.toFixed(2)} margin>=${best.policy.answerMinMargin.toFixed(3)} | ` +
      `clarify>=${best.policy.clarifyThreshold.toFixed(2)} margin>=${best.policy.clarifyMinMargin.toFixed(3)} | ` +
      `meaningfulOverlap>=${best.policy.meaningfulOverlapMin}`
  );
  console.log(
    `  answered=${best.answered}, clarified=${best.clarified}, positive abstained=${best.positiveAbstained}, ` +
      `wrong positive=${best.wrongPositive}, negative false-positive=${best.negativeFalsePositive}`
  );
  console.log(
    `  combined ${(best.combinedAccuracy * 100).toFixed(1)}% | weighted coverage ${best.weightedCoverage.toFixed(2)}`
  );

  console.log("  top policies:");
  for (const row of sweep.candidates.slice(0, maxRows)) {
    console.log(
      `    a>=${row.policy.answerThreshold.toFixed(2)} m>=${row.policy.answerMinMargin.toFixed(3)} | ` +
        `c>=${row.policy.clarifyThreshold.toFixed(2)} m>=${row.policy.clarifyMinMargin.toFixed(3)} | ` +
        `ov>=${row.policy.meaningfulOverlapMin} | ` +
        `ans=${row.answered} clr=${row.clarified} abst=${row.positiveAbstained} negFP=${row.negativeFalsePositive}`
    );
  }
}

async function main() {
  const corpus = loadFaqCorpus(DEFAULT_CORPUS_FILES);
  const evalEntries = loadEvalSet(DEFAULT_EVAL_FILE);
  const negativeEvalEntries = loadNegativeEvalSet(DEFAULT_NEGATIVE_EVAL_FILE);
  const lexicalIndex = buildLexicalIndex(corpus);
  const queryCache = new Map();

  function getLexicalRows(question) {
    const key = `lex:${question}`;
    if (!queryCache.has(key)) {
      queryCache.set(key, rankLexicalCandidates(lexicalIndex, preprocessQuestion(question)));
    }
    return queryCache.get(key);
  }

  const summaries = [];
  const negativeSummaries = [];

  summaries.push(
    evaluateMethod("hybrid_lexical", evalEntries, (question) =>
      pickTop(getLexicalRows(question), (row) => row.scores.hybrid, "hybrid")
    )
  );
  negativeSummaries.push(
    evaluateNegativeMethod("hybrid_lexical", negativeEvalEntries, (question) =>
      pickTop(getLexicalRows(question), (row) => row.scores.hybrid, "hybrid")
    )
  );

  console.log(`Building local embeddings with model ${DEFAULT_EMBEDDING_MODEL}...`);
  const embeddingIndex = await buildEmbeddingIndex(corpus, DEFAULT_EMBEDDING_MODEL);
  const allQueryTexts = [
    ...evalEntries.map((entry) => entry.question),
    ...negativeEvalEntries.map((entry) => entry.question)
  ];
  const queryEmbeddings = await embedTexts(
    allQueryTexts,
    { model: DEFAULT_EMBEDDING_MODEL }
  );

  const embeddingRowsCache = new Map();

  function getEmbeddingRows(question, queryIndex) {
    const key = `emb:${question}`;
    if (!embeddingRowsCache.has(key)) {
      const queryEmbedding = queryEmbeddings[queryIndex];
      const lexicalRows = getLexicalRows(question);
      const lexicalById = new Map(lexicalRows.map((row) => [row.entry.id, row]));
      const embeddingRows = rankEmbeddingCandidates(corpus, embeddingIndex, queryEmbedding).map((row) => {
        const lexical = lexicalById.get(row.entry.id);
        const fuse = lexical?.scores?.fuse ?? 0;
        const tfidf = lexical?.scores?.tfidf ?? 0;
        const overlap = lexical?.scores?.overlap ?? 0;
        const phrase = lexical?.scores?.phrase ?? 0;
        const deny = lexical?.scores?.deny ?? 0;
        const meaningfulOverlap = lexical?.scores?.meaningfulOverlap ?? 0;
        return {
          entry: row.entry,
          scores: {
            local_embedding_hybrid: Math.max(
              0,
              Math.min(
                1,
                0.62 * row.score +
                  0.18 * fuse +
                  0.10 * tfidf +
                  0.06 * overlap +
                  0.04 * phrase -
                  0.25 * deny
              )
            ),
            meaningfulOverlap
          }
        };
      });
      embeddingRowsCache.set(key, embeddingRows);
    }
    return embeddingRowsCache.get(key);
  }

  summaries.push(
    evaluateMethod("local_embedding_hybrid", evalEntries, (question) => {
      const queryIndex = evalEntries.findIndex((entry) => entry.question === question);
      return pickTop(
        getEmbeddingRows(question, queryIndex),
        (row) => row.scores.local_embedding_hybrid,
        "local_embedding_hybrid"
      );
    })
  );
  negativeSummaries.push(
    evaluateNegativeMethod("local_embedding_hybrid", negativeEvalEntries, (question) => {
      const queryIndex = negativeEvalEntries.findIndex((entry) => entry.question === question);
      return pickTop(
        getEmbeddingRows(question, queryIndex + evalEntries.length),
        (row) => row.scores.local_embedding_hybrid,
        "local_embedding_hybrid"
      );
    })
  );

  console.log(`Corpus size: ${corpus.length} FAQ entries`);
  console.log(`Eval size: ${evalEntries.length} questions`);
  console.log(`Negative eval size: ${negativeEvalEntries.length} questions`);
  console.log(`Embedding backend: local (${DEFAULT_EMBEDDING_MODEL})`);

  summaries.sort((a, b) => b.accuracy - a.accuracy || b.top3Accuracy - a.top3Accuracy);
  for (const summary of summaries) {
    printSummary(summary);
  }

  const summaryByMethod = new Map(summaries.map((summary) => [summary.method, summary]));
  const negativeSummaryByMethod = new Map(negativeSummaries.map((summary) => [summary.method, summary]));
  for (const methodName of ["local_embedding_hybrid", "hybrid_lexical"]) {
    const positiveSummary = summaryByMethod.get(methodName);
    const negativeSummary = negativeSummaryByMethod.get(methodName);
    if (!positiveSummary || !negativeSummary) continue;

    const defaultPolicy = evaluatePolicy({
      methodName,
      positiveSummary,
      negativeSummary,
      policy: buildPolicy(methodName)
    });

    console.log(`\n## ${methodName} Decision Policy`);
    console.log(
      `Default policy: answer>=${defaultPolicy.policy.answerThreshold.toFixed(2)} margin>=${defaultPolicy.policy.answerMinMargin.toFixed(3)} | ` +
        `clarify>=${defaultPolicy.policy.clarifyThreshold.toFixed(2)} margin>=${defaultPolicy.policy.clarifyMinMargin.toFixed(3)} | ` +
        `meaningfulOverlap>=${defaultPolicy.policy.meaningfulOverlapMin}`
    );
    console.log(
      `  answered=${defaultPolicy.answered}, clarified=${defaultPolicy.clarified}, positive abstained=${defaultPolicy.positiveAbstained}, ` +
        `wrong positive=${defaultPolicy.wrongPositive}, negative false-positive=${defaultPolicy.negativeFalsePositive}`
    );

    const policySweep = sweepPolicies({
      methodName,
      positiveSummary,
      negativeSummary
    });
    printPolicySweep(`${methodName} Policy Sweep`, policySweep);

    const sweep = sweepThresholds({
      methodName,
      positiveSummary,
      negativeSummary
    });
    printThresholdSweep(`${methodName} Threshold Sweep`, sweep);
  }
}

main().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
