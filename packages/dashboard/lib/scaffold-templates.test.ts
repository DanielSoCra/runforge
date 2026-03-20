import { describe, it, expect } from 'vitest';
import {
  buildL0Vision,
  buildAgentsMd,
  buildClaudeMd,
  buildTraceabilityYml,
  buildWorkflowYml,
} from './scaffold-templates';

describe('scaffold templates', () => {
  it('buildL0Vision includes project name and vision', () => {
    const out = buildL0Vision('My Project', 'Build something great');
    expect(out).toContain('My Project');
    expect(out).toContain('Build something great');
  });

  it('buildAgentsMd returns non-empty markdown', () => {
    const out = buildAgentsMd();
    expect(out).toContain('AGENTS.md');
  });

  it('buildClaudeMd references AGENTS.md', () => {
    const out = buildClaudeMd();
    expect(out).toContain('@AGENTS.md');
  });

  it('buildTraceabilityYml includes project name', () => {
    const out = buildTraceabilityYml('My Project');
    expect(out).toContain('My Project');
    expect(out).toContain('traceability');
  });

  it('buildWorkflowYml sets extends to default', () => {
    const out = buildWorkflowYml();
    expect(out).toContain('extends: default');
  });
});
