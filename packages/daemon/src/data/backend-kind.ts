export type DaemonDataBackendKind = 'auto' | 'legacy' | 'supabase' | 'postgres';

export interface DaemonDataBackendEnv {
  DAEMON_DATA_BACKEND?: string;
}

export function readDaemonDataBackendKind(
  env: DaemonDataBackendEnv = process.env,
): DaemonDataBackendKind {
  const raw = env.DAEMON_DATA_BACKEND?.trim().toLowerCase();
  if (raw === undefined || raw === '') return 'auto';
  if (
    raw === 'auto' ||
    raw === 'legacy' ||
    raw === 'supabase' ||
    raw === 'postgres'
  ) {
    return raw;
  }
  throw new Error(
    `DAEMON_DATA_BACKEND must be one of: auto, legacy, supabase, postgres; received ${raw}`,
  );
}
