import { describe, it, expect, vi } from "vitest";
import { registerToybox } from "../toybox.js";

function makeRegister() {
  const handlers = {};
  let listener = null;
  const register = (cmd, handler) => {
    handlers[cmd] = handler;
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
