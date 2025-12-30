import { describe, it, expect } from "vitest";
import { __testables } from "../games/auction.js";

const { renderStatus, buildBidRow, buildBidModal } = __testables;

describe("auction helpers", () => {
  it("renderStatus includes host, players, and round info", () => {
    const auction = {
      hostId: "h",
      players: new Map([
        ["a", { balance: 100 }],
        ["b", { balance: 200 }],
      ]),
      history: [],
      activeItem: "Rare Candy",
      bids: new Map([["a", { amount: 50 }]]),
    };
    const text = renderStatus(auction);
    expect(text).toContain("Host: <@h>");
    expect(text).toContain("<@a> — 100");
    expect(text).toContain("Current item: **Rare Candy**");
  });

  it("buildBidRow toggles disabled state", () => {
    const activeRow = buildBidRow(true);
    const inactiveRow = buildBidRow(false);
    const activeJson = activeRow.toJSON();
    const inactiveJson = inactiveRow.toJSON();
    expect(activeJson.components.length).toBe(3);
    expect(inactiveJson.components[0].disabled).toBe(true);
    expect(inactiveJson.components[1].disabled).toBe(true);
    expect(inactiveJson.components[2].disabled ?? false).toBe(false);
  });

  it("buildBidModal builds a modal with amount field", () => {
    const modal = buildBidModal().toJSON();
    expect(modal.custom_id).toBe("auction:bidmodal");
    expect(modal.components[0].components[0].custom_id).toBe("amount");
  });
});
