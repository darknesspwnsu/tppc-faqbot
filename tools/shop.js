import { PermissionsBitField } from "discord.js";
import { isAdminOrPrivileged } from "../auth.js";
import { logger } from "../shared/logger.js";
import * as store from "./shop_store.js";

const activeUsers = new Set();
const ID = /^[a-z0-9][a-z0-9_-]{0,31}$/;

export function parseListing(raw) {
  const match = /^(\S+)\s+(?:<@&(\d+)>|(\d+))\s+(\d+)\s+(loot|trivia|scramble)\s+(\d+)\s+(.+)$/s.exec(String(raw || "").trim());
  if (!match) throw new store.ShopError("Expected: <id> <@role|role_id> <price> <loot|trivia|scramble> <refund_percent> <name>.");
  const [, id, mention, roleId, price, currency, refundPercent, name] = match;
  if (!ID.test(id) || !Number.isSafeInteger(Number(price)) || Number(price) < 1 || Number(price) > 1_000_000 || Number(refundPercent) > 100 || name.length > 80) {
    throw new store.ShopError("Use a lowercase item ID (1–32 letters/digits/_/-), a price of 1–1,000,000, a refund percentage of 0–100, and a name up to 80 characters.");
  }
  return { id, roleId: mention || roleId, price: Number(price), currency, refundPercent: Number(refundPercent), name };
}

export function validateCosmeticRole(role, guild) {
  if (!role || role.id === guild.id || role.managed || role.permissions.bitfield !== 0n) {
    throw new store.ShopError("Choose an existing cosmetic role with no permissions; everyone and managed roles cannot be sold.");
  }
  if (!guild.members.me?.permissions.has(PermissionsBitField.Flags.ManageRoles) || !role.editable) {
    throw new store.ShopError("The bot needs Manage Roles and its highest role must be above this cosmetic role.");
  }
  if (guild.channels.cache.some(channel => channel.permissionOverwrites?.cache.get(role.id)?.allow.bitfield > 0n)) {
    throw new store.ShopError("Shop roles must have no channel permission grants. Choose a role used only for cosmetics.");
  }
}

function help(cmd) {
  return [
    `\`${cmd} [page]\` — browse current listings`,
    `\`${cmd} balance\` — available loot, trivia, and scramble points`,
    `\`${cmd} owned [page]\` — purchases, refund amounts, and pending actions`,
    `\`${cmd} buy <id>\` — buy a role (retry to finish a pending purchase)`,
    `\`${cmd} refund <id>\` — remove a purchased role and return the listed refund`,
    "Prices and refund percentages are saved at purchase. Pending purchases can be cancelled for a full refund. Spending reduces the matching leaderboard score.",
  ].join("\n");
}

function pageOf(lines, pageRaw, title) {
  const pages = Math.max(1, Math.ceil(lines.length / 8));
  const page = Number(pageRaw || 1);
  if (!Number.isInteger(page) || page < 1 || page > pages) throw new store.ShopError(`Choose a page from 1 to ${pages}.`);
  return `**${title} (${page}/${pages})**\n${lines.slice((page - 1) * 8, page * 8).join("\n") || "No items yet."}`;
}

async function purchase(message, itemId) {
  const guildId = message.guildId;
  const userId = message.author.id;
  const receipts = await store.listPurchases(guildId, userId);
  const receipt = receipts.find(row => row.item_id === itemId);
  const item = receipt || (await store.listItems(guildId)).find(row => row.item_id === itemId && row.enabled);
  if (!item) throw new store.ShopError("This item is unavailable.");
  const role = await message.guild.roles.fetch(item.role_id, { force: true });
  await message.guild.members.fetchMe();
  await message.guild.channels.fetch();
  validateCosmeticRole(role, message.guild);
  const member = await message.guild.members.fetch({ user: userId, force: true });
  if (!receipt && member.roles.cache.has(role.id)) throw new store.ShopError("You already have this role outside the shop; you cannot buy or refund it here.");
  const row = await store.reservePurchase(guildId, userId, itemId);
  try {
    await member.roles.add(row.role_id, "Points shop purchase");
    await store.finishPurchase(guildId, userId, itemId);
  } catch (err) {
    logger.error("shop.purchase.pending", { guildId, userId, itemId, error: logger.serializeError(err) });
    throw new store.ShopError("Your payment is saved, but the role update is pending. Retry shop buy with this ID without paying again, or use shop refund to cancel for a full refund.");
  }
  return `Purchased **${itemId}** for **${row.price} ${row.currency} points**. Refund: **${Math.floor(row.price * row.refund_percent / 100)}**.`;
}

async function refund(message, itemId) {
  const guildId = message.guildId;
  const userId = message.author.id;
  const row = await store.beginRefund(guildId, userId, itemId);
  try {
    const role = await message.guild.roles.fetch(row.role_id, { force: true });
    if (role) {
      // Removing a previously sold role is allowed even if staff changed its permissions.
      if (!role.editable) throw new store.ShopError("The bot cannot remove this role; ask staff to fix its role hierarchy, then retry.");
      const member = await message.guild.members.fetch({ user: userId, force: true });
      await member.roles.remove(row.role_id, "Points shop refund");
    }
    const result = await store.finishRefund(guildId, userId, itemId, message.member?.displayName || message.author.username);
    return `Refunded **${itemId}** for **${result.amount} ${result.currency} points**. The cosmetic role has been removed.`;
  } catch (err) {
    logger.error("shop.refund.pending", { guildId, userId, itemId, error: logger.serializeError(err) });
    throw new store.ShopError("Your refund is pending. Ask staff to check the bot's role permissions, then retry shop refund with this ID. Points are credited only once the role is removed.");
  }
}

export function registerShop(register) {
  const reply = (message, content) => message.reply({ content, allowedMentions: { parse: [], repliedUser: false } });
  const guarded = handler => async ctx => {
    if (!ctx.message.guildId) return reply(ctx.message, "Use the shop in a server.");
    try {
      return await handler(ctx);
    } catch (err) {
      if (!(err instanceof store.ShopError)) logger.error("shop.command.failed", { guildId: ctx.message.guildId, error: logger.serializeError(err) });
      return reply(ctx.message, err instanceof store.ShopError ? err.message : "The shop is unavailable right now. Please try again later; pending purchases and refunds are saved.");
    }
  };
  register.expose({
    logicalId: "shop.main", name: "shop",
    help: "!shop — spend points on cosmetic roles, check balances, or refund purchases",
    opts: { helpTier: "normal" },
    handler: guarded(async ({ message, rest, cmd }) => {
      const [sub = "", arg, ...extra] = String(rest || "").trim().split(/\s+/);
      if (sub === "help") return reply(message, help(cmd));
      if (sub === "balance") {
        const values = await store.balances(message.guildId, message.author.id);
        return reply(message, Object.entries(values).map(([name, amount]) => `**${name}: ${amount}**`).join(" | "));
      }
      if (sub === "owned") {
        const rows = await store.listPurchases(message.guildId, message.author.id);
        return reply(message, pageOf(rows.map(row => `\`${row.item_id}\` — <@&${row.role_id}> — ${row.state}; refund **${Math.floor(row.price * (row.state === "pending" ? 100 : row.refund_percent) / 100)} ${row.currency}**`), arg, "Your shop purchases"));
      }
      if (sub === "buy" || sub === "refund") {
        if (!ID.test(arg || "") || extra.length) return reply(message, `Usage: \`${cmd} ${sub} <id>\``);
        const key = `${message.guildId}:${message.author.id}`;
        if (activeUsers.has(key)) return reply(message, "Your previous shop action is still processing.");
        activeUsers.add(key);
        try {
          return await reply(message, await (sub === "buy" ? purchase(message, arg) : refund(message, arg)));
        } finally {
          activeUsers.delete(key);
        }
      }
      if (sub && !/^\d+$/.test(sub)) return reply(message, help(cmd));
      const rows = (await store.listItems(message.guildId)).filter(row => row.enabled);
      const lines = rows.map(row => `\`${row.item_id}\` — ${row.name} <@&${row.role_id}> — **${row.price} ${row.currency}**; refund **${row.refund_percent}%**`);
      return reply(message, `${pageOf(lines, sub, "Cosmetic shop")}\nUse \`${cmd} buy <id>\`, \`${cmd} owned\`, or \`${cmd} help\`. Listings update live.`);
    }),
  });
  register.expose({
    logicalId: "shop.admin", name: "shopadmin",
    help: "!shopadmin — configure live cosmetic shop listings",
    opts: { admin: true },
    handler: guarded(async ({ message, rest, cmd }) => {
      if (!isAdminOrPrivileged(message)) return reply(message, "You do not have permission to manage the shop.");
      const [sub, ...args] = String(rest || "").trim().split(/\s+/);
      if (sub === "set") {
        const item = parseListing(args.join(" "));
        await message.guild.members.fetchMe();
        await message.guild.channels.fetch();
        validateCosmeticRole(await message.guild.roles.fetch(item.roleId, { force: true }), message.guild);
        await store.saveItem(message.guildId, message.author.id, item);
        return reply(message, `Saved **${item.id}**. Changes are live for new purchases; existing receipts keep their original price and refund policy.`);
      }
      if (sub === "pause" || sub === "resume") {
        if (!ID.test(args[0] || "") || args.length !== 1) throw new store.ShopError(`Usage: ${cmd} ${sub} <id>`);
        await store.setItemEnabled(message.guildId, args[0], sub === "resume", message.author.id);
        return reply(message, `${args[0]} ${sub === "resume" ? "resumed" : "paused"}. Existing purchases remain refundable.`);
      }
      if (sub === "list") {
        const rows = await store.listItems(message.guildId);
        return reply(message, pageOf(rows.map(row => `\`${row.item_id}\` — ${row.name} — ${row.price} ${row.currency}, ${row.refund_percent}% refund — ${row.enabled ? "enabled" : "paused"}`), args[0], "Shop configuration"));
      }
      return reply(message, [
        `\`${cmd} set <id> <@role|role_id> <price> <loot|trivia|scramble> <refund_percent> <name>\``,
        `\`${cmd} pause <id>\` / \`${cmd} resume <id>\` / \`${cmd} list [page]\``,
        "Create cosmetic roles with no permissions in Discord first. Set role icons or gradients there if the server supports them. Keep the bot's role above the shop roles. Refund 0 disables refunds; 100 gives a full refund.",
      ].join("\n"));
    }),
  });
}
