import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";

const originalEnv = { ...process.env };

describe("shared/logger.js", () => {
  beforeEach(() => {
    vi.resetModules();
    vi.clearAllMocks();
  });

  afterEach(() => {
    process.env = { ...originalEnv };
  });

  it("defaults to error level and text format", async () => {
    process.env = { ...originalEnv };
    const { logger } = await import("../../shared/logger.js");

    const log = vi.spyOn(console, "log").mockImplementation(() => {});
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    const error = vi.spyOn(console, "error").mockImplementation(() => {});

    logger.info("info");
    logger.warn("warn");
    logger.error("error");

    expect(log).not.toHaveBeenCalled();
    expect(warn).not.toHaveBeenCalled();
    expect(error).toHaveBeenCalledTimes(1);
    expect(String(error.mock.calls[0][0])).toContain("ERROR");
  });

  it("honors LOG_LEVEL=warn", async () => {
    process.env = { ...originalEnv, LOG_LEVEL: "warn" };
    const { logger } = await import("../../shared/logger.js");

    const log = vi.spyOn(console, "log").mockImplementation(() => {});
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    const error = vi.spyOn(console, "error").mockImplementation(() => {});

    logger.info("info");
    logger.warn("warn");
    logger.error("error");

    expect(log).not.toHaveBeenCalled();
    expect(warn).toHaveBeenCalledTimes(1);
    expect(error).toHaveBeenCalledTimes(1);
  });

  it("emits JSON when LOG_FORMAT=json", async () => {
    process.env = { ...originalEnv, LOG_FORMAT: "json", LOG_LEVEL: "info" };
    const { logger } = await import("../../shared/logger.js");

    const log = vi.spyOn(console, "log").mockImplementation(() => {});
    logger.info("hello", { foo: "bar" });

    const payload = JSON.parse(String(log.mock.calls[0][0]));
    expect(payload.message).toBe("hello");
    expect(payload.foo).toBe("bar");
    expect(payload.level).toBe("info");
  });

  it("serializes errors safely", async () => {
    const { logger } = await import("../../shared/logger.js");
    const err = new Error("boom");
    const out = logger.serializeError(err);
    expect(out.message).toBe("boom");
    expect(out.name).toBe("Error");
  });
});
