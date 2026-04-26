// src/knowledge-sync/manifest.ts
import { readFile } from 'fs/promises';
import matter from 'gray-matter';
import { VaultAccessManifestSchema, type VaultAccessManifest } from './types.js';

const MANIFEST_RELATIVE_PATH = '00-Meta/auto-claude-sync.md';

export function getManifestPath(vaultRoot: string): string {
  return `${vaultRoot}/${MANIFEST_RELATIVE_PATH}`;
}

export async function readVaultManifest(manifestPath: string): Promise<VaultAccessManifest | null> {
  let raw: string;
  try {
    raw = await readFile(manifestPath, 'utf-8');
  } catch (e: unknown) {
    const err = e as NodeJS.ErrnoException;
    if (err.code === 'ENOENT') return null;
    throw e;
  }

  const { data } = matter(raw);
  const result = VaultAccessManifestSchema.safeParse(data);
  if (!result.success) {
    throw new Error('Manifest parse error: ' + result.error.message);
  }
  return result.data;
}
