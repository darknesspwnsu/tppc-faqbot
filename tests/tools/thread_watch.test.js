import { describe, it, expect, vi } from "vitest";

vi.mock("../../db.js", () => ({ getDb: vi.fn() }));
vi.mock("../../auth.js", () => ({ isAdminOrPrivileged: vi.fn() }));
vi.mock("../../shared/dm.js", () => ({ sendDm: vi.fn() }));
vi.mock("../../shared/logger.js", () => ({ logger: { warn: vi.fn(), serializeError: (e) => e } }));
vi.mock("../../shared/metrics.js", () => ({ metrics: { incrementSchedulerRun: vi.fn() } }));
vi.mock("../../shared/scheduler_registry.js", () => ({ registerScheduler: vi.fn() }));

import { __testables } from "../../tools/thread_watch.js";

const {
  tokenizeArgs,
  parseSubOptions,
  parseThreadInput,
  extractThreadIdFromHtml,
  extractThreadTitleFromHtml,
  extractThreadOpFromHtml,
  parsePostsFromHtml,
  formatSnippet,
  buildPostHotlink,
} = __testables;

describe("tools/thread_watch.js", () => {
  it("tokenizes quoted arguments", () => {
    const tokens = tokenizeArgs('sub 123 --user "Foo Bar"');
    expect(tokens).toEqual(["sub", "123", "--user", "Foo Bar"]);
  });

  it("parses sub options with filters", () => {
    expect(parseSubOptions(["123", "--op"]).filterMode).toBe("op");
    expect(parseSubOptions(["123", "--user", "Foo"]).filterUser).toBe("Foo");
    expect(parseSubOptions(["--user", "Foo", "--op", "123"]).error).toMatch(/Choose only one filter/);
  });

  it("parses thread input from numeric or url", () => {
    const num = parseThreadInput("641631");
    expect(num.threadId).toBe(641631);
    expect(num.threadUrl).toContain("showthread.php?t=641631");

    const url = parseThreadInput("https://forums.tppc.info/showthread.php?t=123&page=2#post123");
    expect(url.threadId).toBe(123);
    expect(url.threadUrl).toBe("https://forums.tppc.info/showthread.php?t=123");
  });

  it("extracts thread title and op", () => {
    const html = `
      <title>TPPC Forums - The TPPC Lottery</title>
      <table id="post111">
        <tr><td><div id="postmenu_111"><a class="bigusername">Haunter</a></div></td></tr>
      </table>
    `;
    expect(extractThreadTitleFromHtml(html)).toBe("The TPPC Lottery");
    expect(extractThreadOpFromHtml(html)).toBe("Haunter");
  });

  it("extracts posts from html", () => {
    const html = `
      <table id="post111">
        <div id="postmenu_111"><a class="bigusername">UserOne</a></div>
        <div id="post_message_111">Hello there</div>
      </table>
      <table id="post222">
        <div id="postmenu_222"><a class="bigusername">UserTwo</a></div>
        <div id="post_message_222">Hi again</div>
      </table>
    `;
    const posts = parsePostsFromHtml(html);
    expect(posts).toHaveLength(2);
    expect(posts[0].postId).toBe(111);
    expect(posts[1].username).toBe("UserTwo");
  });

  it("builds snippets and hotlinks", () => {
    const snippet = formatSnippet("x".repeat(300), 20);
    expect(snippet.length).toBe(20);
    expect(snippet.endsWith("…")).toBe(true);
    expect(buildPostHotlink(123)).toBe(
      "https://forums.tppc.info/showthread.php?p=123#post123"
    );
  });

  it("extracts thread id from html", () => {
    const html = '<a href="showthread.php?t=98765">link</a>';
    expect(extractThreadIdFromHtml(html)).toBe(98765);
  });
});
