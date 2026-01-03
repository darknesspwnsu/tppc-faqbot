import { describe, it, expect, vi, afterEach } from "vitest";

const originalEnv = { ...process.env };

async function loadDbModule({ env = {}, pool = null } = {}) {
  vi.resetModules();

  const createPool = vi.fn(() => pool ?? { execute: vi.fn(async () => []) });
  vi.doMock("mysql2/promise", () => ({ default: { createPool } }));

  process.env = { ...originalEnv, ...env };

  const mod = await import("../../db.js");
  return { ...mod, createPool };
}

afterEach(() => {
  process.env = { ...originalEnv };
  vi.clearAllMocks();
});

describe("db.js", () => {
  it("throws when required env vars are missing", async () => {
    const { getDb } = await loadDbModule({ env: { DB_HOST: "", DB_USER: "", DB_NAME: "" } });
    expect(() => getDb()).toThrow(/Missing DB env vars/);
  });

  it("creates and caches pool with parsed numeric fields", async () => {
    const pool = { execute: vi.fn(async () => []) };
    const { getDb, createPool } = await loadDbModule({
      env: {
        DB_HOST: "127.0.0.1",
        DB_PORT: "3307",
        DB_USER: "bot",
        DB_PASSWORD: "pw",
        DB_NAME: "tppc",
        DB_CONNECTION_LIMIT: "5",
      },
      pool,
    });

    const first = getDb();
    const second = getDb();

    expect(first).toBe(pool);
    expect(second).toBe(pool);
    expect(createPool).toHaveBeenCalledTimes(1);
    expect(createPool).toHaveBeenCalledWith(
      expect.objectContaining({
        host: "127.0.0.1",
        port: 3307,
        user: "bot",
        password: "pw",
        database: "tppc",
        connectionLimit: 5,
      })
    );
  });

  it("initDb creates tables", async () => {
    const execute = vi.fn(async () => []);
    const pool = { execute };
    const { initDb } = await loadDbModule({
      env: { DB_HOST: "127.0.0.1", DB_USER: "bot", DB_NAME: "tppc" },
      pool,
    });

    await initDb();

    const createStatements = execute.mock.calls.map((call) => call[0]);
    expect(createStatements).toEqual(
      expect.arrayContaining([
        expect.stringMatching(/CREATE TABLE IF NOT EXISTS user_ids/),
        expect.stringMatching(/CREATE TABLE IF NOT EXISTS user_texts/),
        expect.stringMatching(/CREATE TABLE IF NOT EXISTS rpg_pokedex/),
        expect.stringMatching(/CREATE TABLE IF NOT EXISTS notify_me/),
        expect.stringMatching(/CREATE TABLE IF NOT EXISTS reminders/),
      ])
    );
  });

  it("wraps CRUD helpers with execute calls", async () => {
    const execute = vi.fn(async () => [[{ saved_id: 42, text: "hi" }]]);
    const pool = { execute };
    const db = await loadDbModule({
      env: { DB_HOST: "127.0.0.1", DB_USER: "bot", DB_NAME: "tppc" },
      pool,
    });

    await db.setSavedId({ guildId: 1, userId: 2, savedId: 3 });
    expect(execute).toHaveBeenCalledWith(
      expect.stringContaining("INSERT INTO user_ids"),
      ["1", "2", 3]
    );

    const saved = await db.getSavedId({ guildId: 1, userId: 2 });
    expect(saved).toBe(42);

    await db.deleteSavedId({ guildId: 1, userId: 2 });
    expect(execute).toHaveBeenCalledWith(
      expect.stringContaining("DELETE FROM user_ids"),
      ["1", "2"]
    );

    await db.setUserText({ guildId: 1, userId: 2, kind: "x", text: "hello" });
    expect(execute).toHaveBeenCalledWith(
      expect.stringContaining("INSERT INTO user_texts"),
      ["1", "2", "x", "hello"]
    );

    const text = await db.getUserText({ guildId: 1, userId: 2, kind: "x" });
    expect(text).toBe("hi");

    await db.deleteUserText({ guildId: 1, userId: 2, kind: "x" });
    expect(execute).toHaveBeenCalledWith(
      expect.stringContaining("DELETE FROM user_texts"),
      ["1", "2", "x"]
    );
  });
});
