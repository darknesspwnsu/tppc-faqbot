// trades/id.js
//
// Registers ID profile commands.

import { MessageFlags } from "discord.js";
import { getSavedId, setSavedId, deleteSavedId, getUserText, setUserText, deleteUserText } from "../db.js";

const IDS_KIND = "ids";
const MAX_IDS = 5;
const LABEL_RE = /^[A-Za-z0-9_]{1,20}$/;
const RESERVED_LABELS = new Set(["all", "help"]);
const ID_HELP =
  "?id add <number> [label] | ?id del [id|label] | ?id setdefault <id|label> | ?id [@user] [label|all]";

function formatHelp(prefix) {
  const p = prefix === "!" || prefix === "?" ? prefix : "?";
  return ID_HELP.replace(/[!?]id\b/g, `${p}id`);
}

function mention(id) {
  return `<@${id}>`;
}

function parseMentions(message) {
  return message.mentions?.users ? Array.from(message.mentions.users.values()) : [];
}

function parseMentionIds(text) {
  const ids = [];
  const re = /<@!?(\d+)>/g;
  let m;
  while ((m = re.exec(String(text ?? ""))) !== null) {
    ids.push(m[1]);
  }
  return ids;
}

function normalizeCommandArg(rest) {
  return String(rest ?? "").trim();
}

function normalizeLabel(label) {
  return String(label ?? "").trim();
}

function labelKey(label) {
  return normalizeLabel(label).toLowerCase();
}

function parseEntries(text) {
  if (!text) return [];
  try {
    const parsed = JSON.parse(text);
    const entries = Array.isArray(parsed) ? parsed : parsed?.ids;
    if (!Array.isArray(entries)) return [];
    return entries
      .map((entry) => ({
        id: Number(entry?.id),
        label: entry?.label ? String(entry.label) : null,
        addedAt: Number(entry?.addedAt) || Date.now(),
      }))
      .filter((entry) => Number.isSafeInteger(entry.id));
  } catch {
    return [];
  }
}

function formatEntry(entry) {
  return entry.label ? `${entry.id} (${entry.label})` : String(entry.id);
}

async function loadEntries({ guildId, userId }) {
  const text = await getUserText({ guildId, userId, kind: IDS_KIND });
  let entries = parseEntries(text);
  if (entries.length) return entries;

  const legacy = await getSavedId({ guildId, userId });
  if (legacy == null) return [];

  entries = [{ id: legacy, label: null, addedAt: Date.now() }];
  await setUserText({ guildId, userId, kind: IDS_KIND, text: JSON.stringify({ ids: entries }) });
  return entries;
}

async function persistEntries({ guildId, userId, entries }) {
  if (!entries.length) {
    await deleteUserText({ guildId, userId, kind: IDS_KIND });
    await deleteSavedId({ guildId, userId });
    return;
  }

  await setUserText({ guildId, userId, kind: IDS_KIND, text: JSON.stringify({ ids: entries }) });
  await setSavedId({ guildId, userId, savedId: entries[0].id });
}

function resolveByLabel(entries, label) {
  const key = labelKey(label);
  return entries.find((entry) => entry.label && labelKey(entry.label) === key) || null;
}

function resolveById(entries, id) {
  const n = Number(id);
  if (!Number.isSafeInteger(n)) return null;
  return entries.find((entry) => entry.id === n) || null;
}

function resolveByTarget(entries, target) {
  const numeric = /^\d+$/.test(target);
  if (numeric) {
    const byId = resolveById(entries, target);
    if (byId) return byId;
  }
  return resolveByLabel(entries, target);
}

async function addEntry({ guildId, userId, idToken, labelToken }) {
  if (!/^\d+$/.test(idToken)) {
    return { error: "Invalid input. Use: `?id add <number> [label]` where <number> is 1–5000000." };
  }

  const id = Number(idToken);
  if (!Number.isSafeInteger(id) || id < 1 || id > 5_000_000) {
    return { error: "Invalid input. Number must be between 1 and 5000000." };
  }

  const labelRaw = normalizeLabel(labelToken);
  if (labelRaw && !LABEL_RE.test(labelRaw)) {
    return { error: "Label must be 1–20 characters using letters, numbers, or underscores." };
  }
  if (labelRaw && RESERVED_LABELS.has(labelKey(labelRaw))) {
    return {
      error: `Label "${labelRaw}" is reserved. Please choose another label.`,
    };
  }

  const entries = await loadEntries({ guildId, userId });
  const existing = resolveById(entries, id);
  const labelExists =
    labelRaw && entries.some((entry) => entry.label && labelKey(entry.label) === labelKey(labelRaw));

  if (labelExists && (!existing || labelKey(existing.label) !== labelKey(labelRaw))) {
    return { error: `Label "${labelRaw}" is already in use.` };
  }

  if (existing) {
    if (labelRaw) {
      existing.label = labelRaw;
      await persistEntries({ guildId, userId, entries });
      return { ok: "✅ ID label updated." };
    }
    return { error: "That ID is already saved." };
  }

  if (entries.length >= MAX_IDS) {
    return { error: `You can only save up to ${MAX_IDS} IDs.` };
  }

  entries.push({ id, label: labelRaw || null, addedAt: Date.now() });
  await persistEntries({ guildId, userId, entries });
  return { ok: "✅ ID saved." };
}

async function deleteEntry({ guildId, userId, target }) {
  const entries = await loadEntries({ guildId, userId });
  if (!entries.length) return { error: "Nothing to clear!" };

  if (!target) {
    await persistEntries({ guildId, userId, entries: [] });
    return { ok: "✅ IDs cleared." };
  }

  const entry = resolveByTarget(entries, target);
  if (!entry) return { error: `No ID found for "${target}".` };

  const next = entries.filter((item) => item !== entry);
  await persistEntries({ guildId, userId, entries: next });
  return { ok: "✅ ID removed." };
}

async function setDefaultEntry({ guildId, userId, target }) {
  if (!target) return { error: "Provide an ID or label to set as default." };
  const entries = await loadEntries({ guildId, userId });
  if (!entries.length) return { error: "No IDs saved yet." };

  const entry = resolveByTarget(entries, target);
  if (!entry) return { error: `No ID found for "${target}".` };
  if (entries[0] === entry) return { ok: "Default ID is already set." };

  const next = [entry, ...entries.filter((item) => item !== entry)];
  await persistEntries({ guildId, userId, entries: next });
  return { ok: "✅ Default ID updated." };
}

function formatUserDefaultLine(display, entry) {
  if (!entry) return `${display} has not set an ID!`;
  return `${display} ${formatEntry(entry)}`;
}

function formatUserAllLine(display, entries) {
  if (!entries.length) return `${display} has not set an ID!`;
  return `${display}: ${entries.map(formatEntry).join(", ")}`;
}

function formatUserLabelLine(display, entry, label) {
  if (!entry) return `${display} has not set an ID for "${label}"!`;
  return `${display} ${formatEntry(entry)}`;
}

async function handleIdMessage({ message, rest, cmd }) {
  if (!message.guild) return;

  const raw = normalizeCommandArg(rest);
  const lower = raw.toLowerCase();
  const tokens = raw.split(/\s+/).filter(Boolean);
  const mentionUsers = parseMentions(message);
  const mentionTokens = new Set(
    mentionUsers.flatMap((u) => [`<@${u.id}>`, `<@!${u.id}>`])
  );
  const nonMentionTokens = tokens.filter(
    (token) => !/^<@!?(\d+)>$/.test(token) && !mentionTokens.has(token)
  );
  const actionToken = nonMentionTokens[0]?.toLowerCase() || "";

  if (mentionUsers.length >= 1 && ["add", "del", "delete", "setdefault"].includes(actionToken)) {
    await message.reply("You can only modify your own IDs.");
    return;
  }

  if (actionToken === "help" || lower === "help") {
    await message.reply(formatHelp(cmd?.[0]));
    return;
  }

  if (actionToken === "add") {
    const idToken = nonMentionTokens[1] || "";
    const labelToken = nonMentionTokens.slice(2).join(" ").trim();
    const result = await addEntry({
      guildId: message.guild.id,
      userId: message.author.id,
      idToken,
      labelToken,
    });
    await message.reply(result.error || result.ok);
    return;
  }

  if (actionToken === "del" || actionToken === "delete") {
    const target = nonMentionTokens.slice(1).join(" ").trim();
    const result = await deleteEntry({
      guildId: message.guild.id,
      userId: message.author.id,
      target,
    });
    await message.reply(result.error || result.ok);
    return;
  }

  if (actionToken === "setdefault") {
    const target = nonMentionTokens.slice(1).join(" ").trim();
    const result = await setDefaultEntry({
      guildId: message.guild.id,
      userId: message.author.id,
      target,
    });
    await message.reply(result.error || result.ok);
    return;
  }

  if (mentionUsers.length >= 1) {
    const lookupToken = nonMentionTokens[0] || "";
    const lines = [];

    for (const u of mentionUsers) {
      const entries = await loadEntries({ guildId: message.guild.id, userId: u.id });
      if (lookupToken.toLowerCase() === "all") {
        lines.push(formatUserAllLine(mention(u.id), entries));
        continue;
      }

      if (lookupToken) {
        const entry = resolveByLabel(entries, lookupToken);
        lines.push(formatUserLabelLine(mention(u.id), entry, lookupToken));
        continue;
      }

      lines.push(formatUserDefaultLine(mention(u.id), entries[0] || null));
    }

    if (lines.length) {
      await message.channel.send(lines.join("\n"));
    }
    return;
  }

  const entries = await loadEntries({ guildId: message.guild.id, userId: message.author.id });
  if (!raw) {
    const line = formatUserDefaultLine(mention(message.author.id), entries[0] || null);
    await message.channel.send(line);
    return;
  }

  if (lower === "all") {
    await message.channel.send(formatUserAllLine(mention(message.author.id), entries));
    return;
  }

  const entry = resolveByLabel(entries, raw);
  await message.channel.send(formatUserLabelLine(mention(message.author.id), entry, raw));
}

async function handleIdSlash({ interaction }) {
  if (!interaction.guildId) return;

  const action = interaction.options?.getString?.("action")?.toLowerCase() || "";
  const value = interaction.options?.getInteger?.("value");
  const label = interaction.options?.getString?.("label") || "";
  const target = interaction.options?.getString?.("target") || "";
  const userOpt = interaction.options?.getUser?.("user") || null;
  const usersText = interaction.options?.getString?.("users") || "";
  const isWrite = ["add", "del", "delall", "setdefault"].includes(action);

  if (isWrite && (userOpt || usersText)) {
    await interaction.reply({
      flags: MessageFlags.Ephemeral,
      content: "You can only modify your own IDs.",
    });
    return;
  }

  if (action === "delall") {
    const result = await deleteEntry({
      guildId: interaction.guildId,
      userId: interaction.user.id,
      target: "",
    });
    await interaction.reply({ flags: MessageFlags.Ephemeral, content: result.error || result.ok });
    return;
  }

  if (action === "del") {
    const result = await deleteEntry({
      guildId: interaction.guildId,
      userId: interaction.user.id,
      target: target || label,
    });
    await interaction.reply({ flags: MessageFlags.Ephemeral, content: result.error || result.ok });
    return;
  }

  if (action === "setdefault") {
    const result = await setDefaultEntry({
      guildId: interaction.guildId,
      userId: interaction.user.id,
      target: target || label,
    });
    await interaction.reply({ flags: MessageFlags.Ephemeral, content: result.error || result.ok });
    return;
  }

  if (action === "add") {
    const result = await addEntry({
      guildId: interaction.guildId,
      userId: interaction.user.id,
      idToken: value == null ? "" : String(value),
      labelToken: label,
    });
    await interaction.reply({ flags: MessageFlags.Ephemeral, content: result.error || result.ok });
    return;
  }

  const ids = new Set();
  if (userOpt?.id) ids.add(userOpt.id);
  for (const id of parseMentionIds(usersText)) ids.add(id);
  if (ids.size === 0) ids.add(interaction.user.id);

  const lines = [];
  for (const id of ids) {
    const entries = await loadEntries({ guildId: interaction.guildId, userId: id });
    const display =
      userOpt && userOpt.id === id
        ? userOpt.username
        : interaction.guild?.members?.cache?.get?.(id)?.user?.username || id;

    if (action === "list") {
      lines.push(formatUserAllLine(display, entries));
      continue;
    }

    const lookup = label || "";
    if (lookup) {
      const entry = resolveByLabel(entries, lookup);
      lines.push(formatUserLabelLine(display, entry, lookup));
      continue;
    }

    lines.push(formatUserDefaultLine(display, entries[0] || null));
  }

  await interaction.reply({ flags: MessageFlags.Ephemeral, content: lines.join("\n") });
}

export function registerId(register) {
  register.expose({
    logicalId: "trading.id",
    name: "id",
    handler: handleIdMessage,
    help: ID_HELP,
  });

  register.slash(
    {
      name: "id",
      description: "Save or look up TPPC IDs.",
      options: [
        {
          type: 3,
          name: "action",
          description: "Optional action to perform.",
          required: false,
          choices: [
            { name: "add", value: "add" },
            { name: "del", value: "del" },
            { name: "delall", value: "delall" },
            { name: "get", value: "get" },
            { name: "list", value: "list" },
            { name: "setdefault", value: "setdefault" },
          ],
        },
        {
          type: 4,
          name: "value",
          description: "ID number to save.",
          required: false,
        },
        {
          type: 3,
          name: "label",
          description: "Optional label (letters/numbers/underscore, max 20).",
          required: false,
        },
        {
          type: 3,
          name: "target",
          description: "ID or label to delete or set as default.",
          required: false,
        },
        {
          type: 6,
          name: "user",
          description: "User to look up.",
          required: false,
        },
        {
          type: 3,
          name: "users",
          description: "Mention one or more users to look up.",
          required: false,
        },
      ],
    },
    handleIdSlash
  );
}
