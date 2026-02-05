// shared/forum_scrape.js
//
// Shared utilities for scraping TPPC forum thread pages.

import { metrics } from "./metrics.js";

const DEFAULT_USER_AGENT =
  "Mozilla/5.0 (compatible; SpectreonBot/1.0; +https://forums.tppc.info/)";
const DEFAULT_TIMEOUT_MS = 30_000;
const DEFAULT_MAX_PAGES = 200;

export function ensureFetch() {
  if (typeof fetch !== "function") {
    throw new Error("Global fetch() is not available. Use Node 18+ or add a fetch polyfill.");
  }
}

export async function fetchWithTimeout(url, { timeoutMs = DEFAULT_TIMEOUT_MS, metricsKey = null } = {}) {
  ensureFetch();

  const controller = new AbortController();
  const t = setTimeout(() => controller.abort(), timeoutMs);

  try {
    const res = await fetch(url, {
      method: "GET",
      signal: controller.signal,
      headers: {
        "User-Agent": DEFAULT_USER_AGENT,
      },
    });
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    if (metricsKey) void metrics.incrementExternalFetch(metricsKey, "ok");
    return await res.text();
  } catch (err) {
    if (metricsKey) void metrics.incrementExternalFetch(metricsKey, "error");
    throw err;
  } finally {
    clearTimeout(t);
  }
}

export function computePageCountFromHtml(html, { maxPages = DEFAULT_MAX_PAGES } = {}) {
  const pageMatch = /Page\s+(\d+)\s+of\s+(\d+)/i.exec(html);
  if (pageMatch) {
    const total = Number(String(pageMatch[2]).replace(/,/g, ""));
    if (Number.isFinite(total) && total > 0) {
      return Math.min(Math.max(1, total), maxPages);
    }
  }

  const m = /Show(?:ing)? results\s+([\d,]+)\s+to\s+([\d,]+)\s+of\s+([\d,]+)/i.exec(html);
  if (m) {
    const x = Number(String(m[1]).replace(/,/g, ""));
    const y = Number(String(m[2]).replace(/,/g, ""));
    const z = Number(String(m[3]).replace(/,/g, ""));
    if (Number.isFinite(x) && Number.isFinite(y) && Number.isFinite(z)) {
      const perPage = Math.max(1, y - x + 1);
      const pages = Math.ceil(z / perPage);
      return Math.min(Math.max(1, pages), maxPages);
    }
  }

  return 1;
}

export function buildPageUrl(baseUrl, pageNum) {
  const u = new URL(baseUrl);
  u.searchParams.set("page", String(pageNum));
  return u.toString();
}

export function extractPostTables(html) {
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

export function htmlToText(html) {
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

export function extractUsernameFromPostTable(postHtml) {
  const m = /<div[^>]*\bid\s*=\s*["']postmenu_\d+["'][^>]*>([\s\S]*?)<\/div>/i.exec(postHtml);
  if (!m) return null;

  const txt = htmlToText(m[1]);
  const firstLine = txt
    .split("\n")
    .map((s) => s.trim())
    .filter(Boolean)[0];
  return firstLine || null;
}

export function extractPostMessageText(postHtml) {
  const m = /<div[^>]*\bid\s*=\s*["']post_message_\d+["'][^>]*>([\s\S]*?)<\/div>/i.exec(postHtml);
  if (!m) return "";
  return htmlToText(m[1]);
}
