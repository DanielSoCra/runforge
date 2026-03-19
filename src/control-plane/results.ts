// src/control-plane/results.ts
import { appendJsonl, readJsonl } from '../lib/json-store.js';
import type { ResultsRecord } from '../types.js';

const RESULTS_PATH = 'state/results.jsonl';

export async function appendResult(record: ResultsRecord, stateDir?: string): Promise<void> {
  const path = stateDir ? `${stateDir}/results.jsonl` : RESULTS_PATH;
  await appendJsonl(path, record);
}

export async function readResults(stateDir?: string): Promise<ResultsRecord[]> {
  const path = stateDir ? `${stateDir}/results.jsonl` : RESULTS_PATH;
  return readJsonl<ResultsRecord>(path);
}
