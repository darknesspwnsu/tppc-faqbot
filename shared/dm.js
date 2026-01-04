// shared/dm.js
//
// Centralized DM helpers with metrics/logging.

import { logger } from "./logger.js";
import { metrics } from "./metrics.js";

function normalizePayload(payload) {
  if (payload == null) return { content: "" };
  if (typeof payload === "string") return { content: payload };
  return payload;
}

export async function sendDm({ user, payload, feature = "dm" } = {}) {
  if (!user || typeof user.send !== "function") {
    return { ok: false, code: "no-user" };
  }

  try {
    await user.send(normalizePayload(payload));
    return { ok: true };
  } catch (err) {
    const code = err?.code || "unknown";
    if (code === 50007) {
      void metrics.increment("dm.fail", { feature });
    }
    logger.warn("dm.send.failed", {
      feature,
      code,
      error: logger.serializeError(err),
    });
    return { ok: false, code, error: err };
  }
}

export async function sendDmBatch({ user, messages, feature = "dm" } = {}) {
  const list = Array.isArray(messages) ? messages : [];
  for (const msg of list) {
    const res = await sendDm({ user, payload: msg, feature });
    if (!res.ok) return res;
  }
  return { ok: true };
}

export async function sendDmChunked({
  user,
  header,
  lines,
  limit = 1900,
  feature = "dm",
} = {}) {
  const safeHeader = String(header || "").trim();
  const safeLines = (lines || []).map((l) => String(l));

  const out = [];
  let cur = safeHeader;
  for (const line of safeLines) {
    const add = (cur ? "\n" : "") + line;
    if ((cur + add).length > limit) {
      if (cur) out.push(cur);
      cur = line;
    } else {
      cur += add;
    }
  }
  if (cur) out.push(cur);

  return sendDmBatch({ user, messages: out, feature });
}

export const __testables = { normalizePayload };
