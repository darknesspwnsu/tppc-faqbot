import { describe, it, expect, vi, afterEach } from "vitest";

const originalEnv = { ...process.env };

async function loadBotModule({
  allowedChannels = "",
  slashGuildId = "",
} = {}) {
  vi.resetModules();

  process.env = {
    ...originalEnv,
    DISCORD_TOKEN: "token",
    ALLOWED_CHANNEL_IDS: allowedChannels,
    SLASH_GUILD_ID: slashGuildId,
  };

  const dispatchMessage = vi.fn(async () => {});
  const dispatchInteraction = vi.fn(async () => {});
  const syncSlashCommands = vi.fn(async () => {});
  const listBang = vi.fn(() => ["!a"]);
  const listSlash = vi.fn(() => ["a"]);

  const buildCommandRegistry = vi.fn(() => ({
    dispatchMessage,
    dispatchInteraction,
    listBang,
    listSlash,
    syncSlashCommands,
  }));

  const initDb = vi.fn(async () => {});

  let clients = [];

  vi.doMock("discord.js", () => {
    class Client {
      constructor() {
        this.user = { id: "user1", tag: "bot#0001" };
        this.application = { id: "app1" };
        this._events = { once: new Map(), on: new Map() };
        clients.push(this);
      }
      once(event, cb) {
        this._events.once.set(event, cb);
      }
      on(event, cb) {
        this._events.on.set(event, cb);
      }
      login = vi.fn(async () => {});
    }

    return {
      Client,
      GatewayIntentBits: {},
      Partials: {},
      Events: { ClientReady: "ready", InteractionCreate: "interactionCreate" },
      __clients: clients,
    };
  });

  vi.doMock("../../commands.js", () => ({ buildCommandRegistry }));
  vi.doMock("../../db.js", () => ({ initDb }));

  await import("../../bot.js");
  const { __clients } = await import("discord.js");
  return {
    buildCommandRegistry,
    dispatchMessage,
    dispatchInteraction,
    syncSlashCommands,
    listBang,
    listSlash,
    initDb,
    client: __clients[0],
  };
}

afterEach(() => {
  process.env = { ...originalEnv };
  vi.clearAllMocks();
});

describe("bot.js", () => {
  it("wires registry and syncs slash commands on ready", async () => {
    const { client, buildCommandRegistry, syncSlashCommands } = await loadBotModule({
      slashGuildId: "g1",
    });

    expect(buildCommandRegistry).toHaveBeenCalledWith({ client });

    const ready = client._events.once.get("ready");
    expect(ready).toBeTypeOf("function");

    await ready();
    expect(syncSlashCommands).toHaveBeenCalledWith({
      token: "token",
      appId: "app1",
      guildId: "g1",
    });
  });

  it("dispatches messages only when they pass guards", async () => {
    const { client, dispatchMessage } = await loadBotModule({
      allowedChannels: "c1,c2",
    });

    const handler = client._events.on.get("messageCreate");
    expect(handler).toBeTypeOf("function");

    await handler({ guild: null });
    await handler({ guild: {}, author: { bot: true } });
    await handler({ guild: {}, author: { bot: false }, channelId: "c3" });
    expect(dispatchMessage).not.toHaveBeenCalled();

    await handler({ guild: {}, author: { bot: false }, channelId: "c2" });
    expect(dispatchMessage).toHaveBeenCalledTimes(1);
  });

  it("dispatches interactions through the registry", async () => {
    const { client, dispatchInteraction } = await loadBotModule();

    const handler = client._events.on.get("interactionCreate");
    expect(handler).toBeTypeOf("function");

    await handler({ id: "i1" });
    expect(dispatchInteraction).toHaveBeenCalledTimes(1);
  });
});
