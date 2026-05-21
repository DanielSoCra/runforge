export type DaemonDataBackendKind = 'postgres';

export interface DaemonDataBackendEnv {
  DAEMON_DATA_BACKEND?: string;
}

export function readDaemonDataBackendKind(
  env: DaemonDataBackendEnv = process.env,
): DaemonDataBackendKind {
  const raw = env.DAEMON_DATA_BACKEND?.trim().toLowerCase();
  if (raw === undefined || raw === '' || raw === 'postgres') return 'postgres';
  throw new Error(`DAEMON_DATA_BACKEND must be postgres; received ${raw}`);
}
