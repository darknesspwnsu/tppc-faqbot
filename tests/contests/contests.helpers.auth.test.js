import { describe, expect, test, vi } from "vitest";

vi.mock("../../auth.js", () => ({
  isAdminOrPrivileged: vi.fn(),
}));

import { isAdminOrPrivileged } from "../../auth.js";
import { isAdminOrPrivilegedMessage } from "../../contests/helpers.js";

describe("isAdminOrPrivilegedMessage", () => {
  test("returns true/false based on auth helper", () => {
    isAdminOrPrivileged.mockReturnValue(true);
    expect(isAdminOrPrivilegedMessage({})).toBe(true);

    isAdminOrPrivileged.mockReturnValue(false);
    expect(isAdminOrPrivilegedMessage({})).toBe(false);
  });

  test("returns false when auth helper throws", () => {
    isAdminOrPrivileged.mockImplementation(() => {
      throw new Error("boom");
    });
    expect(isAdminOrPrivilegedMessage({})).toBe(false);
  });
});
