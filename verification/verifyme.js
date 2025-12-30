// verification/verifyme.js (ESM)
//
// Slash commands:
//   /verifyme username:<forums username>
//   /verifyme securitytoken:<code>
//   /unverify user:@user         (admin/mod/assistant only; per guild config)
//
// Flow (guild-scoped):
// - Uses forums PM to prove ownership (token), then posts an approval request in a staff channel.
// - Staff approves by clicking a role button (Role 1..Role N) or Reject.
//
// Storage (reuses existing user_texts table):
//   kind "fuser"    => verified forum username (string)
//   kind "fpending" => pending JSON { forumUsername, tokenHash, expiresAtMs, createdAtMs, lastSentAtMs }
//
// IMPORTANT:
// - Never echo tokens in Discord.
// - Escape forum username for Discord display only (do NOT modify stored forum username).
// - Approval workflow is configured per guild in data/verification_config.json.

import crypto from "crypto";
import fs from "fs";
import path from "path";
import { fileURLToPath } from "url";
import {
  ActionRowBuilder,
  ButtonBuilder,
  ButtonStyle,
  PermissionsBitField,
} from "discord.js";

import { ForumClient } from "./forum_client.js";
import { getUserText, setUserText, deleteUserText } from "../db.js";
import { isAdminOrPrivileged } from "../auth.js";

const K_VERIFIED = "fuser"; // <= 8 chars (db schema)
const K_PENDING = "fpending";

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

// Config cache
let _cfgCache = null;

function loadVerificationConfig() {
  if (_cfgCache) return _cfgCache;

  // verification/.. -> project root -> data/verification_config.json
  const p = path.join(__dirname, "..", "data", "verification_config.json");
  const raw = fs.readFileSync(p, "utf8");
  _cfgCache = JSON.parse(raw);
  return _cfgCache;
}

function getGuildVerifyConfig(guildId) {
  const cfg = loadVerificationConfig();
  return cfg?.guilds?.[String(guildId)] || null;
}

function escapeDiscordMarkdown(text) {
  // display-only; do NOT use for PM recipients
  return String(text ?? "")
    .replace(/\\/g, "\\\\")
    .replace(/\*/g, "\\*")
    .replace(/_/g, "\\_")
    .replace(/`/g, "\\`")
    .replace(/~/g, "\\~")
    .replace(/\|/g, "\\|");
}

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

function isExpired(expiresAtMs) {
  const t = Number(expiresAtMs);
  return !Number.isFinite(t) || nowMs() > t;
}

function memberHasAnyRole(member, roleIds) {
  if (!member || !roleIds?.length) return false;
  const set = member.roles?.cache;
  if (!set) return false;
  return roleIds.some((rid) => set.has(String(rid)));
}

function canAdminAct(interaction, guildCfg) {
  // Allow either:
  // - has any configured admin role
  // - has Discord Administrator permission
  // - passes your existing isAdminOrPrivileged() (extra safety / backwards compatible)
  try {
    const perms = interaction.memberPermissions;
    if (perms?.has?.(PermissionsBitField.Flags.Administrator)) return true;
  } catch {
    // ignore
  }

  const member = interaction.member;
  if (guildCfg?.adminRoleIds?.length && member?.roles?.cache) {
    if (memberHasAnyRole(member, guildCfg.adminRoleIds)) return true;
  }

  // fallback to your existing helper (message-like shape)
  const msgLike = {
    guildId: interaction.guildId,
    member: interaction.member,
    author: interaction.user,
  };
  try {
    return isAdminOrPrivileged(msgLike);
  } catch {
    return false;
  }
}

async function fetchGuildMember(guild, userId) {
  if (!guild) return null;
  try {
    return await guild.members.fetch(String(userId));
  } catch {
    return null;
  }
}

function getTtlMsFromCfg(guildCfg) {
  const m = Number(guildCfg?.tokenTtlMinutes);
  if (Number.isFinite(m) && m > 0 && m < 24 * 60) return Math.round(m * 60_000);
  return 20 * 60_000; // default 20 min
}

function getCooldownMsFromCfg(guildCfg) {
  const s = Number(guildCfg?.resendCooldownSeconds);
  if (Number.isFinite(s) && s >= 0 && s < 60 * 60) return Math.round(s * 1000);
  return 2 * 60_000; // default 2 min
}

// ---- Staff review message + buttons ----

function buildRoleButtons(guildId, targetUserId, approvalRoles, rejectLabel, disabled) {
  const rows = [];
  let current = new ActionRowBuilder();
  let countInRow = 0;

  const pushButton = (btn) => {
    if (countInRow >= 5) {
      rows.push(current);
      current = new ActionRowBuilder();
      countInRow = 0;
    }
    current.addComponents(btn);
    countInRow++;
  };

  // Role buttons
  for (const r of approvalRoles || []) {
    const roleId = String(r?.id || "").trim();
    const label = String(r?.label || "Approve").trim();
    if (!roleId) continue;

    // customId: vfy:<guildId>:<targetUserId>:role:<roleId>
    pushButton(
      new ButtonBuilder()
        .setCustomId(`vfy:${guildId}:${targetUserId}:role:${roleId}`)
        .setLabel(label)
        .setStyle(ButtonStyle.Success)
        .setDisabled(Boolean(disabled))
    );
  }

  // Reject button
  pushButton(
    new ButtonBuilder()
      .setCustomId(`vfy:${guildId}:${targetUserId}:reject:0`)
      .setLabel(String(rejectLabel || "Reject"))
      .setStyle(ButtonStyle.Danger)
      .setDisabled(Boolean(disabled))
  );

  if (countInRow > 0) rows.push(current);
  return rows;
}

async function postVerificationReview({ interaction, guildCfg, forumUsername }) {
  const guild = interaction.guild;
  if (!guild) return { ok: false, error: "No guild" };

  const channelId = String(guildCfg?.reviewChannelId || "").trim();
  if (!channelId) return { ok: false, error: "No reviewChannelId configured" };

  const ch = await guild.channels.fetch(channelId).catch(() => null);
  if (!ch?.isTextBased?.()) return { ok: false, error: "Review channel not found / not text" };

  const target = interaction.user;
  const safeForum = escapeDiscordMarkdown(forumUsername);

  const content =
    `User ${target} has verified their Forums name as **${safeForum}**.\n` +
    `Click to approve or deny request.`;

  const components = buildRoleButtons(
    guild.id,
    target.id,
    guildCfg.approvalRoles || [],
    guildCfg.rejectLabel || "Reject",
    false
  );

  try {
    const msg = await ch.send({
      content,
      components,
      allowedMentions: { users: [] },
    });
    return { ok: true, messageId: msg.id };
  } catch (e) {
    console.warn("[verifyme] postVerificationReview failed:", e);
    return {
      ok: false,
      error:
        "I couldn't post to the staff review channel (missing access). " +
        "Ask an admin to grant me View Channel + Send Messages in the configured joinlog channel.",
    };
  }
}

async function finalizeReviewMessage(interaction, outcomeLine) {
  const msg = interaction.message;
  const old = msg.content || "";
  const next = `${old}\n\n${outcomeLine}`;

  // Disable buttons (preserve layout, just disabled)
  const customId = String(interaction.customId || "");
  const parts = customId.split(":");
  const guildId = parts[1];
  const targetUserId = parts[2];

  const guildCfg = getGuildVerifyConfig(guildId);
  const components = buildRoleButtons(
    guildId,
    targetUserId,
    guildCfg?.approvalRoles || [],
    guildCfg?.rejectLabel || "Reject",
    true
  );

  await msg.edit({ content: next, components, allowedMentions: { users: [] } });
}

// ---- Registration ----

export function registerVerifyMe(register) {
  // IMPORTANT: do NOT normalize/escape the BCC string; pass it through as-is.
  const forum = new ForumClient({
    baseUrl: process.env.FORUM_BASE_URL,
    username: process.env.FORUM_BOT_USERNAME,
    password: process.env.FORUM_BOT_PASSWORD,
    // pass-through, no trim/escape (BCC issues you mentioned)
    bcc: process.env.FORUM_BOT_BCC ?? "",
  });

  // /verifyme
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
      const guildCfg = guildId ? getGuildVerifyConfig(guildId) : null;

      if (!guildId || !interaction.guild) {
        await interaction.reply({ ephemeral: true, content: "This command must be used in a server." });
        return;
      }

      if (!guildCfg) {
        await interaction.reply({
          ephemeral: true,
          content: "❌ Verification is not configured for this server yet.",
        });
        return;
      }

      const userId = interaction.user?.id;
      if (!userId) return;

      const username = interaction.options.getString("username", false);
      const securitytoken = interaction.options.getString("securitytoken", false);

      if ((username && securitytoken) || (!username && !securitytoken)) {
        await interaction.reply({
          ephemeral: true,
          content:
            "Use **exactly one** option:\n" +
            "• `/verifyme username:<forums username>`\n" +
            "• `/verifyme securitytoken:<code>`",
        });
        return;
      }

      const member = await fetchGuildMember(interaction.guild, userId);
      if (!member) {
        await interaction.reply({ ephemeral: true, content: "❌ Could not resolve your guild member record." });
        return;
      }

      const approvalRoleIds = (guildCfg.approvalRoles || [])
        .map((r) => String(r?.id || "").trim())
        .filter(Boolean);

      // Block if they already have any approval role (no point)
      if (approvalRoleIds.length && memberHasAnyRole(member, approvalRoleIds)) {
        await interaction.reply({
          ephemeral: true,
          content: "✅ You already have a verified role here. No need to verify again.",
        });
        return;
      }

      // If they are already linked in DB, allow them to re-trigger staff approval without re-PM.
      const existingForumUser = await getUserText({ guildId, userId, kind: K_VERIFIED });

      // ---- Step 1: request token (or short-circuit if already linked in DB) ----
      if (username) {
        if (existingForumUser) {
          // They are linked but missing approval roles: post for staff approval again.
          const postRes = await postVerificationReview({
            interaction,
            guildCfg,
            forumUsername: existingForumUser,
          });

          if (!postRes.ok) {
            await interaction.reply({
              ephemeral: true,
              content:
                `✅ You are linked as **${escapeDiscordMarkdown(existingForumUser)}**.\n` +
                `❌ But I couldn't post the staff approval request. Ask staff to check the verification config.`,
            });
            return;
          }

          await interaction.reply({
            ephemeral: true,
            content:
              `✅ You are linked as forum user **${escapeDiscordMarkdown(existingForumUser)}**.\n` +
              `🛡️ Your approval request has been sent to staff.`,
          });
          return;
        }

        const cleaned = String(username).trim();
        if (!cleaned || cleaned.length > 50) {
          await interaction.reply({ ephemeral: true, content: "Please provide a valid forums username." });
          return;
        }

        const TOKEN_TTL_MS = getTtlMsFromCfg(guildCfg);
        const RESEND_COOLDOWN_MS = getCooldownMsFromCfg(guildCfg);

        // If already pending and not expired, enforce cooldown
        const pendingRaw = await getUserText({ guildId, userId, kind: K_PENDING });
        const pending = safeJsonParse(pendingRaw);

        if (pending && !isExpired(pending.expiresAtMs)) {
          const lastSentAtMs = Number(pending.lastSentAtMs || 0);
          if (Number.isFinite(lastSentAtMs) && nowMs() - lastSentAtMs < RESEND_COOLDOWN_MS) {
            const waitSec = Math.ceil((RESEND_COOLDOWN_MS - (nowMs() - lastSentAtMs)) / 1000);
            await interaction.reply({
              ephemeral: true,
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
            forumUsername: cleaned, // store exact user input (no normalization)
            tokenHash,
            expiresAtMs,
            createdAtMs: nowMs(),
            lastSentAtMs: nowMs(),
          }),
        });

        // Send PM (recipient should be raw username; DO NOT escape)
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
            ephemeral: true,
            content:
              `❌ I couldn't send a forum PM to **${escapeDiscordMarkdown(cleaned)}**.\n` +
              (pmRes.error ? `Reason: ${escapeDiscordMarkdown(pmRes.error)}` : "Please try again later."),
          });
          return;
        }

        const ttlMin = Math.round(TOKEN_TTL_MS / 60_000);
        await interaction.reply({
          ephemeral: true,
          content:
            `📩 I sent a verification code to **${escapeDiscordMarkdown(cleaned)}** via TPPC forums PM.\n` +
            `⏳ This code expires in ~${ttlMin} minutes.\n` +
            `Next: run \`/verifyme securitytoken:<code>\` and paste the code from the forum PM.`,
        });
        return;
      }

      // ---- Step 2: redeem token ----
      if (securitytoken) {
        const token = String(securitytoken).trim();
        if (!token || token.length > 64) {
          await interaction.reply({ ephemeral: true, content: "Please provide a valid security token." });
          return;
        }

        const pendingRaw = await getUserText({ guildId, userId, kind: K_PENDING });
        const pending = safeJsonParse(pendingRaw);

        if (!pending) {
          await interaction.reply({
            ephemeral: true,
            content: "❌ No pending verification found. Start with `/verifyme username:<forums username>`",
          });
          return;
        }

        if (isExpired(pending.expiresAtMs)) {
          await deleteUserText({ guildId, userId, kind: K_PENDING }).catch(() => null);
          await interaction.reply({
            ephemeral: true,
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
            ephemeral: true,
            content: "❌ Invalid code. Double-check the PM and try again.",
          });
          return;
        }

        const forumUsername = String(pending.forumUsername || "").trim() || "Unknown";

        // Mark verified + clear pending (guild-scoped)
        await setUserText({ guildId, userId, kind: K_VERIFIED, text: forumUsername });
        await deleteUserText({ guildId, userId, kind: K_PENDING }).catch(() => null);

        // Post staff approval request
        const postRes = await postVerificationReview({ interaction, guildCfg, forumUsername });

        if (!postRes.ok) {
          await interaction.reply({
            ephemeral: true,
            content:
              `✅ Verified and linked to forum user **${escapeDiscordMarkdown(forumUsername)}**.\n` +
              `⚠️ But I couldn't post the staff approval request. Ask staff to check the verification config.`,
          });
          return;
        }

        await interaction.reply({
          ephemeral: true,
          content:
            `✅ Verified and linked to forum user **${escapeDiscordMarkdown(forumUsername)}**.\n` +
            `🛡️ Your approval request has been sent to staff.`,
        });
      }
    }
  );

  // Button handler (role approval / reject)
  register.component("vfy:", async ({ interaction }) => {
    const guildId = interaction.guildId;
    if (!guildId || !interaction.guild) {
      await interaction.reply({ ephemeral: true, content: "Invalid context." });
      return;
    }

    const guildCfg = getGuildVerifyConfig(guildId);
    if (!guildCfg) {
      await interaction.reply({ ephemeral: true, content: "Verification is not configured for this server." });
      return;
    }

    if (!canAdminAct(interaction, guildCfg)) {
      await interaction.reply({ ephemeral: true, content: "❌ You do not have permission to review verifications." });
      return;
    }

    const parts = String(interaction.customId || "").split(":");
    // vfy:<guildId>:<targetUserId>:<action>:<roleIdOr0>
    const cidGuild = parts[1];
    const targetUserId = parts[2];
    const action = parts[3];
    const roleId = parts[4];

    if (cidGuild !== String(guildId) || !targetUserId || !action) {
      await interaction.reply({ ephemeral: true, content: "Invalid review action." });
      return;
    }

    const targetMember = await fetchGuildMember(interaction.guild, targetUserId);
    if (!targetMember) {
      await interaction.reply({ ephemeral: true, content: "User is no longer in the server." });
      await finalizeReviewMessage(interaction, `⚠️ Reviewed by ${interaction.user} — user not in server.`);
      return;
    }

    let outcomeLine = "";
    if (action === "role") {
      const rid = String(roleId || "").trim();
      const allowed = (guildCfg.approvalRoles || []).some((r) => String(r?.id || "").trim() === rid);
      if (!allowed) {
        await interaction.reply({ ephemeral: true, content: "That role is not configured for verification." });
        return;
      }

      await targetMember.roles.add(rid).catch(() => null);
      const label =
        (guildCfg.approvalRoles || []).find((r) => String(r?.id || "").trim() === rid)?.label || "Approved";

      outcomeLine = `✅ **${escapeDiscordMarkdown(label)}** by ${interaction.user} — role granted.`;
    } else if (action === "reject") {
      outcomeLine = `❌ **Rejected** by ${interaction.user}.`;
    } else {
      await interaction.reply({ ephemeral: true, content: "Unknown action." });
      return;
    }

    await interaction.reply({ ephemeral: true, content: "Done." });
    await finalizeReviewMessage(interaction, outcomeLine);
  });
}

// /unverify (admin/mod/assistant only; per guild config)
export function registerUnverify(register) {
  register.slash(
    {
      name: "unverify",
      description: "Admin: remove forum verification linkage for a user",
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
      if (!guildId || !interaction.guild) {
        await interaction.reply({ ephemeral: true, content: "This command must be used in a server." });
        return;
      }

      const guildCfg = getGuildVerifyConfig(guildId);
      if (!guildCfg) {
        await interaction.reply({ ephemeral: true, content: "Verification is not configured for this server." });
        return;
      }

      if (!canAdminAct(interaction, guildCfg)) {
        await interaction.reply({ ephemeral: true, content: "❌ You do not have permission to use /unverify." });
        return;
      }

      const target = interaction.options.getUser("user", true);
      const userId = target.id;

      await deleteUserText({ guildId, userId, kind: K_VERIFIED }).catch(() => null);
      await deleteUserText({ guildId, userId, kind: K_PENDING }).catch(() => null);

      await interaction.reply({ ephemeral: true, content: `✅ Removed verification linkage for ${target}.` });
    }
  );
}
