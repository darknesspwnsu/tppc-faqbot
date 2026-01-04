import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";

const getUserTextRow = vi.fn();
const setUserText = vi.fn();
const getDb = vi.fn();
const isAdminOrPrivileged = vi.fn();

vi.mock("../../db.js", () => ({ getUserTextRow, setUserText, getDb }));
vi.mock("../../auth.js", () => ({ isAdminOrPrivileged }));
vi.mock("../../shared/metrics.js", () => ({ metrics: { increment: vi.fn(), incrementExternalFetch: vi.fn(), incrementSchedulerRun: vi.fn() } }));
vi.mock("../../rpg/rpg_client.js", () => ({
  RpgClient: class {
    fetchPage() {
      return `
        <table class="ranks facrew">
          <tbody>
            <tr class="r1"><td>Trainer</td><td>ShinyCarnivine</td><td>1</td><td></td></tr>
          </tbody>
        </table>`;
    }
  },
}));

function makeRegistry() {
  const handlers = new Map();
  const register = (cmd, fn) => handlers.set(cmd, fn);
  return { register, handlers };
}

function makeMessage({ guildId = "g1" } = {}) {
  return {
    guild: { id: guildId },
    reply: vi.fn(async () => {}),
  };
}

async function getHandlers() {
  const mod = await import("../../tools/promo.js");
  const reg = makeRegistry();
  mod.registerPromo(reg.register);
  return reg.handlers;
}

describe("tools/promo.js", () => {
  const envSnapshot = { ...process.env };

  beforeEach(() => {
    vi.resetModules();
    vi.clearAllMocks();
    getDb.mockReturnValue({ execute: vi.fn(async () => [[]]) });
    process.env.RPG_USERNAME = "user";
    process.env.RPG_PASSWORD = "pass";
  });

  afterEach(() => {
    process.env = { ...envSnapshot };
  });

  it("!promo reads from storage and replies", async () => {
    getUserTextRow.mockResolvedValueOnce({ text: "PROMO", updatedAt: Date.now() });
    const handlers = await getHandlers();

    const msg = makeMessage();
    await handlers.get("!promo")({ message: msg });

    expect(getUserTextRow).toHaveBeenCalledTimes(1);
    expect(getUserTextRow).toHaveBeenCalledWith({ guildId: "g1", userId: "__guild__", kind: "promo" });
    expect(msg.reply).toHaveBeenCalledTimes(1);
  });

  it("!promo replies even when storage fails", async () => {
    getUserTextRow.mockRejectedValueOnce(new Error("db down"));
    const handlers = await getHandlers();

    const msg = makeMessage();
    await handlers.get("!promo")({ message: msg });

    expect(msg.reply).toHaveBeenCalledTimes(1);
  });

  it("!setpromo rejects empty input for non-privileged users", async () => {
    isAdminOrPrivileged.mockReturnValueOnce(false);
    const handlers = await getHandlers();
    const msg = makeMessage();

    await handlers.get("!setpromo")({ message: msg, rest: "" });

    expect(msg.reply).toHaveBeenCalledTimes(1);
    expect(setUserText).toHaveBeenCalledTimes(0);
  });

  it("!setpromo rejects non-privileged users", async () => {
    isAdminOrPrivileged.mockReturnValueOnce(false);
    const handlers = await getHandlers();
    const msg = makeMessage();

    await handlers.get("!setpromo")({ message: msg, rest: "NEW PROMO" });

    expect(msg.reply).toHaveBeenCalledTimes(1);
    expect(setUserText).toHaveBeenCalledTimes(0);
  });

  it("!setpromo persists for privileged users", async () => {
    isAdminOrPrivileged.mockReturnValueOnce(true);
    const handlers = await getHandlers();
    const msg = makeMessage();

    await handlers.get("!setpromo")({ message: msg, rest: "NEW PROMO" });

    expect(setUserText).toHaveBeenCalledTimes(1);
    expect(setUserText).toHaveBeenCalledWith({
      guildId: "g1",
      userId: "__guild__",
      kind: "promo",
      text: "NEW PROMO",
    });
    expect(msg.reply).toHaveBeenCalledTimes(1);
  });

  it("!setpromo clears cache when privileged and empty", async () => {
    isAdminOrPrivileged.mockReturnValue(true);
    getUserTextRow.mockResolvedValueOnce({ text: "PROMO", updatedAt: Date.now() });
    const handlers = await getHandlers();
    const msg = makeMessage();

    await handlers.get("!promo")({ message: msg });
    expect(getUserTextRow).toHaveBeenCalledTimes(1);

    await handlers.get("!setpromo")({ message: msg, rest: "" });
    expect(setUserText).toHaveBeenCalledTimes(0);

    getUserTextRow.mockResolvedValueOnce({ text: "PROMO2", updatedAt: Date.now() });
    await handlers.get("!promo")({ message: msg });
    expect(setUserText).toHaveBeenCalledTimes(1);
    expect(setUserText).toHaveBeenCalledWith({
      guildId: "g1",
      userId: "__guild__",
      kind: "promo",
      text: "ShinyCarnivine",
    });
  });

  it("parsePromoPrize extracts the top promo", async () => {
    const mod = await import("../../tools/promo.js");
    const html = `
      <table class="ranks facrew">
        <tbody>
          <tr class="r1"><td>Trainer</td><td>ShinyCarnivine</td><td>1</td><td></td></tr>
          <tr class="r0"><td>Private</td><td>Team Boost</td><td>5</td><td></td></tr>
        </tbody>
      </table>`;
    expect(mod.__testables.parsePromoPrize(html)).toBe("ShinyCarnivine");
  });

  it("promo schedule targets Sunday midnight ET", async () => {
    const mod = await import("../../tools/promo.js");
    vi.setSystemTime(new Date("2026-01-05T12:00:00Z")); // Mon 07:00 ET
    const next = mod.__testables.nextPromoRefreshEt(new Date());
    expect(next.toISOString()).toBe("2026-01-10T05:00:00.000Z");
  });

  it("promo stale check flips after weekly rollover", async () => {
    const mod = await import("../../tools/promo.js");
    vi.setSystemTime(new Date("2026-01-05T12:00:00Z"));
    const now = Date.now();
    const notStale = mod.__testables.isPromoStale(now);
    expect(notStale).toBe(false);
    const stale = mod.__testables.isPromoStale(now - 8 * 24 * 60 * 60_000);
    expect(stale).toBe(true);
  });
});
