import { createClient } from '@supabase/supabase-js';

import { createPostgresBriefingBackend } from './postgres-backend.js';
import { createSupabaseBriefingBackend } from './supabase-backend.js';
import type { BriefingDataBackend } from './types.js';

export type BriefingDataBackendKind = 'supabase' | 'postgres';

export interface BriefingBackendEnv {
  BRIEFING_DATA_BACKEND?: string;
  SUPABASE_URL?: string;
  SUPABASE_SERVICE_ROLE_KEY?: string;
  AUTO_CLAUDE_DATABASE_URL?: string;
}

export function readBriefingDataBackendKind(
  env: BriefingBackendEnv = process.env,
): BriefingDataBackendKind {
  const raw = env.BRIEFING_DATA_BACKEND?.trim().toLowerCase();
  if (!raw || raw === 'supabase') return 'supabase';
  if (raw === 'postgres') return 'postgres';
  throw new Error(
    `BRIEFING_DATA_BACKEND must be one of: supabase, postgres; received ${raw}`,
  );
}

export function validateBriefingDataBackendEnv(
  env: BriefingBackendEnv = process.env,
): void {
  const backend = readBriefingDataBackendKind(env);
  const missing: string[] = [];

  if (backend === 'supabase') {
    if (!env.SUPABASE_URL) missing.push('SUPABASE_URL');
    if (!env.SUPABASE_SERVICE_ROLE_KEY) {
      missing.push('SUPABASE_SERVICE_ROLE_KEY');
    }
  } else if (!env.AUTO_CLAUDE_DATABASE_URL) {
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
  const backend = readBriefingDataBackendKind(env);
  if (backend === 'postgres') {
    return createPostgresBriefingBackend(env.AUTO_CLAUDE_DATABASE_URL);
  }

  return createSupabaseBriefingBackend(
    createClient(env.SUPABASE_URL!, env.SUPABASE_SERVICE_ROLE_KEY!, {
      auth: { persistSession: false },
    }),
  );
}
