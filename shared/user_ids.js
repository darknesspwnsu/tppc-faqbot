// shared/user_ids.js
//
// Helpers for reading stored trainer ID lists with legacy fallback.

import { getSavedId, getUserText } from "../db.js";

function resolveDefaultAddedAt(defaultAddedAt) {
  if (typeof defaultAddedAt === "function") return defaultAddedAt;
  return () => defaultAddedAt;
}

export function parseStoredIds(text, { defaultAddedAt = 0 } = {}) {
  if (!text) return [];
  try {
    const parsed = JSON.parse(text);
    const entries = Array.isArray(parsed) ? parsed : parsed?.ids;
    if (!Array.isArray(entries)) return [];

    const getAddedAt = resolveDefaultAddedAt(defaultAddedAt);
    return entries
      .map((entry) => {
        const id = Number(entry?.id);
        if (!Number.isSafeInteger(id)) return null;
        return {
          id,
          label: entry?.label ? String(entry.label) : null,
          addedAt: Number(entry?.addedAt) || getAddedAt(),
        };
      })
      .filter(Boolean);
  } catch {
    return [];
  }
}

export async function loadUserIds({
  guildId,
  userId,
  kind = "ids",
  defaultAddedAt = 0,
  onLegacy = null,
} = {}) {
  const text = await getUserText({ guildId, userId, kind });
  const entries = parseStoredIds(text, { defaultAddedAt });
  if (entries.length) return entries;

  const legacy = await getSavedId({ guildId, userId });
  if (legacy == null) return [];

  const getAddedAt = resolveDefaultAddedAt(defaultAddedAt);
  const legacyEntries = [{ id: Number(legacy), label: null, addedAt: getAddedAt() }];
  if (typeof onLegacy === "function") {
    await onLegacy(legacyEntries);
  }
  return legacyEntries;
}
