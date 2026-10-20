import { beforeEach, describe, expect, it, vi } from "vitest";
vi.mock("../../auth.js", () => ({ isAdminOrPrivileged: vi.fn(() => false) }));
vi.mock("../../tools/shop_store.js", async importOriginal => {
  const original = await importOriginal();
  return { ...original, listItems: vi.fn(), listPurchases: vi.fn(), balances: vi.fn(), saveItem: vi.fn(),
    setItemEnabled: vi.fn(), reservePurchase: vi.fn(), finishPurchase: vi.fn(), beginRefund: vi.fn(), finishRefund: vi.fn() };
});
import { registerShop, parseListing, validateCosmeticRole } from "../../tools/shop.js";
import * as store from "../../tools/shop_store.js";
import { isAdminOrPrivileged } from "../../auth.js";

function setup() {
  const handlers = {};
  registerShop({ expose: def => { handlers[def.name] = def.handler; } });
  const role = { id: "123", managed: false, editable: true, permissions: { bitfield: 0n } };
  const member = { roles: { cache: new Map(), add: vi.fn(), remove: vi.fn() } };
  const message = {
    guildId: "g1", author: { id: "u1", username: "User" }, reply: vi.fn(),
    guild: { id: "g1", roles: { fetch: vi.fn(async () => role) },
      channels: { fetch: vi.fn(), cache: { some: () => false } },
      members: { me: { permissions: { has: () => true } }, fetchMe: vi.fn(), fetch: vi.fn(async () => member) } },
  };
  return { handlers, message, role, member, run: rest => handlers.shop({ message, rest, cmd: "?shop" }) };
}
const item = { item_id: "blue", role_id: "123", enabled: 1, price: 10, currency: "loot", refund_percent: 50, name: "Blue badge" };

beforeEach(() => {
  vi.clearAllMocks();
  isAdminOrPrivileged.mockReturnValue(false);
  store.listItems.mockResolvedValue([item]);
  store.listPurchases.mockResolvedValue([]);
  store.reservePurchase.mockResolvedValue(item);
});

describe("shop configuration and permissions", () => {
  it("parses a staff listing and rejects unsafe prices and refund rates", () => {
    expect(parseListing("blue <@&123> 10 trivia 75 Blue badge")).toEqual({ id: "blue", roleId: "123", price: 10, currency: "trivia", refundPercent: 75, name: "Blue badge" });
    for (const raw of ["blue 123 0 loot 100 Blue", "blue 123 5 loot 101 Blue", "blue 123 999999999999999999 loot 10 Blue", "blue 123 5 unknown 50 Blue"]) expect(() => parseListing(raw)).toThrow();
  });
  it("rejects privileged, managed, everyone, inaccessible, and channel-granting roles", () => {
    const { role, message } = setup();
    expect(() => validateCosmeticRole(role, message.guild)).not.toThrow();
    for (const changed of [{ permissions: { bitfield: 8n } }, { managed: true }, { id: "g1" }, { editable: false }]) {
      expect(() => validateCosmeticRole({ ...role, ...changed }, message.guild)).toThrow();
    }
    message.guild.channels.cache.some = () => true;
    expect(() => validateCosmeticRole(role, message.guild)).toThrow();
  });
  it("gates staff writes and applies listing edits immediately", async () => {
    const { handlers, message } = setup();
    const ctx = { message, rest: "set blue 123 10 loot 100 Blue", cmd: "!shopadmin" };
    await handlers.shopadmin(ctx);
    expect(store.saveItem).not.toHaveBeenCalled();
    isAdminOrPrivileged.mockReturnValue(true);
    await handlers.shopadmin(ctx);
    expect(store.saveItem).toHaveBeenCalledWith("g1", "u1", expect.objectContaining({ id: "blue" }));
  });
  it("renders fresh prices and avoids role pings", async () => {
    const { message, run } = setup();
    await run("");
    expect(message.reply.mock.lastCall[0]).toEqual(expect.objectContaining({ content: expect.stringContaining("10 loot"), allowedMentions: { parse: [], repliedUser: false } }));
    store.listItems.mockResolvedValue([{ ...item, price: 20 }]);
    await run("");
    expect(message.reply.mock.lastCall[0].content).toContain("20 loot");
  });
});

describe("shop role delivery and recovery", () => {
  it("reserves points before delivery and records a completed purchase", async () => {
    const { run, member } = setup();
    await run("buy blue");
    expect(store.reservePurchase).toHaveBeenCalledWith("g1", "u1", "blue");
    expect(member.roles.add).toHaveBeenCalledWith("123", expect.any(String));
    expect(store.finishPurchase).toHaveBeenCalledWith("g1", "u1", "blue");
  });
  it("does not sell externally assigned roles", async () => {
    const { run, member } = setup();
    member.roles.cache.set("123", {});
    await run("buy blue");
    expect(store.reservePurchase).not.toHaveBeenCalled();
  });
  it("keeps a durable pending payment on API failure and permits retry", async () => {
    const { run, member, message } = setup();
    member.roles.add.mockRejectedValueOnce(new Error("Discord unavailable"));
    await run("buy blue");
    expect(store.finishPurchase).not.toHaveBeenCalled();
    expect(message.reply.mock.lastCall[0].content).toContain("payment is saved");
    store.listPurchases.mockResolvedValue([{ ...item, state: "pending" }]);
    member.roles.cache.set("123", {});
    await run("buy blue");
    expect(store.finishPurchase).toHaveBeenCalledOnce();
  });
  it("does not credit points until Discord role removal succeeds", async () => {
    const { run, member } = setup();
    store.beginRefund.mockResolvedValue(item);
    member.roles.remove.mockRejectedValueOnce(new Error("Discord unavailable"));
    await run("refund blue");
    expect(store.finishRefund).not.toHaveBeenCalled();
    store.finishRefund.mockResolvedValue({ amount: 5, currency: "loot" });
    await run("refund blue");
    expect(store.finishRefund).toHaveBeenCalledWith("g1", "u1", "blue", "User");
  });
  it("refunds receipts for deleted roles", async () => {
    const { run, message } = setup();
    store.beginRefund.mockResolvedValue(item);
    store.finishRefund.mockResolvedValue({ amount: 5, currency: "loot" });
    message.guild.roles.fetch.mockResolvedValue(null);
    await run("refund blue");
    expect(store.finishRefund).toHaveBeenCalledOnce();
  });
  it("serializes simultaneous buy/refund requests for one member", async () => {
    const { run, member, message } = setup();
    let finish;
    member.roles.add.mockImplementation(() => new Promise(resolve => { finish = resolve; }));
    const buying = run("buy blue");
    await vi.waitFor(() => expect(finish).toBeTypeOf("function"));
    await run("refund blue");
    expect(store.beginRefund).not.toHaveBeenCalled();
    expect(message.reply.mock.lastCall[0].content).toContain("still processing");
    finish();
    await buying;
  });
});
