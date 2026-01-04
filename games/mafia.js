// games/mafia.js
//
// Minimal Mafia (in-memory, host-driven):
// - Start lobby with !mafia (reaction join ✅)
// - Host uses !mafia start to assign roles + begin night
// - DM actions at night: !mafia kill/@inspect/@protect
// - Host resolves night via !mafia resolve
// - Public voting via !mafia vote/@unvote and host !mafia endday (no lynch on no-majority)

import {
  createGameManager,
  withGameSubcommands,
  reply,
  requireSameChannel,
  requireCanManage,
  parseMentionIdsInOrder,
} from "./framework.js";
import { metrics } from "../shared/metrics.js";

const MIN_PLAYERS = 5;
const MAX_PLAYERS = 15;
const JOIN_EMOJI = "✅";

const manager = createGameManager({ id: "mafia", prettyName: "Mafia", scope: "guild" });
const activeByGuild = new Map(); // guildId -> state

function mafiaHelpText() {
  return [
    "**Mafia — Help**",
    "",
    "**Start / Join:**",
    "• `!mafia` — open lobby (✅ reaction join)",
    "• `!mafia start` — host starts the game",
    "",
    "**Night actions (DM the bot):**",
    "• `!mafia kill @user` — Mafia target",
    "• `!mafia inspect @user` — Detective target",
    "• `!mafia protect @user` — Doctor target",
    "",
    "**Day commands (public):**",
    "• `!mafia vote @user`",
    "• `!mafia unvote`",
    "• `!mafia endday` — host resolves votes",
    "",
    "**Info / Admin:**",
    "• `!mafia status`",
    "• `!mafia resolve` — host resolves night",
    "• `!mafia end` — host/admin ends the game",
  ].join("\n");
}

function mafiaRulesText() {
  return [
    "**Mafia — Rules (Minimal)**",
    "",
    `• ${MIN_PLAYERS}–${MAX_PLAYERS} players.`,
    "• Roles: Mafia, Detective, Doctor, Town.",
    "• Mafia win when they reach parity with Town.",
    "• Town win when all Mafia are eliminated.",
    "• Role is revealed on death.",
    "• No lynch if no majority vote.",
  ].join("\n");
}

function mention(id) {
  return `<@${id}>`;
}

function now() {
  return Date.now();
}

function shuffle(arr) {
  const a = arr.slice();
  for (let i = a.length - 1; i > 0; i--) {
    const j = Math.floor(Math.random() * (i + 1));
    [a[i], a[j]] = [a[j], a[i]];
  }
  return a;
}

function mafiaCountFor(n) {
  if (n >= 11) return 3;
  return 2;
}

function buildStatus(state) {
  const alive = [...state.players.values()].filter((p) => p.alive);
  const aliveLine = alive.length ? alive.map((p) => mention(p.id)).join(", ") : "none";
  const phase = state.phase;
  const votes = state.phase === "day" ? buildVoteSummary(state) : "N/A";

  return [
    `**Mafia — Status**`,
    `Phase: **${phase}**`,
    `Alive (${alive.length}): ${aliveLine}`,
    `Votes: ${votes}`,
  ].join("\n");
}

function buildVoteSummary(state) {
  const counts = tallyVotes(state);
  if (!counts.length) return "no votes";
  return counts.map((row) => `${mention(row.targetId)}: ${row.count}`).join(" | ");
}

function tallyVotes(state) {
  const counts = new Map();
  for (const [voterId, targetId] of state.votes.entries()) {
    const voter = state.players.get(voterId);
    const target = state.players.get(targetId);
    if (!voter?.alive || !target?.alive) continue;
    counts.set(targetId, (counts.get(targetId) || 0) + 1);
  }
  return [...counts.entries()]
    .map(([targetId, count]) => ({ targetId, count }))
    .sort((a, b) => b.count - a.count);
}

function clearNightActions(state) {
  state.nightActions = { kill: null, protect: null, inspect: null };
}

function clearVotes(state) {
  state.votes.clear();
}

function aliveCount(state, role = null) {
  let n = 0;
  for (const p of state.players.values()) {
    if (!p.alive) continue;
    if (role && p.role !== role) continue;
    n += 1;
  }
  return n;
}

function checkWin(state) {
  const mafiaAlive = aliveCount(state, "mafia");
  const townAlive = aliveCount(state) - mafiaAlive;
  if (mafiaAlive <= 0) return "town";
  if (mafiaAlive >= townAlive) return "mafia";
  return null;
}

function getStateByPlayer(userId) {
  for (const st of activeByGuild.values()) {
    const player = st?.players?.get?.(userId);
    if (player && player.alive) return st;
  }
  return null;
}

async function dm(user, content) {
  try {
    const channel = await user.createDM();
    await channel.send(content);
    return true;
  } catch {
    void metrics.increment("dm.fail", { feature: "mafia" });
    return false;
  }
}

async function assignRoles(state, players) {
  const shuffled = shuffle(players);
  const mafiaCount = mafiaCountFor(shuffled.length);
  const mafiaIds = new Set(shuffled.slice(0, mafiaCount));

  const nonMafia = shuffled.filter((id) => !mafiaIds.has(id));
  const detectiveId = nonMafia[0] || null;
  const doctorId = nonMafia[1] || null;

  state.players.clear();
  for (const id of shuffled) {
    let role = "town";
    if (mafiaIds.has(id)) role = "mafia";
    if (id === detectiveId) role = "detective";
    if (id === doctorId) role = "doctor";
    state.players.set(id, { id, role, alive: true });
  }

  state.mafiaIds = mafiaIds;
  state.detectiveId = detectiveId;
  state.doctorId = doctorId;
}

async function notifyRoles(state, client) {
  const mafiaList = [...state.mafiaIds].map(mention).join(", ");
  const failures = [];

  for (const p of state.players.values()) {
    const user = await client.users.fetch(p.id).catch(() => null);
    if (!user) {
      failures.push(p.id);
      continue;
    }

    let roleText = `You are **${p.role.toUpperCase()}**.`;
    if (p.role === "mafia") {
      roleText += ` Mafia: ${mafiaList}`;
    }

    const ok = await dm(user, roleText);
    if (!ok) failures.push(p.id);
  }

  return failures;
}

async function startLobby({ message }) {
  const guildId = message.guildId;
  if (!guildId) return;

  const existing = manager.getState({ message });
  if (existing) {
    await reply({ message }, manager.alreadyRunningText(existing));
    return;
  }

  const joinMsg = await message.channel.send(
    `✅ **Mafia Lobby** — react with ${JOIN_EMOJI} to join.\n` +
      `Host: ${mention(message.author.id)}\n` +
      `Players: ${MIN_PLAYERS}–${MAX_PLAYERS}\n` +
      `Host uses \`!mafia start\` when ready.`
  );
  try {
    await joinMsg.react(JOIN_EMOJI);
  } catch {}

  const init = {
    guildId,
    channelId: message.channelId,
    creatorId: message.author.id,
    joinMessageId: joinMsg.id,
    joinChannelId: message.channelId,
    phase: "lobby",
    players: new Map(),
    mafiaIds: new Set(),
    detectiveId: null,
    doctorId: null,
    votes: new Map(),
    nightActions: { kill: null, protect: null, inspect: null },
    createdAtMs: now(),
  };

  manager.setState({ message }, init);
  activeByGuild.set(String(guildId), init);
}

async function startGame({ message, state }) {
  const channel = message.channel;
  if (!channel?.messages?.fetch) {
    await reply({ message }, "Could not access the lobby message.");
    return;
  }

  let joinMsg = null;
  try {
    joinMsg = await channel.messages.fetch(state.joinMessageId);
  } catch {
    joinMsg = null;
  }
  if (!joinMsg) {
    await reply({ message }, "Lobby message not found. Start a new lobby with `!mafia`.");
    return;
  }

  const reaction = joinMsg.reactions.cache.get(JOIN_EMOJI);
  let users = [];
  if (reaction?.users?.fetch) {
    const fetched = await reaction.users.fetch().catch(() => new Map());
    users = [...fetched.values()];
  }

  const entrants = users.filter((u) => !u.bot).map((u) => u.id);
  if (!entrants.includes(message.author.id)) entrants.push(message.author.id);

  const unique = [...new Set(entrants)];
  if (unique.length < MIN_PLAYERS) {
    await reply({ message }, `Need at least ${MIN_PLAYERS} players to start.`);
    return;
  }

  const picked = unique.length > MAX_PLAYERS ? shuffle(unique).slice(0, MAX_PLAYERS) : unique;

  await assignRoles(state, picked);
  state.phase = "night";
  clearVotes(state);
  clearNightActions(state);

  const failures = await notifyRoles(state, message.client);
  if (failures.length) {
    await reply(
      { message },
      `⚠️ Could not DM role to: ${failures.map(mention).join(", ")}`
    );
  }

  await reply(
    { message },
    "🌙 **Night falls.** Mafia/Detective/Doctor: DM your action to the bot.\n" +
      "Host uses `!mafia resolve` to end the night."
  );
}

async function resolveNight({ message, state }) {
  const channel = message.channel;
  const { kill, protect, inspect } = state.nightActions;

  if (inspect && state.detectiveId) {
    const target = state.players.get(inspect);
    if (target?.alive) {
      const user = await message.client.users.fetch(state.detectiveId).catch(() => null);
      if (user) {
        const ok = await dm(
          user,
          `${mention(target.id)} is **${target.role === "mafia" ? "MAFIA" : "NOT Mafia"}**.`
        );
        if (!ok) {
          await channel.send("⚠️ Detective could not be reached via DM.");
        }
      }
    }
  }

  let killedId = null;
  if (kill && kill !== protect) {
    const victim = state.players.get(kill);
    if (victim?.alive) {
      victim.alive = false;
      killedId = victim.id;
      await channel.send(
        `💀 ${mention(victim.id)} was killed. Role: **${victim.role.toUpperCase()}**.`
      );
    }
  } else if (kill && kill === protect) {
    await channel.send("🛡️ The Doctor saved the target.");
  } else {
    await channel.send("🌙 No one was killed tonight.");
  }

  clearNightActions(state);

  const winner = checkWin(state);
  if (winner) {
    await channel.send(
      winner === "town" ? "🏆 **Town wins!**" : "🏆 **Mafia wins!**"
    );
    manager.stop({ message });
    activeByGuild.delete(String(state.guildId));
    return;
  }

  state.phase = "day";
  clearVotes(state);
  await channel.send("☀️ **Day phase.** Discuss and vote with `!mafia vote @user`.");
}

async function endDay({ message, state }) {
  const channel = message.channel;
  const alive = [...state.players.values()].filter((p) => p.alive);
  const majority = Math.floor(alive.length / 2) + 1;
  const counts = tallyVotes(state);

  if (!counts.length || counts[0].count < majority) {
    await channel.send("🕊️ No majority reached. No lynch today.");
  } else {
    const top = counts[0];
    const tied = counts.length > 1 && counts[1].count === top.count;
    if (tied) {
      await channel.send("🕊️ Vote tied. No lynch today.");
    } else {
      const victim = state.players.get(top.targetId);
      if (victim?.alive) {
        victim.alive = false;
        await channel.send(
          `⚖️ ${mention(victim.id)} was lynched. Role: **${victim.role.toUpperCase()}**.`
        );
      }
    }
  }

  clearVotes(state);
  const winner = checkWin(state);
  if (winner) {
    await channel.send(
      winner === "town" ? "🏆 **Town wins!**" : "🏆 **Mafia wins!**"
    );
    manager.stop({ message });
    activeByGuild.delete(String(state.guildId));
    return;
  }

  state.phase = "night";
  clearNightActions(state);
  await channel.send("🌙 **Night falls.** Mafia/Detective/Doctor: DM your action to the bot.");
}

async function handleDmAction({ message, rest, state }) {
  const raw = String(rest || "").trim();
  const [cmd, ...restParts] = raw.split(/\s+/);
  const sub = (cmd || "").toLowerCase();
  const targetIds = parseMentionIdsInOrder(restParts.join(" "));
  const targetId = targetIds[0] || null;

  if (!targetId) {
    await reply({ message }, "Please mention a valid target.");
    return;
  }

  if (state.phase !== "night") {
    await reply({ message }, "Night actions can only be used at night.");
    return;
  }

  const player = state.players.get(message.author.id);
  if (!player?.alive) {
    await reply({ message }, "You are not alive in the current game.");
    return;
  }

  if (sub === "kill") {
    if (player.role !== "mafia") {
      await reply({ message }, "Only Mafia can use `kill`.");
      return;
    }
    state.nightActions.kill = targetId;
    await reply({ message }, `Kill target set to ${mention(targetId)}.`);
    return;
  }

  if (sub === "inspect") {
    if (player.role !== "detective") {
      await reply({ message }, "Only the Detective can use `inspect`.");
      return;
    }
    state.nightActions.inspect = targetId;
    await reply({ message }, `Inspect target set to ${mention(targetId)}.`);
    return;
  }

  if (sub === "protect") {
    if (player.role !== "doctor") {
      await reply({ message }, "Only the Doctor can use `protect`.");
      return;
    }
    state.nightActions.protect = targetId;
    await reply({ message }, `Protect target set to ${mention(targetId)}.`);
    return;
  }

  await reply({ message }, "Unknown night action.");
}

export function registerMafia(register) {
  register(
    "!mafia",
    withGameSubcommands({
      helpText: mafiaHelpText(),
      rulesText: mafiaRulesText(),
      onStatus: async ({ message }) => {
        const state = manager.getState({ message });
        if (!state) return void (await reply({ message }, manager.noActiveText()));
        await reply({ message }, buildStatus(state));
      },
      onStart: async ({ message, rest }) => {
        if (!message.guildId) {
          const state = getStateByPlayer(message.author.id);
          if (!state) {
            await reply({ message }, "No active Mafia game found.");
            return;
          }
          await handleDmAction({ message, rest, state });
          return;
        }

        const state = manager.getState({ message });
        if (state && !(await requireSameChannel({ message }, state, manager))) return;

        const raw = String(rest ?? "").trim();
        const cmd = raw.split(/\s+/)[0]?.toLowerCase() || "";
        const args = raw.slice(cmd.length).trim();

        if (!cmd) {
          await startLobby({ message });
          return;
        }

        if (!state) {
          await reply({ message }, manager.noActiveText());
          return;
        }

        if (["start", "resolve", "endday", "end"].includes(cmd)) {
          const ok = await requireCanManage(
            { message },
            state,
            { ownerField: "creatorId", managerLabel: "Mafia", deniedText: "Only the host/admin can do that." }
          );
          if (!ok) return;
        }

        if (cmd === "start") {
          if (state.phase !== "lobby") {
            await reply({ message }, "The game has already started.");
            return;
          }
          await startGame({ message, state });
          return;
        }

        if (cmd === "resolve") {
          if (state.phase !== "night") {
            await reply({ message }, "You can only resolve during night.");
            return;
          }
          await resolveNight({ message, state });
          return;
        }

        if (cmd === "endday") {
          if (state.phase !== "day") {
            await reply({ message }, "You can only end the day during day phase.");
            return;
          }
          await endDay({ message, state });
          return;
        }

        if (cmd === "end") {
          manager.stop({ message });
          activeByGuild.delete(String(state.guildId));
          await reply({ message }, "🛑 Mafia game ended.");
          return;
        }

        if (cmd === "vote") {
          if (state.phase !== "day") {
            await reply({ message }, "You can only vote during the day.");
            return;
          }
          const targetId = parseMentionIdsInOrder(args)[0];
          if (!targetId) {
            await reply({ message }, "Please mention a valid target.");
            return;
          }
          const voter = state.players.get(message.author.id);
          const target = state.players.get(targetId);
          if (!voter?.alive) {
            await reply({ message }, "You are not alive in this game.");
            return;
          }
          if (!target?.alive) {
            await reply({ message }, "That player is not alive.");
            return;
          }
          state.votes.set(message.author.id, targetId);
          await reply({ message }, `${mention(message.author.id)} voted for ${mention(targetId)}.`);
          return;
        }

        if (cmd === "unvote") {
          if (state.phase !== "day") {
            await reply({ message }, "You can only unvote during the day.");
            return;
          }
          state.votes.delete(message.author.id);
          await reply({ message }, `${mention(message.author.id)} removed their vote.`);
          return;
        }

        await reply({ message }, "Unknown command. Try `!mafia help`.");
      },
    }),
    "!mafia — start Mafia lobby or use subcommands",
    { helpTier: "primary", category: "Games" }
  );
}
