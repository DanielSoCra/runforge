import { createPostgresBriefingBackend } from './postgres-backend.js';
import type { BriefingDataBackend } from './types.js';

export type BriefingDataBackendKind = 'postgres';

export interface BriefingBackendEnv {
  BRIEFING_DATA_BACKEND?: string;
  AUTO_CLAUDE_DATABASE_URL?: string;
}

export function readBriefingDataBackendKind(
  env: BriefingBackendEnv = process.env,
): BriefingDataBackendKind {
  const raw = env.BRIEFING_DATA_BACKEND?.trim().toLowerCase();
  if (!raw || raw === 'postgres') return 'postgres';
  throw new Error(
    `BRIEFING_DATA_BACKEND must be postgres; received ${raw}`,
  );
}

export function validateBriefingDataBackendEnv(
  env: BriefingBackendEnv = process.env,
): void {
  const missing: string[] = [];

  readBriefingDataBackendKind(env);
  if (!env.AUTO_CLAUDE_DATABASE_URL) {
    missing.push('AUTO_CLAUDE_DATABASE_URL');
  }

  if (missing.length > 0) {
    throw new Error(
      `Missing required environment variables: ${missing.join(', ')}`,
    );
  }
}

export function createBriefingDataBackend(
  env: BriefingBackendEnv = process.env,
): BriefingDataBackend {
  readBriefingDataBackendKind(env);
  return createPostgresBriefingBackend(env.AUTO_CLAUDE_DATABASE_URL);
}
