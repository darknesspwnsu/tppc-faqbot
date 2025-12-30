// verification/verification_module.js
//
// Central registry for all verification-related modules.
// Add new verification commands by importing + appending to VERIFICATION_MODULES.

import { registerVerifyMe, registerUnverify } from "./verifyme.js";
import { registerWhois } from "./whois.js";

const VERIFICATION_MODULES = [
  { id: "verifyme", register: registerVerifyMe },
  { id: "unverify", register: registerUnverify },
  { id: "whois", register: registerWhois },
];

export function registerVerification(register) {
  for (const m of VERIFICATION_MODULES) {
    try {
      m.register(register);
    } catch (e) {
      console.error(`[verification] failed to register ${m.id}:`, e);
    }
  }
}

export function listVerificationModules() {
  return VERIFICATION_MODULES.map((m) => m.id);
}
