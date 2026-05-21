import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtemp, writeFile, rm } from 'fs/promises';
import { join } from 'path';
import { tmpdir } from 'os';
import type { Config } from '../config.js';
import {
  __clearGovernanceCacheForTests,
  loadGovernanceContext,
  resolveGovernanceDocument,
} from './governance-context.js';

const baseConfig = {
  dailyBudget: 50,
  perRunBudget: 10,
  governance: {
    documentPath: 'FACTORY_RULES.md',
    maxPrLinesChanged: 1200,
  },
} as Config;

describe('resolveGovernanceDocument', () => {
  it('substitutes configured governance values', () => {
    const rendered = resolveGovernanceDocument(
      'daily={{dailyBudget}} run={{perRunBudget}} size={{maxPrLinesChanged}}',
      { dailyBudget: '$50', perRunBudget: '$10', maxPrLinesChanged: '1200 lines' },
    );

    expect(rendered).toBe('daily=$50 run=$10 size=1200 lines');
  });

  it('rejects unresolved governance parameters', () => {
    expect(() => resolveGovernanceDocument('missing {{unknownValue}}', {
      dailyBudget: '$50',
      perRunBudget: '$10',
      maxPrLinesChanged: '1200 lines',
    })).toThrow(/unresolved governance parameter/i);
  });
});

describe('loadGovernanceContext', () => {
  let dir: string;

  beforeEach(async () => {
    __clearGovernanceCacheForTests();
    dir = await mkdtemp(join(tmpdir(), 'governance-'));
  });

  afterEach(async () => {
    __clearGovernanceCacheForTests();
    await rm(dir, { recursive: true, force: true });
  });

  it('loads and renders FACTORY_RULES from the configured root', async () => {
    await writeFile(
      join(dir, 'FACTORY_RULES.md'),
      '# Rules\n\nBudget {{dailyBudget}}\nRun {{perRunBudget}}\nSize {{maxPrLinesChanged}}',
    );

    const result = await loadGovernanceContext(baseConfig, dir);

    expect(result.content).toContain('Budget $50');
    expect(result.content).toContain('Run $10');
    expect(result.content).toContain('Size 1200 lines');
    expect(result.sourcePath).toBe(join(dir, 'FACTORY_RULES.md'));
  });

  it('rejects a missing governance document', async () => {
    const config = {
      ...baseConfig,
      governance: { ...baseConfig.governance, documentPath: 'missing-rules.md' },
    } as Config;

    await expect(loadGovernanceContext(config, dir)).rejects.toThrow(/governance document not found/i);
  });

  it('rejects an empty governance document', async () => {
    await writeFile(join(dir, 'FACTORY_RULES.md'), '  \n');

    await expect(loadGovernanceContext(baseConfig, dir)).rejects.toThrow(/governance document is empty/i);
  });
});
