// src/session-runtime/offload.ts
import { writeFile } from 'fs/promises';
import { join } from 'path';
import { randomUUID } from 'crypto';

export interface OffloadResult {
  offloaded: boolean;
  content: string;
  originalSize?: number;
  filePath?: string;
}

export async function maybeOffload(
  content: string,
  workspacePath: string,
  threshold: number = 200_000,
): Promise<OffloadResult> {
  if (content.length <= threshold) {
    return { offloaded: false, content };
  }

  const fileName = `offloaded-${randomUUID()}.txt`;
  const filePath = join(workspacePath, '.offload', fileName);

  // Ensure directory exists
  const { mkdir } = await import('fs/promises');
  await mkdir(join(workspacePath, '.offload'), { recursive: true });
  await writeFile(filePath, content);

  return {
    offloaded: true,
    content: `Response too large (${content.length} chars). Content saved to: ${filePath}. Read specific sections as needed.`,
    originalSize: content.length,
    filePath,
  };
}
