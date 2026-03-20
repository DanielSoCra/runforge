import { describe, it, expect } from 'vitest';
import { shouldCheckpoint, formatCheckpointComment } from './checkpoint.js';
import type { AgencyCheckpoints } from './agency-config.js';

const CHECKPOINTS: AgencyCheckpoints = {
  intelligence: 'checkpoint',
  brand: 'checkpoint',
  design: 'checkpoint',
  seo: 'auto',
  content: 'checkpoint',
  assets: 'auto',
  build: 'auto',
  qa: 'auto',
  launch: 'checkpoint',
};

describe('shouldCheckpoint', () => {
  it('returns true when phase is set to checkpoint', () => {
    expect(shouldCheckpoint('brand', CHECKPOINTS)).toBe(true);
  });

  it('returns false when phase is set to auto', () => {
    expect(shouldCheckpoint('seo', CHECKPOINTS)).toBe(false);
  });

  it('returns false for unknown phases', () => {
    expect(shouldCheckpoint('unknown' as any, CHECKPOINTS)).toBe(false);
  });
});

describe('formatCheckpointComment', () => {
  it('includes the phase name', () => {
    const comment = formatCheckpointComment('brand', ['docs/02-brand/brand_guide.md', 'docs/02-brand/brand_assets.json']);
    expect(comment).toContain('brand');
  });

  it('includes each deliverable file path', () => {
    const comment = formatCheckpointComment('brand', ['docs/02-brand/brand_guide.md']);
    expect(comment).toContain('docs/02-brand/brand_guide.md');
  });

  it('includes resume instructions mentioning ready', () => {
    const comment = formatCheckpointComment('brand', []);
    expect(comment).toContain('ready');
  });
});
