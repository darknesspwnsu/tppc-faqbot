// tools/thread_watch.js
//
// Forum thread watch subscriptions (bang only):
//   !threadwatch sub <thread_url|thread_id> [--op | --user "Forum Name"]
//   !threadwatch unsub <thread_url|thread_id|index>
//   !threadwatch list
//   !threadwatch clearall
//   !threadwatch help

import crypto from "node:crypto";
import { ActionRowBuilder, ButtonBuilder, ButtonStyle, MessageFlags } from "discord.js";

import { getDb } from "../db.js";
import { isAdminOrPrivileged } from "../auth.js";
import { sendDm } from "../shared/dm.js";
import { logger } from "../shared/logger.js";
import { metrics } from "../shared/metrics.js";
import { registerScheduler } from "../shared/scheduler_registry.js";
import {
  fetchWithTimeout as fetchForumPage,
  computePageCountFromHtml,
  buildPageUrl,
  extractPostTables,
  extractUsernameFromPostTable,
  extractPostMessageText,
  htmlToText,
} from "../shared/forum_scrape.js";

const THREADWATCH_ALIASES = ["!thread", "!tw", "!watchthread", "!wt", "!watch"];
const THREADWATCH_LIMIT = 3;
const POLL_INTERVAL_MS = 10 * 60_000;
const FETCH_TIMEOUT_MS = 30_000;
const PAGE_DELAY_MS = 250;
const MAX_SCAN_PAGES = 10;
const CLEAR_CONFIRM_TTL_MS = 60_000;
const SNIPPET_MAX_CHARS = 200;

const FILTER_ANY = "any";
const FILTER_OP = "op";
const FILTER_USER = "user";

const FORUM_BASE_URL = process.env.FORUM_BASE_URL || "https://forums.tppc.info";

const pendingClearConfirms = new Map(); // token -> { userId, createdAtMs }

let schedulerBooted = false;
let pollTimer = null;
let pollInFlight = false;
let cachedClient = null;

function sleep(ms) {
  return new Promise((r) => setTimeout(r, ms));
}

function tokenizeArgs(input) {
  const s = String(input || "").trim();
  if (!s) return [];

  const out = [];
  let cur = "";
  let quote = null;

  for (let i = 0; i < s.length; i += 1) {
    const ch = s[i];
    if (quote) {
      if (ch === quote) {
        quote = null;
      } else {
        cur += ch;
      }
      continue;
    }

    if (ch === '"' || ch === "'") {
      quote = ch;
      continue;
    }

    if (/\s/.test(ch)) {
      if (cur) {
        out.push(cur);
        cur = "";
      }
      continue;
    }

    cur += ch;
  }

  if (cur) out.push(cur);
  return out;
}

function normalizeThreadUrl(raw) {
  const s = String(raw || "").trim();
  if (!s) return null;
  try {
    const u = new URL(s);
    if (u.hostname !== "forums.tppc.info") return null;
    if (!u.pathname.includes("showthread.php")) return null;
    u.searchParams.delete("page");
    u.hash = "";
    return u.toString();
  } catch {
    return null;
  }
}

function extractThreadIdFromUrl(url) {
  try {
    const u = new URL(url);
    const t = u.searchParams.get("t");
    if (t && /^\d+$/.test(t)) return Number(t);
  } catch {
    return null;
  }
  return null;
}

function extractThreadIdFromHtml(html) {
  const m = /showthread\.php\?t=(\d+)/i.exec(String(html || ""));
  if (!m) return null;
  const id = Number(m[1]);
  return Number.isFinite(id) ? id : null;
}

function canonicalThreadUrl(threadId) {
  return `${FORUM_BASE_URL}/showthread.php?t=${threadId}`;
}

function parseThreadInput(raw) {
  const s = String(raw || "").trim();
  if (!s) return { threadId: null, threadUrl: null };
  if (/^\d+$/.test(s)) {
    const threadId = Number(s);
    return {
      threadId,
      threadUrl: canonicalThreadUrl(threadId),
    };
  }
  const url = normalizeThreadUrl(s);
  if (!url) return { threadId: null, threadUrl: null };
  return { threadId: extractThreadIdFromUrl(url), threadUrl: url };
}

function extractThreadTitleFromHtml(html) {
  const m = /<title>([\s\S]*?)<\/title>/i.exec(String(html || ""));
  if (!m) return "TPPC Forums";
  const raw = htmlToText(m[1]).trim();
  if (!raw) return "TPPC Forums";
  const parts = raw.split(" - ").map((p) => p.trim()).filter(Boolean);
  return parts.length ? parts[parts.length - 1] : raw;
}

function extractThreadOpFromHtml(html) {
  const posts = extractPostTables(html);
  if (!posts.length) return null;
  return extractUsernameFromPostTable(posts[0]);
}

function extractPostId(postHtml) {
  const m = /\bid\s*=\s*["']post(\d+)["']/.exec(postHtml);
  if (!m) return null;
  const id = Number(m[1]);
  return Number.isFinite(id) ? id : null;
}

function parsePostsFromHtml(html) {
  const posts = [];
  const tables = extractPostTables(html);
  for (const postHtml of tables) {
    const postId = extractPostId(postHtml);
    if (!postId) continue;
    const username = extractUsernameFromPostTable(postHtml) || "Unknown";
    const message = extractPostMessageText(postHtml);
    posts.push({ postId, username, message });
  }
  return posts;
}

function buildPostHotlink(postId) {
  if (!postId) return FORUM_BASE_URL;
  return `${FORUM_BASE_URL}/showthread.php?p=${postId}#post${postId}`;
}

function formatSnippet(text, maxChars = SNIPPET_MAX_CHARS) {
  const cleaned = String(text || "")
    .replace(/\s+/g, " ")
    .trim();
  if (!cleaned) return "(no message text)";
  if (cleaned.length <= maxChars) return cleaned;
  return `${cleaned.slice(0, maxChars - 1)}…`;
}

function memberListLetterFor(username) {
  const first = String(username || "").charAt(0);
  if (!first) return "#";
  const upper = first.toUpperCase();
  return upper >= "A" && upper <= "Z" ? upper : "#";
}

function parseMemberListTotal(html) {
  const m = /Showing results\s+\d+\s+to\s+\d+\s+of\s+([\d,]+)/i.exec(String(html || ""));
  if (!m) return null;
  const total = Number(String(m[1]).replace(/,/g, ""));
  return Number.isFinite(total) ? total : null;
}

function findUserIdInMemberListHtml(html, targetUsername) {
  const re = /member\.php\?[^"']*u=(\d+)[^"']*">([\s\S]*?)<\/a>/gi;
  let m;
  while ((m = re.exec(String(html || ""))) !== null) {
    const userId = m[1];
    const name = htmlToText(m[2])
      .split("\n")
      .map((s) => s.trim())
      .filter(Boolean)[0];
    if (name === targetUsername) return userId;
  }
  return null;
}

async function findForumUserIdByUsername(baseUrl, forumUsername) {
  const letter = memberListLetterFor(forumUsername);
  const perPage = 100;
  let page = 1;
  let maxPage = 1;

  while (page <= maxPage) {
    const url = `${baseUrl}/memberlist.php?ltr=${encodeURIComponent(letter)}&pp=${perPage}&sort=username&order=asc&page=${page}`;
    const html = await fetchForumPage(url, {
      timeoutMs: FETCH_TIMEOUT_MS,
      metricsKey: "threadwatch_user",
    });

    if (page === 1) {
      const total = parseMemberListTotal(html);
      if (total) maxPage = Math.max(1, Math.ceil(total / perPage));
    }

    const userId = findUserIdInMemberListHtml(html, forumUsername);
    if (userId) return userId;

    page += 1;
  }

  return null;
}

async function fetchThreadMeta(threadUrl) {
  const page1Html = await fetchForumPage(threadUrl, {
    timeoutMs: FETCH_TIMEOUT_MS,
    metricsKey: "threadwatch",
  });
  const title = extractThreadTitleFromHtml(page1Html);
  const op = extractThreadOpFromHtml(page1Html);
  const pageCount = computePageCountFromHtml(page1Html);

  let lastPageHtml = page1Html;
  if (pageCount > 1) {
    lastPageHtml = await fetchForumPage(buildPageUrl(threadUrl, pageCount), {
      timeoutMs: FETCH_TIMEOUT_MS,
      metricsKey: "threadwatch",
    });
  }

  const posts = parsePostsFromHtml(lastPageHtml);
  const lastPostId = posts.reduce((acc, p) => (p.postId > acc ? p.postId : acc), 0) || null;

  const threadId = extractThreadIdFromUrl(threadUrl) || extractThreadIdFromHtml(page1Html);

  return { threadId, title, op, lastPostId, pageCount, page1Html };
}

async function fetchPostsSince(threadUrl, minPostId) {
  const page1Html = await fetchForumPage(threadUrl, {
    timeoutMs: FETCH_TIMEOUT_MS,
    metricsKey: "threadwatch",
  });
  const pageCount = computePageCountFromHtml(page1Html);

  const posts = [];
  let latestPostId = null;

  for (let page = pageCount; page >= 1; page -= 1) {
    const isFirst = page === 1;
    const html = isFirst
      ? page1Html
      : await fetchForumPage(buildPageUrl(threadUrl, page), {
          timeoutMs: FETCH_TIMEOUT_MS,
          metricsKey: "threadwatch",
        });

    const pagePosts = parsePostsFromHtml(html);
    for (const post of pagePosts) {
      if (!latestPostId || post.postId > latestPostId) latestPostId = post.postId;
      if (post.postId > minPostId) posts.push(post);
    }

    const minIdOnPage = pagePosts.reduce(
      (acc, p) => (acc === null || p.postId < acc ? p.postId : acc),
      null
    );

    if (minIdOnPage !== null && minIdOnPage <= minPostId) break;

    if (pageCount - page + 1 >= MAX_SCAN_PAGES) break;

    if (!isFirst) await sleep(PAGE_DELAY_MS);
  }

  posts.sort((a, b) => a.postId - b.postId);

  return { posts, latestPostId };
}

async function ensureDmAvailable(user) {
  const res = await sendDm({
    user,
    payload: "✅ I can DM you forum thread updates.",
    feature: "threadwatch",
  });
  if (res.ok) return true;
  if (res.code === 50007) return false;
  throw res.error;
}

function formatFilterLabel(row) {
  if (row.filter_mode === FILTER_OP) return `op (${row.filter_user || "?"})`;
  if (row.filter_mode === FILTER_USER) return `user (${row.filter_user || "?"})`;
  return "any";
}

function buildHelpText() {
  return (
    "Forum thread watch:\n" +
    "• `!threadwatch sub <thread_url|thread_id> [--op | --user \"Forum Name\"]` — subscribe\n" +
    "• `!threadwatch unsub <thread_url|thread_id|index>` — unsubscribe\n" +
    "• `!threadwatch list` — show your tracked threads\n" +
    "• `!threadwatch clearall` — remove all tracked threads\n" +
    "• `!threadwatch help` — show this help\n\n" +
    "Notes:\n" +
    "• Use quotes for forum names with spaces.\n" +
    "• Index refers to the numbered list from `!threadwatch list`.\n" +
    "• Filters are case-sensitive (must match forums display name exactly).\n" +
    `• Limit: ${THREADWATCH_LIMIT} threads per user (admin/privileged unlimited).`
  );
}

function buildClearConfirmRow(token) {
  return new ActionRowBuilder().addComponents(
    new ButtonBuilder()
      .setCustomId(`threadwatch:clear:${token}:confirm`)
      .setLabel("CONFIRM")
      .setStyle(ButtonStyle.Danger),
    new ButtonBuilder()
      .setCustomId(`threadwatch:clear:${token}:cancel`)
      .setLabel("CANCEL")
      .setStyle(ButtonStyle.Secondary)
  );
}

function parseSubOptions(tokens) {
  let input = null;
  let filterMode = FILTER_ANY;
  let filterUser = null;
  let sawOp = false;
  let sawUser = false;

  for (let i = 0; i < tokens.length; i += 1) {
    const token = tokens[i];
    if (token === "--op") {
      filterMode = FILTER_OP;
      sawOp = true;
      continue;
    }
    if (token === "--user" || token.startsWith("--user=")) {
      const value = token.includes("=") ? token.split("=", 2)[1] : tokens[i + 1];
      if (!value) return { error: "Missing forum username after --user." };
      if (!token.includes("=")) i += 1;
      filterMode = FILTER_USER;
      filterUser = value;
      sawUser = true;
      continue;
    }

    if (!input) {
      input = token;
    }
  }

  if (!input) return { error: "Missing thread URL or ID." };
  if (sawOp && sawUser) {
    return { error: "Choose only one filter: --op or --user." };
  }

  return { input, filterMode, filterUser };
}

async function fetchSubscriptionsForUser(userId) {
  const db = getDb();
  const [rows] = await db.execute(
    `
    SELECT id, thread_id, thread_url, thread_title, thread_op, filter_mode, filter_user, last_seen_post_id
    FROM forum_thread_subscriptions
    WHERE user_id = ?
    ORDER BY id ASC
  `,
    [String(userId)]
  );
  return rows || [];
}

async function handleSubCommand({ message, tokens }) {
  const opts = parseSubOptions(tokens);
  if (opts.error) {
    await message.reply(`❌ ${opts.error}`);
    return;
  }

  const { input, filterMode, filterUser } = opts;
  const parsed = parseThreadInput(input);
  if (!parsed.threadUrl) {
    await message.reply("❌ Invalid thread URL or ID. Use a forums.tppc.info/showthread.php?t=... link or a numeric thread ID.");
    return;
  }

  let threadMeta;
  try {
    threadMeta = await fetchThreadMeta(parsed.threadUrl);
  } catch (err) {
    logger.warn("threadwatch.thread_fetch_failed", { error: logger.serializeError(err) });
    await message.reply("❌ Unable to fetch that forum thread right now. Try again later.");
    return;
  }

  const threadId = parsed.threadId || threadMeta.threadId;
  if (!threadId) {
    await message.reply("❌ Unable to detect the thread ID for that URL. Please provide the numeric thread ID instead.");
    return;
  }

  let effectiveMode = filterMode;
  let effectiveUser = filterUser;

  if (filterMode === FILTER_OP) {
    if (!threadMeta.op) {
      await message.reply("❌ Unable to detect the thread starter (OP). Use `--user` instead.");
      return;
    }
    effectiveUser = threadMeta.op;
  }

  if (filterMode === FILTER_USER && effectiveUser) {
    try {
      const found = await findForumUserIdByUsername(FORUM_BASE_URL, effectiveUser);
      if (!found) {
        await message.reply("❌ Forum user not found. Check spelling and capitalization.");
        return;
      }
    } catch (err) {
      logger.warn("threadwatch.user_lookup_failed", { error: logger.serializeError(err) });
      await message.reply("❌ Could not verify that forum user right now. Try again later.");
      return;
    }
  }

  const db = getDb();
  const [existingRows] = await db.execute(
    `
    SELECT id
    FROM forum_thread_subscriptions
    WHERE user_id = ? AND thread_id = ?
  `,
    [String(message.author.id), Number(threadId)]
  );
  const existing = existingRows?.[0] || null;

  if (!existing) {
    if (!isAdminOrPrivileged(message)) {
      const [countRows] = await db.execute(
        `SELECT COUNT(*) AS total FROM forum_thread_subscriptions WHERE user_id = ?`,
        [String(message.author.id)]
      );
      const total = Number(countRows?.[0]?.total || 0);
      if (total >= THREADWATCH_LIMIT) {
        await message.reply(
          `❌ You already track ${THREADWATCH_LIMIT} threads. Use \`!threadwatch list\` and \`!threadwatch unsub\` first.`
        );
        return;
      }
    }

    let canDm = false;
    try {
      canDm = await ensureDmAvailable(message.author);
    } catch (err) {
      logger.warn("threadwatch.dm_check_failed", { error: logger.serializeError(err) });
      await message.reply("❌ Unable to verify your DM settings right now. Try again later.");
      return;
    }

    if (!canDm) {
      await message.reply("❌ I can’t DM you right now (DMs are closed). Subscription not registered.");
      return;
    }

    await db.execute(
      `
      INSERT INTO forum_thread_subscriptions
        (user_id, thread_id, thread_url, thread_title, thread_op, filter_mode, filter_user, last_seen_post_id)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?)
    `,
      [
        String(message.author.id),
        Number(threadId),
        canonicalThreadUrl(threadId),
        String(threadMeta.title || "TPPC Forums"),
        threadMeta.op ? String(threadMeta.op) : null,
        effectiveMode,
        effectiveUser || null,
        Number(threadMeta.lastPostId || 0),
      ]
    );

    await message.reply(
      `✅ Now watching **${threadMeta.title}** (filter: ${effectiveMode}${effectiveUser ? `/${effectiveUser}` : ""}).`
    );
    return;
  }

  let canDm = false;
  try {
    canDm = await ensureDmAvailable(message.author);
  } catch (err) {
    logger.warn("threadwatch.dm_check_failed", { error: logger.serializeError(err) });
    await message.reply("❌ Unable to verify your DM settings right now. Try again later.");
    return;
  }

  if (!canDm) {
    await message.reply("❌ I can’t DM you right now (DMs are closed). Subscription not registered.");
    return;
  }

  await db.execute(
    `
    UPDATE forum_thread_subscriptions
    SET thread_url = ?, thread_title = ?, thread_op = ?, filter_mode = ?, filter_user = ?, last_seen_post_id = ?
    WHERE id = ?
  `,
    [
      canonicalThreadUrl(threadId),
      String(threadMeta.title || "TPPC Forums"),
      threadMeta.op ? String(threadMeta.op) : null,
      effectiveMode,
      effectiveUser || null,
      Number(threadMeta.lastPostId || 0),
      Number(existing.id),
    ]
  );

  await message.reply(
    `✅ Updated watch for **${threadMeta.title}** (filter: ${effectiveMode}${effectiveUser ? `/${effectiveUser}` : ""}).`
  );
}

async function handleUnsubCommand({ message, tokens }) {
  const target = tokens[0];
  if (!target) {
    await message.reply("❌ Provide a thread URL, thread ID, or list index to unsubscribe.");
    return;
  }

  const list = await fetchSubscriptionsForUser(message.author.id);
  if (!list.length) {
    await message.reply("You are not tracking any threads yet.");
    return;
  }

  let row = null;
  const indexMatch = /^#?(\d+)$/.exec(String(target));
  if (indexMatch) {
    const indexValue = Number(indexMatch[1]);
    if (Number.isInteger(indexValue) && indexValue > 0 && indexValue <= list.length) {
      row = list[indexValue - 1];
    }
  }

  if (!row) {
    const parsed = parseThreadInput(target);
    if (!parsed.threadUrl && !parsed.threadId) {
      await message.reply("❌ Invalid thread reference. Use a list index, thread URL, or thread ID.");
      return;
    }

    const threadId = parsed.threadId;
    if (!threadId) {
      await message.reply("❌ Unable to detect thread ID for that URL. Use the numeric thread ID instead.");
      return;
    }

    row = list.find((entry) => Number(entry.thread_id) === Number(threadId));
    if (!row) {
      await message.reply("❌ No matching subscription found for that thread.");
      return;
    }
  }

  const db = getDb();
  await db.execute(`DELETE FROM forum_thread_subscriptions WHERE id = ?`, [Number(row.id)]);

  await message.reply(`✅ Unsubscribed from **${row.thread_title}**.`);
}

async function handleListCommand({ message }) {
  const list = await fetchSubscriptionsForUser(message.author.id);
  if (!list.length) {
    await message.reply("You are not tracking any threads yet. Use `!threadwatch sub <url>` to add one.");
    return;
  }

  const header = `Your tracked threads (${list.length}${isAdminOrPrivileged(message) ? "" : `/${THREADWATCH_LIMIT}`})`;
  const lines = list.map((row, idx) => {
    const filter = formatFilterLabel(row);
    return `${idx + 1}) ${row.thread_title} (t=${row.thread_id}) — filter: ${filter}`;
  });

  await message.reply(`${header}\n${lines.join("\n")}`);
}

async function handleClearAllCommand({ message }) {
  const list = await fetchSubscriptionsForUser(message.author.id);
  if (!list.length) {
    await message.reply("You have no thread subscriptions to clear.");
    return;
  }

  const token = crypto.randomBytes(6).toString("hex");
  pendingClearConfirms.set(token, { userId: message.author.id, createdAtMs: Date.now() });

  await message.reply({
    content: "Confirm clearing all thread watches?",
    components: [buildClearConfirmRow(token)],
  });
}

async function handleClearConfirm({ interaction }) {
  const parts = String(interaction.customId || "").split(":");
  const token = parts[2];
  const action = parts[3];

  const record = pendingClearConfirms.get(token);
  if (!record) {
    await interaction.reply({ content: "❌ This confirmation has expired.", flags: MessageFlags.Ephemeral });
    return;
  }

  if (Date.now() - record.createdAtMs > CLEAR_CONFIRM_TTL_MS) {
    pendingClearConfirms.delete(token);
    await interaction.update({ content: "❌ Confirmation expired.", components: [] });
    return;
  }

  if (interaction.user?.id !== record.userId) {
    await interaction.reply({ content: "❌ This confirmation isn’t for you.", flags: MessageFlags.Ephemeral });
    return;
  }

  if (action === "cancel") {
    pendingClearConfirms.delete(token);
    await interaction.update({ content: "Clear cancelled.", components: [] });
    return;
  }

  if (action === "confirm") {
    pendingClearConfirms.delete(token);
    const db = getDb();
    await db.execute(`DELETE FROM forum_thread_subscriptions WHERE user_id = ?`, [String(record.userId)]);
    await interaction.update({ content: "✅ Cleared all thread watches.", components: [] });
    return;
  }

  await interaction.update({ content: "❌ Unknown action.", components: [] });
}

async function pollSubscriptions() {
  if (pollInFlight) return;
  pollInFlight = true;

  try {
    const db = getDb();
    const [rows] = await db.execute(
      `
      SELECT id, user_id, thread_id, thread_url, thread_title, thread_op,
             filter_mode, filter_user, last_seen_post_id
      FROM forum_thread_subscriptions
    `
    );

    if (!rows || rows.length === 0) return;

    const userCache = new Map();
    const byThread = new Map();
    for (const row of rows) {
      const key = String(row.thread_id);
      if (!byThread.has(key)) {
        byThread.set(key, { threadUrl: row.thread_url, subs: [] });
      }
      byThread.get(key).subs.push(row);
    }

    for (const [threadId, entry] of byThread.entries()) {
      const subs = entry.subs;
      const minSeen = subs.reduce(
        (acc, r) => (acc === null || Number(r.last_seen_post_id) < acc ? Number(r.last_seen_post_id) : acc),
        null
      );
      const minPostId = Number(minSeen || 0);

      let postsResult;
      try {
        postsResult = await fetchPostsSince(entry.threadUrl, minPostId);
      } catch (err) {
        logger.warn("threadwatch.poll.fetch_failed", { threadId, error: logger.serializeError(err) });
        continue;
      }

      const { posts, latestPostId } = postsResult;
      if (!latestPostId) continue;

      for (const sub of subs) {
        const lastSeen = Number(sub.last_seen_post_id || 0);
        const newPosts = posts.filter((p) => p.postId > lastSeen);
        if (!newPosts.length) continue;

        let matchingPosts = newPosts;
        if (sub.filter_mode === FILTER_OP || sub.filter_mode === FILTER_USER) {
          matchingPosts = newPosts.filter((p) => p.username === sub.filter_user);
        }

        if (matchingPosts.length) {
          const latestMatch = matchingPosts.reduce(
            (acc, p) => (acc && acc.postId > p.postId ? acc : p),
            null
          );
          const totalCount = newPosts.length;
          const snippet = formatSnippet(latestMatch?.message);
          const hotlink = buildPostHotlink(latestMatch?.postId);
          const content =
            `📣 **${sub.thread_title}**\n` +
            `${totalCount} new post${totalCount === 1 ? "" : "s"} on a thread you are following.\n` +
            `Latest from **${latestMatch?.username || "Unknown"}**:\n` +
            `> ${snippet}\n` +
            `${hotlink}\n\n` +
            `To stop updates, use \`!threadwatch unsub ${sub.thread_id}\`.`;

          if (!cachedClient) {
            logger.warn("threadwatch.dm.missing_client", { threadId });
          } else {
            const cacheKey = String(sub.user_id);
            let user = userCache.get(cacheKey) || null;
            if (!userCache.has(cacheKey)) {
              user = await cachedClient.users.fetch(cacheKey).catch(() => null);
              userCache.set(cacheKey, user || null);
            }
            if (!user) {
              logger.warn("threadwatch.dm.user_missing", { userId: sub.user_id });
            } else {
              const res = await sendDm({
                user,
                payload: { content },
                feature: "threadwatch",
              });
              if (!res.ok) {
                logger.warn("threadwatch.dm.failed", { error: logger.serializeError(res.error) });
              }
            }
          }

        }

        await db.execute(
          `UPDATE forum_thread_subscriptions SET last_seen_post_id = ? WHERE id = ?`,
          [Number(latestPostId), Number(sub.id)]
        );
      }
    }

    void metrics.incrementSchedulerRun("threadwatch", "ok");
  } catch (err) {
    void metrics.incrementSchedulerRun("threadwatch", "error");
    logger.warn("threadwatch.poll.failed", { error: logger.serializeError(err) });
  } finally {
    pollInFlight = false;
  }
}

function scheduleNextPoll(delayMs = POLL_INTERVAL_MS) {
  if (pollTimer) clearTimeout(pollTimer);
  pollTimer = setTimeout(async () => {
    await pollSubscriptions();
    scheduleNextPoll(POLL_INTERVAL_MS);
  }, delayMs);
  if (typeof pollTimer.unref === "function") pollTimer.unref();
}

function startScheduler() {
  if (schedulerBooted) return;
  schedulerBooted = true;
  scheduleNextPoll(POLL_INTERVAL_MS);
}

function stopScheduler() {
  if (pollTimer) clearTimeout(pollTimer);
  pollTimer = null;
  schedulerBooted = false;
}

export function registerThreadWatchScheduler() {
  registerScheduler(
    "threadwatch",
    (context = {}) => {
      cachedClient = context.client || cachedClient;
      startScheduler();
    },
    () => stopScheduler()
  );
}

export function registerThreadWatch(register) {
  register(
    "!threadwatch",
    async ({ message, rest }) => {
      const tokens = tokenizeArgs(rest);
      const subcmd = String(tokens.shift() || "").toLowerCase();

      if (!subcmd || subcmd === "help") {
        await message.reply(buildHelpText());
        return;
      }

      if (subcmd === "list") {
        await handleListCommand({ message });
        return;
      }

      if (subcmd === "sub") {
        await handleSubCommand({ message, tokens });
        return;
      }

      if (subcmd === "unsub") {
        await handleUnsubCommand({ message, tokens });
        return;
      }

      if (subcmd === "clearall") {
        await handleClearAllCommand({ message });
        return;
      }

      await message.reply(buildHelpText());
    },
    "!threadwatch <sub|unsub|list|clearall|help> — follow TPPC forum threads",
    { aliases: THREADWATCH_ALIASES, category: "Tools" }
  );

  register.component("threadwatch:clear:", handleClearConfirm);
}

export const __testables = {
  tokenizeArgs,
  parseSubOptions,
  parseThreadInput,
  extractThreadIdFromHtml,
  extractThreadTitleFromHtml,
  extractThreadOpFromHtml,
  parsePostsFromHtml,
  formatSnippet,
  buildPostHotlink,
};
