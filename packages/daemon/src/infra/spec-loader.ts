// src/infra/spec-loader.ts
import { readdir, readFile, stat } from 'node:fs/promises';
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

// Default budget: 30 KB keeps total prompt (bugReport + implementation + specs)
// well within a single reasoning context. STACK-AC-DIAGNOSIS says to truncate
// implementation content proactively if it risks exceeding the context window.
const DEFAULT_IMPLEMENTATION_BUDGET = 30_000;

/**
 * Load implementation file content for given spec IDs by resolving code_paths
 * from traceability.yml. Returns concatenated file content with path headers.
 * Truncates to stay within the byte budget (STACK-AC-DIAGNOSIS context constraint).
 */
export async function loadImplementationContent(
  specRefs: string[],
  repoRoot: string,
  budget = DEFAULT_IMPLEMENTATION_BUDGET,
): Promise<string> {
  if (specRefs.length === 0) return '';

  const traceabilityPath = join(repoRoot, '.specify', 'traceability.yml');
  let traceContent: string;
  try {
    traceContent = await readFile(traceabilityPath, 'utf-8');
  } catch {
    return '';
  }

  const codePaths = extractCodePaths(traceContent, new Set(specRefs));
  if (codePaths.length === 0) return '';

  // Expand directory entries into their .ts/.tsx files, deduplicate
  const filePaths = await expandCodePaths(codePaths, repoRoot);
  if (filePaths.length === 0) return '';

  const sections: string[] = [];
  let totalSize = 0;

  for (const relPath of filePaths) {
    const absPath = join(repoRoot, relPath);
    let content: string;
    try {
      content = await readFile(absPath, 'utf-8');
    } catch {
      continue;
    }

    const header = `\n--- ${relPath} ---\n`;
    const section = header + content;

    if (totalSize + section.length > budget) {
      // Add as much of this file as fits
      const remaining = budget - totalSize;
      if (remaining > header.length + 100) {
        sections.push(header + content.slice(0, remaining - header.length) + '\n[truncated]');
      }
      break;
    }

    sections.push(section);
    totalSize += section.length;
  }

  return sections.join('\n');
}

/**
 * Expand code_paths into concrete file paths. Directories are expanded to their
 * .ts/.tsx source files (non-recursive, test files excluded). Globs and missing
 * paths are skipped. Results are deduplicated and returned in stable order.
 */
async function expandCodePaths(codePaths: string[], repoRoot: string): Promise<string[]> {
  const seen = new Set<string>();
  const result: string[] = [];

  for (const relPath of codePaths) {
    if (relPath.includes('*')) continue; // skip globs
    if (seen.has(relPath)) continue;

    const absPath = join(repoRoot, relPath);
    let info;
    try {
      info = await stat(absPath);
    } catch {
      continue;
    }

    if (info.isFile()) {
      seen.add(relPath);
      result.push(relPath);
    } else if (info.isDirectory()) {
      let entries: string[];
      try {
        entries = await readdir(absPath);
      } catch {
        continue;
      }
      for (const entry of entries.sort()) {
        if (!entry.endsWith('.ts') && !entry.endsWith('.tsx')) continue;
        if (entry.endsWith('.test.ts') || entry.endsWith('.test.tsx')) continue;
        const childRel = join(relPath, entry);
        if (seen.has(childRel)) continue;
        // Verify it's a file (not a subdirectory ending in .ts)
        try {
          const childInfo = await stat(join(repoRoot, childRel));
          if (!childInfo.isFile()) continue;
        } catch {
          continue;
        }
        seen.add(childRel);
        result.push(childRel);
      }
    }
  }

  return result;
}

/**
 * Parse traceability.yml and extract code_paths for the given spec IDs.
 * Line-by-line parsing — no yaml dependency needed (matches traceability-paths.test.ts approach).
 */
export function extractCodePaths(traceContent: string, specIds: Set<string>): string[] {
  const paths: string[] = [];
  let currentSpec = '';
  let inCodePaths = false;

  for (const line of traceContent.split('\n')) {
    const specMatch = line.match(/^([A-Z][A-Z0-9_-]+):\s*$/);
    if (specMatch) {
      currentSpec = specMatch[1]!;
      inCodePaths = false;
      continue;
    }

    // Inline code_paths: [path1, path2]
    const inlineMatch = line.match(/^\s+code_paths:\s*\[(.+)\]\s*$/);
    if (inlineMatch && specIds.has(currentSpec)) {
      const items = inlineMatch[1]!.split(',').map(s => s.trim());
      paths.push(...items);
      inCodePaths = false;
      continue;
    }

    if (/^\s+code_paths:\s*$/.test(line)) {
      inCodePaths = specIds.has(currentSpec);
      continue;
    }

    if (inCodePaths && /^\s+-\s+/.test(line)) {
      const path = line.replace(/^\s+-\s+/, '').trim();
      if (path) paths.push(path);
      continue;
    }

    if (/^\s+\w+:/.test(line)) {
      inCodePaths = false;
    }
  }

  return paths;
}

function extractSpecId(content: string): string | null {
  // Extract frontmatter block between --- delimiters, then match id within it
  const fmMatch = content.match(/^---\s*\n([\s\S]*?)\n---/);
  if (!fmMatch) return null;
  const idMatch = fmMatch[1]!.match(/^id:\s*(.+)$/m);
  return idMatch?.[1]?.trim() ?? null;
}
