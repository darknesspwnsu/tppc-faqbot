// rpg/credentials.js
// Shared helpers for RPG credential checks.

export function hasRpgCredentials() {
  return Boolean(process.env.RPG_USERNAME && process.env.RPG_PASSWORD);
}

export function logMissingRpgCredentials(commandLabel) {
  console.error(`[rpg] RPG_USERNAME/RPG_PASSWORD not configured for ${commandLabel}`);
}

export function requireRpgCredentials(commandLabel) {
  if (hasRpgCredentials()) return true;
  logMissingRpgCredentials(commandLabel);
  return false;
}
