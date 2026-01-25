import { describe, it, expect, vi } from "vitest";
import { registerToybox } from "../toybox.js";

function makeRegister() {
  const handlers = {};
  let listener = null;
  const register = (cmd, handler, _help, opts = {}) => {
    handlers[cmd] = handler;
    const aliases = Array.isArray(opts.aliases) ? opts.aliases : [];
    for (const alias of aliases) {
      if (!alias) continue;
      handlers[String(alias)] = handler;
    }
  };
  register.expose = ({ name, handler, opts = {} }) => {
    handlers[`!${name}`] = handler;
    handlers[`?${name}`] = handler;
    const aliases = Array.isArray(opts.aliases) ? opts.aliases : [];
    for (const alias of aliases) {
      const base = String(alias || "").trim().replace(/^!|\?/, "");
      if (!base) continue;
      handlers[`!${base}`] = handler;
      handlers[`?${base}`] = handler;
    }
  };
  register.listener = (fn) => {
    listener = fn;
  };
  return { register, handlers, getListener: () => listener };
}

function makeMessage({
  authorId = "u1",
  mentionId = null,
  content = "",
  bot = false,
} = {}) {
  return {
    author: { id: authorId, bot },
    content,
    mentions: {
      users: {
        first: () => (mentionId ? { id: mentionId } : null),
      },
    },
    channel: { send: vi.fn() },
    reply: vi.fn(),
    react: vi.fn(),
  };
}

describe("toybox commands", () => {
  it("rig blesses mentioned or author user", async () => {
    const { register, handlers } = makeRegister();
    registerToybox(register);

    const message = makeMessage({ authorId: "a1", mentionId: "u2" });
    await handlers["!rig"]({ message });

    expect(message.channel.send).toHaveBeenCalledWith("<@u2> has now been blessed by rngesus.");
  });

  it("rig supports the bless alias", async () => {
    const { register, handlers } = makeRegister();
    registerToybox(register);

    const message = makeMessage({ authorId: "a1", mentionId: "u2" });
    await handlers["!bless"]({ message });

    expect(message.channel.send).toHaveBeenCalledWith("<@u2> has now been blessed by rngesus.");
  });

  it("curse blocks missing or self targets", async () => {
    const { register, handlers } = makeRegister();
    registerToybox(register);

    const message = makeMessage({ authorId: "u1" });
    await handlers["!curse"]({ message });
    expect(message.reply).toHaveBeenCalledWith("You must curse someone else (mention a user).");

    const selfTarget = makeMessage({ authorId: "u1", mentionId: "u1" });
    await handlers["!curse"]({ message: selfTarget });
    expect(selfTarget.reply).toHaveBeenCalledWith(
      "You can't curse yourself. Why would you want to do that?"
    );
  });

  it("slap validates target", async () => {
    const { register, handlers } = makeRegister();
    registerToybox(register);

    const message = makeMessage({ authorId: "u1", mentionId: "u2" });
    await handlers["!slap"]({ message });

    expect(message.channel.send).toHaveBeenCalledWith(
      "_<@u1> slaps <@u2> around a bit with a large trout._"
    );
  });

  it("m8ball requires a question", async () => {
    const { register, handlers } = makeRegister();
    registerToybox(register);

    const message = makeMessage({ authorId: "u1" });
    await handlers["!m8ball"]({ message, rest: "" });

    expect(message.reply).toHaveBeenCalledWith("Usage: `!m8ball <question>`");
  });

  it("m8ball replies with a configured response", async () => {
    const { register, handlers } = makeRegister();
    registerToybox(register);

    const rand = vi.spyOn(Math, "random").mockReturnValue(0);
    const message = makeMessage({ authorId: "u1" });
    await handlers["!m8ball"]({ message, rest: "Will I win?" });

    const replyArg = message.reply.mock.calls[0][0];
    expect(replyArg.content).toBe("🎱 It is certain");
    rand.mockRestore();
  });

  it("m8ball supports the 8ball alias", async () => {
    const { register, handlers } = makeRegister();
    registerToybox(register);

    const rand = vi.spyOn(Math, "random").mockReturnValue(0);
    const message = makeMessage({ authorId: "u1" });
    await handlers["!8ball"]({ message, rest: "Will I win?" });

    const replyArg = message.reply.mock.calls[0][0];
    expect(replyArg.content).toBe("🎱 It is certain");
    rand.mockRestore();
  });

  it("m8ball enforces a cooldown for normal users", async () => {
    const { register, handlers } = makeRegister();
    registerToybox(register);

    const now = vi
      .spyOn(Date, "now")
      .mockReturnValueOnce(100_000)
      .mockReturnValueOnce(101_000);

    const rand = vi.spyOn(Math, "random").mockReturnValue(0);
    const first = makeMessage({ authorId: "u1" });
    await handlers["!m8ball"]({ message: first, rest: "Will I win?" });

    const second = makeMessage({ authorId: "u1" });
    await handlers["!m8ball"]({ message: second, rest: "Again?" });

    expect(second.reply).toHaveBeenCalledWith(
      "⚠️ This command is on cooldown for another 14s!"
    );

    rand.mockRestore();
    now.mockRestore();
  });
});

describe("toybox listener", () => {
  it("reacts to intbkty messages", async () => {
    const { register, getListener } = makeRegister();
    registerToybox(register);

    const listener = getListener();
    const message = makeMessage({ content: "wow intbkty", authorId: "u1" });
    await listener({ message });

    expect(message.react).toHaveBeenCalledWith("👢");
  });

  it("ignores bot messages", async () => {
    const { register, getListener } = makeRegister();
    registerToybox(register);

    const listener = getListener();
    const message = makeMessage({ content: "intbkty", bot: true });
    await listener({ message });

    expect(message.react).not.toHaveBeenCalled();
  });
});
