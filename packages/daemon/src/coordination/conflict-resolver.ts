import { git } from '../lib/git.js';
import { runCommand } from '../lib/process.js';
import { ok, err, type Result } from '../lib/result.js';

export interface ConflictInfo {
  files: string[];
  fileCount: number;
  totalConflictMarkers: number;
}

export interface ConflictResolution {
  resolved: boolean;
  needsHuman: boolean;
  reason?: string;
}

export interface ConflictResolverConfig {
  conflictFileThreshold: number;
  conflictLineThreshold: number;
}

/**
 * Detect conflict size from working directory by parsing
 * `git diff --name-only --diff-filter=U` and counting conflict markers.
 */
export async function detectConflicts(cwd: string): Promise<Result<ConflictInfo>> {
  const diffResult = await git(['diff', '--name-only', '--diff-filter=U'], cwd);
  if (!diffResult.ok) return diffResult;

  const output = diffResult.value.trim();
  const files = output ? output.split('\n').filter(Boolean) : [];

  let totalConflictMarkers = 0;
  for (const file of files) {
    const grepResult = await runCommand('grep', ['-c', '<<<<<<<', file], { cwd });
    if (grepResult.ok) {
      totalConflictMarkers += parseInt(grepResult.value, 10) || 0;
    }
  }

  return ok({
    files,
    fileCount: files.length,
    totalConflictMarkers,
  });
}

/**
 * Check if conflict is small enough for auto-resolution.
 */
export function isSmallConflict(info: ConflictInfo, config: ConflictResolverConfig): boolean {
  return (
    info.fileCount <= config.conflictFileThreshold &&
    info.totalConflictMarkers <= config.conflictLineThreshold
  );
}

/**
 * Attempt resolution: check size, if small invoke resolveSession callback,
 * if large return needs_human.
 */
export async function resolveConflicts(
  cwd: string,
  config: ConflictResolverConfig,
  resolveSession: (files: string[], cwd: string) => Promise<Result<void>>,
): Promise<ConflictResolution> {
  const detectResult = await detectConflicts(cwd);
  if (!detectResult.ok) {
    return { resolved: false, needsHuman: true, reason: detectResult.error.message };
  }

  const info = detectResult.value;

  if (!isSmallConflict(info, config)) {
    return {
      resolved: false,
      needsHuman: true,
      reason: `Conflict too large: ${info.fileCount} files, ${info.totalConflictMarkers} conflict lines`,
    };
  }

  const sessionResult = await resolveSession(info.files, cwd);
  if (!sessionResult.ok) {
    return { resolved: false, needsHuman: true, reason: sessionResult.error.message };
  }

  return { resolved: true, needsHuman: false };
}
