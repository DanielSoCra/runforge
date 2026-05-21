// Retired compatibility shim. The daemon data backend is Postgres-only.

export function getSupabaseClient(): null {
  return null;
}

export function resetSupabaseClient(): void {
  // No-op retained for older tests and imports while traceability catches up.
}
