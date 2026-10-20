import { getDb } from "../db.js";

// Only these identifiers may be interpolated in SQL.
export const POINT_TABLES = Object.freeze({
  loot: "loot_scores",
  trivia: "trivia_scores",
  scramble: "pokemon_scramble_scores",
});

export class ShopError extends Error {}


async function transaction(fn) {
  const db = await getDb().getConnection();
  try {
    await db.beginTransaction();
    const result = await fn(db);
    await db.commit();
    return result;
  } catch (err) {
    await db.rollback().catch(() => {});
    throw err;
  } finally {
    db.release();
  }
}

export async function listItems(guildId) {
  const [rows] = await getDb().execute("SELECT * FROM shop_items WHERE guild_id = ? ORDER BY item_id", [guildId]);
  return rows;
}

export async function listPurchases(guildId, userId) {
  const [rows] = await getDb().execute("SELECT * FROM shop_purchases WHERE guild_id = ? AND user_id = ? ORDER BY item_id", [guildId, userId]);
  return rows;
}

export async function balances(guildId, userId) {
  const result = {};
  for (const [currency, table] of Object.entries(POINT_TABLES)) {
    const [rows] = await getDb().execute(`SELECT score FROM ${table} WHERE guild_id = ? AND user_id = ?`, [guildId, userId]);
    result[currency] = Number(rows[0]?.score || 0);
  }
  return result;
}

export async function saveItem(guildId, userId, item) {
  // Changing a listing's role could otherwise sell the same role under an old receipt.
  return transaction(async db => {
    const [rows] = await db.execute("SELECT role_id FROM shop_items WHERE guild_id = ? AND item_id = ? FOR UPDATE", [guildId, item.id]);
    if (rows.length && rows[0].role_id !== item.roleId) throw new ShopError("An item's role cannot change. Pause it and create a new item ID.");
    if (rows.length) {
      await db.execute(`UPDATE shop_items SET name = ?, price = ?, currency = ?, refund_percent = ?, updated_by = ?
        WHERE guild_id = ? AND item_id = ?`, [item.name, item.price, item.currency, item.refundPercent, userId, guildId, item.id]);
    } else {
      try {
        await db.execute(`INSERT INTO shop_items
          (guild_id, item_id, role_id, name, price, currency, refund_percent, updated_by)
          VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
        [guildId, item.id, item.roleId, item.name, item.price, item.currency, item.refundPercent, userId]);
      } catch (err) {
        if (err.code === "ER_DUP_ENTRY") throw new ShopError("That role already has a shop listing. Edit the existing item instead.");
        throw err;
      }
    }
  });
}

export async function setItemEnabled(guildId, itemId, enabled, userId) {
  const [result] = await getDb().execute("UPDATE shop_items SET enabled = ?, updated_by = ? WHERE guild_id = ? AND item_id = ?", [enabled ? 1 : 0, userId, guildId, itemId]);
  if (!result.affectedRows) throw new ShopError("Item not found.");
}

async function event(db, row, action, amount) {
  await db.execute("INSERT INTO shop_events (guild_id, user_id, item_id, action, currency, amount) VALUES (?, ?, ?, ?, ?, ?)",
    [row.guild_id, row.user_id, row.item_id, action, row.currency, amount]);
}

export async function reservePurchase(guildId, userId, itemId) {
  return transaction(async db => {
    // Listing first, then receipt, then score: consistent lock order for all shop writes.
    const [items] = await db.execute("SELECT * FROM shop_items WHERE guild_id = ? AND item_id = ? FOR UPDATE", [guildId, itemId]);
    const [receipts] = await db.execute("SELECT * FROM shop_purchases WHERE guild_id = ? AND user_id = ? AND item_id = ? FOR UPDATE", [guildId, userId, itemId]);
    if (receipts.length) {
      if (receipts[0].state === "pending") return receipts[0];
      throw new ShopError("You already own this item or have a refund in progress. See shop owned.");
    }
    const item = items[0];
    if (!item || !item.enabled) throw new ShopError("This item is unavailable.");
    const table = POINT_TABLES[item.currency];
    if (!table) throw new ShopError("Invalid item currency; ask staff to fix this listing.");
    const [result] = await db.execute(`UPDATE ${table} SET score = score - ? WHERE guild_id = ? AND user_id = ? AND score >= ?`, [item.price, guildId, userId, item.price]);
    if (!result.affectedRows) throw new ShopError(`You need ${item.price} ${item.currency} points.`);
    const row = { ...item, user_id: userId, state: "pending" };
    await db.execute(`INSERT INTO shop_purchases (guild_id, user_id, item_id, role_id, price, currency, refund_percent, state)
      VALUES (?, ?, ?, ?, ?, ?, ?, 'pending')`, [guildId, userId, itemId, item.role_id, item.price, item.currency, item.refund_percent]);
    await event(db, row, "reserve", item.price);
    return row;
  });
}

export async function finishPurchase(guildId, userId, itemId) {
  await getDb().execute("UPDATE shop_purchases SET state = 'owned' WHERE guild_id = ? AND user_id = ? AND item_id = ? AND state = 'pending'", [guildId, userId, itemId]);
}

export async function beginRefund(guildId, userId, itemId) {
  return transaction(async db => {
    const [rows] = await db.execute("SELECT * FROM shop_purchases WHERE guild_id = ? AND user_id = ? AND item_id = ? FOR UPDATE", [guildId, userId, itemId]);
    const row = rows[0];
    if (!row) throw new ShopError("You have no purchase to refund.");
    if (row.state === "pending") row.refund_percent = 100;
    if (!row.refund_percent) throw new ShopError("This purchase is non-refundable.");
    await db.execute("UPDATE shop_purchases SET state = 'refunding', refund_percent = ? WHERE guild_id = ? AND user_id = ? AND item_id = ?", [row.refund_percent, guildId, userId, itemId]);
    return row;
  });
}

export async function finishRefund(guildId, userId, itemId, displayName) {
  return transaction(async db => {
    const [rows] = await db.execute("SELECT * FROM shop_purchases WHERE guild_id = ? AND user_id = ? AND item_id = ? FOR UPDATE", [guildId, userId, itemId]);
    const row = rows[0];
    if (!row || row.state !== "refunding") throw new ShopError("No refund is in progress.");
    const amount = Math.floor(Number(row.price) * Number(row.refund_percent) / 100);
    const table = POINT_TABLES[row.currency];
    if (!table) throw new ShopError("Invalid purchase currency; ask staff for help.");
    await db.execute(`INSERT INTO ${table} (guild_id, user_id, display_name, score, last_win_at_ms)
      VALUES (?, ?, ?, ?, 0) ON DUPLICATE KEY UPDATE score = score + VALUES(score)`, [guildId, userId, String(displayName).slice(0, 128), amount]);
    await event(db, row, "refund", amount);
    await db.execute("DELETE FROM shop_purchases WHERE guild_id = ? AND user_id = ? AND item_id = ?", [guildId, userId, itemId]);
    return { amount, currency: row.currency };
  });
}
