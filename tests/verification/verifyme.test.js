import { describe, it, expect, vi, beforeEach } from "vitest";

vi.mock("../../db.js", () => ({
  getSavedId: vi.fn(),
  getUserText: vi.fn(),
  setUserText: vi.fn(),
  deleteUserText: vi.fn(),
}));

import { getSavedId, getUserText } from "../../db.js";
import { registerVerifyMe } from "../../verification/verifyme.js";

function makeRegister() {
  const components = new Map();
  return {
    slash: vi.fn(),
    component: (prefix, handler) => components.set(prefix, handler),
    __components: components,
  };
}

describe("verifyme forum ID lookup", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    process.env.FORUM_BOT_USERNAME = "bot";
    process.env.FORUM_BOT_PASSWORD = "pass";
    process.env.FORUM_BASE_URL = "https://forums.tppc.info";
  });

  it("logs fetch failures and DMs guidance without 'not found' line", async () => {
    global.fetch = vi.fn(async () => ({
      ok: false,
      status: 500,
      text: async () => "",
    }));

    getSavedId.mockResolvedValueOnce(null);
    getUserText.mockResolvedValueOnce("Darkness~");

    const reg = makeRegister();
    registerVerifyMe(reg);
    const handler = reg.__components.get("vfy:");
    expect(handler).toBeTypeOf("function");

    const dm = vi.fn(async () => {});
    const targetMember = {
      id: "target",
      roles: { add: vi.fn(async () => {}) },
      user: { send: dm },
    };

    const guild = {
      members: {
        fetch: vi.fn(async () => targetMember),
      },
    };

    const interaction = {
      guildId: "1332822580708511815",
      guild,
      member: { roles: { cache: new Map([["1333401501036711976", true]]) } },
      customId: "vfy:1332822580708511815:target:role:1455432278548418713",
      user: { id: "admin", toString: () => "<@admin>" },
      message: { content: "review", edit: vi.fn(async () => {}) },
      reply: vi.fn(async () => {}),
    };

    const errSpy = vi.spyOn(console, "error").mockImplementation(() => {});
    await handler({ interaction });

    expect(errSpy).toHaveBeenCalledTimes(1);
    expect(dm).toHaveBeenCalledTimes(1);
    const dmText = dm.mock.calls[0][0]?.content || "";
    expect(dmText).toMatch(/link your TPPC Trainer ID/i);
    expect(dmText).not.toMatch(/couldn't find/i);

    errSpy.mockRestore();
  });
});
