// rpg/viewbox.js
//
// View a trainer's full Pokemon box (DM only).

import { ActionRowBuilder, ButtonBuilder, ButtonStyle, MessageFlags } from "discord.js";
import { parse } from "node-html-parser";

import { fetchFindMyIdMatches } from "./findmyid.js";
import { createRpgClientFactory } from "./client_factory.js";
import { requireRpgCredentials } from "./credentials.js";
import { isAdminOrPrivileged } from "../auth.js";
import { sendDmBatch } from "../shared/dm.js";
import { loadUserIds as loadStoredUserIds } from "../shared/user_ids.js";

const VIEWBOX_URL = "https://www.tppcrpg.net/profile.php";
const COOLDOWN_MS = 60_000;
const MAX_MESSAGE_LEN = 2000;
const IDS_KIND = "ids";

const FILTER_CHOICES = [
  { name: "All Pokemon", value: "all" },
  { name: "Golden", value: "golden" },
  { name: "Shiny", value: "shiny" },
  { name: "Dark", value: "dark" },
  { name: "Normal", value: "normal" },
  { name: "Shiny / Dark", value: "shinydark" },
  { name: "Level 4 Only (L4)", value: "l4" },
  { name: "Ungendered (?) only", value: "unknown" },
];

const VARIANT_ORDER = ["G", "S", "D", "N"];
const VARIANT_LABELS = {
  G: "Golden",
  S: "Shiny",
  D: "Dark",
  N: "Normal",
};

const userCooldowns = new Map(); // userId -> lastMs
const VIEWBOX_CONFIRM_PREFIX = "viewbox_confirm:";

function mention(id) {
  return `<@${id}>`;
}

function decodeGenderSymbols(s) {
  return String(s || "")
    .replace(/&#9794;|&#x2642;/gi, "\u2642")
    .replace(/&#9792;|&#x2640;/gi, "\u2640");
}

function getText(node) {
  if (!node) return "";
  return decodeGenderSymbols(String(node.text || ""))
    .replace(/\s+/g, " ")
    .trim();
}

function getVariantCode(classAttr) {
  const m = /(?:^|\s)([NSDG])(?:\s|$)/.exec(String(classAttr || ""));
  return m ? m[1] : "N";
}

function parseEntryText(text) {
  const levelMatch = /\(Level:\s*([\d,]+)\)/i.exec(text);
  if (!levelMatch) return null;
  const level = levelMatch[1].replace(/,/g, "");

  const hasUnknown = /\(\?\)/.test(text);
  const hasFemale = text.includes("\u2640");
  const hasMale = text.includes("\u2642");
  const gender = hasFemale ? "\u2640" : hasMale ? "\u2642" : "";

  let name = text.replace(levelMatch[0], "");
  name = name.replace(/\(\?\)/g, "");
  name = name.replace(/\u2640|\u2642/g, "");
  name = name.replace(/\s+/g, " ").trim();

  return { name, level, gender, unknown: hasUnknown };
}

function parseViewboxEntries(html) {
  const root = parse(String(html || ""));
  const list = root.querySelector("ul#allPoke");
  if (!list) return [];

  const entries = [];
  for (const li of list.querySelectorAll("li")) {
    const text = getText(li);
    if (!text) continue;
    const parsed = parseEntryText(text);
    if (!parsed) continue;
    entries.push({
      variant: getVariantCode(li.getAttribute("class")),
      ...parsed,
    });
  }

  return entries;
}

function parseTrainerName(html) {
  const root = parse(String(html || ""));
  const labels = root.querySelectorAll("strong");
  for (const label of labels) {
    if (getText(label).toLowerCase() !== "trainer name:") continue;
    let node = label.nextSibling;
    while (node) {
      const text = getText(node);
      if (text) return text;
      node = node.nextSibling;
    }
  }
  return "";
}

function applyFilter(entries, filter) {
  if (!filter || filter === "all") return entries;

  if (filter === "golden") return entries.filter((e) => e.variant === "G");
  if (filter === "shiny") return entries.filter((e) => e.variant === "S");
  if (filter === "dark") return entries.filter((e) => e.variant === "D");
  if (filter === "normal") return entries.filter((e) => e.variant === "N");
  if (filter === "shinydark") return entries.filter((e) => e.variant === "S" || e.variant === "D");
  if (filter === "l4") return entries.filter((e) => e.level === "4");
  if (filter === "unknown") return entries.filter((e) => e.unknown);

  return entries;
}

function collapseEntries(entries) {
  const counts = new Map();
  for (const e of entries) {
    const key = `${e.variant}|${e.name}|${e.gender}|${e.unknown}|${e.level}`;
    counts.set(key, (counts.get(key) || 0) + 1);
  }

  const out = [];
  for (const [key, count] of counts.entries()) {
    const [variant, name, gender, unknown, level] = key.split("|");
    out.push({
      variant,
      name,
      gender,
      unknown: unknown === "true",
      level,
      count,
    });
  }

  out.sort((a, b) => {
    if (a.name !== b.name) return a.name.localeCompare(b.name);
    if (a.level !== b.level) return Number(a.level) - Number(b.level);
    return a.gender.localeCompare(b.gender);
  });

  return out;
}

function formatLine(entry) {
  const gender = entry.gender ? ` ${entry.gender}` : "";
  const unknown = entry.unknown ? " (?)" : "";
  const suffix = entry.count > 1 ? ` x${entry.count}` : "";
  return `${entry.name}${unknown}${gender} (Level: ${entry.level})${suffix}`;
}

function buildSections(entries, filter) {
  const sections = [];

  const addSection = (title, items) => {
    if (!items.length) return;
    sections.push({ title, lines: items.map(formatLine) });
  };

  if (filter === "shinydark") {
    const merged = entries.filter((e) => e.variant === "S" || e.variant === "D");
    addSection("Shiny / Dark", merged);
    return sections;
  }

  if (["golden", "shiny", "dark", "normal"].includes(filter)) {
    const code = filter === "golden" ? "G" : filter === "shiny" ? "S" : filter === "dark" ? "D" : "N";
    addSection(VARIANT_LABELS[code], entries.filter((e) => e.variant === code));
    return sections;
  }

  for (const variant of VARIANT_ORDER) {
    addSection(VARIANT_LABELS[variant], entries.filter((e) => e.variant === variant));
  }

  return sections;
}

function chunkLines(lines, maxLen = MAX_MESSAGE_LEN) {
  const chunks = [];
  let current = [];
  let currentLen = 0;

  for (const line of lines) {
    const lineLen = line.length + 1;
    if (currentLen + lineLen > maxLen - 10) {
      chunks.push(current.join("\n"));
      current = [line];
      currentLen = lineLen;
    } else {
      current.push(line);
      currentLen += lineLen;
    }
  }

  if (current.length) chunks.push(current.join("\n"));
  return chunks;
}

function buildSectionBlocks(sections) {
  const blocks = [];
  for (const section of sections) {
    const header = `### ${section.title}`;
    const chunks = chunkLines(section.lines, MAX_MESSAGE_LEN - header.length - 10);
    for (const chunk of chunks) {
      blocks.push(`${header}\n\`\`\`\n${chunk}\n\`\`\``);
    }
  }
  return blocks;
}

function combineBlocks(blocks, maxLen = MAX_MESSAGE_LEN) {
  const messages = [];
  let current = "";

  for (const block of blocks) {
    if (!current) {
      current = block;
      continue;
    }

    if (current.length + 1 + block.length <= maxLen) {
      current += `\n${block}`;
    } else {
      messages.push(current);
      current = block;
    }
  }

  if (current) messages.push(current);
  return messages;
}

async function fetchViewboxEntries(client, id) {
  const url = `${VIEWBOX_URL}?id=${encodeURIComponent(String(id))}&View=All`;
  const html = await client.fetchPage(url);
  return {
    entries: parseViewboxEntries(html),
    trainerName: parseTrainerName(html),
  };
}

function buildConfirmButtons({ userId, id, filter }) {
  const payload = `${userId}:${id}:${filter || "all"}`;
  return [
    new ActionRowBuilder().addComponents(
      new ButtonBuilder()
        .setCustomId(`${VIEWBOX_CONFIRM_PREFIX}continue:${payload}`)
        .setLabel("Continue")
        .setStyle(ButtonStyle.Success),
      new ButtonBuilder()
        .setCustomId(`${VIEWBOX_CONFIRM_PREFIX}cancel:${payload}`)
        .setLabel("Cancel")
        .setStyle(ButtonStyle.Secondary)
    ),
  ];
}

function buildIdButtons({ userId, ids, filter }) {
  const row = new ActionRowBuilder();
  for (const entry of ids) {
    const label = entry.label ? `${entry.id} (${entry.label})` : String(entry.id);
    row.addComponents(
      new ButtonBuilder()
        .setCustomId(`${VIEWBOX_CONFIRM_PREFIX}select:${userId}:${entry.id}:${filter || "all"}`)
        .setLabel(label)
        .setStyle(ButtonStyle.Primary)
    );
  }
  return [row];
}

async function disableInteractionButtons(interaction) {
  const rows = interaction.message?.components || [];
  if (!rows.length) {
    await interaction.deferUpdate().catch(() => {});
    return;
  }

  const disabledRows = rows.map((row) => {
    const newRow = new ActionRowBuilder();
    for (const component of row.components || []) {
      const button = ButtonBuilder.from(component).setDisabled(true);
      newRow.addComponents(button);
    }
    return newRow;
  });

  await interaction.update({ components: disabledRows }).catch(async () => {
    await interaction.deferUpdate().catch(() => {});
  });
}

async function replyEphemeral(interaction, options) {
  if (interaction.deferred && !interaction.replied && interaction.editReply) {
    const next = { ...options };
    delete next.ephemeral;
    delete next.flags;
    await interaction.editReply(next);
    return;
  }

  if (interaction.replied) {
    await interaction.followUp({ ...options, flags: MessageFlags.Ephemeral });
    return;
  }

  await interaction.reply({ ...options, flags: MessageFlags.Ephemeral });
}

function buildViewboxHeader({ id, targetUserId, trainerName, label }) {
  const name = trainerName || label || "";
  if (targetUserId) {
    if (name) {
      return `Viewing box contents for <@${targetUserId}> (RPG username: ${name} | RPG ID: ${id})`;
    }
    return `Viewing box contents for <@${targetUserId}> (RPG ID: ${id})`;
  }
  if (name) {
    return `Viewing box contents for RPG username: ${name} (RPG ID: ${id})`;
  }
  return `Viewing box contents for RPG ID: ${id}`;
}

function extractViewboxLabel(messageContent) {
  const content = String(messageContent || "");
  const mention = content.match(/<@(\d+)>/);
  if (mention) return { targetUserId: mention[1] };
  const mUser = content.match(/entered username "([^"]+)"/i);
  if (mUser) return { label: mUser[1] };
  return {};
}

async function sendViewboxResults({
  interaction,
  id,
  filter,
  bypassCooldown,
  client,
  targetUserId,
  label,
}) {
  const userId = interaction.user?.id;
  const now = Date.now();
  const last = userCooldowns.get(userId) || 0;
  if (!bypassCooldown && now - last < COOLDOWN_MS) {
    const remaining = Math.ceil((COOLDOWN_MS - (now - last)) / 1000);
    await replyEphemeral(interaction, {
      content: `⚠️ This command is on cooldown for another ${remaining}s!`,
    });
    return;
  }

  if (!bypassCooldown) {
    userCooldowns.set(userId, now);
  }

  const { entries: rawEntries, trainerName } = await fetchViewboxEntries(client, id);
  if (!rawEntries.length) {
    await replyEphemeral(interaction, {
      content: "❌ No Pokemon found for that trainer ID.",
    });
    return;
  }

  const filtered = applyFilter(rawEntries, filter);
  if (!filtered.length) {
    await replyEphemeral(interaction, {
      content: "❌ No Pokemon found for that filter.",
    });
    return;
  }

  const collapsed = collapseEntries(filtered);
  const sections = buildSections(collapsed, filter);
  const blocks = buildSectionBlocks(sections);
  const messages = combineBlocks(blocks, MAX_MESSAGE_LEN);
  const header = buildViewboxHeader({ id, targetUserId, trainerName, label });
  try {
    const out = [];
    if (messages.length) {
      const first = messages[0];
      const withHeader = `${header}\n\n${first}`;
      if (withHeader.length <= MAX_MESSAGE_LEN) {
        out.push(withHeader);
      } else {
        out.push(header);
        out.push(first);
      }
      for (let i = 1; i < messages.length; i++) {
        out.push(messages[i]);
      }
    } else {
      out.push(header);
    }

    const res = await sendDmBatch({ user: interaction.user, messages: out, feature: "viewbox" });
    if (!res.ok) {
      if (res.code === 50007) {
        await replyEphemeral(interaction, {
          content: "❌ I couldn't DM you. Please enable DMs from server members and try again.",
        });
        return;
      }
      throw res.error;
    }
  } catch (err) {
    throw err;
  }

  await replyEphemeral(interaction, { content: "✅ Sent your box results via DM." });
}

export function registerViewbox(register) {
  const getClient = createRpgClientFactory();

  register(
    "!viewbox",
    async ({ message }) => {
      if (!message.guildId) return;
      await message.reply(
        "Use `/viewbox id:<id> filter:<optional>` to view a trainer's box. You can also use `rpgusername:<trainer>` or `user:@discord` to look up a saved ID."
      );
    },
    "!viewbox — usage for viewing a trainer's box",
    { hideFromHelp: true }
  );

  register.component(VIEWBOX_CONFIRM_PREFIX, async ({ interaction }) => {
    const customId = String(interaction.customId || "");
    const parts = customId.split(":");
    const action = parts[1] || "";
    const userId = parts[2] || "";
    const id = parts[3] || "";
    const filter = parts[4] || "all";
    const labelInfo = extractViewboxLabel(interaction.message?.content);

    if (!interaction.user || interaction.user.id !== userId) {
      await interaction.reply({ content: "This confirmation isn't for you.", flags: MessageFlags.Ephemeral });
      return;
    }

    if (action === "cancel") {
      await disableInteractionButtons(interaction);
      return;
    }

    if (action !== "continue" && action !== "select") {
      await interaction.deferUpdate().catch(() => {});
      return;
    }

    await disableInteractionButtons(interaction);

    const bypassCooldown = isAdminOrPrivileged({
      member: interaction.member,
      author: interaction.user,
      guildId: interaction.guildId,
    });

    try {
      await sendViewboxResults({
        interaction,
        id,
        filter,
        bypassCooldown,
        client: getClient(),
        ...labelInfo,
      });
    } catch (err) {
      console.error("[rpg] viewbox failed:", err);
      await replyEphemeral(interaction, {
        content: "❌ Failed to fetch the trainer box. Please try again later.",
      });
    }
  });

  register.slash(
    {
      name: "viewbox",
      description: "View a trainer's full Pokemon box (DMs you)",
      options: [
        {
          type: 3, // STRING
          name: "id",
          description: "Trainer ID",
          required: false,
        },
        {
          type: 6, // USER
          name: "user",
          description: "Discord user to look up their saved IDs",
          required: false,
        },
        {
          type: 3, // STRING
          name: "rpgusername",
          description: "RPG username to search for",
          required: false,
        },
        {
          type: 3, // STRING
          name: "filter",
          description: "Optional filter for the box",
          required: false,
          choices: FILTER_CHOICES,
        },
      ],
    },
    async ({ interaction }) => {
      async function ensureDeferred() {
        if (interaction.deferred || interaction.replied) return;
        await interaction.deferReply({ flags: MessageFlags.Ephemeral });
      }

      async function editResponse(payload) {
        await ensureDeferred();
        const next = { ...(payload || {}) };
        delete next.ephemeral;
        delete next.flags;
        return interaction.editReply(next);
      }

      const userId = interaction.user?.id;
      const id = String(interaction.options?.getString?.("id") || "").trim();
      const rpgUsername = String(interaction.options?.getString?.("rpgusername") || "").trim();
      const filter = String(interaction.options?.getString?.("filter") || "all");
      const targetUser = interaction.options?.getUser?.("user") || null;
      const bypassCooldown = isAdminOrPrivileged({
        member: interaction.member,
        author: interaction.user,
        guildId: interaction.guildId,
      });

      const now = Date.now();
      const last = userCooldowns.get(userId) || 0;

      await ensureDeferred();

      if (!requireRpgCredentials("/viewbox")) {
        await editResponse({ content: "❌ RPG credentials are not configured." });
        return;
      }

      try {
        if (id) {
          if (!bypassCooldown && now - last < COOLDOWN_MS) {
        const remaining = Math.ceil((COOLDOWN_MS - (now - last)) / 1000);
        await editResponse({
          content: `⚠️ This command is on cooldown for another ${remaining}s!`,
        });
        return;
      }
      await sendViewboxResults({
        interaction,
        id,
        filter,
        bypassCooldown,
        client: getClient(),
      });
      return;
        }

        if (rpgUsername) {
          if (!bypassCooldown && now - last < COOLDOWN_MS) {
            const remaining = Math.ceil((COOLDOWN_MS - (now - last)) / 1000);
            await editResponse({
              content: `⚠️ This command is on cooldown for another ${remaining}s!`,
            });
            return;
          }

          const matches = await fetchFindMyIdMatches(getClient(), rpgUsername);
          if (!matches.length) {
            await editResponse({
              content: `❌ No trainer matches found for "${rpgUsername}".`,
            });
            return;
          }

          if (matches.length > 1) {
            const lines = matches.map((m) => `• ${m.name} — ${m.id}`);
            await editResponse({
              content: `⚠️ Multiple trainer matches found for "${rpgUsername}". Please narrow down your search term or use a trainer ID.\n${lines.join("\n")}`,
            });
            return;
          }

          const match = matches[0];
          await editResponse({
            content: `✅ Located ID ${match.id} for entered username "${rpgUsername}". Proceed with retrieving box contents?`,
            components: buildConfirmButtons({ userId, id: match.id, filter }),
          });
          return;
        }

        const resolvedUser = targetUser || interaction.user;
        const savedIds = await loadStoredUserIds({
          guildId: interaction.guildId,
          userId: resolvedUser.id,
          kind: IDS_KIND,
          defaultAddedAt: 0,
        });

        if (!savedIds.length) {
          await editResponse({
            content: `❌ ${mention(resolvedUser.id)} has not set an ID.`,
          });
          return;
        }

        if (savedIds.length === 1) {
          await sendViewboxResults({
            interaction,
            id: savedIds[0].id,
            filter,
            bypassCooldown,
            client: getClient(),
            targetUserId: resolvedUser.id,
          });
          return;
        }

        await editResponse({
          content: `Select which box to view for ${mention(resolvedUser.id)}:`,
          components: buildIdButtons({ userId, ids: savedIds, filter }),
        });
        return;

      } catch (err) {
        console.error("[rpg] viewbox failed:", err);
        await editResponse({
          content: "❌ Failed to fetch the trainer box. Please try again later.",
        });
      }
    }
  );
}

export const __testables = {
  parseViewboxEntries,
  applyFilter,
  collapseEntries,
  buildSections,
  buildConfirmButtons,
};
