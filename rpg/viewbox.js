// rpg/viewbox.js
//
// View a trainer's full Pokemon box (DM only).

import { parse } from "node-html-parser";

import { RpgClient } from "./rpg_client.js";
import { isAdminOrPrivileged } from "../auth.js";

const VIEWBOX_URL = "https://www.tppcrpg.net/profile.php";
const COOLDOWN_MS = 60_000;
const MAX_MESSAGE_LEN = 2000;

const FILTER_CHOICES = [
  { name: "All Pokemon", value: "all" },
  { name: "Golden", value: "golden" },
  { name: "Shiny", value: "shiny" },
  { name: "Dark", value: "dark" },
  { name: "Normal", value: "normal" },
  { name: "Shiny / Dark", value: "shinydark" },
  { name: "Level 4 Only (L4)", value: "l4" },
  { name: "Unknown Gender (?) Only", value: "unknown" },
];

const VARIANT_ORDER = ["G", "S", "D", "N"];
const VARIANT_LABELS = {
  G: "Golden",
  S: "Shiny",
  D: "Dark",
  N: "Normal",
};

const userCooldowns = new Map(); // userId -> lastMs

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
  return parseViewboxEntries(html);
}

export function registerViewbox(register) {
  let client = null;
  const getClient = () => {
    if (!client) client = new RpgClient();
    return client;
  };

  register(
    "!viewbox",
    async ({ message }) => {
      if (!message.guildId) return;
      await message.reply("Use `/viewbox id:<id> filter:<optional>` to view a trainer's box.");
    },
    "!viewbox — usage for viewing a trainer's box",
    { hideFromHelp: true, category: "Info" }
  );

  register.slash(
    {
      name: "viewbox",
      description: "View a trainer's full Pokemon box (DMs you)",
      options: [
        {
          type: 3, // STRING
          name: "id",
          description: "Trainer ID",
          required: true,
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
      const userId = interaction.user?.id;
      const id = String(interaction.options?.getString?.("id") || "").trim();
      const filter = String(interaction.options?.getString?.("filter") || "all");
      const bypassCooldown = isAdminOrPrivileged({
        member: interaction.member,
        author: interaction.user,
        guildId: interaction.guildId,
      });

      if (!id) {
        await interaction.reply({ content: "Please provide a trainer ID.", ephemeral: true });
        return;
      }

      const now = Date.now();
      const last = userCooldowns.get(userId) || 0;
      if (!bypassCooldown && now - last < COOLDOWN_MS) {
        const remaining = Math.ceil((COOLDOWN_MS - (now - last)) / 1000);
        await interaction.reply({
          content: `⚠️ This command is on cooldown for another ${remaining}s!`,
          ephemeral: true,
        });
        return;
      }

      if (!process.env.RPG_USERNAME || !process.env.RPG_PASSWORD) {
        console.error("[rpg] RPG_USERNAME/RPG_PASSWORD not configured for /viewbox");
        await interaction.reply({ content: "❌ RPG credentials are not configured.", ephemeral: true });
        return;
      }

      if (!bypassCooldown) {
        userCooldowns.set(userId, now);
      }

      try {
        const rawEntries = await fetchViewboxEntries(getClient(), id);
        if (!rawEntries.length) {
          await interaction.reply({
            content: "❌ No Pokemon found for that trainer ID.",
            ephemeral: true,
          });
          return;
        }

        const filtered = applyFilter(rawEntries, filter);
        if (!filtered.length) {
          await interaction.reply({
            content: "❌ No Pokemon found for that filter.",
            ephemeral: true,
          });
          return;
        }

        const collapsed = collapseEntries(filtered);
        const sections = buildSections(collapsed, filter);
        const blocks = buildSectionBlocks(sections);
        const messages = combineBlocks(blocks, MAX_MESSAGE_LEN);
        for (const msg of messages) {
          await interaction.user.send(msg);
        }

        await interaction.reply({ content: "✅ Sent your box results via DM.", ephemeral: true });
      } catch (err) {
        console.error("[rpg] viewbox failed:", err);
        await interaction.reply({
          content: "❌ Failed to fetch the trainer box. Please try again later.",
          ephemeral: true,
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
};
