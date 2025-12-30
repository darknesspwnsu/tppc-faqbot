import { describe, it, expect, vi } from "vitest";

vi.mock("../../verification/verifyme.js", () => ({
  registerVerifyMe: vi.fn(),
  registerUnverify: vi.fn(),
}));

vi.mock("../../verification/whois.js", () => ({
  registerWhois: vi.fn(),
}));

import { registerVerifyMe, registerUnverify } from "../../verification/verifyme.js";
import { registerWhois } from "../../verification/whois.js";
import { registerVerification, listVerificationModules } from "../../verification/verification.js";

describe("verification registry", () => {
  it("registers all verification modules", () => {
    const register = vi.fn();
    registerVerification(register);

    expect(registerVerifyMe).toHaveBeenCalledWith(register);
    expect(registerUnverify).toHaveBeenCalledWith(register);
    expect(registerWhois).toHaveBeenCalledWith(register);
  });

  it("lists verification modules", () => {
    expect(listVerificationModules()).toEqual(["verifyme", "unverify", "whois"]);
  });
});
