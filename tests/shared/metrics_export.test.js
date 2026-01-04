import { describe, it, expect } from "vitest";

import { __testables } from "../../shared/metrics_export.js";

const { buildMetricsSnapshot, msUntilNextHour } = __testables;

describe("metrics export snapshot", () => {
  it("builds overview and timeseries from rows", () => {
    const now = Date.parse("2026-01-04T10:30:00Z");
    const rows = [
      {
        bucket_ts: "2026-01-04 10:00:00",
        metric: "command.invoked",
        tags_json: JSON.stringify({ cmd: "pokedex", status: "ok" }),
        count: 5,
      },
      {
        bucket_ts: "2026-01-04 09:00:00",
        metric: "external.fetch",
        tags_json: JSON.stringify({ source: "rpg", status: "error" }),
        count: 2,
      },
      {
        bucket_ts: "2026-01-02 08:00:00",
        metric: "dm.fail",
        tags_json: JSON.stringify({ feature: "viewbox" }),
        count: 1,
      },
    ];

    const snapshot = buildMetricsSnapshot(rows, { nowMs: now, windowDays: 90 });
    expect(snapshot.meta.bucket).toBe("hour");
    expect(snapshot.overview.last_24h["command.invoked"]).toBe(5);
    expect(snapshot.overview.last_24h["external.fetch"]).toBe(2);
    expect(snapshot.overview.top_commands_24h[0]).toEqual({ cmd: "pokedex", count: 5 });
    expect(snapshot.overview.top_errors_24h[0].metric).toBe("external.fetch");
    expect(snapshot.timeseries["command.invoked"][0].count).toBe(5);
  });

  it("computes ms until next hour", () => {
    const now = Date.parse("2026-01-04T10:30:15Z");
    const ms = msUntilNextHour(now);
    expect(ms).toBe(29 * 60 * 1000 + 45 * 1000);
  });
});
