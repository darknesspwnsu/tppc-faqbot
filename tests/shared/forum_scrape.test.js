import { describe, it, expect } from "vitest";
import { computePageCountFromHtml } from "../../shared/forum_scrape.js";

describe("shared/forum_scrape.js", () => {
  it("parses page count from 'Show results' text", () => {
    const html = "Show results 1 to 25 of 706";
    expect(computePageCountFromHtml(html)).toBe(29);
  });

  it("parses page count from 'Showing results' text", () => {
    const html = "Showing results 701 to 706 of 706";
    expect(computePageCountFromHtml(html)).toBe(118);
  });

  it("parses page count from 'Page X of Y'", () => {
    const html = "Page 29 of 29";
    expect(computePageCountFromHtml(html)).toBe(29);
  });

  it("prefers 'Page X of Y' when both markers exist", () => {
    const html = "Page 1 of 237 Showing results 1 to 25 of 5,000";
    expect(computePageCountFromHtml(html, { maxPages: 1000 })).toBe(237);
  });

  it("caps page count at maxPages", () => {
    const html = "Page 1 of 237 Showing results 1 to 25 of 5,000";
    expect(computePageCountFromHtml(html)).toBe(200);
  });

  it("defaults to 1 when no markers are found", () => {
    expect(computePageCountFromHtml("no pagination here")).toBe(1);
  });
});
