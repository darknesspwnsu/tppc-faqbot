import { describe, it, expect, vi, beforeEach } from "vitest";

const dbMocks = vi.hoisted(() => ({
  getDb: vi.fn(),
}));

vi.mock("../../db.js", () => dbMocks);

const loggerMocks = vi.hoisted(() => ({
  logger: {
    warn: vi.fn(),
    serializeError: (err) => ({ message: err?.message }),
  },
}));

vi.mock("../../shared/logger.js", () => loggerMocks);

import { metrics, __testables } from "../../shared/metrics.js";

describe("metrics", () => {
  beforeEach(() => {
    dbMocks.getDb.mockReset();
    loggerMocks.logger.warn.mockReset();
  });

  it("normalizes tags and inserts into hourly bucket", async () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-01-02T03:45:12.000Z"));

    const execute = vi.fn().mockResolvedValueOnce([]);
    dbMocks.getDb.mockReturnValue({ execute });

    await metrics.increment("command.invoked", { status: "ok", cmd: "ping" }, 2);

    expect(execute).toHaveBeenCalledTimes(1);
    const [sql, params] = execute.mock.calls[0];
    expect(sql).toContain("INSERT INTO metrics_counters");
    expect(params[0]).toBe("2026-01-02 03:00:00");
    expect(params[1]).toBe("command.invoked");
    expect(params[3]).toBe(JSON.stringify({ cmd: "ping", status: "ok" }));
    expect(params[4]).toBe(2);

    vi.useRealTimers();
  });

  it("skips empty tag values and falls back to count=1", async () => {
    const execute = vi.fn().mockResolvedValueOnce([]);
    dbMocks.getDb.mockReturnValue({ execute });

    await metrics.increment("rpg.fetch", { status: "", method: "GET", extra: null }, "nope");

    const params = execute.mock.calls[0][1];
    expect(params[3]).toBe(JSON.stringify({ method: "GET" }));
    expect(params[4]).toBe(1);
  });
});
