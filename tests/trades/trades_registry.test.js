import { describe, it, expect, vi } from "vitest";

const registerTradeCommands = vi.fn();
const registerId = vi.fn();

vi.mock("../../trades/trade_commands.js", () => ({ registerTradeCommands }));
vi.mock("../../trades/id.js", () => ({ registerId }));

import { registerTrades, listTrades } from "../../trades/trades.js";

describe("trades.js registry", () => {
  it("lists trade modules", () => {
    expect(listTrades()).toEqual(["trade_commands", "id"]);
  });

  it("registers each trade module", () => {
    const register = vi.fn();
    registerTrades(register);

    expect(registerTradeCommands).toHaveBeenCalledWith(register);
    expect(registerId).toHaveBeenCalledWith(register);
  });
});
