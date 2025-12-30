// contests/get_forum_list.js
//
// Admin utility (SLASH ONLY): Scrape forums.tppc.info thread posters and DM a list of
// "username - rpgId" (one per line), based on contest_help_main.py logic,
// with additional rules:
//
// - Optional mode: sorted | nosorted
//   - Default: nosorted (preserve first-seen scan order)
// - Determine thread starter (OP) username from the first post on page 1
// - Skip ALL posts by the starter on any page (starter may reply multiple times)
// - Optional phrase filter: only include users whose post message contains a phrase
// - DM header: "TPPC Forums thread list for <link> (Started by: <username>)"
//
// Slash usage:
//   /getforumlist url:<threadUrl> mode:[sorted|nosorted] phrase:[optional]
//
// Notes:
// - All interaction outputs are EPHEMERAL (private to invoker).
// - Results are sent via DM to the invoker.

import { MessageFlags } from "discord.js";
import { isAdminOrPrivileged } from "../auth.js";

const FETCH_TIMEOUT_MS = 30_000;
const PAGE_DELAY_MS = 500;
const MAX_PAGES_HARD_CAP = 200; // safety
const DM_CHUNK_LIMIT = 1900;

// Guild-scoped "in progress" guard so admins can't start multiple scrapes at once.
const scrapeLocksByGuild = new Map(); // guildId -> true

function sleep(ms) {
  return new Promise((r) => setTimeout(r, ms));
}

function ensureFetch() {
  if (typeof fetch !== "function") {
    throw new Error("Global fetch() is not available. Use Node 18+ or add a fetch polyfill.");
  }
}

function normalizeThreadUrl(raw) {
  const s = String(raw || "").trim();
  if (!s) return null;

  try {
    const u = new URL(s);
    if (u.hostname !== "forums.tppc.info") return null;
    if (!u.pathname.includes("showthread.php")) return null;
    return u.toString();
  } catch {
    return null;
  }
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
    return await res.text();
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

function extractAlt2CellText(postHtml) {
  const m = /<td[^>]*\bclass\s*=\s*["']alt2[^"']*["'][^>]*>([\s\S]*?)<\/td>/i.exec(postHtml);
  if (!m) return "";
  return htmlToText(m[1]);
}

function extractLinkedIdsFromSidebarText(sidebarText) {
  const txt = String(sidebarText || "");
  const lineMatch = /TPPC:\s*#([^\n]+)/i.exec(txt);
  const segment = lineMatch ? lineMatch[0] : "";

  const ids = [];
  const re = /#(\d+)/g;
  let mm;
  while ((mm = re.exec(segment))) ids.push(mm[1]);
  return ids;
}

function extractPostMessageText(postHtml) {
  const m = /<div[^>]*\bid\s*=\s*["']post_message_\d+["'][^>]*>([\s\S]*?)<\/div>/i.exec(postHtml);
  if (!m) return "";
  return htmlToText(m[1]);
}

function findIdInPostText(postText, linkedIds) {
  const ids = Array.isArray(linkedIds) ? linkedIds : [];
  if (ids.length === 0) return null;

  const found = String(postText || "").match(/\d+/g) || [];
  for (const maybe of found) {
    if (ids.includes(maybe)) return maybe;
  }
  return ids[0] ?? null;
}

function normUser(u) {
  return String(u || "").trim().toLowerCase();
}

function findThreadStarterUsernameFromPage1(html) {
  // First post table on page 1 should be the OP
  const posts = extractPostTables(html);
  if (!posts.length) return null;

  const starter = extractUsernameFromPostTable(posts[0]);
  return starter || null;
}

async function scrapeThreadUserIdPairs(threadUrl, { phrase = null } = {}) {
  const page1Html = await fetchWithTimeout(threadUrl);
  const pageCount = computePageCountFromHtml(page1Html);

  const starterName = findThreadStarterUsernameFromPage1(page1Html);
  const starterKey = starterName ? normUser(starterName) : null;

  // Map insertion order = scan order
  // NOTE: for phrase-filtered scrapes we do NOT mark someone as seen until they match.
  const seen = new Map(); // username -> rpgId (string|null)
  const warnings = [];

  if (!starterName) {
    warnings.push("Could not detect thread starter (OP). Starter posts may not be excluded.");
  }

  const phraseNorm = phrase ? String(phrase).toLowerCase() : null;

  function processPage(html) {
    const posts = extractPostTables(html);
    for (const postHtml of posts) {
      const username = extractUsernameFromPostTable(postHtml);
      if (!username) continue;

      // Skip all posts by thread starter
      if (starterKey && normUser(username) === starterKey) continue;

      // If we already recorded this user, ignore subsequent posts.
      // For phrase filter: we only record when a post matches, so this
      // check is safe and does not prevent later qualifying posts.
      if (seen.has(username)) continue;

      const sidebarText = extractAlt2CellText(postHtml);
      const linkedIds = extractLinkedIdsFromSidebarText(sidebarText);
      const postText = extractPostMessageText(postHtml);

      // Optional phrase filter (case-insensitive substring match)
      if (phraseNorm) {
        const txt = String(postText || "").toLowerCase();
        if (!txt.includes(phraseNorm)) continue;
      }

      const targetId = findIdInPostText(postText, linkedIds);
      seen.set(username, targetId);
    }
  }

  processPage(page1Html);

  for (let p = 2; p <= pageCount; p++) {
    await sleep(PAGE_DELAY_MS);
    const url = buildPageUrl(threadUrl, p);
    const html = await fetchWithTimeout(url);
    processPage(html);
  }

  if (seen.size === 0) {
    warnings.push("No posters found (thread empty, inaccessible, or HTML layout changed).");
  }

  return {
    pairs: seen,
    pageCount,
    warnings,
    starterName: starterName || "Unknown",
    phrase: phraseNorm ? String(phrase) : null,
  };
}

async function dmChunked(user, header, lines) {
  const dm = await user.createDM();

  let cur = header.trim();
  for (const line of lines) {
    const add = (cur ? "\n" : "") + line;
    if ((cur + add).length > DM_CHUNK_LIMIT) {
      await dm.send(cur);
      cur = line;
    } else {
      cur += add;
    }
  }
  if (cur) await dm.send(cur);
}

// Build a message-like object so auth.js can reuse the same logic for privileged users.
function interactionAsMessageLike(interaction) {
  return {
    guildId: interaction.guildId,
    member: interaction.member,
    author: interaction.user,
  };
}

export function registerForumList(register) {
  register.slash(
    {
      name: "getforumlist",
      description: "Scrape a TPPC forum thread and DM a username - rpg id list (admin only)",
      options: [
        {
          type: 3, // STRING
          name: "url",
          description: "forums.tppc.info/showthread.php?... thread URL",
          required: true,
        },
        {
          type: 3, // STRING
          name: "mode",
          description: "Sort output by username (default: nosorted)",
          required: false,
          choices: [
            { name: "nosorted (scan order)", value: "nosorted" },
            { name: "sorted (A→Z)", value: "sorted" },
          ],
        },
        {
          type: 3, // STRING
          name: "phrase",
          description: "Only include posters whose message contains this phrase (optional)",
          required: false,
        },
      ],
    },
    async ({ interaction }) => {
      if (!interaction.guildId) return;

      // Admin/privileged only
      if (!isAdminOrPrivileged(interactionAsMessageLike(interaction))) {
        await interaction.reply({
          flags: MessageFlags.Ephemeral,
          content: "You don’t have permission to use this command.",
        });
        return;
      }

      const gid = String(interaction.guildId);
      if (scrapeLocksByGuild.get(gid)) {
        await interaction.reply({
          flags: MessageFlags.Ephemeral,
          content: "⏳ A forum scrape is already running for this server. Try again in a moment.",
        });
        return;
      }

      const urlRaw = interaction.options?.getString?.("url") ?? "";
      const mode = (interaction.options?.getString?.("mode") ?? "nosorted").toLowerCase();
      const phrase = String(interaction.options?.getString?.("phrase") ?? "").trim();
      const sorted = mode === "sorted";

      const threadUrl = normalizeThreadUrl(urlRaw);
      if (!threadUrl) {
        await interaction.reply({
          flags: MessageFlags.Ephemeral,
          content: "❌ Invalid URL. Please provide a `forums.tppc.info/showthread.php?...` thread link.",
        });
        return;
      }

      scrapeLocksByGuild.set(gid, true);

      try {
        // Private status updates only
        await interaction.deferReply({
          flags: MessageFlags.Ephemeral,
        });

        await interaction.editReply("🔎 Scraping the forum thread… I’ll DM you the results.");

        let result;
        try {
          result = await scrapeThreadUserIdPairs(threadUrl, {
            phrase: phrase || null,
          });
        } catch (e) {
          console.warn("[getforumlist] scrape failed:", e);
          await interaction.editReply("❌ Failed to scrape that thread (network/HTML issue). Try again later.");
          return;
        }

        const { pairs, pageCount, warnings, starterName } = result;

        // Default is UNSORTED: preserve insertion order from Map
        let rows = [];
        for (const [username, rpgId] of pairs.entries()) {
          rows.push({ username, rpgId: rpgId || "NO GOOD REFERENCE" });
        }

        if (sorted) {
          rows.sort((a, b) => a.username.toLowerCase().localeCompare(b.username.toLowerCase()));
        }

        const lines = rows.map((r) => `${r.username} - ${r.rpgId}`);

        const header =
          `TPPC Forums thread list for ${threadUrl} (Started by: ${starterName})\n` +
          `Pages scanned: ${pageCount}\n` +
          `Unique users (excluding starter): ${rows.length}\n` +
          `Mode: ${sorted ? "sorted" : "nosorted"}\n` +
          (phrase ? `Phrase filter: "${phrase}"\n` : "") +
          (warnings.length ? `⚠️ ${warnings.join(" ")}\n` : "") +
          `\nusername - rpg id\n----------------`;

        try {
          await dmChunked(interaction.user, header, lines);
          await interaction.editReply(`✅ Done — DM’d you ${rows.length} entries.`);
        } catch (e) {
          console.warn("[getforumlist] DM failed:", e);
          await interaction.editReply(
            "❌ I couldn’t DM you (your DMs might be closed). Enable DMs from this server and retry."
          );
        }
      } finally {
        scrapeLocksByGuild.delete(gid);
      }
    },
    { admin: true }
  );
}
