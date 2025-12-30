import { describe, it, expect, vi, beforeEach } from "vitest";
import { registerCalculator, __testables } from "../calculator.js";

const {
  parseNum,
  levelToExp,
  expToLevel,
  marketPriceAtLevel,
  buyerPaysAtLevel,
  sellerGetsAtLevel,
  minLevelForTarget,
  maxLevelForBudget,
  levelForBuyerPays,
  levelForSellerGets,
} = __testables;

function makeMessage() {
  return {
    reply: vi.fn(async () => {}),
  };
}

function makeRegistry() {
  const handlers = new Map(); // command -> fn
  const meta = new Map(); // command -> { aliases, helpTier... }
  const register = (cmd, fn, help, opts = {}) => {
    handlers.set(cmd, fn);
    meta.set(cmd, { help, opts });
  };
  return { register, handlers, meta };
}

async function runBang(handlers, cmd, rest) {
  const fn = handlers.get(cmd);
  if (!fn) throw new Error(`Missing handler for ${cmd}`);
  const message = makeMessage();
  await fn({ message, rest: rest ?? "" });
  return message;
}

describe("calculator.js", () => {
  let handlers;

  beforeEach(() => {
    const reg = makeRegistry();
    registerCalculator(reg.register);
    handlers = reg.handlers;
  });

  it("registers !calculate and !calculator", () => {
    expect(handlers.has("!calculate")).toBe(true);
    expect(handlers.has("!calculator")).toBe(true);
  });

  it("!calculate with empty args replies", async () => {
    const msg = await runBang(handlers, "!calculate", "");
    expect(msg.reply).toHaveBeenCalledTimes(1);
  });

  it("help replies", async () => {
    const msg = await runBang(handlers, "!calculate", "help");
    expect(msg.reply).toHaveBeenCalledTimes(1);
  });

  it("unknown function replies", async () => {
    const msg = await runBang(handlers, "!calculate", "nope 123");
    expect(msg.reply).toHaveBeenCalledTimes(1);
  });

  it("l2e and l2eb reply for valid input", async () => {
    const msg1 = await runBang(handlers, "!calculate", "l2e 125");
    expect(msg1.reply).toHaveBeenCalledTimes(1);

    const msg2 = await runBang(handlers, "!calculate", "l2eb 125");
    expect(msg2.reply).toHaveBeenCalledTimes(1);
  });

  it("l2e rejects negative or missing args silently", async () => {
    const msg1 = await runBang(handlers, "!calculate", "l2e");
    expect(msg1.reply).toHaveBeenCalledTimes(0);

    const msg2 = await runBang(handlers, "!calculate", "l2e -5");
    expect(msg2.reply).toHaveBeenCalledTimes(0);
  });

  it("e2l parses formatted numbers and replies", async () => {
    const msg = await runBang(handlers, "!calculate", "e2l 100,162");
    expect(msg.reply).toHaveBeenCalledTimes(1);

    const msg2 = await runBang(handlers, "!calculate", "e2l  100_162 ");
    expect(msg2.reply).toHaveBeenCalledTimes(1);
  });

  it("eb2l accepts decimals in billions", async () => {
    const msg = await runBang(handlers, "!calculate", "eb2l 42.5");
    expect(msg.reply).toHaveBeenCalledTimes(1);
  });

  it("buy / buym reply for valid input", async () => {
    const msg = await runBang(handlers, "!calculate", "buy 500000000");
    expect(msg.reply).toHaveBeenCalledTimes(1);

    const msg2 = await runBang(handlers, "!calculate", "buym 500");
    expect(msg2.reply).toHaveBeenCalledTimes(1);
  });

  it("sell / sellm reply for valid input", async () => {
    const msg = await runBang(handlers, "!calculate", "sell 250000000");
    expect(msg.reply).toHaveBeenCalledTimes(1);

    const msg2 = await runBang(handlers, "!calculate", "sellm 250");
    expect(msg2.reply).toHaveBeenCalledTimes(1);
  });

  it("ld replies for valid input", async () => {
    const msg = await runBang(handlers, "!calculate", "ld 1500 1200");
    expect(msg.reply).toHaveBeenCalledTimes(1);
  });

  it("la replies for valid input", async () => {
    const msg = await runBang(handlers, "!calculate", "la 100 200 300");
    expect(msg.reply).toHaveBeenCalledTimes(1);
  });

  it("ea and eba reply for valid input", async () => {
    const msg = await runBang(handlers, "!calculate", "ea 100000 200000 300000");
    expect(msg.reply).toHaveBeenCalledTimes(1);

    const msg2 = await runBang(handlers, "!calculate", "eba 42.5 10 1.25");
    expect(msg2.reply).toHaveBeenCalledTimes(1);
  });

  it("invalid numeric input is rejected silently for numeric functions", async () => {
    const m1 = await runBang(handlers, "!calculate", "e2l notanumber");
    expect(m1.reply).toHaveBeenCalledTimes(0);

    const m2 = await runBang(handlers, "!calculate", "la 100 nope 200");
    expect(m2.reply).toHaveBeenCalledTimes(0);

    const m3 = await runBang(handlers, "!calculate", "buy 0");
    expect(m3.reply).toHaveBeenCalledTimes(0);

    const m4 = await runBang(handlers, "!calculate", "ld 5");
    expect(m4.reply).toHaveBeenCalledTimes(0);
  });

  it("!calculator replies when called with empty or 'help'", async () => {
    const msg1 = await runBang(handlers, "!calculator", "");
    expect(msg1.reply).toHaveBeenCalledTimes(1);

    const msg2 = await runBang(handlers, "!calculator", "help");
    expect(msg2.reply).toHaveBeenCalledTimes(1);
  });

  it("!calculator with other args does nothing", async () => {
    const msg = await runBang(handlers, "!calculator", "nope");
    expect(msg.reply).toHaveBeenCalledTimes(0);
  });

  it("calculator math helpers are consistent", () => {
    expect(parseNum("1,234")).toBe(1234);
    expect(levelToExp(10)).toBe(1001);
    expect(expToLevel(1001)).toBe(10);
    expect(marketPriceAtLevel(2)).toBe(10 * (2 ** 3 + 1));
    expect(buyerPaysAtLevel(2, true)).toBe(Math.floor(marketPriceAtLevel(2) * 2 / 3));
    expect(sellerGetsAtLevel(2)).toBe(Math.floor(marketPriceAtLevel(2) / 2));
    expect(minLevelForTarget(100, (L) => L * 10)).toBe(10);
    expect(maxLevelForBudget(99, (L) => L * 10)).toBe(9);
    expect(levelForBuyerPays(1_000_000, false)).not.toBe(null);
    expect(levelForSellerGets(1_000_000)).not.toBe(null);
  });
});
