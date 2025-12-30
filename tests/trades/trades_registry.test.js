import { describe, it, expect, vi } from "vitest";

const tradeMocks = vi.hoisted(() => ({
  registerTradeCommands: vi.fn(),
  registerId: vi.fn(),
}));

vi.mock("../../trades/trade_commands.js", () => ({
  registerTradeCommands: tradeMocks.registerTradeCommands,
}));
vi.mock("../../trades/id.js", () => ({
  registerId: tradeMocks.registerId,
}));

import { registerTrades, listTrades } from "../../trades/trades.js";

describe("trades.js registry", () => {
  it("lists trade modules", () => {
    expect(listTrades()).toEqual(["trade_commands", "id"]);
  });

  it("registers each trade module", () => {
    const register = vi.fn();
    registerTrades(register);

    expect(tradeMocks.registerTradeCommands).toHaveBeenCalledWith(register);
    expect(tradeMocks.registerId).toHaveBeenCalledWith(register);
  });
});
