import { describe, it, expect, vi } from "vitest";

const infoMocks = vi.hoisted(() => ({
  registerInfoCommands: vi.fn(),
  registerHelpbox: vi.fn(),
}));

vi.mock("../../info/faq.js", () => ({
  registerInfoCommands: infoMocks.registerInfoCommands,
}));
vi.mock("../../info/helpbox.js", () => ({
  registerHelpbox: infoMocks.registerHelpbox,
}));

import { registerInfo } from "../../info/info.js";

describe("info registry", () => {
  it("registers info commands and helpbox", () => {
    const register = vi.fn();
    const helpModel = vi.fn(() => []);

    registerInfo(register, { helpModel });

    expect(infoMocks.registerInfoCommands).toHaveBeenCalledWith(register);
    expect(infoMocks.registerHelpbox).toHaveBeenCalledWith(register, { helpModel });
  });
});
