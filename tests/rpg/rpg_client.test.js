import { describe, it, expect, vi, afterEach } from "vitest";

vi.mock("../../shared/metrics.js", () => ({
  metrics: { increment: vi.fn(), incrementExternalFetch: vi.fn() },
}));

import { RpgClient, __testables } from "../../rpg/rpg_client.js";

const { parseCookiePair, getSetCookiesFromResponse } = __testables;

function makeHeaders({ getSetCookie, raw, get } = {}) {
  return {
    getSetCookie,
    raw,
    get,
  };
}

function makeRes({ ok = true, status = 200, text = "OK", headers = {} } = {}) {
  return {
    ok,
    status,
    headers,
    text: vi.fn().mockResolvedValue(text),
  };
}

afterEach(() => {
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

describe("rpg_client helpers", () => {
  it("parses cookie pairs", () => {
    expect(parseCookiePair("session=abc; Path=/; HttpOnly")).toEqual(["session", "abc"]);
    expect(parseCookiePair("  name = value  ")).toEqual(["name", "value"]);
    expect(parseCookiePair("noequals")).toBeNull();
    expect(parseCookiePair("=bad")).toBeNull();
  });

  it("extracts set-cookie headers across header shapes", () => {
    const viaGetSetCookie = getSetCookiesFromResponse({
      headers: makeHeaders({ getSetCookie: () => ["a=1", "b=2"] }),
    });
    expect(viaGetSetCookie).toEqual(["a=1", "b=2"]);

    const viaRaw = getSetCookiesFromResponse({
      headers: makeHeaders({ raw: () => ({ "set-cookie": ["c=3"] }) }),
    });
    expect(viaRaw).toEqual(["c=3"]);

    const viaGet = getSetCookiesFromResponse({
      headers: makeHeaders({ get: () => "d=4" }),
    });
    expect(viaGet).toEqual(["d=4"]);
  });
});

describe("RpgClient login", () => {
  it("logs in and caches the session", async () => {
    const fetch = vi.fn().mockResolvedValue(makeRes({ status: 200, text: "Logout" }));
    vi.stubGlobal("fetch", fetch);
    vi.spyOn(Date, "now").mockReturnValue(1000);

    const client = new RpgClient({ baseUrl: "https://example.test", username: "u", password: "p" });
    await client.login();
    await client.login();

    expect(fetch).toHaveBeenCalledTimes(1);
    expect(fetch.mock.calls[0][0]).toBe("https://example.test/login.php");
    expect(fetch.mock.calls[0][1]).toEqual(
      expect.objectContaining({ method: "POST" })
    );
  });

  it("throws on failed login status", async () => {
    const fetch = vi.fn().mockResolvedValue(makeRes({ status: 500, ok: false }));
    vi.stubGlobal("fetch", fetch);

    const client = new RpgClient({ baseUrl: "https://example.test", username: "u", password: "p" });

    await expect(client.login()).rejects.toThrow("RPG login failed");
  });

  it("throws when login response lacks logout marker", async () => {
    const fetch = vi.fn().mockResolvedValue(makeRes({ status: 200, text: "Welcome" }));
    vi.stubGlobal("fetch", fetch);

    const client = new RpgClient({ baseUrl: "https://example.test", username: "u", password: "p" });

    await expect(client.login()).rejects.toThrow("RPG login rejected");
  });
});

describe("RpgClient fetch helpers", () => {
  it("retries fetchPage after login redirect", async () => {
    vi.stubGlobal("fetch", vi.fn());

    const client = new RpgClient({ baseUrl: "https://example.test", username: "u", password: "p" });
    client.login = vi.fn().mockResolvedValue(true);

    const res1 = makeRes({
      ok: false,
      status: 302,
      headers: makeHeaders({ get: () => "https://example.test/login.php" }),
    });
    const res2 = makeRes({ status: 200, text: "OK" });
    client._fetch = vi.fn().mockResolvedValueOnce(res1).mockResolvedValueOnce(res2);

    const text = await client.fetchPage("/foo");

    expect(text).toBe("OK");
    expect(client.login).toHaveBeenCalledTimes(2);
  });

  it("follows redirect location on fetchPage", async () => {
    vi.stubGlobal("fetch", vi.fn());

    const client = new RpgClient({ baseUrl: "https://example.test", username: "u", password: "p" });
    client.login = vi.fn().mockResolvedValue(true);

    const res1 = makeRes({
      ok: false,
      status: 302,
      headers: makeHeaders({ get: () => "/next" }),
    });
    const res2 = makeRes({ status: 200, text: "NEXT" });
    client._fetch = vi.fn().mockResolvedValueOnce(res1).mockResolvedValueOnce(res2);

    const text = await client.fetchPage("/foo");

    expect(text).toBe("NEXT");
  });

  it("retries fetchForm after login redirect", async () => {
    vi.stubGlobal("fetch", vi.fn());

    const client = new RpgClient({ baseUrl: "https://example.test", username: "u", password: "p" });
    client.login = vi.fn().mockResolvedValue(true);

    const res1 = makeRes({
      ok: false,
      status: 302,
      headers: makeHeaders({ get: () => "https://example.test/login.php" }),
    });
    const res2 = makeRes({ status: 200, text: "OK" });
    client._fetch = vi.fn().mockResolvedValueOnce(res1).mockResolvedValueOnce(res2);

    const text = await client.fetchForm("/foo", "x=y");

    expect(text).toBe("OK");
    expect(client.login).toHaveBeenCalledTimes(2);
  });
});
