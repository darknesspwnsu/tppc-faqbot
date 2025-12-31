import { describe, it, expect } from "vitest";

import { __testables } from "../../rpg/viewbox.js";

const { parseViewboxEntries, applyFilter, collapseEntries, buildSections } = __testables;

describe("rpg viewbox parsing", () => {
  it("parses entries and collapses duplicates", () => {
    const html = `
      <ul id="allPoke">
        <li class="S ">ShinyBergmite &#9792; (Level: 125)</li>
        <li class="S ">ShinyBergmite &#9792; (Level: 125)</li>
        <li class="D u">DarkAbsol &#9792; (Level: 5)</li>
        <li class="N ">HootHoot (?) (Level: 5)</li>
      </ul>
    `;
    const entries = parseViewboxEntries(html);
    expect(entries).toHaveLength(4);
    const collapsed = collapseEntries(entries);
    const shiny = collapsed.find((e) => e.name === "ShinyBergmite");
    expect(shiny.count).toBe(2);
    expect(shiny.level).toBe("125");
  });

  it("filters by unknown and l4", () => {
    const html = `
      <ul id="allPoke">
        <li class="N ">HootHoot (?) (Level: 5)</li>
        <li class="N ">Abra &#9794; (Level: 4)</li>
        <li class="S ">ShinyAbra &#9794; (Level: 4)</li>
      </ul>
    `;
    const entries = parseViewboxEntries(html);
    expect(applyFilter(entries, "unknown")).toHaveLength(1);
    expect(applyFilter(entries, "l4")).toHaveLength(2);
  });

  it("builds sections for shiny/dark merge", () => {
    const html = `
      <ul id="allPoke">
        <li class="S ">ShinyAbra &#9794; (Level: 4)</li>
        <li class="D ">DarkAbra &#9794; (Level: 4)</li>
      </ul>
    `;
    const entries = collapseEntries(parseViewboxEntries(html));
    const sections = buildSections(entries, "shinydark");
    expect(sections[0].title).toBe("Shiny / Dark");
    expect(sections[0].lines.length).toBeGreaterThan(0);
  });
});
