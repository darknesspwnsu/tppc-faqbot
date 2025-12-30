import { describe, it, expect, vi, beforeEach } from "vitest";

vi.mock("../../db.js", () => ({
  getUserText: vi.fn(),
}));

import { getUserText } from "../../db.js";
import { registerWhois } from "../../verification/whois.js";

function makeRegister() {
  let handler = null;
  return {
    slash: vi.fn((_def, fn) => {
      handler = fn;
    }),
    __handler: () => handler,
  };
}

describe("whois", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("replies with verified forum username", async () => {
    getUserText.mockResolvedValueOnce("Darkness~");

    const reg = makeRegister();
    registerWhois(reg);
    const handler = reg.__handler();
    expect(handler).toBeTypeOf("function");

    const reply = vi.fn(async () => {});
    const interaction = {
      guildId: "g1",
      options: {
        getUser: (_name, _required) => ({ id: "u1", toString: () => "<@u1>" }),
      },
      reply,
    };

    await handler({ interaction });
    expect(reply).toHaveBeenCalledTimes(1);
    const payload = reply.mock.calls[0][0];
    expect(payload.content).toMatch(/verified as forum user/i);
  });

  it("replies when user is not verified", async () => {
    getUserText.mockResolvedValueOnce(null);

    const reg = makeRegister();
    registerWhois(reg);
    const handler = reg.__handler();

    const reply = vi.fn(async () => {});
    const interaction = {
      guildId: "g1",
      options: {
        getUser: (_name, _required) => ({ id: "u2", toString: () => "<@u2>" }),
      },
      reply,
    };

    await handler({ interaction });
    expect(reply).toHaveBeenCalledTimes(1);
    const payload = reply.mock.calls[0][0];
    expect(payload.content).toMatch(/not verified/i);
  });
});
