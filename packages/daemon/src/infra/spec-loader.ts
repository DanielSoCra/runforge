// src/infra/spec-loader.ts
import { readdir, readFile } from 'node:fs/promises';
import { join } from 'node:path';

const SPEC_DIRS = ['functional', 'architecture', 'stack'] as const;

/**
 * Load spec file content for given spec IDs by scanning .specify/ frontmatter.
 * Returns concatenated spec content for all matched IDs.
 * Unmatched IDs are silently skipped (specs may reference draft/unwritten specs).
 */
export async function loadSpecContent(
  specRefs: string[],
  specifyRoot: string,
): Promise<string> {
  if (specRefs.length === 0) return '';

  const refSet = new Set(specRefs);
  const matched: string[] = [];

  for (const dir of SPEC_DIRS) {
    const dirPath = join(specifyRoot, dir);
    let files: string[];
    try {
      files = await readdir(dirPath);
    } catch {
      continue; // directory may not exist
    }

    for (const file of files) {
      if (!file.endsWith('.md')) continue;
      const filePath = join(dirPath, file);
      const content = await readFile(filePath, 'utf-8');
      const id = extractSpecId(content);
      if (id && refSet.has(id)) {
        matched.push(content);
        refSet.delete(id);
        if (refSet.size === 0) break;
      }
    }
    if (refSet.size === 0) break;
  }

  return matched.join('\n\n---\n\n');
}

function extractSpecId(content: string): string | null {
  // Extract frontmatter block between --- delimiters, then match id within it
  const fmMatch = content.match(/^---\s*\n([\s\S]*?)\n---/);
  if (!fmMatch) return null;
  const idMatch = fmMatch[1]!.match(/^id:\s*(.+)$/m);
  return idMatch?.[1]?.trim() ?? null;
}
