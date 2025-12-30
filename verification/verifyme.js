// verification/verifyme.js (ESM)
//
// Slash command: /verifyme
// - /verifyme username:<forums username>
//   -> bot PMs that forum username with a token
// - /verifyme securitytoken:<token>
//   -> completes verification if token matches pending record
//
// DB storage uses existing user_texts table:
// - kind "fuser"    => verified forum username
// - kind "fpending" => pending verification JSON
//
// NOTE: user_texts.kind is VARCHAR(8) in your schema:contentReference[oaicite:2]{index=2}
// so we keep kinds <= 8 chars.
//
// Env:
//   FORUM_BASE_URL, FORUM_BOT_USERNAME, FORUM_BOT_PASSWORD, FORUM_BOT_BCC (optional)
// Optional role auto-grant:
//   VERIFIED_ROLE_ID=<roleId>

import crypto from "crypto";
import { MessageFlags } from "discord.js";
import { ForumClient } from "./forum_client.js";
import { getUserText, setUserText, deleteUserText } from "../db.js"; // uses your existing helpers:contentReference[oaicite:3]{index=3}
import { isAdminOrPrivileged } from "../auth.js";

const K_VERIFIED = "fuser";
const K_PENDING = "fpending";

const TOKEN_TTL_MS = 20 * 60_000; // 20 min
const RESEND_COOLDOWN_MS = 2 * 60_000; // 2 min anti-spam

function nowMs() {
  return Date.now();
}

function sha256Hex(s) {
  return crypto.createHash("sha256").update(String(s), "utf8").digest("hex");
}

function genToken() {
  // 10 hex chars; easy to type
  return crypto.randomBytes(5).toString("hex");
}

function safeJsonParse(s) {
  try {
    return JSON.parse(String(s || ""));
  } catch {
    return null;
  }
}

function escapeDiscordMarkdown(text) {
  return String(text)
    .replace(/\\/g, "\\\\")
    .replace(/\*/g, "\\*")
    .replace(/_/g, "\\_")
    .replace(/`/g, "\\`")
    .replace(/~/g, "\\~")
    .replace(/\|/g, "\\|");
}

function isExpired(expiresAtMs) {
  const t = Number(expiresAtMs);
  return !Number.isFinite(t) || nowMs() > t;
}

async function tryGrantRole(interaction) {
  const roleId = String(process.env.VERIFIED_ROLE_ID || "").trim();
  if (!roleId) return;

  try {
    const member = interaction.member;
    // In discord.js v14, member can be APIInteractionGuildMember; it still can have roles sometimes.
    // We'll best-effort fetch the GuildMember if needed.
    const guild = interaction.guild;
    if (!guild) return;

    const gm =
      member?.roles?.add
        ? member
        : await guild.members.fetch(interaction.user.id).catch(() => null);

    if (!gm?.roles?.add) return;
    await gm.roles.add(roleId).catch(() => null);
  } catch {
    // ignore
  }
}

export function registerVerifyMe(register) {
  // Instantiate once; ForumClient keeps cookies / session in memory
  const forum = new ForumClient();

  register.slash(
    {
      name: "verifyme",
      description: "Link your TPPC forums account by receiving a code via forum PM",
      options: [
        {
          type: 3, // STRING
          name: "username",
          description: "Your TPPC forums username (bot will PM you a code)",
          required: false,
        },
        {
          type: 3, // STRING
          name: "securitytoken",
          description: "The code you received via forum PM",
          required: false,
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

      const userId = interaction.user?.id;
      if (!userId) return;

      const username = interaction.options.getString("username", false);
      const securitytoken = interaction.options.getString("securitytoken", false);

      if ((username && securitytoken) || (!username && !securitytoken)) {
        await interaction.reply({
          flags: MessageFlags.Ephemeral,
          content:
            "Use **exactly one** option:\n" +
            "• `/verifyme username:<forums username>`\n" +
            "• `/verifyme securitytoken:<code>`",
        });
        return;
      }

      // Already verified?
      const existingForumUser = await getUserText({ guildId, userId, kind: K_VERIFIED });
      if (existingForumUser && username) {
        await interaction.reply({
          flags: MessageFlags.Ephemeral,
          content:
            `✅ You are already verified as **${existingForumUser}**.\n` +
            `If you need to re-verify, ask an admin to clear your verification record.`,
        });
        return;
      }

      // Step 1: request token
      if (username) {
        const cleaned = String(username).trim();
        if (!cleaned || cleaned.length > 50) {
          await interaction.reply({
            flags: MessageFlags.Ephemeral,
            content: "Please provide a valid forums username.",
          });
          return;
        }

        // If already pending and not expired, enforce cooldown
        const pendingRaw = await getUserText({ guildId, userId, kind: K_PENDING });
        const pending = safeJsonParse(pendingRaw);

        if (pending && !isExpired(pending.expiresAtMs)) {
          const lastSentAtMs = Number(pending.lastSentAtMs || 0);
          if (Number.isFinite(lastSentAtMs) && nowMs() - lastSentAtMs < RESEND_COOLDOWN_MS) {
            const waitSec = Math.ceil((RESEND_COOLDOWN_MS - (nowMs() - lastSentAtMs)) / 1000);
            await interaction.reply({
              flags: MessageFlags.Ephemeral,
              content: `⏳ A code was sent recently. Please wait ~${waitSec}s and try again.`,
            });
            return;
          }
        }

        const token = genToken();
        const tokenHash = sha256Hex(token);
        const expiresAtMs = nowMs() + TOKEN_TTL_MS;

        // Save pending BEFORE sending (so retries can be recovered)
        await setUserText({
          guildId,
          userId,
          kind: K_PENDING,
          text: JSON.stringify({
            forumUsername: cleaned,
            tokenHash,
            expiresAtMs,
            createdAtMs: nowMs(),
            lastSentAtMs: nowMs(),
          }),
        });

        // Send PM
        const discordTag = interaction.user?.tag || interaction.user?.username || "";
        const pmRes = await forum.sendVerificationPm({
          forumUsername: cleaned,
          discordTag,
          token,
        });

        if (!pmRes.ok) {
          // clear pending on failure so user can retry cleanly
          await deleteUserText({ guildId, userId, kind: K_PENDING }).catch(() => null);

          await interaction.reply({
            flags: MessageFlags.Ephemeral,
            content:
              `❌ I couldn't send a forum PM to **${escapeDiscordMarkdown(cleaned)}**.\n` +
              (pmRes.error ? `Reason: ${pmRes.error}` : "Please try again later."),
          });
          return;
        }

        const ttlMin = Math.round(TOKEN_TTL_MS / 60_000);
        await interaction.reply({
          flags: MessageFlags.Ephemeral,
          content:
            `📩 I sent a verification code to  via TPPC forums PM.\n` +
            `⏳ This code expires in ~${ttlMin} minutes.\n` +
            `Now run: \`/verifyme securitytoken:<token>\` (use the code from the PM).`,
        });

        return;
      }

      // Step 2: redeem token
      if (securitytoken) {
        const token = String(securitytoken).trim();
        if (!token || token.length > 64) {
          await interaction.reply({
            flags: MessageFlags.Ephemeral,
            content: "Please provide a valid security token.",
          });
          return;
        }

        const pendingRaw = await getUserText({ guildId, userId, kind: K_PENDING });
        const pending = safeJsonParse(pendingRaw);

        if (!pending) {
          await interaction.reply({
            flags: MessageFlags.Ephemeral,
            content:
              "❌ No pending verification found.\n" +
              "Start with: `/verifyme username:<forums username>`",
          });
          return;
        }

        if (isExpired(pending.expiresAtMs)) {
          await deleteUserText({ guildId, userId, kind: K_PENDING }).catch(() => null);
          await interaction.reply({
            flags: MessageFlags.Ephemeral,
            content: "⌛ Your verification code expired. Please request a new one.",
          });
          return;
        }

        const expectedHash = String(pending.tokenHash || "");
        const gotHash = sha256Hex(token);

        // constant-time compare
        let ok = false;
        try {
          const a = Buffer.from(expectedHash, "hex");
          const b = Buffer.from(gotHash, "hex");
          ok = a.length === b.length && crypto.timingSafeEqual(a, b);
        } catch {
          ok = false;
        }

        if (!ok) {
          await interaction.reply({
            flags: MessageFlags.Ephemeral,
            content: "❌ Invalid code. Double-check the PM and try again.",
          });
          return;
        }

        const forumUsername = String(pending.forumUsername || "").trim() || "Unknown";

        // Mark verified + clear pending
        await setUserText({ guildId, userId, kind: K_VERIFIED, text: forumUsername });
        await deleteUserText({ guildId, userId, kind: K_PENDING }).catch(() => null);

        await tryGrantRole(interaction);

        await interaction.reply({
          flags: MessageFlags.Ephemeral,
          content: `✅ Verified! Your Discord account is now linked to forum user **${escapeDiscordMarkdown(forumUsername)}**.`,
        });
      }
    }
  );
}

export function registerUnverify(register) {
  register.slash(
    {
      name: "unverify",
      description: "Admin: remove TPPC forum verification for a user",
      options: [
        {
          type: 6, // USER
          name: "user",
          description: "User to unverify",
          required: true,
        },
      ],
    },
    async ({ interaction }) => {
      const guildId = interaction.guildId;
      if (!guildId) {
        await interaction.reply({ ephemeral: true, content: "This command must be used in a server." });
        return;
      }

      // Permission gate (admin/privileged only)
      // interaction.member is available in guild contexts; reuse your existing auth gate
      const fakeMessageLike = { guildId, member: interaction.member, author: interaction.user };
      if (!isAdminOrPrivileged(fakeMessageLike)) {
        await interaction.reply({ ephemeral: true, content: "❌ You do not have permission to use /unverify." });
        return;
      }

      const target = interaction.options.getUser("user", true);
      const userId = target.id;

      // Delete verified + pending records
      await deleteUserText({ guildId, userId, kind: "fuser" }).catch(() => null);
      await deleteUserText({ guildId, userId, kind: "fpending" }).catch(() => null);

      await interaction.reply({
        ephemeral: true,
        content: `✅ Removed verification for ${target}.`,
      });
    }
  );
}
