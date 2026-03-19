import { describe, it, expect } from 'vitest';
import { processSingleIssue } from './process-single.js';

describe('processSingleIssue', () => {
  it('returns error for missing config', async () => {
    const result = await processSingleIssue(999, '/nonexistent/config.json');
    expect(result.ok).toBe(false);
  });
});
