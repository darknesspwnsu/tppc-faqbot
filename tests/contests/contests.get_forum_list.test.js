import { describe, expect, test } from "vitest";

import {
  normalizeThreadUrl,
  computePageCountFromHtml,
  extractUsernameFromPostTable,
  extractLinkedIdsFromSidebarText,
  extractPostMessageText,
} from "../../contests/get_forum_list.js";

describe("get_forum_list parsing", () => {
  test("normalizeThreadUrl accepts forum thread urls", () => {
    const ok = normalizeThreadUrl("https://forums.tppc.info/showthread.php?t=123");
    expect(ok).toContain("forums.tppc.info/showthread.php");
    const bad = normalizeThreadUrl("https://example.com/showthread.php?t=123");
    expect(bad).toBe(null);
  });

  test("computePageCountFromHtml falls back to 1", () => {
    expect(computePageCountFromHtml("<html></html>")).toBe(1);
  });

  test("extractUsernameFromPostTable pulls username", () => {
    const html = '<table id="post123"><div id="postmenu_1">UserName</div></table>';
    expect(extractUsernameFromPostTable(html)).toBe("UserName");
  });

  test("extractLinkedIdsFromSidebarText finds ids", () => {
    const txt = "TPPC: #123 #456";
    expect(extractLinkedIdsFromSidebarText(txt)).toEqual(["123", "456"]);
  });

  test("extractPostMessageText strips html", () => {
    const html = '<div id="post_message_1">Hi<br>there</div>';
    expect(extractPostMessageText(html)).toBe("Hi\nthere");
  });
});
