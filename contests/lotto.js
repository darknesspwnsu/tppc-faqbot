// contests/lotto.js
//
// TPPC Lottery helper:
// - Track used lotto combinations from the forum thread.
// - Generate unique unused combinations with a short reservation window.
// - Check who posted a specific combo.
// - Roll winning numbers (admin).

import { isAdminOrPrivileged } from "../auth.js";
import { getDb } from "../db.js";
import { logger } from "../shared/logger.js";
import { metrics } from "../shared/metrics.js";
import { sendChunked } from "./helpers.js";

const LOTTO_THREAD_URL = "https://forums.tppc.info/showthread.php?t=641631";
const FETCH_TIMEOUT_MS = 30_000;
const PAGE_DELAY_MS = 500;
const CACHE_TTL_MS = 2 * 60_000;
const RESERVATION_MS = 10 * 60_000;
const GENERATE_COOLDOWN_MS = 10 * 60_000;
const MAX_PAGES_HARD_CAP = 200;
const POSTS_PER_PAGE = 25;

const lottoStateByGuild = new Map(); // guildId -> state

function sleep(ms) {
  return new Promise((r) => setTimeout(r, ms));
}

function ensureFetch() {
  if (typeof fetch !== "function") {
    throw new Error("Global fetch() is not available. Use Node 18+ or add a fetch polyfill.");
  }
}

async function fetchWithTimeout(url) {
  ensureFetch();

  const controller = new AbortController();
  const t = setTimeout(() => controller.abort(), FETCH_TIMEOUT_MS);

  try {
    const res = await fetch(url, {
      method: "GET",
      signal: controller.signal,
      headers: {
        "User-Agent": "Mozilla/5.0 (compatible; SpectreonBot/1.0; +https://forums.tppc.info/)",
      },
    });
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    void metrics.incrementExternalFetch("lotto", "ok");
    return await res.text();
  } catch (err) {
    void metrics.incrementExternalFetch("lotto", "error");
    throw err;
  } finally {
    clearTimeout(t);
  }
}

function computePageCountFromHtml(html) {
  const m = /Show results\s+(\d+)\s+to\s+(\d+)\s+of\s+(\d+)/i.exec(html);
  if (!m) return 1;

  const x = Number(m[1]);
  const y = Number(m[2]);
  const z = Number(m[3]);
  if (!Number.isFinite(x) || !Number.isFinite(y) || !Number.isFinite(z)) return 1;

  const perPage = Math.max(1, y - x + 1);
  const pages = Math.ceil(z / perPage);
  return Math.min(Math.max(1, pages), MAX_PAGES_HARD_CAP);
}

function buildPageUrl(baseUrl, pageNum) {
  const u = new URL(baseUrl);
  u.searchParams.set("page", String(pageNum));
  return u.toString();
}

function extractPostTables(html) {
  const re = /<table[^>]*\bid\s*=\s*["']post\d+["'][\s\S]*?<\/table>/gi;
  return html.match(re) || [];
}

function decodeEntitiesBasic(str) {
  return String(str || "")
    .replaceAll("&nbsp;", " ")
    .replaceAll("&amp;", "&")
    .replaceAll("&lt;", "<")
    .replaceAll("&gt;", ">")
    .replaceAll("&quot;", '"')
    .replaceAll("&#39;", "'")
    .replaceAll("&apos;", "'");
}

function htmlToText(html) {
  let s = String(html || "");
  s = s.replace(/<\s*br\s*\/?\s*>/gi, "\n");
  s = s.replace(/<\/p\s*>/gi, "\n");
  s = s.replace(/<\/div\s*>/gi, "\n");
  s = s.replace(/<[^>]+>/g, "");
  s = decodeEntitiesBasic(s);
  s = s.replace(/\r/g, "");
  s = s.replace(/[ \t]+\n/g, "\n");
  s = s.replace(/\n{3,}/g, "\n\n");
  s = s.trim();
  return s;
}

function extractUsernameFromPostTable(postHtml) {
  const m = /<div[^>]*\bid\s*=\s*["']postmenu_\d+["'][^>]*>([\s\S]*?)<\/div>/i.exec(postHtml);
  if (!m) return null;

  const txt = htmlToText(m[1]);
  const firstLine = txt
    .split("\n")
    .map((s) => s.trim())
    .filter(Boolean)[0];
  return firstLine || null;
}

function extractPostMessageText(postHtml) {
  const m = /<div[^>]*\bid\s*=\s*["']post_message_\d+["'][^>]*>([\s\S]*?)<\/div>/i.exec(postHtml);
  if (!m) return "";
  return htmlToText(m[1]);
}

function extractPostId(postHtml) {
  const m = /\bid\s*=\s*["']post(\d+)["']/.exec(postHtml);
  if (!m) return null;
  return Number(m[1]);
}

function comboKey(nums) {
  return nums.join("-");
}

function parseLottoNumbersFromText(text) {
  const matches = [...String(text || "").matchAll(/\[(\d{1,2})\]/g)].map((m) => Number(m[1]));
  if (matches.length !== 3) return null;
  const nums = matches.filter((n) => Number.isInteger(n) && n >= 1 && n <= 10);
  if (nums.length !== 3) return null;
  const uniq = new Set(nums);
  if (uniq.size !== 3) return null;
  return nums.slice().sort((a, b) => a - b);
}

function parseNumbersFromInput(text) {
  const nums = (String(text || "").match(/\d+/g) || []).map((n) => Number(n));
  const filtered = nums.filter((n) => Number.isInteger(n) && n >= 1 && n <= 10);
  const uniq = Array.from(new Set(filtered));
  if (uniq.length !== 3) return null;
  return uniq.slice().sort((a, b) => a - b);
}

function allCombos() {
  const combos = [];
  for (let a = 1; a <= 10; a += 1) {
    for (let b = a + 1; b <= 10; b += 1) {
      for (let c = b + 1; c <= 10; c += 1) {
        combos.push([a, b, c]);
      }
    }
  }
  return combos;
}

const ALL_COMBOS = allCombos();

function formatCombo(nums) {
  return nums.map((n) => `[${n}]`).join(" ");
}

function getState(guildId) {
  const key = String(guildId || "");
  if (!key) return null;
  if (!lottoStateByGuild.has(key)) {
    lottoStateByGuild.set(key, {
      active: false,
      threadUrl: LOTTO_THREAD_URL,
      startPostId: null,
      lastFetchAt: 0,
      inFlight: null,
      loaded: false,
      loading: null,
      lastGenerateByUser: new Map(), // userId -> timestamp
      usedByKey: new Map(), // key -> { nums, user, postId, postUrl }
      reservedByKey: new Map(), // key -> { userId, expiresAt }
      reservedByUser: new Map(), // userId -> { key, expiresAt }
    });
  }
  return lottoStateByGuild.get(key);
}

async function ensureStateLoaded(state, guildId) {
  if (state.loaded) return;
  if (state.loading) {
    await state.loading;
    return;
  }

  state.loading = (async () => {
    try {
      const db = getDb();
      const [rows] = await db.execute(
        `
        SELECT active, thread_url, start_post_id
        FROM lotto_tracking
        WHERE guild_id = ?
      `,
        [String(guildId)]
      );

      if (rows?.length) {
        const row = rows[0];
        state.active = Boolean(row.active);
        state.threadUrl = row.thread_url || LOTTO_THREAD_URL;
        state.startPostId = row.start_post_id != null ? Number(row.start_post_id) : null;
      }

      state.loaded = true;
    } finally {
      state.loading = null;
    }
  })();

  await state.loading;
}

async function persistState(state, guildId) {
  const db = getDb();
  await db.execute(
    `
    INSERT INTO lotto_tracking (guild_id, active, thread_url, start_post_id)
    VALUES (?, ?, ?, ?)
    ON DUPLICATE KEY UPDATE
      active = VALUES(active),
      thread_url = VALUES(thread_url),
      start_post_id = VALUES(start_post_id)
  `,
    [
      String(guildId),
      state.active ? 1 : 0,
      state.threadUrl || LOTTO_THREAD_URL,
      state.startPostId,
    ]
  );
}

async function clearPersistedState(guildId) {
  const db = getDb();
  await db.execute(`DELETE FROM lotto_tracking WHERE guild_id = ?`, [String(guildId)]);
}

function cleanupReservations(state) {
  const now = Date.now();
  for (const [key, res] of state.reservedByKey.entries()) {
    if (!res || res.expiresAt <= now) {
      state.reservedByKey.delete(key);
    }
  }
  for (const [userId, res] of state.reservedByUser.entries()) {
    if (!res || res.expiresAt <= now || !state.reservedByKey.has(res.key)) {
      state.reservedByUser.delete(userId);
    }
  }
}

function reserveCombo(state, userId, key) {
  const now = Date.now();
  cleanupReservations(state);

  const existing = state.reservedByUser.get(userId);
  if (existing && existing.expiresAt > now) return existing.key;

  const expiresAt = now + RESERVATION_MS;
  state.reservedByKey.set(key, { userId, expiresAt });
  state.reservedByUser.set(userId, { key, expiresAt });
  return key;
}

function isReserved(state, key) {
  cleanupReservations(state);
  return state.reservedByKey.has(key);
}

function buildPostUrl(threadUrl, postId) {
  if (!threadUrl || !postId) return threadUrl || "";
  const u = new URL(threadUrl);
  u.searchParams.set("p", String(postId));
  u.hash = `post${postId}`;
  return u.toString();
}

function computeStartPage(startPostId) {
  if (!Number.isInteger(startPostId) || startPostId <= 0) return 1;
  return Math.floor((startPostId - 1) / POSTS_PER_PAGE) + 1;
}

async function refreshThreadCombos(state, { force = false } = {}) {
  if (!state.active) return { ok: false, reason: "inactive" };
  if (!force && Date.now() - state.lastFetchAt < CACHE_TTL_MS) return { ok: true, reason: "cache" };
  if (state.inFlight) return state.inFlight;

  state.inFlight = (async () => {
    try {
      const page1Html = await fetchWithTimeout(state.threadUrl);
      const pageCount = computePageCountFromHtml(page1Html);
      const used = new Map();
      const startPage = Math.min(
        Math.max(1, computeStartPage(state.startPostId)),
        pageCount
      );

      const pages = [];
      if (startPage === 1) {
        pages.push({ html: page1Html, pageNum: 1 });
      }

      for (let page = Math.max(2, startPage); page <= pageCount; page += 1) {
        await sleep(PAGE_DELAY_MS);
        const html = await fetchWithTimeout(buildPageUrl(state.threadUrl, page));
        pages.push({ html, pageNum: page });
      }

      for (const { html } of pages) {
        const posts = extractPostTables(html);
        for (const postHtml of posts) {
          const postId = extractPostId(postHtml);
          if (!postId) continue;
          if (state.startPostId && postId < state.startPostId) continue;

          const nums = parseLottoNumbersFromText(extractPostMessageText(postHtml));
          if (!nums) continue;

          const key = comboKey(nums);
          if (used.has(key)) continue;

          used.set(key, {
            nums,
            user: extractUsernameFromPostTable(postHtml) || "Unknown",
            postId,
            postUrl: buildPostUrl(state.threadUrl, postId),
          });
        }
      }

      state.usedByKey = used;
      state.lastFetchAt = Date.now();

      for (const key of used.keys()) {
        state.reservedByKey.delete(key);
      }
      cleanupReservations(state);

      return { ok: true, reason: "ok" };
    } catch (err) {
      logger.warn("lotto.refresh.failed", { error: logger.serializeError(err) });
      return { ok: false, reason: "fetch_failed" };
    } finally {
      state.inFlight = null;
    }
  })();

  return state.inFlight;
}

function formatActiveStateMessage(state) {
  if (!state.active) {
    return "❌ No active lotto tracking. Use `!lotto set <postnumber>` to begin.";
  }
  return null;
}

function needsRefresh(state) {
  if (!state.active) return false;
  if (state.inFlight) return false;
  return Date.now() - state.lastFetchAt >= CACHE_TTL_MS;
}

async function handleGenerate({ message, state }) {
  const inactive = formatActiveStateMessage(state);
  if (inactive) {
    await message.reply(inactive);
    return;
  }

  if (needsRefresh(state)) {
    await message.reply("⏳ Checking the lotto thread for unused combos...");
  }

  const refresh = await refreshThreadCombos(state);
  if (!refresh.ok) {
    await message.reply("❌ Unable to refresh the lotto thread right now. Try again in a bit.");
    return;
  }

  cleanupReservations(state);
  const existing = state.reservedByUser.get(message.author.id);
  if (existing) {
    const remainingMs = existing.expiresAt - Date.now();
    const remainingMin = Math.max(1, Math.ceil(remainingMs / 60_000));
    await message.reply(
      `🎟️ Your reserved combo (valid for ~${remainingMin} min): ${existing.key
        .split("-")
        .map((n) => `[${n}]`)
        .join(" ")}\nPost it or wait for the reservation to expire before requesting a new one.`
    );
    return;
  }

  if (!isAdminOrPrivileged(message)) {
    const last = state.lastGenerateByUser.get(message.author.id) || 0;
    const nextAllowed = last + GENERATE_COOLDOWN_MS;
    const remainingMs = nextAllowed - Date.now();
    if (remainingMs > 0) {
      const remainingMin = Math.ceil(remainingMs / 60_000);
      await message.reply(
        `⏳ Please wait about ${remainingMin} minute(s) before generating another lotto combo.`
      );
      return;
    }
  }

  const available = ALL_COMBOS.filter((nums) => {
    const key = comboKey(nums);
    if (state.usedByKey.has(key)) return false;
    if (isReserved(state, key)) return false;
    return true;
  });

  if (!available.length) {
    await message.reply("❌ No unused lotto combinations are available right now.");
    return;
  }

  const pick = available[Math.floor(Math.random() * available.length)];
  const key = reserveCombo(state, message.author.id, comboKey(pick));
  state.lastGenerateByUser.set(message.author.id, Date.now());

  await message.reply(
    `🎟️ Your unique lotto combo (reserved for ~10 min): ${key
      .split("-")
      .map((n) => `[${n}]`)
      .join(" ")}`
  );
}

async function handleCheck({ message, state, input }) {
  const inactive = formatActiveStateMessage(state);
  if (inactive) {
    await message.reply(inactive);
    return;
  }

  const nums = parseNumbersFromInput(input);
  if (!nums) {
    await message.reply("❌ Provide 3 unique numbers between 1-10. Example: `!lotto check 1 2 3`");
    return;
  }

  if (needsRefresh(state)) {
    await message.reply("⏳ Checking the lotto thread...");
  }

  const refresh = await refreshThreadCombos(state);
  if (!refresh.ok) {
    await message.reply("❌ Unable to refresh the lotto thread right now. Try again in a bit.");
    return;
  }

  const key = comboKey(nums);
  const hit = state.usedByKey.get(key);
  if (!hit) {
    await message.reply(`✅ ${formatCombo(nums)} is currently unused.`);
    return;
  }

  const note = hit.postUrl ? `\nPost: ${hit.postUrl}` : "";
  await message.reply(`❌ ${formatCombo(nums)} was already claimed by **${hit.user}**.${note}`);
}

async function handleRoll({ message, state }) {
  if (!isAdminOrPrivileged(message)) return;
  const inactive = formatActiveStateMessage(state);
  if (inactive) {
    await message.reply(inactive);
    return;
  }

  if (needsRefresh(state)) {
    await message.reply("⏳ Checking the lotto thread before rolling...");
  }

  const refresh = await refreshThreadCombos(state);
  if (!refresh.ok) {
    await message.reply("❌ Unable to refresh the lotto thread right now. Try again in a bit.");
    return;
  }

  const pick = ALL_COMBOS[Math.floor(Math.random() * ALL_COMBOS.length)];
  const key = comboKey(pick);
  const hit = state.usedByKey.get(key);
  if (!hit) {
    await message.reply(`🎲 Winning numbers: ${formatCombo(pick)}\nNo winner this week.`);
    return;
  }

  const note = hit.postUrl ? `\nPost: ${hit.postUrl}` : "";
  await message.reply(
    `🎲 Winning numbers: ${formatCombo(pick)}\nWinner: **${hit.user}**.${note}`
  );
}

async function handleSet({ message, state, input }) {
  if (!isAdminOrPrivileged(message)) return;
  const postId = Number(String(input || "").trim());
  if (!Number.isInteger(postId) || postId <= 0) {
    await message.reply("❌ Usage: `!lotto set <postnumber>`");
    return;
  }

  state.active = true;
  state.startPostId = postId;
  state.lastFetchAt = 0;
  state.usedByKey = new Map();
  state.reservedByKey = new Map();
  state.reservedByUser = new Map();

  try {
    await persistState(state, message.guildId);
  } catch (err) {
    logger.warn("lotto.state.persist_failed", { error: logger.serializeError(err) });
    await message.reply("❌ Unable to save lotto tracking state. Try again later.");
    return;
  }
  const loadingMessage = await message.reply("⏳ Loading lotto thread...");
  const refresh = await refreshThreadCombos(state, { force: true });
  if (!refresh.ok) {
    await loadingMessage.edit("⚠️ Tracking enabled, but the thread could not be fetched yet.");
    return;
  }

  await loadingMessage.edit(
    `✅ Lotto tracking enabled from post #${postId}. Used combos loaded: ${state.usedByKey.size}.`
  );
}

async function handleReset({ message, state }) {
  if (!isAdminOrPrivileged(message)) return;
  state.active = false;
  state.startPostId = null;
  state.lastFetchAt = 0;
  state.usedByKey = new Map();
  state.reservedByKey = new Map();
  state.reservedByUser = new Map();
  state.lastGenerateByUser = new Map();
  state.loaded = true;
  state.loading = null;
  try {
    await clearPersistedState(message.guildId);
  } catch (err) {
    logger.warn("lotto.state.clear_failed", { error: logger.serializeError(err) });
    await message.reply("❌ Unable to clear persisted lotto state. Try again later.");
    return;
  }
  await message.reply("✅ Lotto tracking reset. Use `!lotto set <postnumber>` to begin again.");
}

async function handleHelp({ message }) {
  const lines = [
    "`!lotto` — generate a unique unused lotto combo (reserved ~10 min)",
    "`!lotto check 1 2 3` — check if a combo is already used",
    "`!lotto status` — view tracking status and entrant count",
    "`!lotto roll` — roll winning numbers (admin)",
    "`!lotto set <postnumber>` — start tracking from a forum post number (admin)",
    "`!lotto reset` — stop tracking and clear cache (admin)",
    "`!lotto rules` — summary of lotto rules",
  ];

  await sendChunked({
    send: (content) => message.reply(content),
    header: "📌 Lotto commands:",
    lines,
  });
}

async function handleRules({ message }) {
  const lines = [
    "Pick 3 unique numbers from 1–10 (inclusive).",
    "Numbers should be posted in ascending order like: `Name - [1] [2] [3]`.",
    "Each 3-number combination can only be used once (order doesn’t matter).",
    "Active users only (see forum post for details).",
  ];

  await sendChunked({
    send: (content) => message.reply(content),
    header: "📜 TPPC Lottery rules (summary):",
    lines,
  });
}

async function handleStatus({ message, state }) {
  if (!state.active) {
    await message.reply("❌ No active lotto tracking. Use `!lotto set <postnumber>` to begin.");
    return;
  }

  const refresh = await refreshThreadCombos(state);
  if (!refresh.ok) {
    await message.reply("❌ Unable to refresh the lotto thread right now. Try again in a bit.");
    return;
  }

  await message.reply(
    `✅ Lotto tracking is active.\nStart post: #${state.startPostId}\nValid entrants: ${state.usedByKey.size}`
  );
}

function parseSubcommand(rest) {
  const trimmed = String(rest || "").trim();
  if (!trimmed) return { cmd: "generate", arg: "" };
  const parts = trimmed.split(/\s+/);
  const head = parts[0].toLowerCase();
  const tail = parts.slice(1).join(" ");

  if (head === "set") return { cmd: "set", arg: tail };
  if (head === "reset") return { cmd: "reset", arg: "" };
  if (head === "help") return { cmd: "help", arg: "" };
  if (head === "rules") return { cmd: "rules", arg: "" };
  if (head === "roll") return { cmd: "roll", arg: "" };
  if (head === "status") return { cmd: "status", arg: "" };
  if (head === "check") return { cmd: "check", arg: tail };

  // If the rest looks like numbers, treat as a check.
  if (parseNumbersFromInput(trimmed)) return { cmd: "check", arg: trimmed };
  return { cmd: "generate", arg: trimmed };
}

export function registerLotto(register) {
  register(
    "!lotto",
    async ({ message, rest }) => {
      if (!message.guildId) return;
      const state = getState(message.guildId);
      if (!state) return;
      try {
        await ensureStateLoaded(state, message.guildId);
      } catch (err) {
        logger.warn("lotto.state.load_failed", { error: logger.serializeError(err) });
        await message.reply("❌ Unable to load lotto tracking state. Try again later.");
        return;
      }

      const { cmd, arg } = parseSubcommand(rest);
      if (cmd === "set") return handleSet({ message, state, input: arg });
      if (cmd === "reset") return handleReset({ message, state });
      if (cmd === "help") return handleHelp({ message });
      if (cmd === "rules") return handleRules({ message });
      if (cmd === "roll") return handleRoll({ message, state });
      if (cmd === "status") return handleStatus({ message, state });
      if (cmd === "check") return handleCheck({ message, state, input: arg });
      return handleGenerate({ message, state });
    },
    "!lotto — TPPC Lottery helper (generate/check/roll)",
    { admin: false, aliases: ["!lottery"] }
  );
}

export const __testables = {
  parseLottoNumbersFromText,
  parseNumbersFromInput,
  comboKey,
  allCombos,
  buildPostUrl,
  computeStartPage,
};
