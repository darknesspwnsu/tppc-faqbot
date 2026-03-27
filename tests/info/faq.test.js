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

const embeddingMocks = vi.hoisted(() => ({
  embedTexts: vi.fn(async (texts) =>
    (Array.isArray(texts) ? texts : [texts]).map((text) => {
      const tokens = String(text ?? "")
        .toLowerCase()
        .replace(/[^a-z0-9\s]/g, " ")
        .split(/\s+/)
        .filter(Boolean);
      const dims = new Array(16).fill(0);

      for (const token of tokens) {
        let hash = 0;
        for (let i = 0; i < token.length; i += 1) {
          hash = (hash * 31 + token.charCodeAt(i)) >>> 0;
        }
        dims[hash % dims.length] += 1;
      }

      const norm = Math.sqrt(dims.reduce((sum, value) => sum + value * value, 0)) || 1;
      return dims.map((value) => value / norm);
    })
  ),
  getDefaultLocalEmbeddingModel: vi.fn(() => "mock-local-model")
}));

vi.mock("../../shared/local_embeddings.js", () => embeddingMocks);

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
    process.env = {
      ...originalEnv,
      FAQ_LOCAL_EMBEDDING_THRESHOLD: "0.5"
    };
    fsMocks.readFileSync.mockReset();
    embeddingMocks.embedTexts.mockClear();
  });

  afterEach(() => {
    process.env = { ...originalEnv };
  });

  it("matches and renders FAQ entries", async () => {
    setFileMap({
      "data/faq.json": JSON.stringify({
        version: "1",
        entries: [{ id: "q1", q: "How do I play", a: "Do this." }],
      }),
    });

    const faq = createFaqService();
    const out = await faq.matchAndRender({ message: makeMessage(), questionRaw: "how do i play" });
    expect(out).toBe("Do this.");
  });

  it("recovers noisy typo-heavy queries with normalization", async () => {
    setFileMap({
      "data/faq.json": JSON.stringify({
        entries: [{ id: "trade_caps", q: "What are trade caps?", a: "Caps." }],
      }),
    });

    const faq = createFaqService();
    const out = await faq.matchAndRender({
      message: makeMessage(),
      questionRaw: "wht r trade capz on tpcc",
    });
    expect(out).toBe("Caps.");
  });

  it("uses richer semantic metadata for rank-based trade cap phrasing", async () => {
    setFileMap({
      "data/faq.json": JSON.stringify({
        entries: [
          {
            id: "trade_caps",
            question: "What are the trade caps by rank?",
            examples: ["trade caps", "what cap does commander rank get"],
            intentDescription:
              "trade cap limits by rank, commander cap, max trade level allowed for each rank",
            a: "Caps."
          },
        ],
      }),
    });

    const faq = createFaqService();
    const out = await faq.matchAndRender({
      message: makeMessage(),
      questionRaw: "are trading caps different for commanders",
    });
    expect(out).toBe("Caps.");
  });

  it("separates unsold return intent from completed-sale payout intent", async () => {
    setFileMap({
      "data/faq.json": JSON.stringify({
        entries: [
          {
            id: "proto_unsold_pokemon_return",
            question: "Do unsold pokemon return to me after the sale timer ends?",
            examples: [
              "if my pokemon doesn't sell on the buy page do i get it back",
              "when the buy page timer ends does my pokemon return"
            ],
            intentDescription:
              "unsold pokemon returns to your account after listing expires on the buy page",
            a: "Returns."
          },
          {
            id: "pokemon_sale_price",
            question: "Why didn't I receive the full price for the pokemon I sold?",
            examples: ["how much money do i receive when a pokemon sells"],
            intentDescription: "completed sale payout and tax after a pokemon is bought",
            denyTerms: ["get it back", "return to me", "unsold"],
            a: "Price."
          }
        ],
      }),
    });

    const faq = createFaqService();
    const out = await faq.matchAndRender({
      message: makeMessage(),
      questionRaw: "i sold my pokemon on the buy page so can i get it back",
    });
    expect(out).toBe("Returns.");
  });

  it("registers FAQ commands that respond", async () => {
    setFileMap({
      "data/faq.json": JSON.stringify({
        entries: [
          { id: "q1", q: "How do I play", a: "Do this." },
          { id: "proto_1", question: "Can I macro or automate clicking?", answer: "lorem ipsum" },
        ],
      }),
      "data/ngs.json": JSON.stringify(["Pikachu", "Eevee"]),
      "data/glossary.json": JSON.stringify({ ul: "Unleveled" }),
      "data/wiki_titles.json": JSON.stringify(["Pokemon"]),
    });

    const register = makeRegister();
    registerInfoCommands(register);

    const faqHandler = register.getHandler("!faq");
    const faqDebugHandler = register.getHandler("!faqdebug");
    const ngHandler = register.getHandler("!ng");
    const glossaryHandler = register.getHandler("!glossary");

    const msg = makeMessage();
    await faqHandler({ message: msg, rest: "" });
    expect(msg.reply).toHaveBeenCalledWith(expect.stringContaining("Please ask a specific question"));

    await faqHandler({ message: msg, rest: "How do I play" });
    expect(msg.reply).toHaveBeenCalledWith("Do this.");

    await faqHandler({ message: msg, rest: "can i automate clicking" });
    expect(msg.reply).toHaveBeenCalledWith("lorem ipsum");

    await faqDebugHandler({ message: msg, rest: "How do I play" });
    expect(msg.reply).toHaveBeenCalledWith(expect.stringContaining("q1"));

    await ngHandler({ message: msg });
    expect(msg.reply).toHaveBeenCalledWith(expect.stringContaining("Current NGs"));

    await glossaryHandler({ message: msg, rest: "ul" });
    expect(msg.reply).toHaveBeenCalledWith(expect.stringContaining("Unleveled"));
  });

  it("returns a best-match clarify response for borderline matches", async () => {
    process.env.FAQ_LOCAL_EMBEDDING_THRESHOLD = "0.90";
    process.env.FAQ_LOCAL_EMBEDDING_CLARIFY_THRESHOLD = "0.50";
    process.env.FAQ_CLARIFY_MIN_MARGIN = "0.04";
    process.env.FAQ_MEANINGFUL_OVERLAP_MIN = "2";

    setFileMap({
      "data/faq.json": JSON.stringify({
        entries: [
          { id: "proto_1", question: "Can I macro or automate clicking?", answer: "lorem ipsum" },
          { id: "proto_2", question: "Can I gamble?", answer: "ipsum lorem" }
        ],
      }),
      "data/ngs.json": JSON.stringify(["Pikachu", "Eevee"]),
      "data/glossary.json": JSON.stringify({ ul: "Unleveled" }),
      "data/wiki_titles.json": JSON.stringify(["Pokemon"]),
    });

    const register = makeRegister();
    registerInfoCommands(register);
    const faqHandler = register.getHandler("!faq");

    const msg = makeMessage();
    await faqHandler({ message: msg, rest: "can i automate clicking" });
    expect(msg.reply).toHaveBeenCalledWith(expect.stringContaining("Best FAQ match:"));
    expect(msg.reply).toHaveBeenCalledWith(expect.stringContaining("lorem ipsum"));
  });

  it("falls back to channel send if reply reference is gone", async () => {
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

    const msg = makeMessage();
    msg.reply = vi.fn(async () => {
      const error = new Error("Invalid Form Body\nmessage_reference[MESSAGE_REFERENCE_UNKNOWN_MESSAGE]: Unknown message");
      error.code = 50035;
      throw error;
    });

    await faqHandler({ message: msg, rest: "How do I play" });
    expect(msg.channel.send).toHaveBeenCalledWith("Do this.");
  });

  it("merges prototype FAQs on top of the base corpus", async () => {
    setFileMap({
      "data/faq.json": JSON.stringify({
        entries: [
          { id: "new_starter_quests", q: "What are the new starter quests?", a: "Old answer." },
          { id: "new_starter_quests", question: "What are the new starter quests?", answer: "lorem ipsum" },
        ],
      }),
    });

    const faq = createFaqService();

    const out = await faq.matchAndRender({
      message: makeMessage(),
      questionRaw: "what are the new starter quests",
    });

    expect(out).toBe("lorem ipsum");
  });
});
