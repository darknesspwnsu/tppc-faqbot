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
    expect(registerLevel4Rarity).toHaveBeenCalledWith(reg.register, "Tools");
  });
});
