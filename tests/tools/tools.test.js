import { describe, it, expect, vi, beforeEach } from "vitest";

const registerLinks = vi.fn();
const registerPromo = vi.fn();
const registerCalculator = vi.fn();
const registerRarity = vi.fn();
const registerLevel4Rarity = vi.fn();

vi.mock("../../tools/links.js", () => ({ registerLinks }));
vi.mock("../../tools/promo.js", () => ({ registerPromo }));
vi.mock("../../tools/calculator.js", () => ({ registerCalculator }));
vi.mock("../../tools/rarity.js", () => ({ registerRarity, registerLevel4Rarity }));

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
    expect(registerLevel4Rarity).toHaveBeenCalledWith(reg.register, "Tools");
  });
});
