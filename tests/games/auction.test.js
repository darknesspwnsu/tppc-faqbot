import { describe, it, expect } from "vitest";
import { __testables } from "../../games/auction.js";

const { renderStatus, buildBidRow, buildBidModal, bidButtonLabel, buildBidListLines, splitJoinInput } = __testables;

describe("auction helpers", () => {
  it("renderStatus returns a string", () => {
    const auction = {
      hostId: "h",
      players: new Map(),
      history: [],
      activeItem: null,
      bids: new Map(),
    };
    const text = renderStatus(auction);
    expect(typeof text).toBe("string");
  });

  it("buildBidRow toggles disabled state", () => {
    const activeRow = buildBidRow(true, "Update Bid");
    const inactiveRow = buildBidRow(false);
    const activeJson = activeRow.toJSON();
    const inactiveJson = inactiveRow.toJSON();
    expect(activeJson.components.length).toBe(3);
    expect(activeJson.components[0].label).toBe("Update Bid");
    expect(inactiveJson.components[0].disabled).toBe(true);
    expect(inactiveJson.components[1].disabled).toBe(true);
    expect(inactiveJson.components[2].disabled ?? false).toBe(false);
  });

  it("buildBidModal builds a modal with amount field", () => {
    const modal = buildBidModal().toJSON();
    expect(modal.custom_id).toBe("auction:bidmodal");
    expect(modal.components[0].components[0].custom_id).toBe("amount");
  });

  it("bidButtonLabel reflects whether any bids exist", () => {
    expect(bidButtonLabel({ hasAnyBid: false })).toBe("Place Bid");
    expect(bidButtonLabel({ hasAnyBid: true })).toBe("Update Bid");
  });

  it("buildBidListLines sorts and excludes the winner", () => {
    const bids = [
      { uid: "a", amount: 50 },
      { uid: "b", amount: 75 },
      { uid: "c", amount: 25 },
    ];
    const lines = buildBidListLines(bids, "b");
    expect(lines).toEqual(["<@a> — **50**", "<@c> — **25**"]);
  });

  it("splitJoinInput returns mention ids and option tokens", () => {
    const { mentionIds, optionTokens } = splitJoinInput("10 <@123> <@!456>");
    expect(mentionIds).toEqual(["123", "456"]);
    expect(optionTokens).toEqual(["10"]);
  });

  it("splitJoinInput ignores mention tokens when none are present", () => {
    const { mentionIds, optionTokens } = splitJoinInput("15 8 600");
    expect(mentionIds).toEqual([]);
    expect(optionTokens).toEqual(["15", "8", "600"]);
  });

  it("splitJoinInput handles mentions with extra whitespace", () => {
    const { mentionIds, optionTokens } = splitJoinInput("500   <@123>\n<@!456>");
    expect(mentionIds).toEqual(["123", "456"]);
    expect(optionTokens).toEqual(["500"]);
  });

  it("splitJoinInput ignores a leading join token", () => {
    const { mentionIds, optionTokens } = splitJoinInput("join 500 <@123>");
    expect(mentionIds).toEqual(["123"]);
    expect(optionTokens).toEqual(["500"]);
  });
});
