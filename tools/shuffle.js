import { randomInt } from "node:crypto";

export function shuffleItems(items, pick = randomInt) {
  const result = [...items];
  for (let i = result.length - 1; i > 0; i--) {
    const j = pick(i + 1);
    [result[i], result[j]] = [result[j], result[i]];
  }
  return result;
}

export function parseShuffleItems(raw) {
  const text = String(raw || "").trim();
  // Lines/commas preserve names containing spaces; a single line also accepts words.
  return text.split(/[\r\n,]/.test(text) ? /[\r\n,]+/ : /\s+/).map(s => s.trim()).filter(Boolean);
}

export function registerShuffle(register) {
  register.expose({
    logicalId: "rng.shuffle",
    name: "shuffle",
    opts: { aliases: ["randomize"] },
    help: "!shuffle <items...> — publicly randomize a list; separate names with commas or new lines",
    handler: async ({ message, rest, cmd }) => {
      const items = parseShuffleItems(rest);
      if (items.length < 2 || items.length > 200) {
        return message.reply(`Usage: \`${cmd} <items...>\` (2–200 items). Use commas or new lines for names with spaces.`);
      }
      const content = `**Shuffled list (${items.length})**\n${shuffleItems(items).join("\n")}`;
      const payload = { allowedMentions: { parse: [], repliedUser: false } };
      if (content.length <= 2000) payload.content = content;
      else {
        payload.content = `Shuffled ${items.length} items:`;
        payload.files = [{ attachment: Buffer.from(content), name: "shuffled-list.txt" }];
      }
      return message.reply(payload);
    },
  });
}
