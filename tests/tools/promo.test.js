import { describe, it, expect, vi, beforeEach } from "vitest";

const getUserText = vi.fn();
const setUserText = vi.fn();
const isAdminOrPrivileged = vi.fn();

vi.mock("../../db.js", () => ({ getUserText, setUserText }));
vi.mock("../../auth.js", () => ({ isAdminOrPrivileged }));

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
  beforeEach(() => {
    vi.resetModules();
    vi.clearAllMocks();
  });

  it("!promo reads from storage and replies", async () => {
    getUserText.mockResolvedValueOnce("PROMO");
    const handlers = await getHandlers();

    const msg = makeMessage();
    await handlers.get("!promo")({ message: msg });

    expect(getUserText).toHaveBeenCalledTimes(1);
    expect(getUserText).toHaveBeenCalledWith({ guildId: "g1", userId: "__guild__", kind: "promo" });
    expect(msg.reply).toHaveBeenCalledTimes(1);
  });

  it("!promo replies even when storage fails", async () => {
    getUserText.mockRejectedValueOnce(new Error("db down"));
    const handlers = await getHandlers();

    const msg = makeMessage();
    await handlers.get("!promo")({ message: msg });

    expect(msg.reply).toHaveBeenCalledTimes(1);
  });

  it("!setpromo rejects empty input", async () => {
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
});
