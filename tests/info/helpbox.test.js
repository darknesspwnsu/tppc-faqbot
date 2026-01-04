import { describe, it, expect, vi } from "vitest";

vi.mock("discord.js", () => ({
  MessageFlags: { Ephemeral: 64 },
}));

import { registerHelpbox } from "../../info/helpbox.js";

function makeRegister() {
  const commands = new Map();
  const slashHandlers = new Map();
  const components = new Map();

  const register = (cmd, handler) => {
    commands.set(cmd, handler);
  };

  register.slash = (def, handler) => {
    slashHandlers.set(def.name, handler);
  };

  register.component = (prefix, handler) => {
    components.set(prefix, handler);
  };

  register.getHandler = (cmd) => commands.get(cmd);
  register.getSlash = (name) => slashHandlers.get(name);
  register.getComponent = (prefix) => components.get(prefix);

  return register;
}

const pages = [
  { category: "Info", lines: ["!faq", "!help"] },
  { category: "Trading", lines: ["!ft", "!lf"] },
  { category: "Admin", lines: ["!admincmd"] },
];

function helpModel() {
  return pages;
}

describe("helpbox", () => {
  it("handles !help redirect and category rendering", async () => {
    const register = makeRegister();
    registerHelpbox(register, { helpModel });

    const handler = register.getHandler("!help");
    const message = {
      guildId: "g1",
      member: {},
      author: { id: "u1" },
      reply: vi.fn(async () => ({})),
    };

    await handler({ message, rest: "" });
    expect(message.reply).toHaveBeenCalledWith(
      "Use `/help` for the full command list (private)."
    );

    await handler({ message, rest: "Info" });
    expect(message.reply).toHaveBeenCalledWith(
      expect.stringContaining("**Info**")
    );

    await handler({ message, rest: "Admin" });
    expect(message.reply).toHaveBeenCalledWith(
      expect.stringContaining("Unknown help category")
    );
  });

  it("renders /help response and component updates", async () => {
    const register = makeRegister();
    registerHelpbox(register, { helpModel });

    const slash = register.getSlash("help");
    const interaction = {
      guildId: "g1",
      user: { id: "u1" },
      member: {},
      options: { getString: () => null },
      reply: vi.fn(async () => ({})),
    };

    await slash({ interaction });
    expect(interaction.reply).toHaveBeenCalledWith(
      expect.objectContaining({
        flags: 64,
        embeds: [expect.any(Object)],
      })
    );

    const helpcat = register.getComponent("helpcat:");
    const updateInteraction = {
      guildId: "g1",
      user: { id: "u1" },
      member: {},
      customId: "helpcat:1",
      update: vi.fn(async () => ({})),
    };

    await helpcat({ interaction: updateInteraction });
    expect(updateInteraction.update).toHaveBeenCalledWith(
      expect.objectContaining({
        embeds: [expect.any(Object)],
        components: expect.any(Array),
      })
    );
  });
});
