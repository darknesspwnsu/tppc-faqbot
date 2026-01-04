import { beforeEach, describe, expect, it, vi } from "vitest";

const dbMocks = vi.hoisted(() => ({
  getDb: vi.fn(),
}));

vi.mock("../../db.js", () => dbMocks);
vi.mock("../../shared/metrics.js", () => ({ metrics: { increment: vi.fn(), incrementExternalFetch: vi.fn(), incrementSchedulerRun: vi.fn() } }));

import { registerReminders, __testables } from "../../tools/reminders.js";

function makeRegister() {
  const calls = { slash: [], listener: [] };
  return {
    slash: (config, handler, opts) => calls.slash.push({ config, handler, opts }),
    listener: (handler) => calls.listener.push(handler),
    calls,
  };
}

function makeInteraction({
  guildId = "g1",
  channelId = "c1",
  sub,
  phrase,
  messageId,
  time,
  userId = "u1",
  isAdmin = false,
} = {}) {
  const permissions = isAdmin ? { has: vi.fn(() => true) } : { has: vi.fn(() => false) };
  return {
    guildId,
    channelId,
    member: { permissions },
    user: {
      id: userId,
      send: vi.fn(async () => {}),
    },
    options: {
      getSubcommand: () => sub,
      getString: (key) => {
        if (key === "phrase") return phrase;
        if (key === "message_id") return messageId;
        if (key === "time") return time;
        if (key === "notify_id") return phrase;
        if (key === "reminder_id") return phrase;
        return null;
      },
      getFocused: () => phrase || "",
    },
    reply: vi.fn(async () => {}),
    respond: vi.fn(async () => {}),
    client: {
      users: { fetch: vi.fn(async () => ({ send: vi.fn(async () => {}) })) },
      guilds: { cache: { has: vi.fn(() => true) } },
    },
  };
}

describe("tools/reminders", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    __testables.resetState();
  });

  it("sets a notifyme phrase", async () => {
    const execute = vi.fn(async (sql) => {
      if (sql.includes("SELECT id, user_id, phrase FROM notify_me")) return [[]];
      if (sql.includes("INSERT INTO notify_me")) return [{ insertId: 10 }];
      return [[]];
    });
    dbMocks.getDb.mockReturnValue({ execute });

    const register = makeRegister();
    registerReminders(register);
    const notifySlash = register.calls.slash.find((c) => c.config.name === "notifyme");

    const interaction = makeInteraction({ sub: "set", phrase: "hello" });
    await notifySlash.handler({ interaction });

    expect(interaction.reply).toHaveBeenCalledWith(
      expect.objectContaining({ content: "✅ I’ll notify you when I see: \"hello\"" })
    );
    expect(execute).toHaveBeenCalledWith(
      expect.stringContaining("INSERT INTO notify_me"),
      ["g1", "u1", "hello"]
    );
  });

  it("rejects notifyme when DMs are closed", async () => {
    const execute = vi.fn(async () => [[]]);
    dbMocks.getDb.mockReturnValue({ execute });

    const register = makeRegister();
    registerReminders(register);
    const notifySlash = register.calls.slash.find((c) => c.config.name === "notifyme");

    const interaction = makeInteraction({ sub: "set", phrase: "hello" });
    interaction.user.send.mockRejectedValue({ code: 50007 });
    await notifySlash.handler({ interaction });

    expect(interaction.reply).toHaveBeenCalledWith(
      expect.objectContaining({ content: expect.stringContaining("couldn’t DM you") })
    );
    expect(execute).not.toHaveBeenCalledWith(expect.stringContaining("INSERT INTO notify_me"), expect.anything());
  });

  it("lists notifyme phrases", async () => {
    const execute = vi.fn(async (sql) => {
      if (sql.includes("SELECT id, phrase, created_at FROM notify_me")) {
        return [[{ id: 1, phrase: "alpha", created_at: "2025-01-01T00:00:00Z" }]];
      }
      return [[]];
    });
    dbMocks.getDb.mockReturnValue({ execute });

    const register = makeRegister();
    registerReminders(register);
    const notifySlash = register.calls.slash.find((c) => c.config.name === "notifyme");

    const interaction = makeInteraction({ sub: "list" });
    await notifySlash.handler({ interaction });

    expect(interaction.reply).toHaveBeenCalledWith(
      expect.objectContaining({ content: expect.stringContaining("alpha") })
    );
  });

  it("rejects notifyme duplicates", async () => {
    const execute = vi.fn(async (sql) => {
      if (sql.includes("SELECT id, user_id, phrase FROM notify_me")) {
        return [[{ id: 5, user_id: "u1", phrase: "Hello" }]];
      }
      return [[]];
    });
    dbMocks.getDb.mockReturnValue({ execute });

    const register = makeRegister();
    registerReminders(register);
    const notifySlash = register.calls.slash.find((c) => c.config.name === "notifyme");

    const interaction = makeInteraction({ sub: "set", phrase: "hello" });
    await notifySlash.handler({ interaction });

    expect(interaction.reply).toHaveBeenCalledWith(
      expect.objectContaining({ content: expect.stringContaining("already watching") })
    );
    expect(execute).not.toHaveBeenCalledWith(expect.stringContaining("INSERT INTO notify_me"), expect.anything());
  });

  it("enforces notifyme limit", async () => {
    const execute = vi.fn(async (sql) => {
      if (sql.includes("SELECT id, user_id, phrase FROM notify_me")) {
        return [[
          { id: 1, user_id: "u1", phrase: "a" },
          { id: 2, user_id: "u1", phrase: "b" },
          { id: 3, user_id: "u1", phrase: "c" },
          { id: 4, user_id: "u1", phrase: "d" },
          { id: 5, user_id: "u1", phrase: "e" },
        ]];
      }
      if (sql.includes("SELECT COUNT(*) AS total FROM notify_me")) return [[{ total: 10 }]];
      return [[]];
    });
    dbMocks.getDb.mockReturnValue({ execute });

    const register = makeRegister();
    registerReminders(register);
    const notifySlash = register.calls.slash.find((c) => c.config.name === "notifyme");

    const interaction = makeInteraction({ sub: "set", phrase: "hello" });
    await notifySlash.handler({ interaction });

    expect(interaction.reply).toHaveBeenCalledWith(
      expect.objectContaining({ content: expect.stringContaining("only have 10 notifications") })
    );
    expect(execute).not.toHaveBeenCalledWith(expect.stringContaining("INSERT INTO notify_me"), expect.anything());
  });

  it("allows notifyme over limit for admins", async () => {
    const execute = vi.fn(async (sql) => {
      if (sql.includes("SELECT id, user_id, phrase FROM notify_me")) {
        return [[
          { id: 1, user_id: "u1", phrase: "a" },
          { id: 2, user_id: "u1", phrase: "b" },
          { id: 3, user_id: "u1", phrase: "c" },
          { id: 4, user_id: "u1", phrase: "d" },
          { id: 5, user_id: "u1", phrase: "e" },
        ]];
      }
      if (sql.includes("SELECT COUNT(*) AS total FROM notify_me")) return [[{ total: 10 }]];
      if (sql.includes("INSERT INTO notify_me")) return [{ insertId: 11 }];
      return [[]];
    });
    dbMocks.getDb.mockReturnValue({ execute });

    const register = makeRegister();
    registerReminders(register);
    const notifySlash = register.calls.slash.find((c) => c.config.name === "notifyme");

    const interaction = makeInteraction({ sub: "set", phrase: "hello", isAdmin: true });
    await notifySlash.handler({ interaction });

    expect(interaction.reply).toHaveBeenCalledWith(
      expect.objectContaining({ content: expect.stringContaining("I’ll notify you") })
    );
    expect(execute).toHaveBeenCalledWith(
      expect.stringContaining("INSERT INTO notify_me"),
      ["g1", "u1", "hello"]
    );
  });

  it("responds with notifyme autocomplete options", async () => {
    const execute = vi.fn(async (sql) => {
      if (sql.includes("SELECT id, user_id, phrase FROM notify_me")) {
        return [[{ id: 2, user_id: "u1", phrase: "beta" }]];
      }
      return [[]];
    });
    dbMocks.getDb.mockReturnValue({ execute });

    const register = makeRegister();
    registerReminders(register);
    const notifySlash = register.calls.slash.find((c) => c.config.name === "notifyme");

    const interaction = makeInteraction({ sub: "unset", phrase: "b" });
    await notifySlash.opts.autocomplete({ interaction });

    expect(interaction.respond).toHaveBeenCalledWith([{ name: "beta", value: "2" }]);
  });

  it("notifies on matching phrases", async () => {
    const execute = vi.fn(async (sql) => {
      if (sql.includes("SELECT id, user_id, phrase FROM notify_me")) {
        return [[{ id: 3, user_id: "u1", phrase: "magic" }]];
      }
      return [[]];
    });
    dbMocks.getDb.mockReturnValue({ execute });

    const register = makeRegister();
    registerReminders(register);
    const listener = register.calls.listener[0];

    const send = vi.fn(async () => {});
    const message = {
      guildId: "g1",
      channelId: "c1",
      id: "m1",
      content: "hello magic there",
      author: { id: "u2", bot: false },
      client: { users: { fetch: vi.fn(async () => ({ send })) } },
    };

    await listener({ message });
    expect(send).toHaveBeenCalledWith(expect.stringContaining("/notifyme unset"));
  });

  it("rejects remindme set with invalid input", async () => {
    const execute = vi.fn(async () => [[]]);
    dbMocks.getDb.mockReturnValue({ execute });

    const register = makeRegister();
    registerReminders(register);
    const remindSlash = register.calls.slash.find((c) => c.config.name === "remindme");

    const interaction = makeInteraction({ sub: "set", phrase: "hi", messageId: "123", time: "10m" });
    await remindSlash.handler({ interaction });

    expect(interaction.reply).toHaveBeenCalledWith(
      expect.objectContaining({ content: expect.stringContaining("exactly one") })
    );
  });

  it("rejects remindme when DMs are closed", async () => {
    const execute = vi.fn(async () => [[]]);
    dbMocks.getDb.mockReturnValue({ execute });

    const register = makeRegister();
    registerReminders(register);
    const remindSlash = register.calls.slash.find((c) => c.config.name === "remindme");

    const interaction = makeInteraction({ sub: "set", phrase: "hi", time: "10m" });
    interaction.user.send.mockRejectedValue({ code: 50007 });
    await remindSlash.handler({ interaction });

    expect(interaction.reply).toHaveBeenCalledWith(
      expect.objectContaining({ content: expect.stringContaining("couldn’t DM you") })
    );
    expect(execute).not.toHaveBeenCalledWith(expect.stringContaining("INSERT INTO reminders"), expect.anything());
  });

  it("rejects remindme with invalid message id", async () => {
    const execute = vi.fn(async () => [[]]);
    dbMocks.getDb.mockReturnValue({ execute });

    const register = makeRegister();
    registerReminders(register);
    const remindSlash = register.calls.slash.find((c) => c.config.name === "remindme");

    const interaction = makeInteraction({ sub: "set", messageId: "abc", time: "10m" });
    await remindSlash.handler({ interaction });

    expect(interaction.reply).toHaveBeenCalledWith(
      expect.objectContaining({ content: expect.stringContaining("valid numeric message ID") })
    );
  });

  it("rejects remindme over 1 year", async () => {
    const execute = vi.fn(async () => [[]]);
    dbMocks.getDb.mockReturnValue({ execute });

    const register = makeRegister();
    registerReminders(register);
    const remindSlash = register.calls.slash.find((c) => c.config.name === "remindme");

    const interaction = makeInteraction({ sub: "set", phrase: "ping", time: "2y" });
    await remindSlash.handler({ interaction });

    expect(interaction.reply).toHaveBeenCalledWith(
      expect.objectContaining({ content: expect.stringContaining("cannot exceed 1 year") })
    );
  });

  it("sets a remindme phrase and schedules it", async () => {
    const execute = vi.fn(async (sql) => {
      if (sql.includes("SELECT id, phrase, message_id, channel_id")) return [[]];
      if (sql.includes("INSERT INTO reminders")) return [{ insertId: 5 }];
      return [[]];
    });
    dbMocks.getDb.mockReturnValue({ execute });

    const register = makeRegister();
    registerReminders(register);
    const remindSlash = register.calls.slash.find((c) => c.config.name === "remindme");

    const interaction = makeInteraction({ sub: "set", phrase: "ping", time: "10m" });
    await remindSlash.handler({ interaction });

    expect(interaction.reply).toHaveBeenCalledWith(
      expect.objectContaining({ content: "✅ Reminder set." })
    );
    expect(execute).toHaveBeenCalledWith(expect.stringContaining("INSERT INTO reminders"), expect.anything());
  });

  it("allows remindme in DMs with a phrase", async () => {
    const execute = vi.fn(async (sql) => {
      if (sql.includes("SELECT id, phrase, message_id, channel_id")) return [[]];
      if (sql.includes("INSERT INTO reminders")) return [{ insertId: 6 }];
      return [[]];
    });
    dbMocks.getDb.mockReturnValue({ execute });

    const register = makeRegister();
    registerReminders(register);
    const remindSlash = register.calls.slash.find((c) => c.config.name === "remindme");

    const interaction = makeInteraction({
      sub: "set",
      phrase: "ping",
      time: "10m",
      guildId: null,
      channelId: "dm1",
    });
    await remindSlash.handler({ interaction });

    expect(interaction.reply).toHaveBeenCalledWith(
      expect.objectContaining({ content: "✅ Reminder set." })
    );
    expect(execute).toHaveBeenCalledWith(expect.stringContaining("INSERT INTO reminders"), expect.anything());
  });

  it("allows remindme over limit for admins", async () => {
    const execute = vi.fn(async (sql) => {
      if (sql.includes("SELECT id, phrase, message_id, channel_id")) {
        return [[
          { id: 1, phrase: "a", message_id: "", channel_id: "c1", guild_id: "g1", remind_at_ms: 1 },
          { id: 2, phrase: "b", message_id: "", channel_id: "c1", guild_id: "g1", remind_at_ms: 2 },
          { id: 3, phrase: "c", message_id: "", channel_id: "c1", guild_id: "g1", remind_at_ms: 3 },
          { id: 4, phrase: "d", message_id: "", channel_id: "c1", guild_id: "g1", remind_at_ms: 4 },
          { id: 5, phrase: "e", message_id: "", channel_id: "c1", guild_id: "g1", remind_at_ms: 5 },
        ]];
      }
      if (sql.includes("INSERT INTO reminders")) return [{ insertId: 12 }];
      return [[]];
    });
    dbMocks.getDb.mockReturnValue({ execute });

    const register = makeRegister();
    registerReminders(register);
    const remindSlash = register.calls.slash.find((c) => c.config.name === "remindme");

    const interaction = makeInteraction({ sub: "set", phrase: "ping", time: "10m", isAdmin: true });
    await remindSlash.handler({ interaction });

    expect(interaction.reply).toHaveBeenCalledWith(
      expect.objectContaining({ content: "✅ Reminder set." })
    );
    expect(execute).toHaveBeenCalledWith(expect.stringContaining("INSERT INTO reminders"), expect.anything());
  });

  it("lists reminders", async () => {
    const execute = vi.fn(async (sql) => {
      if (sql.includes("SELECT id, phrase, message_id, channel_id")) {
        return [[
          {
            id: 7,
            phrase: "check box",
            message_id: "",
            channel_id: "c1",
            guild_id: "g1",
            remind_at_ms: 1730000000000,
          },
        ]];
      }
      return [[]];
    });
    dbMocks.getDb.mockReturnValue({ execute });

    const register = makeRegister();
    registerReminders(register);
    const remindSlash = register.calls.slash.find((c) => c.config.name === "remindme");

    const interaction = makeInteraction({ sub: "list" });
    await remindSlash.handler({ interaction });

    expect(interaction.reply).toHaveBeenCalledWith(
      expect.objectContaining({ content: expect.stringContaining("check box") })
    );
  });

  it("removes a reminder on unset", async () => {
    const execute = vi.fn(async (sql) => {
      if (sql.includes("DELETE FROM reminders")) return [[]];
      return [[]];
    });
    dbMocks.getDb.mockReturnValue({ execute });

    const register = makeRegister();
    registerReminders(register);
    const remindSlash = register.calls.slash.find((c) => c.config.name === "remindme");

    const interaction = makeInteraction({ sub: "unset", phrase: "3" });
    await remindSlash.handler({ interaction });

    expect(execute).toHaveBeenCalledWith(expect.stringContaining("DELETE FROM reminders"), [3, "u1"]);
    expect(interaction.reply).toHaveBeenCalledWith(
      expect.objectContaining({ content: "✅ Reminder removed." })
    );
  });

  it("clears notifyme entries for the server", async () => {
    const execute = vi.fn(async (sql) => {
      if (sql.includes("DELETE FROM notify_me WHERE guild_id")) return [[]];
      if (sql.includes("SELECT id, user_id, phrase FROM notify_me")) {
        return [[{ id: 2, user_id: "u1", phrase: "beta" }]];
      }
      return [[]];
    });
    dbMocks.getDb.mockReturnValue({ execute });

    const register = makeRegister();
    registerReminders(register);
    const notifySlash = register.calls.slash.find((c) => c.config.name === "notifyme");

    const interaction = makeInteraction({ sub: "clear" });
    await notifySlash.handler({ interaction });

    expect(execute).toHaveBeenCalledWith(
      expect.stringContaining("DELETE FROM notify_me WHERE guild_id"),
      ["g1", "u1"]
    );
    expect(interaction.reply).toHaveBeenCalledWith(
      expect.objectContaining({ content: expect.stringContaining("Cleared all notifications") })
    );
  });

  it("clears all reminders", async () => {
    const execute = vi.fn(async (sql) => {
      if (sql.includes("DELETE FROM reminders WHERE user_id")) return [[]];
      return [[]];
    });
    dbMocks.getDb.mockReturnValue({ execute });

    const register = makeRegister();
    registerReminders(register);
    const remindSlash = register.calls.slash.find((c) => c.config.name === "remindme");

    const interaction = makeInteraction({ sub: "clear" });
    await remindSlash.handler({ interaction });

    expect(execute).toHaveBeenCalledWith(
      expect.stringContaining("DELETE FROM reminders WHERE user_id"),
      ["u1"]
    );
    expect(interaction.reply).toHaveBeenCalledWith(
      expect.objectContaining({ content: expect.stringContaining("Cleared all reminders") })
    );
  });

  it("fires a reminder and deletes it", async () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2025-01-01T00:00:00Z"));

    const execute = vi.fn(async (sql) => {
      if (sql.includes("DELETE FROM reminders")) return [[]];
      return [[]];
    });
    dbMocks.getDb.mockReturnValue({ execute });

    const send = vi.fn(async () => {});
    __testables.setBootClient({ users: { fetch: vi.fn(async () => ({ send })) } });

    __testables.scheduleReminder({
      id: 9,
      userId: "u9",
      guildId: "g1",
      channelId: "c1",
      messageId: "m1",
      phrase: "",
      remindAtMs: Date.now() + 1000,
      createdAtMs: Date.now() - 5 * 60 * 1000,
    });

    await vi.advanceTimersByTimeAsync(1000);
    expect(send).toHaveBeenCalledWith(expect.stringContaining("set 5m ago"));
    expect(execute).toHaveBeenCalledWith(
      expect.stringContaining("DELETE FROM reminders"),
      [9, "u9"]
    );

    vi.useRealTimers();
  });

  it("rejects message_id reminders in DMs", async () => {
    const execute = vi.fn(async () => [[]]);
    dbMocks.getDb.mockReturnValue({ execute });

    const register = makeRegister();
    registerReminders(register);
    const remindSlash = register.calls.slash.find((c) => c.config.name === "remindme");

    const interaction = makeInteraction({
      sub: "set",
      messageId: "123",
      time: "10m",
      guildId: null,
      channelId: "dm1",
    });
    await remindSlash.handler({ interaction });

    expect(interaction.reply).toHaveBeenCalledWith(
      expect.objectContaining({ content: expect.stringContaining("only work when set inside a server") })
    );
    expect(execute).not.toHaveBeenCalledWith(expect.stringContaining("INSERT INTO reminders"), expect.anything());
  });

  it("rejects message_id reminders when bot is not in guild", async () => {
    const execute = vi.fn(async () => [[]]);
    dbMocks.getDb.mockReturnValue({ execute });

    const register = makeRegister();
    registerReminders(register);
    const remindSlash = register.calls.slash.find((c) => c.config.name === "remindme");

    const interaction = makeInteraction({ sub: "set", messageId: "123", time: "10m" });
    interaction.client.guilds.cache.has.mockReturnValue(false);
    await remindSlash.handler({ interaction });

    expect(interaction.reply).toHaveBeenCalledWith(
      expect.objectContaining({ content: expect.stringContaining("servers I'm in") })
    );
    expect(execute).not.toHaveBeenCalledWith(expect.stringContaining("INSERT INTO reminders"), expect.anything());
  });
});
