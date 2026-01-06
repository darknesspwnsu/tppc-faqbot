import { describe, expect, it, vi } from "vitest";

const dbExecute = vi.fn(async () => [[]]);
vi.mock("../../db.js", () => ({ getDb: vi.fn(() => ({ execute: dbExecute })) }));
vi.mock("../../shared/metrics.js", () => ({
  metrics: { incrementSchedulerRun: vi.fn(), increment: vi.fn() },
}));
vi.mock("../../shared/dm.js", () => ({ sendDm: vi.fn(async () => ({ ok: true })) }));
vi.mock("../../configs/rpg_event_channels.js", () => ({ RPG_EVENT_CHANNELS_BY_GUILD: {} }));
vi.mock("../../configs/admin_announcement_channels.js", () => ({
  ADMIN_ANNOUNCEMENT_CHANNELS_BY_GUILD: { "329934860388925442": ["779468797009985576"] },
}));
vi.mock("../../configs/rpg_events.js", () => ({
  RPG_EVENT_TIMEZONE: "America/New_York",
  RPG_EVENT_OVERRIDES: {},
  RPG_EVENTS: [
    {
      id: "team_rocket",
      name: "Team Rocket Takeover",
      kind: "radio_tower",
      description: "Rocket",
    },
    {
      id: "soon",
      name: "Soon Event",
      kind: "fixed_date",
      month: 2,
      day: 1,
      description: "Soon",
    },
    {
      id: "later",
      name: "Later Event",
      kind: "fixed_date",
      month: 4,
      day: 1,
      description: "Later",
    },
  ],
}));
vi.mock("../../rpg/radio_tower.js", () => ({
  detectRadioTower: vi.fn(async () => false),
  buildRadioTowerMessage: () => "Rocket!",
}));
vi.mock("../../events/special_days.js", async () => {
  const actual = await vi.importActual("../../events/special_days.js");
  return {
    ...actual,
    loadSpecialDays: async () => ({
      defaults: { timezone: "America/New_York", announceHour: 0, announceMinute: 0 },
      days: [],
    }),
  };
});

import { __testables, registerEvents } from "../../events/events.js";

describe("events parsing helpers", () => {
  it("parses event ids and dedupes", () => {
    const ids = __testables.parseEventIds("golden_days, team_rocket team_rocket");
    expect(ids).toEqual(["golden_days", "team_rocket"]);
  });

  it("limits upcoming events to the next two months by default", async () => {
    const now = new Date("2026-01-01T12:00:00Z");
    const limited = await __testables.resolveEventsForList(now);
    expect(limited.upcoming.map((e) => e.id)).toEqual(["team_rocket", "soon"]);

    const all = await __testables.resolveEventsForList(now, { includeAll: true });
    expect(all.upcoming.map((e) => e.id)).toEqual(["soon", "later", "team_rocket"]);
  });

  it("formats weekly promo messages with promo text", () => {
    const message = __testables.buildEventMessage(
      { id: "weekly_promo", name: "Weekly Promo Refresh" },
      new Date("2026-01-04T05:00:00Z"),
      new Date("2026-01-11T05:00:00Z"),
      { promo: "ShinyCarnivine" }
    );
    expect(message).toContain("Weekly TPPC promo has been refreshed.");
    expect(message).toContain("Current promo: **ShinyCarnivine**.");
    expect(message).toContain("Duration: **7 days**.");
  });

  it("formats standard event messages with duration", () => {
    const message = __testables.buildEventMessage(
      { id: "scatterbug", name: "Scatterbug Swarm", description: "Scatterbug swarm (24h)." },
      new Date("2026-01-10T05:00:00Z"),
      new Date("2026-01-11T05:00:00Z")
    );
    expect(message).toContain("Scatterbug Swarm");
    expect(message).toContain("Duration: **24h 0m**.");
  });

  it("responds with help text for !events help", async () => {
    const register = vi.fn();
    register.slash = vi.fn();
    register.listener = vi.fn();
    register.onMessage = vi.fn();

    registerEvents(register);
    const handler = register.mock.calls.find((call) => call[0] === "!events")?.[1];
    expect(handler).toBeTypeOf("function");

    const reply = vi.fn();
    await handler({
      message: { content: "!events help", reply },
    });
    expect(reply).toHaveBeenCalled();
    const messageText = reply.mock.calls[0][0];
    expect(messageText).toContain("!events help");
    expect(messageText).toContain("/subscriptions subscribe");
    expect(messageText).toContain("discord_announcements");
  });

  it("handles /events list", async () => {
    const register = vi.fn();
    register.slash = vi.fn();
    register.listener = vi.fn();
    register.onMessage = vi.fn();

    registerEvents(register);
    const handler = register.slash.mock.calls.find((call) => call[0]?.name === "events")?.[1];
    expect(handler).toBeTypeOf("function");

    const reply = vi.fn();
    await handler({
      interaction: {
        options: { getSubcommand: () => "list" },
        reply,
      },
    });
    expect(reply).toHaveBeenCalled();
  });

  it("rejects unknown subscription ids", async () => {
    const register = vi.fn();
    register.slash = vi.fn();
    register.listener = vi.fn();
    register.onMessage = vi.fn();

    registerEvents(register);
    const handler = register.slash.mock.calls.find((call) => call[0]?.name === "subscriptions")?.[1];
    expect(handler).toBeTypeOf("function");

    const reply = vi.fn();
    await handler({
      interaction: {
        user: { id: "u1" },
        options: {
          getSubcommand: () => "subscribe",
          getString: () => "unknown_id",
        },
        reply,
      },
    });
    expect(reply).toHaveBeenCalled();
    expect(reply.mock.calls[0][0].content).toContain("Unknown event IDs");
  });

  it("lists subscriptions with descriptions", async () => {
    dbExecute.mockImplementation(async (sql) => {
      if (sql.includes("FROM event_subscriptions")) {
        return [[{ event_id: "soon" }]];
      }
      return [[]];
    });
    const register = vi.fn();
    register.slash = vi.fn();
    register.listener = vi.fn();
    register.onMessage = vi.fn();

    registerEvents(register);
    const handler = register.slash.mock.calls.find((call) => call[0]?.name === "subscriptions")?.[1];
    const reply = vi.fn();
    await handler({
      interaction: {
        user: { id: "u1" },
        options: { getSubcommand: () => "list" },
        reply,
      },
    });
    expect(reply).toHaveBeenCalled();
    expect(reply.mock.calls[0][0].content).toContain("Soon");
  });

  it("subscribes to valid event ids", async () => {
    dbExecute.mockImplementation(async () => [[]]);
    const register = vi.fn();
    register.slash = vi.fn();
    register.listener = vi.fn();
    register.onMessage = vi.fn();

    registerEvents(register);
    const handler = register.slash.mock.calls.find((call) => call[0]?.name === "subscriptions")?.[1];
    const reply = vi.fn();
    await handler({
      interaction: {
        user: { id: "u1" },
        options: {
          getSubcommand: () => "subscribe",
          getString: () => "soon",
        },
        reply,
      },
    });
    expect(reply).toHaveBeenCalled();
    expect(reply.mock.calls[0][0].content).toContain("Subscribed");
  });

  it("forwards admin announcements to subscribers", async () => {
    dbExecute.mockImplementation(async (sql) => {
      if (sql.includes("FROM event_subscriptions")) {
        return [[{ user_id: "u1" }]];
      }
      return [[]];
    });
    const register = vi.fn();
    register.slash = vi.fn();
    register.listener = vi.fn();
    register.onMessage = vi.fn();

    registerEvents(register);
    const listener = register.listener.mock.calls[0][0];
    const { sendDm } = await vi.importMock("../../shared/dm.js");
    const client = {
      users: { fetch: vi.fn(async () => ({ id: "u1" })) },
    };
    const message = {
      id: "m1",
      guildId: "329934860388925442",
      channelId: "779468797009985576",
      createdTimestamp: 1700000000000,
      content: "New announcement!",
      url: "https://discord.com/channels/329934860388925442/779468797009985576/1",
      guild: { name: "TPPC" },
      channel: { name: "announcements" },
      embeds: [],
      attachments: new Map(),
      client,
    };
    await listener({ message });
    expect(__testables.isAdminAnnouncementChannel(message)).toBe(true);
    await __testables.forwardAdminAnnouncement(message);
    expect(client.users.fetch).toHaveBeenCalled();
    expect(sendDm).toHaveBeenCalled();
  });
});
