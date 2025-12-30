import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";

const fsMocks = vi.hoisted(() => ({
  readFileSync: vi.fn(),
}));

vi.mock("node:fs", () => ({
  default: fsMocks,
  readFileSync: fsMocks.readFileSync,
}));

const authMocks = vi.hoisted(() => ({
  isAdminOrPrivileged: vi.fn(() => true),
}));

vi.mock("../../auth.js", () => authMocks);

import { createFaqService, registerInfoCommands } from "../../info/faq.js";

const originalEnv = { ...process.env };

function setFileMap(map) {
  fsMocks.readFileSync.mockImplementation((filePath) => {
    const key = String(filePath);
    for (const [needle, contents] of Object.entries(map)) {
      if (key.includes(needle)) return contents;
    }
    throw new Error(`Unexpected file read: ${filePath}`);
  });
}

function makeRegister() {
  const calls = new Map();
  const register = (cmd, handler) => calls.set(cmd, handler);
  register.expose = () => {};
  register.slash = () => {};
  register.component = () => {};
  register.onMessage = () => {};
  register.listener = () => {};
  register.getHandler = (cmd) => calls.get(cmd);
  return register;
}

function makeMessage() {
  return {
    guild: { id: "g1" },
    guildId: "g1",
    author: { id: "u1" },
    channel: { send: vi.fn(async () => ({})) },
    reply: vi.fn(async () => ({})),
  };
}

describe("faq service", () => {
  beforeEach(() => {
    process.env = { ...originalEnv, FAQ_MATCH_THRESHOLD: "0.5" };
    fsMocks.readFileSync.mockReset();
  });

  afterEach(() => {
    process.env = { ...originalEnv };
  });

  it("matches and renders FAQ entries", () => {
    setFileMap({
      "data/faq.json": JSON.stringify({
        version: "1",
        entries: [{ id: "q1", q: "How do I play", a: "Do this." }],
      }),
    });

    const faq = createFaqService();
    const out = faq.matchAndRender({ message: makeMessage(), questionRaw: "how do i play" });
    expect(out).toBe("Do this.");
  });

  it("registers FAQ commands that respond", async () => {
    setFileMap({
      "data/faq.json": JSON.stringify({
        entries: [{ id: "q1", q: "How do I play", a: "Do this." }],
      }),
      "data/ngs.json": JSON.stringify(["Pikachu", "Eevee"]),
      "data/glossary.json": JSON.stringify({ ul: "Unleveled" }),
      "data/wiki_titles.json": JSON.stringify(["Pokemon"]),
    });

    const register = makeRegister();
    registerInfoCommands(register);

    const faqHandler = register.getHandler("!faq");
    const ngHandler = register.getHandler("!ng");
    const glossaryHandler = register.getHandler("!glossary");

    const msg = makeMessage();
    await faqHandler({ message: msg, rest: "" });
    expect(msg.reply).toHaveBeenCalledWith(expect.stringContaining("Please ask a specific question"));

    await faqHandler({ message: msg, rest: "How do I play" });
    expect(msg.reply).toHaveBeenCalledWith("Do this.");

    await ngHandler({ message: msg });
    expect(msg.reply).toHaveBeenCalledWith(expect.stringContaining("Current NGs"));

    await glossaryHandler({ message: msg, rest: "ul" });
    expect(msg.reply).toHaveBeenCalledWith(expect.stringContaining("Unleveled"));
  });
});
