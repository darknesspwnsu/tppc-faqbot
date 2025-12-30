// verification/whois.js
import { MessageFlags } from "discord.js";
import { getUserText } from "../db.js";

const K_VERIFIED = "fuser"; // same kind used by /verifyme

function escapeDiscordMarkdown(text) {
  return String(text)
    .replace(/\\/g, "\\\\")
    .replace(/\*/g, "\\*")
    .replace(/_/g, "\\_")
    .replace(/`/g, "\\`")
    .replace(/~/g, "\\~")
    .replace(/\|/g, "\\|");
}

export function registerWhois(register) {
  register.slash(
    {
      name: "whois",
      description: "Check what TPPC forums account a Discord user is verified as",
      options: [
        {
          type: 6, // USER
          name: "user",
          description: "Discord user to look up",
          required: true,
        },
      ],
    },
    async ({ interaction }) => {
      const guildId = interaction.guildId;
      if (!guildId) {
        await interaction.reply({
          flags: MessageFlags.Ephemeral,
          content: "This command must be used in a server.",
        });
        return;
      }

      const target = interaction.options.getUser("user", true);
      const forumUser = await getUserText({
        guildId,
        userId: target.id,
        kind: K_VERIFIED,
      }); // guild-scoped lookup

      await interaction.reply({
        flags: MessageFlags.Ephemeral,
        content: forumUser
          ? `✅ ${target} is verified as forum user: **${escapeDiscordMarkdown(forumUser)}**`
          : `❌ ${target} is **not verified**.`,
      });
    }
  );
}
