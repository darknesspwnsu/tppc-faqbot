import { describe, it, expect, vi } from "vitest";

const metricsMock = vi.hoisted(() => ({
  increment: vi.fn(),
}));

const loggerMock = vi.hoisted(() => ({
  warn: vi.fn(),
  serializeError: (err) => ({ message: err?.message }),
}));

vi.mock("../../shared/metrics.js", () => ({ metrics: metricsMock }));
vi.mock("../../shared/logger.js", () => ({ logger: loggerMock }));

import { sendDm, sendDmChunked } from "../../shared/dm.js";

describe("dm helpers", () => {
  it("records dm.fail on 50007 errors", async () => {
    const user = {
      send: vi.fn().mockRejectedValue({ code: 50007 }),
    };
    const res = await sendDm({ user, payload: "hi", feature: "test" });
    expect(res.ok).toBe(false);
    expect(metricsMock.increment).toHaveBeenCalledWith("dm.fail", { feature: "test" });
  });

  it("chunks and sends multiple messages", async () => {
    const user = { send: vi.fn().mockResolvedValue({}) };
    const lines = ["a", "b", "c"];
    const res = await sendDmChunked({ user, header: "h", lines, limit: 4, feature: "chunk" });
    expect(res.ok).toBe(true);
    expect(user.send).toHaveBeenCalledTimes(2);
  });
});
