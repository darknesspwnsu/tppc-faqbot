/**
 * helpbox.js
 *
 * Registers:
 *  - /help (ephemeral, category navigation; permission-aware)
 *  - help category interactions:
 *      - buttons: helpcat:<index>
 *      - select menus: helpmenu:<chunkIndex> (value is page index)
 *  - !help (public redirect)
 *  - !help <category> (public: show only that category)
 *
 * Notes:
 *  - helpModel MUST be called with (guildId, viewerMessageLike) at runtime
 *    so output reflects both guild exposure + viewer permissions.
 *  - Slash option choices must be static at registration time; we build them from helpModel(null, null).
 *  - Components always re-render with helpModel(interaction.guildId, viewerLike).
 */

import { MessageFlags } from "discord.js";

const lastHelpCategoryByUser = new Map(); // userId -> pageIdx

function clamp(n, lo, hi) {
  return Math.max(lo, Math.min(hi, n));
}

function findTradingIndex(pages) {
  const idx = pages.findIndex((p) => String(p.category).toLowerCase() === "trading");
  return idx >= 0 ? idx : 0;
}

function getDefaultIndex(pages, userId) {
  const remembered = lastHelpCategoryByUser.get(userId);
  if (Number.isFinite(remembered) && remembered >= 0 && remembered < pages.length) {
    return remembered;
  }
  return findTradingIndex(pages);
}

function rememberIndex(userId, idx) {
  if (!userId) return;
  if (!Number.isFinite(idx)) return;
  lastHelpCategoryByUser.set(userId, idx);
}

function embedForPage(pages, idx) {
  const p = pages[idx];
  const desc =
    (p.lines || [])
      .map((l) => {
        if (l === "Admin:") return "**Admin:**";
        return `• ${l}`;
      })
      .join("\n") || "_No commands in this category._";

  return {
    title: p.category,
    description: desc,
    footer: { text: `Category ${idx + 1} / ${pages.length}` },
  };
}

function buildButtons(pages, activeIdx) {
  const rows = [];
  const buttons = pages.map((p, i) => ({
    type: 2,
    style: i === activeIdx ? 1 : 2, // Primary for active
    label: p.category,
    custom_id: `helpcat:${i}`,
    disabled: i === activeIdx,
  }));

  for (let i = 0; i < buttons.length; i += 5) {
    rows.push({ type: 1, components: buttons.slice(i, i + 5) });
  }

  return rows;
}

function buildCategoryChoices(pages) {
  // Discord: max 25 choices
  return pages.slice(0, 25).map((p) => ({
    name: String(p.category).slice(0, 100),
    value: String(p.category).slice(0, 100),
  }));
}

function indexForCategory(pages, categoryValue) {
  const key = String(categoryValue || "").toLowerCase();
  const idx = pages.findIndex((p) => String(p.category).toLowerCase() === key);
  return idx >= 0 ? idx : null;
}

function buildSelectMenus(pages, activeIdx) {
  // Discord select menu option limit is 25. Components limit is 5 rows.
  // We'll create N menus of up to 25 options each; each menu is its own row.
  const MAX_OPTIONS = 25;
  const MAX_ROWS = 5;

  const rows = [];
  const totalChunks = Math.ceil(pages.length / MAX_OPTIONS);

  // Only show up to 5 menus (125 categories). If you ever exceed this, we clamp.
  const chunksToShow = Math.min(totalChunks, MAX_ROWS);

  for (let chunk = 0; chunk < chunksToShow; chunk++) {
    const start = chunk * MAX_OPTIONS;
    const end = Math.min(pages.length, start + MAX_OPTIONS);

    const options = [];
    for (let i = start; i < end; i++) {
      const label = String(pages[i].category).slice(0, 100); // label max 100
      options.push({
        label,
        value: String(i),
        default: i === activeIdx,
      });
    }

    rows.push({
      type: 1,
      components: [
        {
          type: 3, // String select
          custom_id: `helpmenu:${chunk}`,
          placeholder: `Pick a category (${start + 1}-${end} of ${pages.length})`,
          min_values: 1,
          max_values: 1,
          options,
        },
      ],
    });
  }

  return rows;
}

function buildComponents(pages, activeIdx) {
  // Buttons are great up to 25 categories (25 buttons total, 5 rows of 5).
  // Above that, switch to select menus to avoid component limits.
  if (pages.length <= 25) return buildButtons(pages, activeIdx);
  return buildSelectMenus(pages, activeIdx);
}

function messageLikeFromInteraction(interaction) {
  return {
    guildId: interaction.guildId,
    member: interaction.member,
    author: interaction.user,
  };
}

function normalizeCategoryArg(raw) {
  const s = String(raw || "").trim();
  if (!s) return null;
  return s;
}

function renderCategoryPublic(categoryPage) {
  const header = `**${categoryPage.category}**`;
  const body =
    (categoryPage.lines || [])
      .map((l) => {
        if (l === "Admin:") return "**Admin:**";
        if (!String(l || "").trim()) return ""; // drop empty spacer lines safely
        return `• ${l}`;
      })
      .filter(Boolean)
      .join("\n") || "_No commands in this category._";

  const out = `${header}\n${body}`;
  return out.length <= 1990 ? out : out.slice(0, 1980) + "\n…";
}

function filterPublicPages(pages) {
  return (pages || []).filter((page) => String(page.category || "").toLowerCase() !== "admin");
}

export function registerHelpbox(register, { helpModel }) {
  // Precompute static choices for the slash option (must be static at registration time).
  // Actual pages are computed per guild AND per viewer at runtime.
  const DEFAULT_CHOICES = buildCategoryChoices(helpModel(null, null));

  // Bang !help (public)
  // - No args: redirect only
  // - With args: show that category publicly (permission-aware)
  register(
    "!help",
    async ({ message, rest }) => {
      const arg = normalizeCategoryArg(rest);
      // QoL: list categories (permission-aware)
      const argKey = String(arg || "").trim().toLowerCase();
      if (argKey === "allcategories" || argKey === "categories") {
        const pages = filterPublicPages(helpModel(message.guildId, message));
        if (!pages.length) {
          await message.reply("No help categories available. Use `/help` (private).");
          return;
        }

        const cats = pages.map((p) => `• ${p.category}`);

        const header = `**Help categories (${cats.length}):**\n`;
        const footer = `\nUse \`!help <category>\` or \`/help\`.`;

        // Chunk to avoid 2000 char limit
        let chunk = header;
        for (const line of cats) {
          if ((chunk + line + "\n").length > 1900) {
            await message.reply(chunk + footer);
            chunk = header;
          }
          chunk += line + "\n";
        }
        await message.reply(chunk + footer);
        return;
      }

      // No args -> ONLY redirect to /help
      if (!arg) {
        await message.reply("Use `/help` for the full command list (private).");
        return;
      }

      // With args -> show the category page publicly
      const pages = filterPublicPages(helpModel(message.guildId, message));
      if (!pages.length) {
        await message.reply("Use `/help` for the full command list (private).");
        return;
      }

      const idx = indexForCategory(pages, arg);
      if (idx == null) {
        await message.reply(
          `Unknown help category: **${arg}**.\nUse \`/help\` (private) to browse categories.`
        );
        return;
      }

      await message.reply(renderCategoryPublic(pages[idx]));
    },
    "!help — redirects to /help, or `!help <category>` to show one category",
    { aliases: ["!helpme", "!h"], category: "Info" }
  );

  // Slash /help (ephemeral)
  register.slash(
    {
      name: "help",
      description: "Show a categorized help menu (private)",
      options: [
        {
          type: 3, // STRING
          name: "category",
          description: "Open directly to a category (optional)",
          required: false,
          choices: DEFAULT_CHOICES,
        },
      ],
    },
    async ({ interaction }) => {
      const pages = helpModel(interaction.guildId, messageLikeFromInteraction(interaction));
      if (!pages.length) {
        await interaction.reply({
          flags: MessageFlags.Ephemeral,
          content: "No commands available.",
        });
        return;
      }

      const userId = interaction.user?.id;

      const chosenCat = interaction.options?.getString?.("category") ?? null;
      let idx = null;

      if (chosenCat) idx = indexForCategory(pages, chosenCat);
      if (idx == null) idx = getDefaultIndex(pages, userId);

      idx = clamp(idx, 0, pages.length - 1);
      rememberIndex(userId, idx);

      await interaction.reply({
        flags: MessageFlags.Ephemeral,
        embeds: [embedForPage(pages, idx)],
        components: buildComponents(pages, idx),
      });
    }
  );

  // Button category switch: helpcat:<index>
  register.component("helpcat:", async ({ interaction }) => {
    const pages = helpModel(interaction.guildId, messageLikeFromInteraction(interaction));
    if (!pages.length) {
      await interaction.update({ content: "No commands available.", embeds: [], components: [] });
      return;
    }

    const raw = String(interaction.customId || "");
    let idx = Number(raw.split(":")[1]);
    if (!Number.isFinite(idx)) idx = 0;
    idx = clamp(idx, 0, pages.length - 1);

    const userId = interaction.user?.id;
    rememberIndex(userId, idx);

    await interaction.update({
      embeds: [embedForPage(pages, idx)],
      components: buildComponents(pages, idx),
    });
  });

  // Select menu category switch: helpmenu:<chunk>, value is page index
  register.component("helpmenu:", async ({ interaction }) => {
    const pages = helpModel(interaction.guildId, messageLikeFromInteraction(interaction));
    if (!pages.length) {
      await interaction.update({ content: "No commands available.", embeds: [], components: [] });
      return;
    }

    // StringSelectMenuInteraction has `values`
    const v = Array.isArray(interaction.values) ? interaction.values[0] : null;
    let idx = Number(v);
    if (!Number.isFinite(idx)) idx = 0;
    idx = clamp(idx, 0, pages.length - 1);

    const userId = interaction.user?.id;
    rememberIndex(userId, idx);

    await interaction.update({
      embeds: [embedForPage(pages, idx)],
      components: buildComponents(pages, idx),
    });
  });
}
