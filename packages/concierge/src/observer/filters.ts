const SECRET_SEGMENTS = new Set(['secrets', '.secrets']);
const SECRET_FILENAMES = new Set(['.env', '.env.local', '.env.production']);

export function shouldIgnoreObservedPath(path: string): boolean {
  const segments = path.split(/[\\/]/).filter(Boolean);
  const filename = segments.at(-1) ?? '';
  if (SECRET_FILENAMES.has(filename)) return true;
  return segments.some((segment) => SECRET_SEGMENTS.has(segment));
}
