// wiki.js
import fs from "node:fs";
import path from "node:path";

function normalizeForSearch(s) {
  return (s ?? "")
    .toLowerCase()
    .trim()
    .replace(/[_]+/g, " ")
    .replace(/[^a-z0-9\s]/g, " ")
    .replace(/\s+/g, " ");
}

function titleToWikiUrl(title) {
  // MediaWiki style: spaces -> underscores
  const slug = title.replace(/\s+/g, "_");
  // encodeURIComponent will encode spaces etc; underscores remain
  return `https://wiki.tppc.info/${encodeURIComponent(slug)}`;
}

export function createWikiService(opts = {}) {
  const maxResults = Number(opts.maxResults ?? process.env.WIKI_MAX_RESULTS ?? 8);
  const titlesPath =
    opts.titlesPath ??
    process.env.WIKI_TITLES_PATH ??
    path.join(process.cwd(), "data", "wiki_titles.json");

  // Load once
  const raw = fs.readFileSync(titlesPath, "utf8");
  const titles = JSON.parse(raw);
  if (!Array.isArray(titles)) {
    throw new Error("wiki_titles.json must be a JSON array of strings");
  }

  // Precompute normalized titles for fast contains matching
  const items = titles
    .filter((t) => typeof t === "string" && t.trim())
    .map((title) => ({
      title,
      norm: normalizeForSearch(title),
    }));

  function search(queryRaw) {
    const q = normalizeForSearch(queryRaw);
    if (!q) return [];

    // contains match
    const matches = [];
    for (const it of items) {
      if (it.norm.includes(q)) matches.push(it.title);
    }

    // Prefer: exact (case-insensitive) first, then shorter titles, then alpha
    const qLower = (queryRaw ?? "").trim().toLowerCase();
    matches.sort((a, b) => {
      const aLower = a.toLowerCase();
      const bLower = b.toLowerCase();

      const aExact = aLower === qLower ? 0 : 1;
      const bExact = bLower === qLower ? 0 : 1;
      if (aExact !== bExact) return aExact - bExact;

      if (a.length !== b.length) return a.length - b.length;
      return a.localeCompare(b);
    });

    return matches.slice(0, maxResults).map((title) => ({
      title,
      url: titleToWikiUrl(title),
    }));
  }

  return { search };
}
