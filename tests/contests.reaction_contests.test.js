import { describe, expect, test, vi } from "vitest";

import { collectEntrantsByReactions } from "../contests/reaction_contests.js";

function mockClient() {
  const handlers = new Map();
  const client = {
    on: vi.fn((evt, fn) => handlers.set(evt, fn)),
    channels: {
      fetch: vi.fn(async () => ({
        isTextBased: () => true,
        messages: {
          fetch: vi.fn(async () => ({ edit: vi.fn().mockResolvedValue(undefined) })),
        },
      })),
    },
  };
  client.__handlers = handlers;
  return client;
}

function mockJoinMessage() {
  return {
    id: "m1",
    react: vi.fn().mockResolvedValue(undefined),
  };
}

function mockMessage(joinMsg, client) {
  return {
    guildId: "1",
    channelId: "2",
    client,
    channel: {
      send: vi.fn().mockResolvedValue(joinMsg),
    },
  };
}

describe("collectEntrantsByReactions", () => {
  test("collects entrants and honors maxEntrants", async () => {
    const client = mockClient();
    const joinMsg = mockJoinMessage();
    const message = mockMessage(joinMsg, client);

    const p = collectEntrantsByReactions({
      message,
      promptText: "join",
      durationMs: 1000,
      maxEntrants: 2,
      emoji: "👍",
    });

    // Allow the async setup to register the collector state.
    await Promise.resolve();
    await Promise.resolve();

    const add = client.__handlers.get("messageReactionAdd");
    expect(add).toBeTypeOf("function");

    await add({ message: { id: "m1", guildId: "1", partial: false }, partial: false }, { id: "u1", bot: false });
    await add({ message: { id: "m1", guildId: "1", partial: false }, partial: false }, { id: "u2", bot: false });

    const res = await p;
    expect([...res.entrants]).toEqual(["u1", "u2"]);
  });
});
