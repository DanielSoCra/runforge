export function readObject(value: unknown): Record<string, unknown> {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) {
    throw new Error('args must be an object');
  }
  return value as Record<string, unknown>;
}

export function readStringArg(args: unknown, key: string): string {
  const value = readObject(args)[key];
  if (typeof value !== 'string' || value.length === 0) {
    throw new Error(`${key} must be a non-empty string`);
  }
  return value;
}

export function readNumberArg(args: unknown, key: string): number {
  const value = readObject(args)[key];
  if (typeof value !== 'number' || !Number.isFinite(value)) {
    throw new Error(`${key} must be a finite number`);
  }
  return value;
}
