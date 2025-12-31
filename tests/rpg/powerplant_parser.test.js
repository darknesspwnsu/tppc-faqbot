import { describe, it, expect } from "vitest";

import { __testables } from "../../rpg/powerplant.js";

const { parsePowerPlantController } = __testables;

describe("rpg power plant parsing", () => {
  it("parses the controlling team", () => {
    const html = `
      <div id="body">
        <div id="inner">
          <p class="center">The Power Plant is currently controlled by <strong>Team Magma</strong>!</p>
        </div>
      </div>
    `;
    expect(parsePowerPlantController(html)).toBe("Team Magma");
  });

  it("returns null when not found", () => {
    expect(parsePowerPlantController("<p>Nope</p>")).toBeNull();
  });
});
