// rpg/findmyid.js
//
// Slash-only helper to find RPG trainer IDs by name.

import { parse } from "node-html-parser";

import { RpgClient } from "./rpg_client.js";

const FIND_MY_ID_URL = "https://www.tppcrpg.net/view_profile.php";

function getText(node) {
  if (!node) return "";
  return String(node.text || "")
    .replace(/\s+/g, " ")
    .trim();
}

function parseIdFromHref(href) {
  const match = /[?&]id=(\d+)/i.exec(String(href || ""));
  return match ? match[1] : "";
}

function parseFindMyIdMatches(html) {
  const root = parse(String(html || ""));
  const table = root.querySelector("table.m");
  if (!table) return [];

  const matches = [];
  const seen = new Set();
  for (const link of table.querySelectorAll("a")) {
    const name = getText(link);
    const id = parseIdFromHref(link.getAttribute("href"));
    if (!name || !id) continue;
    const key = `${name}::${id}`;
    if (seen.has(key)) continue;
    seen.add(key);
    matches.push({ name, id });
  }
  return matches;
}

async function fetchFindMyIdMatches(client, name) {
  const form = new URLSearchParams();
  form.set("Trainer", name);
  const html = await client.fetchForm(FIND_MY_ID_URL, form);
  return parseFindMyIdMatches(html);
}

export function registerFindMyId(register) {
  let client = null;
  const getClient = () => {
    if (!client) client = new RpgClient();
    return client;
  };

  register(
    "!findmyid",
    async ({ message }) => {
      if (!message.guildId) return;
      await message.reply("Use `/findmyid name:<name>` to search for a trainer ID.");
    },
    "!findmyid — usage for the trainer ID lookup",
    { hideFromHelp: true, category: "Info" }
  );

  register.slash(
    {
      name: "findmyid",
      description: "Find TPPC RPG trainer IDs by name",
      options: [
        {
          type: 3, // STRING
          name: "name",
          description: "Trainer name to search for",
          required: true,
        },
      ],
    },
    async ({ interaction }) => {
      const name = String(interaction.options?.getString?.("name") || "").trim();
      if (!name) {
        await interaction.reply({ content: "Please provide a trainer name.", ephemeral: true });
        return;
      }

      try {
        if (!process.env.RPG_USERNAME || !process.env.RPG_PASSWORD) {
          console.error("[rpg] RPG_USERNAME/RPG_PASSWORD not configured for /findmyid");
          await interaction.reply({
            content: "❌ RPG credentials are not configured.",
            ephemeral: true,
          });
          return;
        }

        const matches = await fetchFindMyIdMatches(getClient(), name);
        if (!matches.length) {
          await interaction.reply({
            content: `❌ No trainer matches found for "${name}".`,
            ephemeral: true,
          });
          return;
        }

        if (matches.length === 1) {
          const match = matches[0];
          await interaction.reply({
            content: `✅ Match found! ${match.name} — ${match.id}`,
            ephemeral: true,
          });
          return;
        }

        const lines = matches.map((m) => `• ${m.name} — ${m.id}`);
        await interaction.reply({
          content: `☑️ Matches found!\n${lines.join("\n")}`,
          ephemeral: true,
        });
      } catch (err) {
        console.error("[rpg] findmyid failed:", err);
        await interaction.reply({
          content: "Failed to fetch trainer matches. Please try again later.",
          ephemeral: true,
        });
      }
    }
  );
}

export const __testables = { parseFindMyIdMatches, parseIdFromHref };
