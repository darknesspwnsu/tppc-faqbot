import { beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  getDb: vi.fn(),
  isAdminOrPrivileged: vi.fn(() => true),
  sendDm: vi.fn(async () => ({ ok: true })),
  registerScheduler: vi.fn(),
  startTimeout: vi.fn(({ fn }) => {
    const t = setTimeout(fn, 0);
    t.unref = () => {};
    return t;
  }),
  clearTimer: vi.fn((timer) => {
    if (timer) clearTimeout(timer);
  }),
  getVerifiedRoleIds: vi.fn(() => ["role1"]),
  parseSecondsToMs: vi.fn((raw) => {
    const s = String(raw || "").trim().toLowerCase();
    const m = /^(\d+)\s*s$/.exec(s);
    if (!m) return { error: "Delay must be specified in seconds, e.g. `2s` (1s–30s)." };
    const seconds = Number(m[1]);
    if (seconds < 1) return { error: "Delay must be at least 1 second." };
    if (seconds > 30) return { error: "Delay cannot exceed 30 seconds." };
    return { ms: seconds * 1000, seconds };
  }),
}));

vi.mock("../../db.js", () => ({ getDb: mocks.getDb }));
vi.mock("../../auth.js", () => ({ isAdminOrPrivileged: mocks.isAdminOrPrivileged }));
vi.mock("../../shared/dm.js", () => ({ sendDm: mocks.sendDm }));
vi.mock("../../shared/scheduler_registry.js", () => ({ registerScheduler: mocks.registerScheduler }));
vi.mock("../../shared/timer_utils.js", () => ({
  startTimeout: mocks.startTimeout,
  clearTimer: mocks.clearTimer,
}));
vi.mock("../../contests/eligibility.js", () => ({ getVerifiedRoleIds: mocks.getVerifiedRoleIds }));
vi.mock("../../contests/rng.js", () => ({ parseSecondsToMs: mocks.parseSecondsToMs }));

import {
  registerScheduledCommands,
  registerScheduledCommandsScheduler,
  __testables,
} from "../../contests/scheduled_commands.js";

function makeRegister() {
  const calls = { slash: [], listener: [] };
  return {
    slash: (config, handler, opts) => calls.slash.push({ config, handler, opts }),
    listener: (handler) => calls.listener.push(handler),
    calls,
  };
}

function makeInteraction({
  sub = "create",
  time = "5m",
  command = "!roll 1d100",
  scheduleId = "1",
  guildId = "g1",
  channelId = "c1",
  dispatchResult = { ok: true, canonicalCmd: "!roll", exposeLogicalId: "rng.roll" },
} = {}) {
  return {
    guildId,
    channelId,
    guild: {
      id: guildId,
      members: {
        fetch: vi.fn(async () => ({ id: "member1" })),
      },
    },
    channel: {
      id: channelId,
      isTextBased: () => true,
      send: vi.fn(async () => ({})),
    },
    member: { id: "member1", permissions: { has: vi.fn(() => true) } },
    user: { id: "u1" },
    options: {
      getSubcommand: () => sub,
      getString: (key) => {
        if (key === "time") return time;
        if (key === "command") return command;
        if (key === "schedule_id") return scheduleId;
        return null;
      },
    },
    client: {
      spectreonCommandRegistry: {
        dispatchMessage: vi.fn(async () => dispatchResult),
      },
      guilds: { cache: new Map(), fetch: vi.fn() },
      channels: { cache: new Map(), fetch: vi.fn() },
      users: { fetch: vi.fn(async () => ({ id: "u1" })) },
    },
    reply: vi.fn(async () => {}),
  };
}

describe("contests/scheduled_commands", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    __testables.resetState();
  });

  it("creates a schedule for an allowed command", async () => {
    const execute = vi.fn(async (sql) => {
      if (sql.includes("INSERT INTO scheduled_contest_commands")) return [{ insertId: 42 }];
      return [[]];
    });
    mocks.getDb.mockReturnValue({ execute });
    mocks.isAdminOrPrivileged.mockReturnValue(true);

    const register = makeRegister();
    registerScheduledCommands(register);
    const scheduleSlash = register.calls.slash.find((c) => c.config.name === "schedule");

    const interaction = makeInteraction();
    await scheduleSlash.handler({ interaction });

    expect(interaction.client.spectreonCommandRegistry.dispatchMessage).toHaveBeenCalledTimes(1);
    expect(interaction.client.spectreonCommandRegistry.dispatchMessage.mock.calls[0][0]).toMatchObject({
      __dryRun: true,
      content: "!roll 1d100",
    });
    expect(execute).toHaveBeenCalledWith(
      expect.stringContaining("INSERT INTO scheduled_contest_commands"),
      ["g1", "c1", "u1", "!roll 1d100", expect.any(Number)]
    );
    expect(interaction.reply).toHaveBeenCalledWith(
      expect.objectContaining({
        content: expect.stringContaining("Scheduled command **#42**"),
        flags: 64,
      })
    );
  });

  it("rejects non-admin users", async () => {
    const execute = vi.fn(async () => [[]]);
    mocks.getDb.mockReturnValue({ execute });
    mocks.isAdminOrPrivileged.mockReturnValue(false);

    const register = makeRegister();
    registerScheduledCommands(register);
    const scheduleSlash = register.calls.slash.find((c) => c.config.name === "schedule");

    const interaction = makeInteraction();
    await scheduleSlash.handler({ interaction });

    expect(interaction.reply).toHaveBeenCalledWith(
      expect.objectContaining({
        content: "❌ You do not have permission to use this command.",
      })
    );
    expect(execute).not.toHaveBeenCalledWith(
      expect.stringContaining("INSERT INTO scheduled_contest_commands"),
      expect.anything()
    );
  });

  it("rejects commands outside the hard allowlist", async () => {
    const execute = vi.fn(async () => [[]]);
    mocks.getDb.mockReturnValue({ execute });
    mocks.isAdminOrPrivileged.mockReturnValue(true);

    const register = makeRegister();
    registerScheduledCommands(register);
    const scheduleSlash = register.calls.slash.find((c) => c.config.name === "schedule");

    const interaction = makeInteraction({
      command: "!customlb list",
      dispatchResult: { ok: true, canonicalCmd: "!customlb", exposeLogicalId: null },
    });
    await scheduleSlash.handler({ interaction });

    expect(interaction.reply).toHaveBeenCalledWith(
      expect.objectContaining({
        content: "❌ That command is not allowed by `/schedule`.",
        flags: 64,
      })
    );
    expect(execute).not.toHaveBeenCalledWith(
      expect.stringContaining("INSERT INTO scheduled_contest_commands"),
      expect.anything()
    );
  });

  it("enforces strict RNG argument validation at schedule time", async () => {
    const execute = vi.fn(async () => [[]]);
    mocks.getDb.mockReturnValue({ execute });
    mocks.isAdminOrPrivileged.mockReturnValue(true);

    const register = makeRegister();
    registerScheduledCommands(register);
    const scheduleSlash = register.calls.slash.find((c) => c.config.name === "schedule");

    const interaction = makeInteraction({
      command: "!roll bad",
      dispatchResult: { ok: true, canonicalCmd: "!roll", exposeLogicalId: "rng.roll" },
    });
    await scheduleSlash.handler({ interaction });

    expect(interaction.reply).toHaveBeenCalledWith(
      expect.objectContaining({
        content: expect.stringContaining("Invalid roll format"),
        flags: 64,
      })
    );
    expect(execute).not.toHaveBeenCalledWith(
      expect.stringContaining("INSERT INTO scheduled_contest_commands"),
      expect.anything()
    );
  });

  it("lists pending schedules", async () => {
    const execute = vi.fn(async (sql) => {
      if (sql.includes("FROM scheduled_contest_commands")) {
        return [[
          {
            id: 7,
            guild_id: "g1",
            channel_id: "c1",
            creator_user_id: "u2",
            command_text: "!roll 1d100",
            execute_at_ms: Date.now() + 60_000,
            created_at: "2026-01-01T00:00:00Z",
          },
        ]];
      }
      return [[]];
    });
    mocks.getDb.mockReturnValue({ execute });
    mocks.isAdminOrPrivileged.mockReturnValue(true);

    const register = makeRegister();
    registerScheduledCommands(register);
    const scheduleSlash = register.calls.slash.find((c) => c.config.name === "schedule");

    const interaction = makeInteraction({ sub: "list" });
    await scheduleSlash.handler({ interaction });

    expect(interaction.reply).toHaveBeenCalledWith(
      expect.objectContaining({
        content: expect.stringContaining("Scheduled commands (1):"),
        flags: 64,
      })
    );
  });

  it("cancels an existing schedule by id", async () => {
    const execute = vi.fn(async (sql) => {
      if (sql.includes("WHERE guild_id = ? AND id = ?") && sql.includes("LIMIT 1")) {
        return [[
          {
            id: 9,
            guild_id: "g1",
            channel_id: "c1",
            creator_user_id: "u1",
            command_text: "!roll 1d100",
            execute_at_ms: Date.now() + 60_000,
            created_at: "2026-01-01T00:00:00Z",
          },
        ]];
      }
      if (sql.includes("DELETE FROM scheduled_contest_commands")) return [{ affectedRows: 1 }];
      return [[]];
    });
    mocks.getDb.mockReturnValue({ execute });
    mocks.isAdminOrPrivileged.mockReturnValue(true);

    const register = makeRegister();
    registerScheduledCommands(register);
    const scheduleSlash = register.calls.slash.find((c) => c.config.name === "schedule");

    const interaction = makeInteraction({ sub: "cancel", scheduleId: "9" });
    await scheduleSlash.handler({ interaction });

    expect(interaction.reply).toHaveBeenCalledWith(
      expect.objectContaining({
        content: "✅ Cancelled scheduled command #9.",
        flags: 64,
      })
    );
    expect(execute).toHaveBeenCalledWith(
      expect.stringContaining("DELETE FROM scheduled_contest_commands"),
      ["g1", 9]
    );
  });

  it("runtime re-check failures DM the job creator", async () => {
    const now = Date.now() - 1_000;
    const execute = vi.fn(async (sql) => {
      if (sql.includes("FROM scheduled_contest_commands")) {
        return [[
          {
            id: 33,
            guild_id: "g1",
            channel_id: "c1",
            creator_user_id: "u1",
            command_text: "!roll 1d100",
            execute_at_ms: now,
            created_at: "2026-01-01T00:00:00Z",
          },
        ]];
      }
      if (sql.includes("DELETE FROM scheduled_contest_commands")) return [{ affectedRows: 1 }];
      return [[]];
    });
    mocks.getDb.mockReturnValue({ execute });
    mocks.isAdminOrPrivileged.mockReturnValue(false);

    const guild = {
      id: "g1",
      members: { fetch: vi.fn(async () => ({ id: "member1" })) },
    };
    const channel = {
      id: "c1",
      isTextBased: () => true,
      send: vi.fn(async () => ({})),
    };
    const client = {
      spectreonCommandRegistry: {
        dispatchMessage: vi.fn(async () => ({ ok: true, canonicalCmd: "!roll", exposeLogicalId: "rng.roll" })),
      },
      guilds: { cache: { get: vi.fn(() => guild) }, fetch: vi.fn(async () => guild) },
      channels: { cache: { get: vi.fn(() => channel) }, fetch: vi.fn(async () => channel) },
      users: { fetch: vi.fn(async () => ({ id: "u1" })) },
    };

    registerScheduledCommandsScheduler({});
    expect(mocks.registerScheduler).toHaveBeenCalledTimes(1);
    const start = mocks.registerScheduler.mock.calls[0][1];
    start({ client });

    await new Promise((resolve) => setTimeout(resolve, 10));
    await Promise.resolve();

    expect(mocks.sendDm).toHaveBeenCalledTimes(1);
    expect(mocks.sendDm.mock.calls[0][0]).toMatchObject({
      feature: "schedule",
    });
  });

  it("shows help text for /schedule help", async () => {
    const execute = vi.fn(async () => [[]]);
    mocks.getDb.mockReturnValue({ execute });
    mocks.isAdminOrPrivileged.mockReturnValue(true);

    const register = makeRegister();
    registerScheduledCommands(register);
    const scheduleSlash = register.calls.slash.find((c) => c.config.name === "schedule");

    const interaction = makeInteraction({ sub: "help" });
    await scheduleSlash.handler({ interaction });

    expect(interaction.reply).toHaveBeenCalledWith(
      expect.objectContaining({
        content: expect.stringContaining("**/schedule help**"),
        flags: 64,
      })
    );
    expect(interaction.reply).toHaveBeenCalledWith(
      expect.objectContaining({
        content: expect.stringContaining("`!/?roll`, `!/?choose`, `!/?elim`, `!/?awesome`"),
      })
    );
  });
});
