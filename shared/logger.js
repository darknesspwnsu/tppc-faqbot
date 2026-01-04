// shared/logger.js
//
// Lightweight structured logger with level filtering.

const LEVELS = {
  error: 0,
  warn: 1,
  info: 2,
};

const DEFAULT_LEVEL = "error";
const DEFAULT_FORMAT = "text";

function resolveLevel() {
  const raw = String(process.env.LOG_LEVEL || DEFAULT_LEVEL).toLowerCase();
  return LEVELS[raw] != null ? raw : DEFAULT_LEVEL;
}

function resolveFormat() {
  const raw = String(process.env.LOG_FORMAT || DEFAULT_FORMAT).toLowerCase();
  return raw === "text" ? "text" : "json";
}

function shouldLog(level) {
  const current = resolveLevel();
  return LEVELS[level] <= LEVELS[current];
}

function serializeError(err) {
  if (!err) return null;
  return {
    name: err.name,
    message: err.message,
    stack: err.stack,
  };
}

function formatLine({ level, message, fields }) {
  const ts = new Date().toISOString();
  const payload = { ts, level, message, ...fields };
  if (resolveFormat() === "text") {
    const extras = Object.entries(fields || {})
      .map(([k, v]) => `${k}=${JSON.stringify(v)}`)
      .join(" ");
    return `[${ts}] ${level.toUpperCase()} ${message}${extras ? " " + extras : ""}`;
  }
  return JSON.stringify(payload);
}

function log(level, message, fields = {}) {
  if (!shouldLog(level)) return;
  const line = formatLine({ level, message, fields });
  if (level === "error") {
    console.error(line);
  } else if (level === "warn") {
    console.warn(line);
  } else {
    console.log(line);
  }
}

export const logger = {
  info: (message, fields) => log("info", message, fields),
  warn: (message, fields) => log("warn", message, fields),
  error: (message, fields) => log("error", message, fields),
  serializeError,
};
