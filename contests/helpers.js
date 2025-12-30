// contests/helpers.js
//
// Shared helpers for contest modules.

import { isAdminOrPrivileged } from "../auth.js";

export function isAdminOrPrivilegedMessage(messageLike) {
  try {
    return Boolean(isAdminOrPrivileged(messageLike));
  } catch {
    return false;
  }
}

// Remove emojis & symbols, keep letters/numbers/spaces
export function stripEmojisAndSymbols(name) {
  if (!name) return "";
  return String(name)
    .replace(/[^\p{L}\p{N}\s]/gu, "")
    .trim();
}

/**
 * Normalize text for matching:
 * - lowercase
 * - treat punctuation/symbols as spaces
 * - collapse whitespace
 * - pad with spaces so we can do whole-word/phrase boundary checks
 *
 * Example:
 *  "Hello, WORLD!!" -> " hello world "
 */
export function normalizeForMatch(s) {
  const t = String(s ?? "").trim().toLowerCase();
  const cleaned = t.replace(/[^a-z0-9]+/g, " ");
  const collapsed = cleaned.replace(/\s+/g, " ").trim();
  return collapsed ? ` ${collapsed} ` : " ";
}

/**
 * Whole-word / whole-phrase match.
 * Works because normalizeForMatch pads with spaces.
 */
export function includesWholePhrase(normalizedMessage, phrase) {
  const p = normalizeForMatch(phrase);
  if (!p || p === " ") return false;
  return normalizedMessage.includes(p);
}

export async function sendChunked({ send, header, lines, limit = 1900 }) {
  const safeHeader = String(header || "").trim();
  const safeLines = Array.isArray(lines) ? lines : [];
  const body = safeLines.join("\n");

  const out = safeHeader ? `${safeHeader}\n\n${body}` : body;
  if (out.length <= limit) {
    if (out) await send(out);
    return;
  }

  if (safeHeader) await send(safeHeader);

  let chunk = "";
  for (const line of safeLines) {
    if ((chunk + "\n" + line).length > limit) {
      await send(chunk);
      chunk = line;
    } else {
      chunk = chunk ? `${chunk}\n${line}` : line;
    }
  }
  if (chunk) await send(chunk);
}

export async function dmChunked(user, header, lines, limit = 1900) {
  const dm = await user.createDM();

  let cur = String(header || "").trim();
  for (const line of lines) {
    const add = (cur ? "\n" : "") + line;
    if ((cur + add).length > limit) {
      await dm.send(cur);
      cur = line;
    } else {
      cur += add;
    }
  }
  if (cur) await dm.send(cur);
}
