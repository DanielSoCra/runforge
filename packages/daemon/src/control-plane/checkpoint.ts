import type { AgencyCheckpoints } from './agency-config.js';

export function shouldCheckpoint(
  phase: string,
  checkpoints: AgencyCheckpoints,
): boolean {
  return (checkpoints as unknown as Record<string, string>)[phase] === 'checkpoint';
}

export function formatCheckpointComment(phase: string, deliverables: string[]): string {
  const files = deliverables.length > 0
    ? '\n\n**Deliverables:**\n' + deliverables.map(f => `- \`${f}\``).join('\n')
    : '';

  return `## ✅ ${phase} phase complete — checkpoint

The \`${phase}\` phase has finished.${files}

**To continue:** add the \`ready\` label to this issue and the pipeline will resume from the next phase automatically.`;
}
