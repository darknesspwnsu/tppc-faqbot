// tests/framework.test.js
import { describe, it, expect, vi, beforeEach } from "vitest";

// Mock auth BEFORE importing framework.js
vi.mock("../auth.js", () => ({
  isAdminOrPrivileged: vi.fn(() => false),
}));

// Now import framework after mock is set up
import * as fw from "../games/framework.js";
import { isAdminOrPrivileged } from "../auth.js";

function makeMember({ admin = false, manageGuild = false } = {}) {
  return {
    permissions: {
      has: (flag) => {
        // discord.js flags are numbers/bitfields; framework only checks two flags.
        // We don't need exact numeric values; we just map by "flag identity" by stringifying.
        const s = String(flag);
        if (admin && s.includes("Administrator")) return true;
        if (manageGuild && s.includes("ManageGuild")) return true;
        return admin || manageGuild; // fallback: treat any checked flag as true if enabled
      },
    },
  };
}

function makeMessage({ guildId = "g1", channelId = "c1", authorId = "u1", adminish = false, privileged = false } = {}) {
  // control privileged list via mocked isAdminOrPrivileged
  isAdminOrPrivileged.mockReturnValue(privileged);

  return {
    guildId,
    channelId, // 🔑 REQUIRED — this is what requireSameChannel reads
    channel: { id: channelId, send: vi.fn(async () => ({})) },
    author: { id: authorId },
    member: adminish ? makeMember({ admin: true }) : makeMember({ admin: false }),
    reply: vi.fn(async () => ({})),
  };
}

function makeInteraction({
  guildId = "g1",
  channelId = "c1",
  userId = "u1",
  adminish = false,
  customId = "x",
  messageId = "m1",
} = {}) {
  return {
    guildId,
    channelId,
    user: { id: userId },
    member: adminish ? makeMember({ admin: true }) : makeMember({ admin: false }),
    customId,
    message: { id: messageId },
    isButton: () => true,
    reply: vi.fn(async () => ({})),
  };
}

function makeChannel() {
  return {
    id: "c1",
    send: vi.fn(async (payload) => {
      // emulate discord.js Message-ish return
      const content = typeof payload === "string" ? payload : payload?.content ?? "";
      return { id: "m-posted", content };
    }),
    messages: {
      fetch: vi.fn(async (id) => ({
        id,
        edit: vi.fn(async () => ({})),
        delete: vi.fn(async () => ({})),
      })),
    },
  };
}

function makeClient(channel) {
  return {
    channels: {
      cache: new Map([[channel.id, channel]]),
      fetch: vi.fn(async (id) => (id === channel.id ? channel : null)),
    },
  };
}

function makeButtonInteraction({
  userId = "u1",
  messageId = "m1",
  channelId = "c1",
  guildId = "g1",
} = {}) {
  return {
    isButton: () => true,
    customId: "test",
    user: { id: userId },
    guildId,
    channelId,
    message: { id: messageId },
    reply: vi.fn(async () => {}),
  };
}

describe("framework.js exports", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("mention / channelMention", () => {
    expect(fw.mention("123")).toBe("<@123>");
    expect(fw.channelMention("999")).toBe("<#999>");
  });

  it("parseMentionIdsInOrder", () => {
    expect(fw.parseMentionIdsInOrder("hi <@1> <@!2> <@3>")).toEqual(["1", "2", "3"]);
    expect(fw.parseMentionIdsInOrder("none here")).toEqual([]);
  });

  it("cleanRest", () => {
    expect(fw.cleanRest("  hello  ")).toBe("hello");
    expect(fw.cleanRest(null)).toBe("");
  });

  it("clampInt", () => {
    expect(fw.clampInt("10", 1, 20)).toBe(10);
    expect(fw.clampInt("0", 1, 20)).toBe(null);
    expect(fw.clampInt("21", 1, 20)).toBe(null);
    expect(fw.clampInt("not", 1, 20)).toBe(null);
  });

  it("nowMs returns a number", () => {
    const t = fw.nowMs();
    expect(typeof t).toBe("number");
    expect(t).toBeGreaterThan(0);
  });

  it("shuffleInPlace keeps elements", () => {
    const arr = [1, 2, 3, 4, 5];
    fw.shuffleInPlace(arr);
    expect(arr.slice().sort()).toEqual([1, 2, 3, 4, 5]);
  });

  it("parseDurationSeconds / formatDurationSeconds", () => {
    expect(fw.parseDurationSeconds("30")).toBe(30);
    expect(fw.parseDurationSeconds("10s")).toBe(10);
    expect(fw.parseDurationSeconds("5m")).toBe(300);
    expect(fw.parseDurationSeconds("2h")).toBe(7200);
    expect(fw.parseDurationSeconds("bad")).toBe(null);
    expect(fw.parseDurationSeconds("", 7)).toBe(7);

    expect(fw.formatDurationSeconds(30)).toBe("30s");
    expect(fw.formatDurationSeconds(300)).toBe("300s");
    expect(fw.formatDurationSeconds(7200)).toBe("7200s");
    expect(fw.formatDurationSeconds(3661)).toBe("3661s");
  });

  it("isAdminish", () => {
    expect(fw.isAdminish(null)).toBe(false);
    expect(fw.isAdminish(makeMember({ admin: true }))).toBe(true);
    expect(fw.isAdminish(makeMember({ manageGuild: true }))).toBe(true);
    expect(fw.isAdminish(makeMember({ admin: false, manageGuild: false }))).toBe(false);
  });

  it("isAdminOrPrivilegedMessage uses auth.js", () => {
    const msg = makeMessage({ privileged: true });
    expect(fw.isAdminOrPrivilegedMessage(msg)).toBe(true);

    const msg2 = makeMessage({ privileged: false });
    expect(fw.isAdminOrPrivilegedMessage(msg2)).toBe(false);
  });

  it("canManageCtx: owner always allowed; message uses privileged list; interaction uses adminish", () => {
    const state = { hostId: "host" };

    // owner allowed
    const msgOwner = makeMessage({ authorId: "host", privileged: false, adminish: false });
    expect(fw.canManageCtx({ message: msgOwner }, state, "hostId")).toBe(true);

    // non-owner but privileged on message allowed
    const msgPriv = makeMessage({ authorId: "x", privileged: true, adminish: false });
    expect(fw.canManageCtx({ message: msgPriv }, state, "hostId")).toBe(true);

    // non-owner, not privileged on message: denied
    const msgNo = makeMessage({ authorId: "x", privileged: false, adminish: false });
    expect(fw.canManageCtx({ message: msgNo }, state, "hostId")).toBe(false);

    // interaction path uses isAdminish(member)
    const interAdmin = makeInteraction({ userId: "x", adminish: true });
    expect(fw.canManageCtx({ interaction: interAdmin }, state, "hostId")).toBe(true);

    const interNo = makeInteraction({ userId: "x", adminish: false });
    expect(fw.canManageCtx({ interaction: interNo }, state, "hostId")).toBe(false);
  });

  it("canManageGame convenience wrapper", () => {
    const game = { creatorId: "u1" };
    const msg = makeMessage({ authorId: "u1", privileged: false });
    expect(
      fw.canManageGame(
        { userId: "u1", member: msg.member },
        game,
        "creatorId"
      )
    ).toBe(true);
  });

  it("createGameManager guild-scoped basics", async () => {
    const mgr = fw.createGameManager({ id: "x", prettyName: "X", scope: "guild" });
    const msg = makeMessage({ guildId: "g1" });

    expect(mgr.getState({ message: msg })).toBe(null);
    expect(mgr.isActive({ message: msg })).toBe(false);

    const start = mgr.tryStart({ message: msg }, { guildId: "g1", channelId: "c1", creatorId: "u1" });
    expect(start.ok).toBe(true);
    expect(mgr.isActive({ message: msg })).toBe(true);

    mgr.stop({ message: msg });
    expect(mgr.isActive({ message: msg })).toBe(false);
  });

  it("createGameManager global scope basics", () => {
    const mgr = fw.createGameManager({ id: "x", scope: "global" });
    const msgA = makeMessage({ guildId: "g1" });
    const msgB = makeMessage({ guildId: "g2" });

    mgr.tryStart({ message: msgA }, { hello: 1 });
    expect(mgr.isActive({ message: msgB })).toBe(true); // same global slot
    mgr.stop({ message: msgB });
    expect(mgr.isActive({ message: msgA })).toBe(false);
  });

  it("createBoard: post/update/delete happy path", async () => {
    const channel = makeChannel();
    const client = makeClient(channel);

    const state = { client, channelId: channel.id, messageId: null };
    const board = fw.createBoard(state);

    const msg = await board.post(channel, { content: "hello", components: [] });
    expect(msg.id).toBe("m-posted");
    expect(state.messageId).toBe("m-posted");

    const okUpdate = await board.update({ content: "edit", components: [] });
    expect(okUpdate).toBe(true);

    await board.end({ content: "done" });
  });

  it("withQoLSubcommands routes help/rules/start only", async () => {
    const calls = [];

    const handler = fw.withQoLSubcommands({
      helpText: "HELP",
      rulesText: "RULES",
      onStart: async () => calls.push("start"),
    });

    const msg = makeMessage();
    msg.reply = vi.fn(async (t) => calls.push(typeof t === "string" ? t : t.content));

    await handler({ message: msg, rest: "help" });
    await handler({ message: msg, rest: "rules" });
    await handler({ message: msg, rest: "" });

    expect(calls).toContain("HELP");
    expect(calls).toContain("RULES");
    expect(calls).toContain("start");
  });

  it("withGameSubcommands routes start/help/rules/status", async () => {
    const calls = [];
    const handler = fw.withGameSubcommands({
      helpText: "HELP",
      rulesText: "RULES",
      onStart: async () => calls.push("start"),
      onStatus: async () => calls.push("status"),
    });

    const msg = makeMessage();
    msg.reply = vi.fn(async (t) => calls.push(typeof t === "string" ? t : t.content));

    await handler({ message: msg, rest: "help" });
    await handler({ message: msg, rest: "rules" });
    await handler({ message: msg, rest: "status" });
    await handler({ message: msg, rest: "" });

    expect(calls).toContain("HELP");
    expect(calls).toContain("RULES");
    expect(calls).toContain("status");
    expect(calls).toContain("start");
  });

  it("makeGameQoL registers expected commands", async () => {
    const registered = [];

    // tiny fake register() that captures command strings + handlers
    const register = (cmd, fn, _help, _opts) => registered.push({ cmd, fn });

    const mgr = fw.createGameManager({ id: "x", prettyName: "X", scope: "guild" });
    fw.makeGameQoL(register, {
      manager: mgr,
      id: "x",
      prettyName: "X",
      helpText: "HELP",
      rulesText: "RULES",
      renderStatus: () => "STATUS",
      cancel: async () => {},
      end: async () => {},
    });

    const cmds = registered.map((r) => r.cmd).sort();
    // includes dual forms per your standard:
    expect(cmds).toContain("!xhelp");
    expect(cmds).toContain("!xrules");
    expect(cmds).toContain("!xstatus");
    expect(cmds).toContain("!cancelx");
    expect(cmds).toContain("!endx");

    // sanity: calling the help handler replies
    const help = registered.find((r) => r.cmd === "!xhelp");
    const msg = makeMessage();
    msg.reply = vi.fn(async (t) => t);
    await help.fn({ message: msg });
    expect(msg.reply).toHaveBeenCalled();
  });

  it("alreadyRunningText / noActiveText", () => {
    const mgr = fw.createGameManager({ id: "x", prettyName: "Test", scope: "guild" });

    expect(typeof mgr.noActiveText()).toBe("string");
    expect(typeof mgr.alreadyRunningText({ channelId: "c1" })).toBe("string");
  });

  it("requireActive replies when no game is active", async () => {
    const mgr = fw.createGameManager({ id: "x", scope: "guild" });
    const msg = makeMessage();

    const result = await fw.requireActive({ message: msg }, mgr);
    expect(result).toBe(null);
    expect(msg.reply).toHaveBeenCalled();
  });

  it("requireSameChannel rejects wrong channel", async () => {
    const mgr = fw.createGameManager({ id: "x", scope: "guild" });

    const msg = makeMessage({ channelId: "c2" });
    const game = { channelId: "c1" };

    const ok = await fw.requireSameChannel({ message: msg }, game, mgr);
    expect(ok).toBe(false);
    expect(msg.reply).toHaveBeenCalled();
  });

  it("guardBoardInteraction rejects when no active game", async () => {
    const mgr = fw.createGameManager({ id: "x", scope: "guild" });
    const i = makeButtonInteraction();

    const res = await fw.guardBoardInteraction(i, {
      manager: mgr,
      messageIdField: "messageId",
    });

    expect(res).toBe(null);
  });

  it("guardBoardInteraction rejects wrong messageId", async () => {
    const mgr = fw.createGameManager({ id: "x", scope: "guild" });

    mgr.tryStart(
      { guildId: "g1" },
      { guildId: "g1", messageId: "other" }
    );

    const i = makeButtonInteraction({ messageId: "m1" });

    const res = await fw.guardBoardInteraction(i, {
      manager: mgr,
      messageIdField: "messageId",
    });

    expect(res).toBe(null);
  });

  it("guardBoardInteraction allows correct interaction", async () => {
    const mgr = fw.createGameManager({ id: "x", scope: "guild" });

    mgr.tryStart(
      { guildId: "g1" },
      { guildId: "g1", messageId: "m1" }
    );

    const i = makeButtonInteraction({ messageId: "m1" });

    const res = await fw.guardBoardInteraction(i, {
      manager: mgr,
      messageIdField: "messageId",
    });

    expect(res).not.toBe(null);
    expect(res.state).toBeTruthy();
  });

  it("createGameManager rejects duplicate start", () => {
    const mgr = fw.createGameManager({ id: "x", scope: "guild" });

    const msg = makeMessage({ guildId: "g1" });
    mgr.tryStart({ message: msg }, { guildId: "g1" });

    const res = mgr.tryStart({ message: msg }, { guildId: "g1" });
    expect(res.ok).toBe(false);
  });

  it("createGameManager.stop is safe when nothing active", () => {
    const mgr = fw.createGameManager({ id: "x", scope: "guild" });
    expect(() => mgr.stop({ guildId: "g1" })).not.toThrow();
  });

it("makeGameQoL cancel and end handlers execute", async () => {
  const registered = [];
  const register = (cmd, fn) => registered.push({ cmd, fn });

  const mgr = fw.createGameManager({ id: "x", scope: "guild" });

  const cancelFn = vi.fn(async () => {});
  const endFn = vi.fn(async () => {});

  fw.makeGameQoL(register, {
    manager: mgr,
    id: "x",
    prettyName: "X",
    helpText: "HELP",
    rulesText: "RULES",
    renderStatus: () => "STATUS",
    cancel: cancelFn,
    end: endFn,
  });

  mgr.tryStart(
    { guildId: "g1", channelId: "c1" },
    {
      guildId: "g1",
      channelId: "c1",
      creatorId: "u1",
    }
  );

  const cancel = registered.find(r => r.cmd === "!cancelx");
  const end = registered.find(r => r.cmd === "!endx");

  expect(cancel).toBeTruthy();
  expect(end).toBeTruthy();

  const msg = makeMessage({
    guildId: "g1",
    channelId: "c1",
    authorId: "u1",
    privileged: true, // 🔑 REQUIRED
  });

  await cancel.fn({ message: msg });
  await end.fn({ message: msg });

  expect(cancelFn).toHaveBeenCalledTimes(1);
  expect(endFn).toHaveBeenCalledTimes(1);
});


  it("withGameSubcommands unknown subcommand falls through to start", async () => {
    const calls = [];
    const handler = fw.withGameSubcommands({
      helpText: "HELP",
      rulesText: "RULES",
      onStart: async () => calls.push("start"),
    });

    const msg = makeMessage();
    await handler({ message: msg, rest: "unknown" });

    expect(calls).toContain("start");
  });

});
