import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({ execute: vi.fn() }));
vi.mock("../../db.js", () => ({ getDb: () => ({ execute: mocks.execute }) }));
vi.mock("../../auth.js", () => ({ isAdminOrPrivileged: () => true }));

import { registerTrivia } from "../../tools/trivia.js";

describe("trivia answer locking", () => {
  let command;
  let answer;
  let channel;
  let resultMessage;

  beforeEach(() => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-10-17T12:00:00Z"));
    mocks.execute.mockReset().mockImplementation(async (sql, params) => {
      if (sql.includes("SELECT guild_id")) {
        return [[{ guild_id: params[0], channel_id: "channel", duration_seconds: 30,
          category: "pokemon", difficulty: "easy" }]];
      }
      return [{ affectedRows: 1 }];
    });
    resultMessage = { edit: vi.fn(async () => {}) };
    channel = { isTextBased: () => true, send: vi.fn(async () => resultMessage) };
    registerTrivia({
      listener: () => {},
      component: (_prefix, handler) => { answer = handler; },
      expose: ({ handler }) => { command = handler; },
    });
  });

  afterEach(async () => {
    await vi.runOnlyPendingTimersAsync();
    vi.clearAllTimers();
    vi.useRealTimers();
    vi.restoreAllMocks();
  });

  async function startRound(guildId = "guild", difficulty = "easy") {
    await command({
      message: { guildId, channelId: "channel", author: { id: "host" }, reply: vi.fn(),
        client: { channels: { fetch: vi.fn(async () => channel) } } },
      rest: `run now pokemon ${difficulty}`, cmd: "!trivia",
    });
    return channel.send.mock.lastCall[0].components[0].components
      .map((button) => button.data.custom_id);
  }

  function click(customId, userId = "user", guildId = "guild", reply = vi.fn(async () => {})) {
    return { interaction: { customId, guildId, user: { id: userId, username: userId },
      isButton: () => true, reply } };
  }

  it("locks the first answer even when two different clicks arrive together", async () => {
    const buttons = await startRound();
    const first = click(buttons[0]);
    const second = click(buttons[1]);
    await Promise.all([answer(first), answer(second)]);
    expect(first.interaction.reply.mock.lastCall[0].content).toContain("Answer recorded: **A**. Your answer is final.");
    expect(second.interaction.reply.mock.lastCall[0].content).toContain("Your answer is locked: **A**");
    expect(first.interaction.reply.mock.lastCall[0].flags).toBe(64);
    expect(second.interaction.reply.mock.lastCall[0].flags).toBe(64);

    await vi.advanceTimersByTimeAsync(30_000);
    const result = resultMessage.edit.mock.lastCall[0];
    const firstWasCorrect = result.components[0].components[0].data.style === 3;
    expect(result.content).toContain("Responses: **1**");
    expect(result.content.includes("<@user>")).toBe(firstWasCorrect);
  });

  it("rejects repeated clicks while allowing another participant and another guild", async () => {
    const buttons = await startRound();
    await answer(click(buttons[0]));
    const repeat = click(buttons[0]);
    await answer(repeat);
    expect(repeat.interaction.reply.mock.lastCall[0].content).toContain("locked: **A**");
    const otherUser = click(buttons[1], "other");
    await answer(otherUser);
    expect(otherUser.interaction.reply.mock.lastCall[0].content).toContain("Answer recorded: **B**");
    const otherGuildButtons = await startRound("other-guild");
    const otherGuild = click(otherGuildButtons[2], "user", "other-guild");
    await answer(otherGuild);
    expect(otherGuild.interaction.reply.mock.lastCall[0].content).toContain("Answer recorded: **C**");
  });

  it("rejects old buttons and answers at the deadline", async () => {
    const buttons = await startRound();
    const stale = click("trivia:answer:old-round:0");
    await answer(stale);
    expect(stale.interaction.reply.mock.lastCall[0].content).toContain("has ended");
    vi.setSystemTime(Date.now() + 30_000);
    const late = click(buttons[0]);
    await answer(late);
    expect(late.interaction.reply.mock.lastCall[0].content).toContain("has ended");
  });

  it("initializes new servers with a 30-second window and documents the rules", async () => {
    const reply = vi.fn(async () => {});
    await command({ message: { guildId: "new-guild", channelId: "channel", reply }, rest: "status", cmd: "!trivia" });
    const insert = mocks.execute.mock.calls.find(([sql]) => sql.includes("INSERT INTO trivia_settings"));
    expect(insert[1][3]).toBe(30);
    await command({ message: { guildId: "guild", reply }, rest: "help", cmd: "!trivia" });
    expect(reply.mock.lastCall[0]).toContain("Your first answer is final. The default answer window is 30 seconds.");
  });

  it("remembers twenty posted questions per guild independently", async () => {
    vi.spyOn(Math, "random").mockReturnValue(0.5);
    for (const difficulty of ["easy", "hard"]) {
      const posted = [];
      for (let round = 0; round < 21; round += 1) {
        await startRound(`variety-guild-${difficulty}`, difficulty);
        const question = channel.send.mock.lastCall[0].content.split("\n")[1];
        expect(posted.slice(-20)).not.toContain(question);
        posted.push(question);
        await vi.advanceTimersByTimeAsync(30_000);
      }
      await startRound(`independent-guild-${difficulty}`, difficulty);
      expect(channel.send.mock.lastCall[0].content.split("\n")[1]).toBe(posted[0]);
    }
  });
});
