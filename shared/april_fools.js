const APRIL_FOOLS_TIME_ZONE = "America/New_York";

function normalizeMidnight(parts) {
  if (parts.hour !== 24) return;
  parts.hour = 0;
}

function getZonedParts(date, timeZone = APRIL_FOOLS_TIME_ZONE) {
  const fmt = new Intl.DateTimeFormat("en-US", {
    timeZone,
    hour12: false,
    hourCycle: "h23",
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
    second: "2-digit",
  });

  const rawParts = fmt.formatToParts(date);
  const out = {};
  for (const part of rawParts) {
    if (part.type === "year") out.year = Number(part.value);
    if (part.type === "month") out.month = Number(part.value);
    if (part.type === "day") out.day = Number(part.value);
    if (part.type === "hour") out.hour = Number(part.value);
    if (part.type === "minute") out.minute = Number(part.value);
    if (part.type === "second") out.second = Number(part.value);
  }

  normalizeMidnight(out);
  return out;
}

export function isAprilFoolsActive(date = new Date()) {
  const parts = getZonedParts(date, APRIL_FOOLS_TIME_ZONE);
  return parts.month === 4 && parts.day === 1;
}

export function isAprilFoolsBypassed(ctx = {}) {
  return Boolean(ctx?.aprilFoolsBypass || ctx?.message?.__aprilFoolsBypass);
}

export const __testables = {
  APRIL_FOOLS_TIME_ZONE,
  getZonedParts,
};
