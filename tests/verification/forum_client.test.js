import { describe, it, expect, vi, beforeEach } from "vitest";

import { ForumClient } from "../../verification/forum_client.js";

function makeResponse({ status = 200, body = "", cookies = [] } = {}) {
  return {
    status,
    ok: status >= 200 && status < 300,
    text: async () => body,
    headers: {
      getSetCookie: () => cookies,
    },
  };
}

describe("ForumClient", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("throws when credentials are missing", () => {
    expect(() => new ForumClient({ username: "", password: "" })).toThrow(/missing credentials/i);
  });

  it("sends verification PM on success", async () => {
    const fetchMock = vi.fn()
      // login GET
      .mockResolvedValueOnce(makeResponse({ status: 200, body: '<input name="securitytoken" value="guest">' }))
      // login POST
      .mockResolvedValueOnce(makeResponse({ status: 302 }))
      // newpm GET
      .mockResolvedValueOnce(makeResponse({ status: 200, body: '<input name="securitytoken" value="tok123">' }))
      // insertpm POST
      .mockResolvedValueOnce(makeResponse({ status: 302 }));

    global.fetch = fetchMock;

    const client = new ForumClient({
      baseUrl: "https://forums.tppc.info",
      username: "bot",
      password: "pass",
      bcc: "",
    });

    const res = await client.sendVerificationPm({
      forumUsername: "User",
      discordTag: "Tag#0001",
      token: "abc123",
    });

    expect(res.ok).toBe(true);
    expect(fetchMock).toHaveBeenCalledTimes(4);
  });

  it("returns user-not-found error", async () => {
    const fetchMock = vi.fn()
      // login GET
      .mockResolvedValueOnce(makeResponse({ status: 200, body: '<input name="securitytoken" value="guest">' }))
      // login POST
      .mockResolvedValueOnce(makeResponse({ status: 302 }))
      // newpm GET
      .mockResolvedValueOnce(makeResponse({ status: 200, body: '<input name="securitytoken" value="tok123">' }))
      // insertpm POST with error page
      .mockResolvedValueOnce(makeResponse({ status: 200, body: "The following users were not found:" }));

    global.fetch = fetchMock;

    const client = new ForumClient({
      baseUrl: "https://forums.tppc.info",
      username: "bot",
      password: "pass",
      bcc: "",
    });

    const res = await client.sendVerificationPm({
      forumUsername: "Missing",
      discordTag: "",
      token: "abc123",
    });

    expect(res.ok).toBe(false);
    expect(res.error).toMatch(/could not be found/i);
  });
});
