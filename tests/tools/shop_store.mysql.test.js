import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { getDb, initDb } from "../../db.js";
import * as shop from "../../tools/shop_store.js";

// Explicit opt-in; never point this at the bot's live database.
const enabled = process.env.SHOP_TEST_MYSQL === "1";
const guild = "shop_test_guild";
const otherGuild = "shop_test_other";
const tables = ["shop_items", "shop_purchases", "shop_events", ...Object.values(shop.POINT_TABLES)];
const listing = { id: "blue", roleId: "123", price: 10, currency: "loot", refundPercent: 50, name: "Blue" };

describe.skipIf(!enabled)("shop transactions with MySQL", () => {
  async function cleanup() {
    for (const table of tables) await getDb().execute(`DELETE FROM ${table} WHERE guild_id IN (?, ?)`, [guild, otherGuild]);
  }
  beforeAll(async () => {
    if (!process.env.DB_NAME?.endsWith("_test")) throw new Error("Use a dedicated DB_NAME ending in _test.");
    await initDb();
  }, 30_000);
  beforeEach(async () => {
    await cleanup();
    await shop.saveItem(guild, "staff", listing);
    await getDb().execute("INSERT INTO loot_scores (guild_id, user_id, display_name, score) VALUES (?, 'u1', 'User', 30)", [guild]);
  });
  afterAll(async () => {
    if (process.env.DB_NAME?.endsWith("_test")) {
      await cleanup();
      await getDb().end();
    }
  });

  it("reserves once for concurrent duplicate buys and keeps the original receipt", async () => {
    const receipts = await Promise.all([shop.reservePurchase(guild, "u1", "blue"), shop.reservePurchase(guild, "u1", "blue")]);
    expect(receipts.map(row => Number(row.price))).toEqual([10, 10]);
    expect((await shop.balances(guild, "u1")).loot).toBe(20);
    await shop.saveItem(guild, "staff", { ...listing, price: 99, currency: "trivia", refundPercent: 0 });
    await shop.setItemEnabled(guild, "blue", false, "staff");
    const retry = await shop.reservePurchase(guild, "u1", "blue");
    expect(retry).toMatchObject({ currency: "loot", refund_percent: 50, state: "pending" });
    await shop.finishPurchase(guild, "u1", "blue");
    await expect(shop.reservePurchase(guild, "u1", "blue")).rejects.toThrow("already own");
    const [events] = await getDb().execute("SELECT * FROM shop_events WHERE guild_id = ?", [guild]);
    expect(events).toHaveLength(1);
  });

  it("credits the original refund once under concurrent refund attempts", async () => {
    await shop.reservePurchase(guild, "u1", "blue");
    await shop.finishPurchase(guild, "u1", "blue");
    await shop.saveItem(guild, "staff", { ...listing, price: 100, currency: "trivia", refundPercent: 100 });
    await shop.beginRefund(guild, "u1", "blue");
    const results = await Promise.allSettled([shop.finishRefund(guild, "u1", "blue", "User"), shop.finishRefund(guild, "u1", "blue", "User")]);
    expect(results.filter(result => result.status === "fulfilled")).toHaveLength(1);
    expect((await shop.balances(guild, "u1")).loot).toBe(25);
    expect(await shop.listPurchases(guild, "u1")).toEqual([]);
  });

  it("rolls back insufficient funds without creating receipts or audit entries", async () => {
    await shop.saveItem(guild, "staff", { ...listing, price: 31 });
    await expect(shop.reservePurchase(guild, "u1", "blue")).rejects.toThrow("need 31");
    expect((await shop.balances(guild, "u1")).loot).toBe(30);
    expect(await shop.listPurchases(guild, "u1")).toEqual([]);
    const [events] = await getDb().execute("SELECT * FROM shop_events WHERE guild_id = ?", [guild]);
    expect(events).toEqual([]);
  });

  it("does not overspend when buying two different items concurrently", async () => {
    await shop.saveItem(guild, "staff", { ...listing, price: 20 });
    await shop.saveItem(guild, "staff", { ...listing, id: "red", roleId: "456", price: 20 });
    const results = await Promise.allSettled([shop.reservePurchase(guild, "u1", "blue"), shop.reservePurchase(guild, "u1", "red")]);
    expect(results.filter(result => result.status === "fulfilled")).toHaveLength(1);
    expect((await shop.balances(guild, "u1")).loot).toBe(10);
  });

  it("allows full cancellation of a non-refundable pending purchase", async () => {
    await shop.saveItem(guild, "staff", { ...listing, refundPercent: 0 });
    await shop.reservePurchase(guild, "u1", "blue");
    await shop.beginRefund(guild, "u1", "blue");
    expect(await shop.finishRefund(guild, "u1", "blue", "User")).toEqual({ amount: 10, currency: "loot" });
    expect((await shop.balances(guild, "u1")).loot).toBe(30);
  });

  it("blocks refunds on a completed non-refundable purchase", async () => {
    await shop.saveItem(guild, "staff", { ...listing, refundPercent: 0 });
    await shop.reservePurchase(guild, "u1", "blue");
    await shop.finishPurchase(guild, "u1", "blue");
    await expect(shop.beginRefund(guild, "u1", "blue")).rejects.toThrow("non-refundable");
  });

  it("scopes all funds, listings and receipts to a guild and forbids role reassignment", async () => {
    expect(await shop.listItems(otherGuild)).toEqual([]);
    await expect(shop.reservePurchase(otherGuild, "u1", "blue")).rejects.toThrow("unavailable");
    await expect(shop.saveItem(guild, "staff", { ...listing, roleId: "456" })).rejects.toThrow("cannot change");
    await expect(shop.saveItem(guild, "staff", { ...listing, id: "other" })).rejects.toThrow();
    expect((await shop.balances(otherGuild, "u1")).loot).toBe(0);
  });

  it.each(["trivia", "scramble"])("spends and refunds %s without touching other currencies", async currency => {
    await shop.saveItem(guild, "staff", { ...listing, currency, price: 7 });
    await getDb().execute(`INSERT INTO ${shop.POINT_TABLES[currency]} (guild_id, user_id, display_name, score) VALUES (?, 'u1', 'User', 10)`, [guild]);
    await shop.reservePurchase(guild, "u1", "blue");
    await shop.finishPurchase(guild, "u1", "blue");
    await shop.beginRefund(guild, "u1", "blue");
    expect(await shop.finishRefund(guild, "u1", "blue", "User")).toEqual({ amount: 3, currency });
    const balances = await shop.balances(guild, "u1");
    expect(balances[currency]).toBe(6);
    expect(balances.loot).toBe(30);
  });
});
