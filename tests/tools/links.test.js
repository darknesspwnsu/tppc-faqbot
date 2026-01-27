import { describe, it, expect, vi } from "vitest";
import { registerLinks } from "../../tools/links.js";

function makeRegistry() {
  const handlers = new Map();
  const helpByCmd = new Map();
  const register = (cmd, fn, help) => {
    handlers.set(cmd, fn);
    if (help) helpByCmd.set(cmd, help);
  };
  return { register, handlers, helpByCmd };
}

function makeMessage() {
  return {
    reply: vi.fn(async () => {}),
  };
}

describe("tools/links.js", () => {
  it("registers link commands", () => {
    const reg = makeRegistry();
    registerLinks(reg.register);
    expect(reg.handlers.has("!organizer")).toBe(true);
    expect(reg.handlers.has("!tools")).toBe(true);
  });

  it("mentions /sortbox in organizer help text", () => {
    const reg = makeRegistry();
    registerLinks(reg.register);

    const help = reg.helpByCmd.get("!organizer") || "";
    expect(help).toContain("/sortbox");
  });

  it("replies for !organizer and !tools", async () => {
    const reg = makeRegistry();
    registerLinks(reg.register);

    const organizer = reg.handlers.get("!organizer");
    const tools = reg.handlers.get("!tools");
    const msg1 = makeMessage();
    const msg2 = makeMessage();

    await organizer({ message: msg1 });
    await tools({ message: msg2 });

    expect(msg1.reply).toHaveBeenCalledTimes(1);
    expect(msg2.reply).toHaveBeenCalledTimes(1);
    expect(msg1.reply).toHaveBeenCalledWith(expect.stringContaining("/sortbox"));
  });
});
