import { describe, it, expect, vi, beforeEach } from "vitest";
import { registerCalculator } from "../calculator.js";

/**
 * Test harness notes:
 * - calculator.js only exports registerCalculator, so we test by registering commands and invoking handlers.
 * - Some invalid inputs intentionally "return" without replying. We assert reply NOT called for those cases.
 */

// ----- Minimal math re-implementation (for expected values) -----
function levelToExp(level) {
  return Math.pow(level, 3) + 1;
}
function expToLevel(exp) {
  if (exp < 1) return 0;
  const t = exp - 1;
  let L = Math.floor(Math.cbrt(t));
  while (levelToExp(L + 1) <= exp) L++;
  while (L > 0 && levelToExp(L) > exp) L--;
  return L;
}
function marketPriceAtLevel(level) {
  return 10 * levelToExp(level);
}
function buyerPaysAtLevel(level, ppEnabled) {
  const mp = marketPriceAtLevel(level);
  return ppEnabled ? Math.floor((mp * 2) / 3) : mp;
}
function sellerGetsAtLevel(level) {
  const mp = marketPriceAtLevel(level);
  return Math.floor(mp / 2);
}
function minLevelForTarget(target, f) {
  if (!Number.isFinite(target) || target <= 0) return null;
  let lo = 1;
  let hi = 1;
  while (f(hi) < target) {
    hi *= 2;
    if (hi > 50_000_000) return null;
  }
  while (lo < hi) {
    const mid = Math.floor((lo + hi) / 2);
    if (f(mid) >= target) hi = mid;
    else lo = mid + 1;
  }
  return lo;
}
function maxLevelForBudget(budget, f) {
  if (!Number.isFinite(budget) || budget <= 0) return null;
  if (f(1) > budget) return 0;
  const firstTooExpensive = minLevelForTarget(budget + 1, f);
  if (firstTooExpensive == null) return null;
  return Math.max(0, firstTooExpensive - 1);
}

function levelForBuyerPays(target, ppEnabled) {
  return maxLevelForBudget(target, (L) => buyerPaysAtLevel(L, ppEnabled));
}
function levelForSellerGets(target) {
  return maxLevelForBudget(target, (L) => sellerGetsAtLevel(L));
}

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

  it("!calculate with empty args prints usage", async () => {
    const msg = await runBang(handlers, "!calculate", "");
    expect(msg.reply).toHaveBeenCalledTimes(1);
    const text = msg.reply.mock.calls[0][0];
    expect(String(text)).toContain("Usage:");
    expect(String(text)).toContain("!calc help");
  });

  it("help prints the help text", async () => {
    const msg = await runBang(handlers, "!calculate", "help");
    expect(msg.reply).toHaveBeenCalledTimes(1);
    const text = msg.reply.mock.calls[0][0];
    expect(String(text)).toContain("**Calculator help**");
    expect(String(text)).toContain("!calc l2e");
    expect(String(text)).toContain("!calc sellm");
  });

  it("unknown function replies with unknown function", async () => {
    const msg = await runBang(handlers, "!calculate", "nope 123");
    expect(msg.reply).toHaveBeenCalledTimes(1);
    expect(String(msg.reply.mock.calls[0][0])).toContain("Unknown function");
  });

  it("l2e and l2eb output expected values", async () => {
    const lvl = 125;
    const exp = levelToExp(lvl);

    const msg1 = await runBang(handlers, "!calculate", `l2e ${lvl}`);
    expect(msg1.reply).toHaveBeenCalledTimes(1);
    expect(String(msg1.reply.mock.calls[0][0])).toContain(`Level ${lvl} → Exp:`);

    const msg2 = await runBang(handlers, "!calculate", `l2eb ${lvl}`);
    expect(msg2.reply).toHaveBeenCalledTimes(1);
    const out2 = String(msg2.reply.mock.calls[0][0]);
    expect(out2).toContain(`Level ${lvl} → Exp:`);
    // billions formatting "X.XX bil"
    expect(out2).toMatch(/bil$/);

    // sanity: l2e includes exp integer (with commas)
    const out1 = String(msg1.reply.mock.calls[0][0]);
    expect(out1.replace(/,/g, "")).toContain(String(Math.round(exp)));
  });

  it("l2e rejects negative or missing args silently", async () => {
    const msg1 = await runBang(handlers, "!calculate", "l2e");
    expect(msg1.reply).toHaveBeenCalledTimes(0);

    const msg2 = await runBang(handlers, "!calculate", "l2e -5");
    expect(msg2.reply).toHaveBeenCalledTimes(0);
  });

  it("e2l parses commas/underscores/spaces and returns expected level", async () => {
    const exp = 100_162; // 100,162
    const lvl = expToLevel(exp);

    const msg = await runBang(handlers, "!calculate", "e2l 100,162");
    expect(msg.reply).toHaveBeenCalledTimes(1);
    expect(String(msg.reply.mock.calls[0][0])).toContain(`Level: ${lvl}`);

    const msg2 = await runBang(handlers, "!calculate", "e2l  100_162 ");
    expect(msg2.reply).toHaveBeenCalledTimes(1);
    expect(String(msg2.reply.mock.calls[0][0])).toContain(`Level: ${lvl}`);
  });

  it("eb2l accepts decimals in billions", async () => {
    const bil = 42.5;
    const exp = bil * 1e9;
    const lvl = expToLevel(exp);

    const msg = await runBang(handlers, "!calculate", `eb2l ${bil}`);
    expect(msg.reply).toHaveBeenCalledTimes(1);
    const out = String(msg.reply.mock.calls[0][0]);
    expect(out).toContain("Exp 42.50 bil");
    expect(out).toContain(`Level: ${lvl}`);
  });

  it("buy / buym produce max affordable levels for PP no/yes", async () => {
    const target = 500_000_000;
    const no = levelForBuyerPays(target, false);
    const yes = levelForBuyerPays(target, true);

    const msg = await runBang(handlers, "!calculate", `buy ${target}`);
    expect(msg.reply).toHaveBeenCalledTimes(1);
    const out = String(msg.reply.mock.calls[0][0]);
    expect(out).toContain("Buyer pays");
    expect(out).toContain("Note: Prices are based on actual EXP");
    expect(out).toContain(`PP: no  → Level ${no}`);
    expect(out).toContain(`PP: yes → Level ${yes}`);

    const msg2 = await runBang(handlers, "!calculate", "buym 500");
    expect(msg2.reply).toHaveBeenCalledTimes(1);
    const out2 = String(msg2.reply.mock.calls[0][0]);
    expect(out2).toContain("Note: Prices are based on actual EXP");
    expect(out2).toContain(`PP: no  → Level ${no}`);
    expect(out2).toContain(`PP: yes → Level ${yes}`);
  });

  it("sell / sellm produce max affordable level and show same level for PP no/yes", async () => {
    const target = 250_000_000;
    const lvl = levelForSellerGets(target);

    const msg = await runBang(handlers, "!calculate", `sell ${target}`);
    expect(msg.reply).toHaveBeenCalledTimes(1);
    const out = String(msg.reply.mock.calls[0][0]);
    expect(out).toContain("Seller receives");
    expect(out).toContain("max affordable level");
    expect(out).toContain("Note: Prices are based on actual EXP");
    expect(out).toContain(`PP: no  → Level ${lvl}`);
    expect(out).toContain(`PP: yes → Level ${lvl}`);

    const msg2 = await runBang(handlers, "!calculate", "sellm 250");
    expect(msg2.reply).toHaveBeenCalledTimes(1);
    const out2 = String(msg2.reply.mock.calls[0][0]);
    expect(out2).toContain("max affordable level");
    expect(out2).toContain("Note: Prices are based on actual EXP");
    expect(out2).toContain(`PP: no  → Level ${lvl}`);
    expect(out2).toContain(`PP: yes → Level ${lvl}`);
  });

  it("ld: computes exp diff and level of that diff", async () => {
    const l1 = 1500;
    const l2 = 1200;
    const diffExp = Math.abs(levelToExp(l1) - levelToExp(l2));
    const diffLvl = expToLevel(diffExp);

    const msg = await runBang(handlers, "!calculate", `ld ${l1} ${l2}`);
    expect(msg.reply).toHaveBeenCalledTimes(1);
    const out = String(msg.reply.mock.calls[0][0]).replace(/,/g, "");
    expect(out).toContain(`Level diff (${l1} ↔ ${l2})`);
    expect(out).toContain(`Exp: ${String(Math.round(diffExp))}`);
    expect(out).toContain(`Level: ${diffLvl}`);
  });

  it("la: sums levels as exp then back to level", async () => {
    const lvls = [100, 200, 300];
    const totalExp = lvls.reduce((s, L) => s + levelToExp(L), 0);
    const totalLvl = expToLevel(totalExp);

    const msg = await runBang(handlers, "!calculate", `la ${lvls.join(" ")}`);
    expect(msg.reply).toHaveBeenCalledTimes(1);
    const out = String(msg.reply.mock.calls[0][0]).replace(/,/g, "");
    expect(out).toContain("Levels [100 200 300]");
    expect(out).toContain(`Total Exp: ${String(Math.round(totalExp))}`);
    expect(out).toContain(`Level: ${totalLvl}`);
  });

  it("ea: sums exp values; eba: sums exp in billions", async () => {
    const exps = [100_000, 200_000, 300_000];
    const totalExp = exps.reduce((s, e) => s + e, 0);
    const totalLvl = expToLevel(totalExp);

    const msg = await runBang(handlers, "!calculate", `ea ${exps.join(" ")}`);
    expect(msg.reply).toHaveBeenCalledTimes(1);
    const out = String(msg.reply.mock.calls[0][0]).replace(/,/g, "");
    expect(out).toContain(`Total Exp: ${String(totalExp)}`);
    expect(out).toContain(`Level: ${totalLvl}`);

    const bils = [42.5, 10, 1.25];
    const totalExp2 = bils.reduce((s, b) => s + b * 1e9, 0);
    const totalLvl2 = expToLevel(totalExp2);

    const msg2 = await runBang(handlers, "!calculate", `eba ${bils.join(" ")}`);
    expect(msg2.reply).toHaveBeenCalledTimes(1);
    const out2 = String(msg2.reply.mock.calls[0][0]);
    expect(out2).toContain("Exps [42.50 bil, 10.00 bil, 1.25 bil]");
    expect(out2).toContain(`Level: ${totalLvl2}`);
  });

  it("invalid numeric input is rejected silently for numeric functions", async () => {
    // e2l bad number => silent return
    const m1 = await runBang(handlers, "!calculate", "e2l notanumber");
    expect(m1.reply).toHaveBeenCalledTimes(0);

    // la with bad token => silent
    const m2 = await runBang(handlers, "!calculate", "la 100 nope 200");
    expect(m2.reply).toHaveBeenCalledTimes(0);

    // buy with <=0 => silent
    const m3 = await runBang(handlers, "!calculate", "buy 0");
    expect(m3.reply).toHaveBeenCalledTimes(0);

    // ld wrong arg count => silent
    const m4 = await runBang(handlers, "!calculate", "ld 5");
    expect(m4.reply).toHaveBeenCalledTimes(0);
  });

  it("!calculator prints help when called with empty or 'help'", async () => {
    const msg1 = await runBang(handlers, "!calculator", "");
    expect(msg1.reply).toHaveBeenCalledTimes(1);
    expect(String(msg1.reply.mock.calls[0][0])).toContain("**Calculator help**");

    const msg2 = await runBang(handlers, "!calculator", "help");
    expect(msg2.reply).toHaveBeenCalledTimes(1);
    expect(String(msg2.reply.mock.calls[0][0])).toContain("**Calculator help**");
  });

  it("!calculator with other args does nothing", async () => {
    const msg = await runBang(handlers, "!calculator", "nope");
    expect(msg.reply).toHaveBeenCalledTimes(0);
  });
});
