import { describe, it, expect, vi, beforeEach } from "vitest";
import fs from "fs/promises";
import { registerCalculator, __testables } from "../../tools/calculator.js";

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
    __testables.setTrainerTable(null);
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

  it("perf returns a trainer plan", async () => {
    __testables.setTrainerTable({
      data: [
        { name: "TrainerA", number: 1, expDay: 10, expNight: 10 },
        { name: "TrainerB", number: 2, expDay: 1, expNight: 1 },
      ],
    });

    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-01-01T15:00:00Z"));

    const msg = await runBang(handlers, "!calculate", "perf 1 13");
    const replyArg = msg.reply.mock.calls[0][0];
    expect(replyArg).toContain("**📈 Perfect EXP plan**");
    expect(replyArg).toContain("TrainerA");
    expect(replyArg).toContain("TrainerB");
    expect(replyArg).toContain("**1** × 1");
    expect(replyArg).toContain("> **Heads-up:**");
    expect(replyArg).toContain("Update 5/14/23");

    vi.useRealTimers();
    __testables.setTrainerTable(null);
  });

  it("perf uses daytime exp values", async () => {
    __testables.setTrainerTable({
      data: [{ name: "DayGym", number: 9, expDay: 10, expNight: 99 }],
    });

    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-01-01T15:00:00Z"));

    const msg = await runBang(handlers, "!calculate", "perf 1 21");
    const replyArg = msg.reply.mock.calls[0][0];
    expect(replyArg).toContain("DayGym");
    expect(replyArg).toContain("**2** × 10");
    expect(replyArg).not.toContain("× 99");

    vi.useRealTimers();
    __testables.setTrainerTable(null);
  });

  it("perf uses nighttime exp values", async () => {
    __testables.setTrainerTable({
      data: [{ name: "NightGym", number: 10, expDay: 10, expNight: 20 }],
    });

    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-01-02T03:00:00Z"));

    const msg = await runBang(handlers, "!calculate", "perf 1 41");
    const replyArg = msg.reply.mock.calls[0][0];
    expect(replyArg).toContain("NightGym");
    expect(replyArg).toContain("**2** × 20");
    expect(replyArg).not.toContain("× 10");

    vi.useRealTimers();
    __testables.setTrainerTable(null);
  });

  it("perf handles formatted numbers with commas/underscores", async () => {
    __testables.setTrainerTable({
      data: [{ name: "CommaGym", number: 11, expDay: 25, expNight: 25 }],
    });

    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-01-01T15:00:00Z"));

    const msg = await runBang(handlers, "!calculate", "perf 1,000 1_050");
    const replyArg = msg.reply.mock.calls[0][0];
    expect(replyArg).toContain("CommaGym");
    expect(replyArg).toContain("**2** × 25");

    vi.useRealTimers();
    __testables.setTrainerTable(null);
  });

  it("perf supports a highest gym filter", async () => {
    __testables.setTrainerTable({
      data: [
        { name: "TrainerA", number: 1, expDay: 10, expNight: 10 },
        { name: "TrainerB", number: 2, expDay: 6, expNight: 6 },
        { name: "TrainerC", number: 3, expDay: 1, expNight: 1 },
      ],
    });

    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-01-01T15:00:00Z"));

    const msg = await runBang(handlers, "!calculate", "perf 1 21 2");
    const replyArg = msg.reply.mock.calls[0][0];
    expect(replyArg).toContain("TrainerB");
    expect(replyArg).toContain("TrainerC");
    expect(replyArg).not.toContain("TrainerA");

    vi.useRealTimers();
    __testables.setTrainerTable(null);
  });

  it("perf keeps top gym when highest gym is not found", async () => {
    __testables.setTrainerTable({
      data: [
        { name: "TopGym", number: 1, expDay: 10, expNight: 10 },
        { name: "MidGym", number: 2, expDay: 5, expNight: 5 },
      ],
    });

    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-01-01T15:00:00Z"));

    const msg = await runBang(handlers, "!calculate", "perf 1 21 999");
    const replyArg = msg.reply.mock.calls[0][0];
    expect(replyArg).toContain("TopGym");

    vi.useRealTimers();
    __testables.setTrainerTable(null);
  });

  it("perf rejects when desired exp is not greater", async () => {
    __testables.setTrainerTable({
      data: [{ name: "TrainerA", number: 1, expDay: 10, expNight: 10 }],
    });

    const msg = await runBang(handlers, "!calculate", "perf 100 100");
    const replyArg = msg.reply.mock.calls[0][0];
    expect(replyArg).toContain("Desired exp must be greater");

    __testables.setTrainerTable(null);
  });

  it("perf rejects invalid highest gym arguments", async () => {
    const msg = await runBang(handlers, "!calculate", "perf 1 20 0");
    const replyArg = msg.reply.mock.calls[0][0];
    expect(replyArg).toContain("Usage: `!calc perf <current_exp> <desired_exp> [highest_gym_id]`");
  });

  it("perf rejects non-numeric args with usage", async () => {
    const msg = await runBang(handlers, "!calculate", "perf nope 20");
    const replyArg = msg.reply.mock.calls[0][0];
    expect(replyArg).toContain("Usage: `!calc perf <current_exp> <desired_exp> [highest_gym_id]`");
  });

  it("perf rejects too many args with usage", async () => {
    const msg = await runBang(handlers, "!calculate", "perf 1 2 3 4");
    const replyArg = msg.reply.mock.calls[0][0];
    expect(replyArg).toContain("Usage: `!calc perf <current_exp> <desired_exp> [highest_gym_id]`");
  });

  it("perf responds when no trainer plan exists", async () => {
    __testables.setTrainerTable({
      data: [{ name: "TooBig", number: 1, expDay: 100, expNight: 100 }],
    });

    const msg = await runBang(handlers, "!calculate", "perf 1 50");
    const replyArg = msg.reply.mock.calls[0][0];
    expect(replyArg).toContain("No valid trainer plan found");

    __testables.setTrainerTable(null);
  });

  it("perf usage includes the reference link", async () => {
    const msg = await runBang(handlers, "!calculate", "perf");
    const replyArg = msg.reply.mock.calls[0][0];
    expect(replyArg).toContain("Usage: `!calc perf <current_exp> <desired_exp> [highest_gym_id]`");
    expect(replyArg).toContain("coldsp33d.github.io/perfect_exp");
  });

  it("perf handles trainer data read failures", async () => {
    const spy = vi.spyOn(fs, "readFile").mockRejectedValue(new Error("boom"));
    __testables.setTrainerTable(null);

    const msg = await runBang(handlers, "!calculate", "perf 1 20");
    const replyArg = msg.reply.mock.calls[0][0];
    expect(replyArg).toContain("Trainer data is unavailable");

    spy.mockRestore();
    __testables.setTrainerTable(null);
  });

  it("findOptimalTrainers respects gap filtering and ordering", () => {
    const table = {
      data: [
        { name: "Big", number: 1, expDay: 100, expNight: 100 },
        { name: "Med", number: 2, expDay: 10, expNight: 10 },
        { name: "Small", number: 3, expDay: 3, expNight: 3 },
      ],
    };

    const { plan } = __testables.findOptimalTrainers(1, 25, table, false);
    expect(plan[0].name).toBe("Med");
    expect(plan[0].numBattles).toBe(2);
    expect(plan[1].name).toBe("Small");
  });

  it("findOptimalTrainers applies the highest gym filter", () => {
    const table = {
      data: [
        { name: "Top", number: 1, expDay: 10, expNight: 10 },
        { name: "Mid", number: 2, expDay: 6, expNight: 6 },
        { name: "Low", number: 3, expDay: 1, expNight: 1 },
      ],
    };

    const { plan } = __testables.findOptimalTrainers(1, 21, table, false, 2);
    expect(plan[0].name).toBe("Mid");
    expect(plan.some((entry) => entry.name === "Top")).toBe(false);
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
