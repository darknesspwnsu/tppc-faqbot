// contests/pollcontest.js
//
// /pollcontest create|cancel|untrack - manage a Discord poll contest and process results on close.

import {
  ActionRowBuilder,
  ButtonBuilder,
  ButtonStyle,
  MessageFlags,
  ModalBuilder,
  TextInputBuilder,
  TextInputStyle,
} from "discord.js";

import { isAdminOrPrivileged } from "../auth.js";
import { getDb } from "../db.js";
import { chooseOne } from "./rng.js";
import { formatUserWithId, sendChunked, stripEmojisAndSymbols } from "./helpers.js";
import { parseDurationSeconds } from "../shared/time_utils.js";
import { startTimeout, startInterval, clearTimer } from "../shared/timer_utils.js";

const MAX_DURATION_SECONDS = 24 * 60 * 60;

const activePolls = new Map();
const pendingConfigs = new Map();
let pollHooksInstalled = false;
let booted = false;
let clientRef = null;

function ensureClient(client) {
  if (!clientRef && client) clientRef = client;
}

async function savePollRecord(record) {
  const db = getDb();
  await db.execute(
    `
    INSERT INTO poll_contests (
      message_id,
      guild_id,
      channel_id,
      owner_id,
      ends_at_ms,
      run_choose,
      get_lists,
      winners_only
    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?)
    ON DUPLICATE KEY UPDATE
      ends_at_ms = VALUES(ends_at_ms),
      run_choose = VALUES(run_choose),
      get_lists = VALUES(get_lists),
      winners_only = VALUES(winners_only)
    `,
    [
      String(record.messageId),
      String(record.guildId),
      String(record.channelId),
      String(record.ownerId),
      Number(record.endsAtMs),
      record.runChoose ? 1 : 0,
      record.getLists ? 1 : 0,
      record.winnersOnly ? 1 : 0,
    ]
  );
}

async function deletePollRecord(messageId) {
  const db = getDb();
  await db.execute("DELETE FROM poll_contests WHERE message_id = ?", [String(messageId)]);
}

async function markPollUntracked(messageId) {
  const db = getDb();
  await db.execute(
    `
    INSERT INTO poll_untracked (message_id)
    VALUES (?)
    ON DUPLICATE KEY UPDATE message_id = VALUES(message_id)
    `,
    [String(messageId)]
  );
}

async function isPollUntracked(messageId) {
  const db = getDb();
  const [rows] = await db.execute(
    "SELECT message_id FROM poll_untracked WHERE message_id = ? LIMIT 1",
    [String(messageId)]
  );
  return Boolean(rows?.[0]?.message_id);
}

async function loadPollRecords() {
  const db = getDb();
  const [rows] = await db.execute("SELECT * FROM poll_contests");
  return Array.isArray(rows) ? rows : [];
}

function clearPollTimer(messageId) {
  const existing = activePolls.get(messageId);
  if (existing?.timeout) clearTimer(existing.timeout, `poll:${messageId}`);
  if (existing?.watch) clearTimer(existing.watch, `poll:${messageId}:watch`);
  activePolls.delete(messageId);
}

async function checkPollStatus(messageId) {
  const record = activePolls.get(messageId);
  if (!record || !clientRef) return;

  try {
    const channel = await clientRef.channels.fetch(record.channelId);
    if (!channel?.isTextBased?.()) return;
    const message = await channel.messages.fetch(record.messageId);
    const poll = message?.poll;
    if (!poll) return;

    const ended =
      poll.resultsFinalized ||
      (Number.isFinite(poll.expiresTimestamp) && poll.expiresTimestamp <= Date.now());
    if (ended) {
      await processPoll(messageId);
    }
  } catch (err) {
    if (err?.code === 10008 || err?.status === 404) {
      await deletePollRecord(messageId);
      clearPollTimer(messageId);
      return;
    }
  }
}

function schedulePoll(record) {
  const msgId = String(record.messageId);
  if (activePolls.has(msgId)) return;

  const delayMs = Math.max(0, Number(record.endsAtMs) - Date.now() + 2000);
  const timeout = startTimeout({
    label: `poll:${msgId}`,
    ms: delayMs,
    fn: () => processPoll(msgId),
  });
  const watch = startInterval({
    label: `poll:${msgId}:watch`,
    ms: 10_000,
    fn: () => {
      void checkPollStatus(msgId);
    },
  });

  activePolls.set(msgId, {
    ...record,
    timeout,
    watch,
  });
}

function storePendingConfig(config) {
  const token = `${Date.now().toString(36)}${Math.random().toString(36).slice(2, 8)}`;
  const timeout = startTimeout({
    label: `poll:config:${token}`,
    ms: 10 * 60_000,
    fn: () => pendingConfigs.delete(token),
  });
  pendingConfigs.set(token, { ...config, timeout });
  return token;
}

function getPendingConfig(token) {
  return pendingConfigs.get(token);
}

function clearPendingConfig(token) {
  const existing = pendingConfigs.get(token);
  if (existing?.timeout) clearTimer(existing.timeout, `poll:config:${token}`);
  pendingConfigs.delete(token);
}

function describeDurationSeconds(sec) {
  if (!Number.isFinite(sec) || sec <= 0) return "Unknown";
  if (sec < 60) return `${sec} second${sec === 1 ? "" : "s"}`;
  const mins = Math.round(sec / 60);
  if (mins < 60) return `${mins} minute${mins === 1 ? "" : "s"}`;
  const hours = Math.round(mins / 60);
  return `${hours} hour${hours === 1 ? "" : "s"}`;
}

function formatDiscordTimestamp(ms) {
  const epoch = Math.max(0, Math.floor(ms / 1000));
  return `<t:${epoch}:f>`;
}

function camelizeIfNeeded(name) {
  if (!name) return "";
  if (!name.includes(" ")) return name;
  return name
    .split(/\s+/)
    .filter(Boolean)
    .map((word) => word.charAt(0).toUpperCase() + word.slice(1))
    .join("");
}

async function buildNameMap(guild, voters) {
  const ids = [...new Set(voters.map((user) => String(user.id)))];
  const nameMap = new Map();
  let bulk = null;

  if (guild?.members?.fetch && ids.length) {
    try {
      bulk = await guild.members.fetch({ user: ids });
    } catch {}
  }

  for (const user of voters) {
    const id = String(user.id);
    const member = bulk?.get?.(id) || guild?.members?.cache?.get?.(id) || null;
    const rawName = member?.displayName || user.username || "";
    const cleaned = stripEmojisAndSymbols(rawName);
    nameMap.set(id, camelizeIfNeeded(cleaned) || user.username || id);
  }

  return nameMap;
}

function buildConfigView(config, note = "") {
  const statusLines = [
    `**Question:** ${config.question}`,
    `**Options:** ${config.options.length}`,
    `**Duration:** ${describeDurationSeconds(config.durationSeconds)}`,
    `**Run choose:** ${config.runChoose ? "Yes" : "No"}`,
    `**Get lists:** ${config.getLists ? "Yes" : "No"}`,
    `**Choose winning option only:** ${config.winnersOnly ? "Yes" : "No"}`,
  ];

  if (note) statusLines.push(`\n${note}`);

  const toggleRow = new ActionRowBuilder().addComponents(
    new ButtonBuilder()
      .setCustomId(`pollcontest:toggle:choose:${config.token}`)
      .setLabel("Run choose")
      .setStyle(config.runChoose ? ButtonStyle.Success : ButtonStyle.Secondary),
    new ButtonBuilder()
      .setCustomId(`pollcontest:toggle:lists:${config.token}`)
      .setLabel("Get lists")
      .setStyle(config.getLists ? ButtonStyle.Success : ButtonStyle.Secondary),
    new ButtonBuilder()
      .setCustomId(`pollcontest:toggle:winners:${config.token}`)
      .setLabel("Choose winning option only")
      .setStyle(config.winnersOnly ? ButtonStyle.Success : ButtonStyle.Secondary)
      .setDisabled(!config.runChoose)
  );

  const actionRow = new ActionRowBuilder().addComponents(
    new ButtonBuilder()
      .setCustomId(`pollcontest:start:${config.token}`)
      .setLabel(config.pollMessageId ? "Track poll" : "Start poll")
      .setStyle(ButtonStyle.Success),
    new ButtonBuilder()
      .setCustomId(`pollcontest:cancel:${config.token}`)
      .setLabel("Cancel")
      .setStyle(ButtonStyle.Secondary)
  );

  return {
    content: statusLines.join("\n"),
    components: [toggleRow, actionRow],
  };
}

function buildConfigDisabledView(config, note) {
  const view = buildConfigView(config, note);
  const disabledRows = view.components.map((row) => {
    const newRow = new ActionRowBuilder();
    for (const component of row.components) {
      newRow.addComponents(ButtonBuilder.from(component).setDisabled(true));
    }
    return newRow;
  });
  return { content: view.content, components: disabledRows };
}

async function installPollHooks(client) {
  if (pollHooksInstalled) return;
  pollHooksInstalled = true;

  client.on("messageDelete", async (message) => {
    const msgId = message?.id ? String(message.id) : null;
    if (!msgId || !activePolls.has(msgId)) return;

    try {
      clearPollTimer(msgId);
      await deletePollRecord(msgId);
      console.log(`[pollcontest] poll ${msgId} deleted; cleaned up`);
    } catch (err) {
      console.error("[pollcontest] cleanup failed after message delete:", err);
    }
  });

  client.on("messageUpdate", async (oldMessage, newMessage) => {
    const msgId = String(newMessage?.id || oldMessage?.id || "");
    if (!msgId || !activePolls.has(msgId)) return;

    let message = newMessage;
    if (message?.partial && message?.fetch) {
      try {
        message = await message.fetch();
      } catch {
        message = null;
      }
    }

    if (!message?.poll && message?.channel?.messages?.fetch) {
      try {
        message = await message.channel.messages.fetch(msgId);
      } catch {
        message = null;
      }
    }

    const poll = message?.poll;
    if (!poll) return;
    const ended =
      poll.resultsFinalized ||
      (Number.isFinite(poll.expiresTimestamp) && poll.expiresTimestamp <= Date.now());
    if (ended) {
      await processPoll(msgId);
    }
  });
}

async function boot(client) {
  if (booted) {
    ensureClient(client);
    return;
  }
  booted = true;
  ensureClient(client);
  await installPollHooks(client);

  try {
    const rows = await loadPollRecords();
    for (const row of rows) {
      schedulePoll({
        messageId: row.message_id,
        guildId: row.guild_id,
        channelId: row.channel_id,
        ownerId: row.owner_id,
        endsAtMs: Number(row.ends_at_ms),
        runChoose: Boolean(row.run_choose),
        getLists: Boolean(row.get_lists),
        winnersOnly: Boolean(row.winners_only),
      });
    }
  } catch (err) {
    console.error("[pollcontest] failed to load active polls:", err);
  }
}

async function fetchAllVoters(answer) {
  const voters = new Map();
  let after = undefined;

  for (;;) {
    const batch = await answer.voters.fetch({ limit: 100, after });
    for (const user of batch.values()) {
      voters.set(user.id, user);
    }
    if (batch.size < 100) break;
    after = batch.last()?.id;
    if (!after) break;
  }

  return [...voters.values()];
}

function formatMention(user) {
  return `<@${user.id}>`;
}

function describeAnswer(answer, index) {
  return String(answer?.text || `Option ${index + 1}`).trim();
}

function pickWinner(voters) {
  if (!voters.length) return null;
  return chooseOne(voters);
}

function countVotes(voters) {
  return Array.isArray(voters) ? voters.length : 0;
}

function resolveWinnersOnly(answerResults) {
  const counts = answerResults.map((r) => countVotes(r.voters));
  const max = Math.max(0, ...counts);
  const winnerIndices = counts
    .map((count, idx) => (count === max ? idx : -1))
    .filter((idx) => idx >= 0);

  if (winnerIndices.length !== 1) {
    return { mode: "tie", indices: winnerIndices };
  }
  return { mode: "winner", indices: winnerIndices };
}

async function processPoll(messageId) {
  const record = activePolls.get(messageId);
  if (!record) return;

  if (!clientRef) {
    record.timeout = startTimeout({
      label: `poll:${messageId}`,
      ms: 5000,
      fn: () => processPoll(messageId),
    });
    return;
  }

  clearPollTimer(messageId);

  let channel = null;
  let message = null;
  try {
    channel = await clientRef.channels.fetch(record.channelId);
    if (!channel?.isTextBased?.()) throw new Error("Channel not text-based");
    if (channel.messages?.endPoll) {
      try {
        await channel.messages.endPoll(record.messageId);
      } catch {}
    }
    message = await channel.messages.fetch(record.messageId);
  } catch (err) {
    if (err?.code === 10008 || err?.status === 404) {
      await deletePollRecord(messageId);
      return;
    }
    console.error("[pollcontest] failed to fetch poll message:", err);
    await deletePollRecord(messageId);
    return;
  }

  const poll = message.poll;
  if (!poll) {
    console.error("[pollcontest] poll data missing for message:", messageId);
    await deletePollRecord(messageId);
    return;
  }

  const botUserId = clientRef?.user?.id;
  const authorId = message.author?.id || null;
  const pollStarterId =
    authorId && botUserId && authorId === botUserId && record.ownerId ? record.ownerId : authorId || record.ownerId;

  const answers = [...poll.answers.values()];
  const answerResults = [];
  for (let i = 0; i < answers.length; i += 1) {
    const answer = answers[i];
    try {
      const voters = await fetchAllVoters(answer);
      answerResults.push({ answer, voters, index: i });
    } catch (err) {
      console.error("[pollcontest] failed to fetch poll voters:", err);
      answerResults.push({ answer, voters: [], index: i });
    }
  }

  const notes = [];
  let resultSet = answerResults;
  let forceLists = false;
  let suppressChoose = false;
  if (record.winnersOnly) {
    const winnerInfo = resolveWinnersOnly(answerResults);
    if (winnerInfo.mode === "tie") {
      notes.push("⚠️ Tie for most votes; showing results for all options.");
      notes.push("⚠️ Falling back to voter lists so the host can decide.");
      forceLists = true;
      suppressChoose = true;
    } else {
      resultSet = winnerInfo.indices.map((idx) => answerResults[idx]);
    }
  }

  const header = `📊 Poll results: ${poll.question?.text || "(untitled poll)"}`;
  const channelLines = [];
  const listLines = [];
  const shouldList = record.getLists || forceLists;
  const sendListsFirst = shouldList && record.runChoose;
  const guild = channel?.guild || null;
  let nameMap = null;
  if (shouldList) {
    const allVoters = answerResults.flatMap((item) => item.voters);
    nameMap = await buildNameMap(guild, allVoters);
  }

  for (const item of resultSet) {
    const label = describeAnswer(item.answer, item.index);
    const votes = countVotes(item.voters);
    channelLines.push(`**${label}** — ${votes} vote${votes === 1 ? "" : "s"}`);

    if (record.runChoose && !suppressChoose) {
      const winner = pickWinner(item.voters);
      if (winner) {
        const winnerLabel = await formatUserWithId({ guildId: record.guildId, userId: winner.id });
        channelLines.push(`Winner: ${winnerLabel}`);
      } else {
        channelLines.push("Winner: (no votes)");
      }
    }

    if (shouldList) {
      listLines.push(`**${label}** — ${votes} vote${votes === 1 ? "" : "s"}`);
      if (votes) {
        const names = item.voters.map((v) => nameMap?.get(String(v.id)) || v.username || String(v.id));
        listLines.push(names.join(", "));
      } else {
        listLines.push("No votes.");
      }
      listLines.push("");
    }
  }

  if (notes.length) {
    channelLines.push("");
    channelLines.push(...notes);
  }

  if (shouldList && sendListsFirst) {
    try {
      if (listLines[listLines.length - 1] === "") listLines.pop();
      if (pollStarterId) {
        listLines.unshift(`Poll started by: ${formatMention({ id: pollStarterId })}`);
      }
      await sendChunked({
        send: (content) => channel.send(content),
        header: `📋 Poll voter lists: ${poll.question?.text || "(untitled poll)"}`,
        lines: listLines,
      });
    } catch (err) {
      console.error("[pollcontest] failed to send poll lists:", err);
    }
  }

  try {
    await sendChunked({
      send: (content) => channel.send(content),
      header,
      lines: channelLines,
    });
  } catch (err) {
    console.error("[pollcontest] failed to send channel results:", err);
  }

  if (shouldList && !sendListsFirst) {
    try {
      if (listLines[listLines.length - 1] === "") listLines.pop();
      if (pollStarterId) {
        listLines.unshift(`Poll started by: ${formatMention({ id: pollStarterId })}`);
      }
      await sendChunked({
        send: (content) => channel.send(content),
        header: `📋 Poll voter lists: ${poll.question?.text || "(untitled poll)"}`,
        lines: listLines,
      });
    } catch (err) {
      console.error("[pollcontest] failed to send poll lists:", err);
    }
  }

  await deletePollRecord(messageId);
}

function buildPollQuestion(question) {
  return { text: String(question || "").trim() };
}

function buildPollAnswers(options) {
  return options.map((text) => ({ text: String(text).trim() }));
}

function parseOptionsFromLines(raw) {
  return String(raw || "")
    .split("\n")
    .map((line) => line.trim())
    .filter(Boolean);
}

async function cancelPollRecord({ messageId, actorId, isAdmin }) {
  const record = activePolls.get(messageId);
  if (!record) return { ok: false, reason: "not_found" };
  if (!isAdmin && String(record.ownerId) !== String(actorId)) {
    return { ok: false, reason: "not_owner" };
  }

  clearPollTimer(messageId);
  await deletePollRecord(messageId);

  if (clientRef) {
    try {
      const channel = await clientRef.channels.fetch(record.channelId);
      if (channel?.isTextBased?.()) {
        await channel.messages.endPoll(messageId);
        await channel.send(`🛑 Poll ${messageId} was cancelled.`);
      }
    } catch (err) {
      console.error("[pollcontest] failed to end cancelled poll:", err);
    }
  }

  return { ok: true };
}

export function registerPollContest(register) {
  register.listener(({ message }) => {
    if (!message?.client) return;
    boot(message.client);
  });

  register(
    "!pollcontest",
    async ({ message, rest }) => {
      const arg = String(rest || "").trim().toLowerCase();
      if (arg !== "help") return;
      await message.reply(
        "Use `/pollcontest create` to start a poll contest (modal), " +
          "or `/pollcontest create poll_id:<messageId>` to track an existing poll. " +
          "Manage with `/pollcontest cancel message_id:<id>` or `/pollcontest untrack message_id:<id>`."
      );
    },
    "!pollcontest help — show /pollcontest usage",
    { hideFromHelp: true }
  );

  register.slash(
    {
      name: "pollcontest",
      description: "Create or manage poll contests",
      options: [
        {
          type: 1, // SUB_COMMAND
          name: "create",
          description: "Create a poll contest and process results",
          options: [
            {
              type: 3, // STRING
              name: "poll_id",
              description: "Use an existing poll message ID instead of creating a new poll",
              required: false,
            },
          ],
        },
        {
          type: 1, // SUB_COMMAND
          name: "cancel",
          description: "Cancel a poll contest by message ID",
          options: [
            {
              type: 3, // STRING
              name: "message_id",
              description: "Message ID of the poll to cancel",
              required: true,
            },
          ],
        },
        {
          type: 1, // SUB_COMMAND
          name: "untrack",
          description: "Stop tracking a poll contest by message ID",
          options: [
            {
              type: 3, // STRING
              name: "message_id",
              description: "Message ID of the poll to untrack",
              required: true,
            },
          ],
        },
      ],
    },
    async ({ interaction }) => {
      ensureClient(interaction.client);
      await boot(interaction.client);

      if (!interaction.guildId) {
        await interaction.reply({
          content: "Poll contests must be created in a server channel.",
          flags: MessageFlags.Ephemeral,
        });
        return;
      }

      const sub = interaction.options?.getSubcommand?.() || "";

      if (sub === "create") {
        if (!isAdminOrPrivileged(interaction)) {
          await interaction.reply({
            content: "You do not have permission to run this command.",
            flags: MessageFlags.Ephemeral,
          });
          return;
        }

        const pollId = String(interaction.options?.getString?.("poll_id") || "").trim();
        if (pollId) {
          if (!interaction.channel?.messages?.fetch) {
            await interaction.reply({
              content: "Could not access this channel.",
              flags: MessageFlags.Ephemeral,
            });
            return;
          }

          let message = null;
          try {
            message = await interaction.channel.messages.fetch(pollId);
          } catch {
            message = null;
          }

          const poll = message?.poll || null;
          if (!poll) {
            await interaction.reply({
              content: "Could not find a poll with that message ID in this channel.",
              flags: MessageFlags.Ephemeral,
            });
            return;
          }

          if (String(message.channelId || "") !== String(interaction.channelId || "")) {
            await interaction.reply({
              content: "That poll is not in this channel.",
              flags: MessageFlags.Ephemeral,
            });
            return;
          }

          const botId = interaction.client?.user?.id;
          const messageId = String(message.id);
          if (botId && String(message.author?.id) === String(botId)) {
            const allowed = await isPollUntracked(messageId);
            if (!allowed) {
              await interaction.reply({
                content: "That poll was started by Spectreon and is already tracked.",
                flags: MessageFlags.Ephemeral,
              });
              return;
            }
          }

          if (poll.allowMultiselect) {
            await interaction.reply({
              content: "That poll allows multiple selections and is not supported.",
              flags: MessageFlags.Ephemeral,
            });
            return;
          }

          const endsAtMs = Number(poll.expiresTimestamp);
          if (!Number.isFinite(endsAtMs)) {
            await interaction.reply({
              content: "That poll does not have a valid expiry time.",
              flags: MessageFlags.Ephemeral,
            });
            return;
          }

          const pollEnded = endsAtMs <= Date.now();

          if (activePolls.has(messageId)) {
            await interaction.reply({
              content: "That poll is already being tracked.",
              flags: MessageFlags.Ephemeral,
            });
            return;
          }

          const answers = [...poll.answers.values()].map((answer) => answer.text).filter(Boolean);
          if (answers.length < 2) {
            await interaction.reply({
              content: "That poll must have at least two options.",
              flags: MessageFlags.Ephemeral,
            });
            return;
          }

          if (answers.length > 10) {
            await interaction.reply({
              content: "That poll has more than 10 options and is not supported.",
              flags: MessageFlags.Ephemeral,
            });
            return;
          }

          const durationSeconds = Math.max(1, Math.floor((endsAtMs - Date.now()) / 1000));
          const token = storePendingConfig({
            question: poll.question?.text || "(untitled poll)",
            options: answers,
            durationSeconds,
            runChoose: false,
            getLists: false,
            winnersOnly: false,
            ownerId: interaction.user?.id,
            guildId: interaction.guildId,
            channelId: interaction.channelId,
            pollMessageId: messageId,
            pollEndsAtMs: endsAtMs,
            pollEnded,
          });

          const config = { ...getPendingConfig(token), token };
          await interaction.reply({
            ...buildConfigView(
              config,
              pollEnded ? "Using existing poll (already ended)." : "Using existing poll."
            ),
            flags: MessageFlags.Ephemeral,
          });
          return;
        }

        const modal = new ModalBuilder()
          .setCustomId(`pollcontest:modal:${interaction.id}`)
          .setTitle("Create Poll Contest");

        const questionInput = new TextInputBuilder()
          .setCustomId("question")
          .setLabel("Question")
          .setStyle(TextInputStyle.Short)
          .setRequired(true);

        const optionsInput = new TextInputBuilder()
          .setCustomId("options")
          .setLabel("Options (one per line, 2–10)")
          .setStyle(TextInputStyle.Paragraph)
          .setRequired(true);

        const durationInput = new TextInputBuilder()
          .setCustomId("duration")
          .setLabel("Duration (e.g. 10m, 2h, 30s)")
          .setStyle(TextInputStyle.Short)
          .setRequired(true);

        modal.addComponents(
          new ActionRowBuilder().addComponents(questionInput),
          new ActionRowBuilder().addComponents(optionsInput),
          new ActionRowBuilder().addComponents(durationInput)
        );

        await interaction.showModal(modal);
        return;
      }

      if (sub === "cancel") {
        const messageId = String(interaction.options?.getString?.("message_id") || "").trim();
        if (!messageId) {
          await interaction.reply({ content: "Please provide a poll message ID.", ephemeral: true });
          return;
        }

        const res = await cancelPollRecord({
          messageId,
          actorId: interaction.user?.id,
          isAdmin: isAdminOrPrivileged(interaction),
        });

        if (res.ok) {
          await interaction.reply({ content: "✅ Poll cancelled.", ephemeral: true });
          return;
        }

        const content =
          res.reason === "not_found"
            ? "No active poll found for that message ID."
            : "You can only cancel polls you created.";
        await interaction.reply({ content, ephemeral: true });
        return;
      }

      if (sub === "untrack") {
        const messageId = String(interaction.options?.getString?.("message_id") || "").trim();
        if (!messageId) {
          await interaction.reply({ content: "Please provide a poll message ID.", ephemeral: true });
          return;
        }

        const existing = activePolls.get(messageId);
        if (existing) {
          clearPollTimer(messageId);
        }

        if (!existing) {
          await interaction.reply({ content: "No tracked poll found for that message ID.", ephemeral: true });
          return;
        }

        await deletePollRecord(messageId);
        await markPollUntracked(messageId);
        await interaction.reply({ content: "✅ Poll untracked.", ephemeral: true });
        return;
      }

      await interaction.reply({
        content: "Unknown pollcontest subcommand.",
        flags: MessageFlags.Ephemeral,
      });
    },
    { admin: true, adminCategory: "Contests" }
  );

  register.component("pollcontest:", async ({ interaction }) => {
    if (!interaction.isModalSubmit?.() && !interaction.isButton?.() && !interaction.isStringSelectMenu?.()) {
      return;
    }

    if (!interaction.guildId) {
      if (interaction.reply) {
        await interaction.reply({
          content: "Poll contests must be created in a server channel.",
          flags: MessageFlags.Ephemeral,
        });
      }
      return;
    }

    if (interaction.isModalSubmit?.()) {
      if (!isAdminOrPrivileged(interaction)) {
        await interaction.reply({
          content: "You do not have permission to run this command.",
          flags: MessageFlags.Ephemeral,
        });
        return;
      }

      const question = String(interaction.fields?.getTextInputValue?.("question") || "").trim();
      const options = parseOptionsFromLines(interaction.fields?.getTextInputValue?.("options"));
      const durationRaw = interaction.fields?.getTextInputValue?.("duration");
      const durationSeconds = parseDurationSeconds(durationRaw, null);

      if (!question) {
        await interaction.reply({ content: "Please provide a question.", flags: MessageFlags.Ephemeral });
        return;
      }

      if (options.length < 2) {
        await interaction.reply({
          content: "Please provide at least two poll options.",
          flags: MessageFlags.Ephemeral,
        });
        return;
      }

      if (options.length > 10) {
        await interaction.reply({
          content: "Please provide no more than 10 poll options.",
          flags: MessageFlags.Ephemeral,
        });
        return;
      }

      if (!Number.isFinite(durationSeconds) || durationSeconds <= 0) {
        await interaction.reply({
          content: "Please provide a valid duration (e.g. 10m, 2h, 30s).",
          flags: MessageFlags.Ephemeral,
        });
        return;
      }

      if (durationSeconds > MAX_DURATION_SECONDS) {
        await interaction.reply({
          content: "Poll duration cannot exceed 24 hours.",
          flags: MessageFlags.Ephemeral,
        });
        return;
      }

      const token = storePendingConfig({
        question,
        options,
        durationSeconds,
        runChoose: false,
        getLists: false,
        winnersOnly: false,
        ownerId: interaction.user?.id,
        guildId: interaction.guildId,
        channelId: interaction.channelId,
      });

      const config = { ...getPendingConfig(token), token };
      await interaction.reply({
        ...buildConfigView(config),
        flags: MessageFlags.Ephemeral,
      });
      return;
    }

    const customId = String(interaction.customId || "");
    const parts = customId.split(":");
    const action = parts[1];
    const token = parts[parts.length - 1];
    const config = getPendingConfig(token);

    if (!config) {
      await interaction.reply({
        content: "This poll setup has expired. Please run /pollcontest create again.",
        flags: MessageFlags.Ephemeral,
      });
      return;
    }

    const isOwner = String(config.ownerId) === String(interaction.user?.id);
    if (!isOwner && !isAdminOrPrivileged(interaction)) {
      await interaction.reply({
        content: "Only the poll creator can edit this setup.",
        flags: MessageFlags.Ephemeral,
      });
      return;
    }

    if (interaction.isButton?.() && action === "toggle") {
      const field = parts[2];
      if (field === "choose") {
        config.runChoose = !config.runChoose;
        if (!config.runChoose) config.winnersOnly = false;
      }
      if (field === "lists") config.getLists = !config.getLists;
      if (field === "winners" && config.runChoose) config.winnersOnly = !config.winnersOnly;
      const view = buildConfigView({ ...config, token });
      await interaction.update(view);
      return;
    }

    if (interaction.isButton?.() && action === "cancel") {
      clearPendingConfig(token);
      const view = buildConfigDisabledView({ ...config, token }, "Cancelled.");
      await interaction.update(view);
      return;
    }

    if (interaction.isButton?.() && action === "start") {
      if (!config.runChoose && !config.getLists) {
        await interaction.reply({
          content: "Enable Run choose or Get lists before starting.",
          flags: MessageFlags.Ephemeral,
        });
        return;
      }

      if (!interaction.channel?.send) {
        await interaction.reply({
          content: "Could not access this channel.",
          flags: MessageFlags.Ephemeral,
        });
        return;
      }

      try {
        let messageId = String(config.pollMessageId || "");
        let endsAtMs = Number(config.pollEndsAtMs || 0);
        if (!messageId) {
          const poll = {
            question: buildPollQuestion(config.question),
            answers: buildPollAnswers(config.options),
            duration: Math.max(1, Math.ceil(config.durationSeconds / 3600)),
            allowMultiselect: false,
          };

          const pollMessage = await interaction.channel.send({ poll });
          messageId = String(pollMessage.id);
          endsAtMs = Date.now() + config.durationSeconds * 1000;
        }

        const record = {
          messageId,
          guildId: config.guildId,
          channelId: config.channelId,
          ownerId: config.ownerId,
          endsAtMs,
          runChoose: config.runChoose,
          getLists: config.getLists,
          winnersOnly: config.winnersOnly,
        };

        await savePollRecord(record);
        schedulePoll(record);
        clearPendingConfig(token);

        if (config.pollMessageId && config.pollEndsAtMs <= Date.now()) {
          await processPoll(messageId);
        } else {
          try {
            await interaction.channel.send(
              `⏰ Bot will end this poll at ${formatDiscordTimestamp(endsAtMs)}.`
            );
          } catch (err) {
            console.error("[pollcontest] failed to send poll end note:", err);
          }
        }

        const view = buildConfigDisabledView(
          { ...config, token },
          config.pollMessageId && config.pollEndsAtMs <= Date.now()
            ? "✅ Poll started. Processing results now."
            : `✅ Poll started. Bot will end this poll at ${formatDiscordTimestamp(endsAtMs)}.`
        );
        await interaction.update(view);
      } catch (err) {
        console.error("[pollcontest] failed to create poll:", err);
        await interaction.reply({
          content: "Failed to create the poll.",
          flags: MessageFlags.Ephemeral,
        });
      }
      return;
    }
  });


  register(
    "!cancelpoll",
    async ({ message, rest }) => {
      if (!message.guildId) return;
      if (!isAdminOrPrivileged(message)) return;

      ensureClient(message.client);
      await boot(message.client);

      const messageId = String(rest || "").trim();
      if (!messageId) {
        await message.reply("Usage: !cancelpoll <messageId>");
        return;
      }

      const res = await cancelPollRecord({
        messageId,
        actorId: message.author?.id,
        isAdmin: isAdminOrPrivileged(message),
      });

      if (res.ok) {
        await message.reply("✅ Poll cancelled.");
        return;
      }

      await message.reply(
        res.reason === "not_found"
          ? "No active poll found for that message ID."
          : "You can only cancel polls you created."
      );
    },
    "!cancelpoll — cancel a poll contest by message ID",
    { hideFromHelp: true }
  );

}

export const _test = {
  resolveWinnersOnly,
  resetState() {
    activePolls.clear();
    pendingConfigs.clear();
    clientRef = null;
    pollHooksInstalled = false;
    booted = false;
  },
};
