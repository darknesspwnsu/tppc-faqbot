import { ActionRowBuilder, ButtonBuilder, ButtonStyle } from "discord.js";

const DEFAULT_LABEL_LIMIT = 80;
const DEFAULT_MAX_BUTTONS = 5;
const USER_ID_RE = /^\d{17,20}$/;

function truncateLabel(label, limit) {
  const text = String(label ?? "");
  if (text.length <= limit) return text;
  if (limit <= 3) return text.slice(0, limit);
  return text.slice(0, limit - 3) + "...";
}

function buildDidYouMeanButtons(suggestions, toButton, options = {}) {
  const { maxButtons = DEFAULT_MAX_BUTTONS, labelLimit = DEFAULT_LABEL_LIMIT } = options;
  const row = new ActionRowBuilder();

  for (const suggestion of suggestions.slice(0, maxButtons)) {
    const buttonData = toButton(suggestion);
    if (!buttonData?.customId) continue;
    const label = truncateLabel(buttonData.label ?? "", labelLimit);
    if (!label) continue;
    const style = buttonData.style ?? ButtonStyle.Secondary;
    row.addComponents(
      new ButtonBuilder().setCustomId(buttonData.customId).setLabel(label).setStyle(style)
    );
  }

  return row.components.length ? [row] : [];
}

function buildDidYouMeanCustomId(prefix, userId, payload) {
  const enc = (s) => encodeURIComponent(String(s ?? ""));
  const userPart = userId ? `${enc(userId)}:` : "";
  return `${prefix}:${userPart}${payload}`;
}

function splitDidYouMeanCustomId(prefix, customId) {
  const full = String(customId || "");
  const head = `${prefix}:`;
  if (!full.startsWith(head)) return null;

  const rest = full.slice(head.length);
  const parts = rest.split(":");
  const decoded = decodeURIComponent(parts[0] || "");
  if (USER_ID_RE.test(decoded)) {
    return { userId: decoded, payload: parts.slice(1).join(":") };
  }
  return { userId: null, payload: rest };
}

async function enforceDidYouMeanUser(interaction, userId) {
  if (!userId) return true;
  const actorId = interaction?.user?.id || interaction?.member?.user?.id;
  if (!actorId || actorId === userId) return true;
  const content = "Only the person who ran the command can use these buttons.";
  try {
    await interaction.reply({ content, ephemeral: true });
  } catch {
    try {
      await interaction.followUp({ content, ephemeral: true });
    } catch {}
  }
  return false;
}

export {
  buildDidYouMeanButtons,
  buildDidYouMeanCustomId,
  splitDidYouMeanCustomId,
  enforceDidYouMeanUser,
};
