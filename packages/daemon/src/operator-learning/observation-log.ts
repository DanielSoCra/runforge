// packages/daemon/src/operator-learning/observation-log.ts
//
// Append-only observation log with Zod validation on read.

import { mkdir } from 'fs/promises';
import { dirname } from 'path';
import { appendJsonl, readJsonl } from '../lib/json-store.js';
import { ObservationSchema, type Observation } from './types.js';

export async function appendObservation(path: string, observation: Observation): Promise<void> {
  await mkdir(dirname(path), { recursive: true });
  await appendJsonl(path, observation);
}

export async function readObservations(path: string): Promise<Observation[]> {
  const raw = await readJsonl<unknown>(path);
  const observations: Observation[] = [];
  for (const entry of raw) {
    const parsed = ObservationSchema.safeParse(entry);
    if (parsed.success) {
      observations.push(parsed.data);
    }
  }
  return observations;
}

export function observationsForKey(
  observations: Observation[],
  decisionClass: string,
  context: string,
): Observation[] {
  return observations.filter(
    (o) =>
      o.decisionClass === decisionClass &&
      o.context === context,
  );
}

export function generateObservationId(): string {
  return `obs-${Date.now()}-${Math.random().toString(36).slice(2, 10)}`;
}
