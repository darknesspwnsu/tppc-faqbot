import { ActionRowBuilder, ButtonBuilder, ButtonStyle } from "discord.js";

const DEFAULT_LABEL_LIMIT = 80;
const DEFAULT_MAX_BUTTONS = 5;

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

export { buildDidYouMeanButtons };
