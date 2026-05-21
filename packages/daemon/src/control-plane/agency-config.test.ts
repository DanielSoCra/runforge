import { describe, it, expect, vi } from 'vitest';
import {
  readAgencyConfig,
  mergeAgencyConfig,
  type AgencyConfig,
} from './agency-config.js';

const DEFAULT_SETTINGS: AgencyConfig = {
  client: '',
  language: 'de',
  stack: 'astro',
  deploy_target: 'github-pages',
  source_url: null,
  start_from: null,
  features: [],
  checkpoints: {
    intelligence: 'checkpoint',
    brand: 'checkpoint',
    design: 'checkpoint',
    seo: 'auto',
    content: 'checkpoint',
    assets: 'auto',
    build: 'auto',
    qa: 'auto',
    launch: 'checkpoint',
  },
};

describe('mergeAgencyConfig', () => {
  it('returns defaults when no overrides', () => {
    const result = mergeAgencyConfig(DEFAULT_SETTINGS, {});
    expect(result.stack).toBe('astro');
    expect(result.language).toBe('de');
  });

  it('repo-level overrides win over global defaults', () => {
    const result = mergeAgencyConfig(DEFAULT_SETTINGS, {
      stack: 'native',
      language: 'en',
    });
    expect(result.stack).toBe('native');
    expect(result.language).toBe('en');
  });

  it('checkpoint overrides merge at key level', () => {
    const result = mergeAgencyConfig(DEFAULT_SETTINGS, {
      checkpoints: { brand: 'auto' },
    });
    expect(result.checkpoints.brand).toBe('auto');
    expect(result.checkpoints.seo).toBe('auto'); // unchanged
    expect(result.checkpoints.launch).toBe('checkpoint'); // unchanged
  });

  it('features array replaced entirely by override', () => {
    const result = mergeAgencyConfig(DEFAULT_SETTINGS, {
      features: ['blog-setup', 'contact-form'],
    });
    expect(result.features).toEqual(['blog-setup', 'contact-form']);
  });

  it('source_url null in defaults can be overridden', () => {
    const result = mergeAgencyConfig(DEFAULT_SETTINGS, {
      source_url: 'https://example.com',
    });
    expect(result.source_url).toBe('https://example.com');
  });
});

describe('readAgencyConfig', () => {
  it('merges global settings with repo plugin config', async () => {
    const mockConfigStore = {
      from: vi.fn().mockImplementation((table: string) => ({
        select: vi.fn().mockReturnThis(),
        eq: vi.fn().mockReturnThis(),
        single: vi
          .fn()
          .mockResolvedValue(
            table === 'plugin_global_settings'
              ? { data: { settings: { default_stack: 'native' } }, error: null }
              : { data: { config: { language: 'en' } }, error: null },
          ),
      })),
    } as any;

    const result = await readAgencyConfig(mockConfigStore, 'repo-123');
    expect(result.stack).toBe('native');
    expect(result.language).toBe('en');
  });

  it('falls back to defaults when the config store returns no data', async () => {
    const mockConfigStore = {
      from: vi.fn().mockImplementation(() => ({
        select: vi.fn().mockReturnThis(),
        eq: vi.fn().mockReturnThis(),
        single: vi
          .fn()
          .mockResolvedValue({ data: null, error: { message: 'not found' } }),
      })),
    } as any;

    const result = await readAgencyConfig(mockConfigStore, 'repo-123');
    expect(result.stack).toBe('astro');
    expect(result.language).toBe('de');
  });

  it('returns defaults immediately when the config store is null', async () => {
    const result = await readAgencyConfig(null, '');
    expect(result.stack).toBe('astro');
    expect(result.language).toBe('de');
    expect(result.checkpoints.intelligence).toBe('checkpoint');
  });
});
