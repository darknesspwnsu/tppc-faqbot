// shared/logging_helpers.js
// Shared logging helpers for consistent module registration errors.

export function logRegisterFailure(scope, id, err) {
  console.error(`[${scope}] failed to register ${id}:`, err);
}
