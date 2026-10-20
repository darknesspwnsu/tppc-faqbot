import { describe, it, expect, vi, beforeEach } from "vitest";

const registerLinks = vi.fn();
const registerPromo = vi.fn();
const registerPromoScheduler = vi.fn();
const registerCalculator = vi.fn();
const registerRarity = vi.fn();
const registerRarityScheduler = vi.fn();
const registerLevel4Rarity = vi.fn();
const registerReminders = vi.fn();
const registerMessageCounts = vi.fn();
const registerMetricsExport = vi.fn();
const registerMetricsExportScheduler = vi.fn();
const registerThreadWatch = vi.fn();
const registerThreadWatchScheduler = vi.fn();
const registerMarketPoll = vi.fn();
const registerMarketPollScheduler = vi.fn();
const registerPokemonScramble = vi.fn();
const registerPokemonScrambleScheduler = vi.fn();
const registerTrivia = vi.fn();
const registerTriviaScheduler = vi.fn();
const registerLoot = vi.fn();
const registerLootScheduler = vi.fn();
const registerShuffle = vi.fn();
const registerShop = vi.fn();

vi.mock("../../tools/links.js", () => ({ registerLinks }));
vi.mock("../../tools/promo.js", () => ({ registerPromo, registerPromoScheduler }));
vi.mock("../../tools/calculator.js", () => ({ registerCalculator }));
vi.mock("../../tools/rarity.js", () => ({
  registerRarity,
  registerLevel4Rarity,
  registerRarityScheduler,
}));
vi.mock("../../tools/reminders.js", () => ({ registerReminders }));
vi.mock("../../tools/message_counts.js", () => ({ registerMessageCounts }));
vi.mock("../../tools/metrics_export.js", () => ({
  registerMetricsExport,
  registerMetricsExportScheduler,
}));
vi.mock("../../tools/thread_watch.js", () => ({
  registerThreadWatch,
  registerThreadWatchScheduler,
}));
vi.mock("../../tools/marketpoll.js", () => ({
  registerMarketPoll,
  registerMarketPollScheduler,
}));
vi.mock("../../tools/pokemon_scramble.js", () => ({
  registerPokemonScramble,
  registerPokemonScrambleScheduler,
}));
vi.mock("../../tools/trivia.js", () => ({ registerTrivia, registerTriviaScheduler }));
vi.mock("../../tools/loot.js", () => ({ registerLoot, registerLootScheduler }));
vi.mock("../../tools/shuffle.js", () => ({ registerShuffle }));
vi.mock("../../tools/shop.js", () => ({ registerShop }));

function makeRegistry() {
  const register = vi.fn();
  return { register };
}

describe("tools/tools.js", () => {
  beforeEach(() => {
    vi.resetModules();
    vi.clearAllMocks();
  });

  it("registers all tool modules and level4 rarity", async () => {
    const { registerTools } = await import("../../tools/tools.js");
    const reg = makeRegistry();

    registerTools(reg.register);

    expect(registerLinks).toHaveBeenCalledWith(reg.register);
    expect(registerPromo).toHaveBeenCalledWith(reg.register);
    expect(registerCalculator).toHaveBeenCalledWith(reg.register);
    expect(registerRarity).toHaveBeenCalledWith(reg.register);
    expect(registerReminders).toHaveBeenCalledWith(reg.register);
    expect(registerMessageCounts).toHaveBeenCalledWith(reg.register);
    expect(registerMetricsExport).toHaveBeenCalledWith(reg.register);
    expect(registerThreadWatch).toHaveBeenCalledWith(reg.register);
    expect(registerMarketPoll).toHaveBeenCalledWith(reg.register);
    expect(registerPokemonScramble).toHaveBeenCalledWith(reg.register);
    expect(registerTrivia).toHaveBeenCalledWith(reg.register);
    expect(registerLoot).toHaveBeenCalledWith(reg.register);
    expect(registerShuffle).toHaveBeenCalledWith(reg.register);
    expect(registerShop).toHaveBeenCalledWith(reg.register);
    expect(registerLevel4Rarity).toHaveBeenCalledWith(reg.register, "Tools");
  }, 15_000);
});
