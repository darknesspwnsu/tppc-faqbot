import { describe, expect, it, vi, beforeEach } from "vitest";

const { sendDm, increment, warn } = vi.hoisted(() => ({
  sendDm: vi.fn(async () => ({ ok: true })),
  increment: vi.fn(),
  warn: vi.fn(),
}));

vi.mock("../../shared/dm.js", () => ({ sendDm }));
vi.mock("../../shared/metrics.js", () => ({ metrics: { increment } }));
vi.mock("../../shared/logger.js", () => ({ logger: { warn } }));
const execute = vi.fn(async () => [[]]);
vi.mock("../../db.js", () => ({ getDb: () => ({ execute }) }));
vi.mock("../../configs/welcome_config.js", () => ({
  WELCOME_GUILD_IDS: new Set(["329934860388925442"]),
  WELCOME_MESSAGE: "welcome",
}));

import { handleGuildMemberAdd, __testables } from "../../info/welcome.js";

describe("welcome DM", () => {
  beforeEach(() => {
    sendDm.mockClear();
    increment.mockClear();
    warn.mockClear();
    execute.mockClear();
  });

  it("skips bots", async () => {
    await handleGuildMemberAdd({
      user: { id: "u1", bot: true },
      guild: { id: "329934860388925442" },
    });
    expect(sendDm).not.toHaveBeenCalled();
  });

  it("skips guilds not configured", async () => {
    await handleGuildMemberAdd({
      user: { id: "u1", bot: false },
      guild: { id: "123" },
    });
    expect(sendDm).not.toHaveBeenCalled();
  });

  it("sends the welcome DM", async () => {
    await handleGuildMemberAdd({
      user: { id: "u1", bot: false },
      guild: { id: "329934860388925442" },
    });
    expect(sendDm).toHaveBeenCalledWith({
      user: { id: "u1", bot: false },
      payload: __testables.WELCOME_MESSAGE,
      feature: "welcome",
    });
    expect(increment).toHaveBeenCalledWith("welcome.dm", { status: "ok" });
  });

  it("skips users already welcomed", async () => {
    execute.mockImplementation(async (sql) => {
      if (sql.includes("FROM welcome_dms")) {
        return [[{ ok: 1 }]];
      }
      return [[]];
    });
    await handleGuildMemberAdd({
      user: { id: "u1", bot: false },
      guild: { id: "329934860388925442" },
    });
    expect(sendDm).not.toHaveBeenCalled();
  });

  it("logs failures", async () => {
    sendDm.mockResolvedValueOnce({ ok: false, code: "E_FAIL", error: new Error("nope") });
    await handleGuildMemberAdd({
      user: { id: "u1", bot: false },
      guild: { id: "329934860388925442" },
    });
    expect(increment).toHaveBeenCalledWith("welcome.dm", { status: "error" });
    expect(warn).toHaveBeenCalled();
  });
});
