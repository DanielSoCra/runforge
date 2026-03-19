// src/knowledge/extractor.test.ts
import { describe, it, expect } from 'vitest';
import { extractPitfalls } from './extractor.js';

describe('extractPitfalls', () => {
  it('extracts a valid pitfall marker from output', () => {
    const output = `Some text <!-- PITFALL: {"artifactPatterns":["src/**/*.ts"],"description":"Use strict types"} --> more text`;
    const markers = extractPitfalls(output);
    expect(markers).toHaveLength(1);
    expect(markers[0]).toEqual({
      artifactPatterns: ['src/**/*.ts'],
      description: 'Use strict types',
    });
  });

  it('handles multiple pitfall markers', () => {
    const output = [
      '<!-- PITFALL: {"artifactPatterns":["src/**/*.ts"],"description":"First"} -->',
      '<!-- PITFALL: {"artifactPatterns":["docs/**/*.md"],"description":"Second"} -->',
    ].join('\n');
    const markers = extractPitfalls(output);
    expect(markers).toHaveLength(2);
    expect(markers[0]!.description).toBe('First');
    expect(markers[1]!.description).toBe('Second');
  });

  it('returns empty array when no markers present', () => {
    const output = 'No pitfall markers here. Just normal text.';
    const markers = extractPitfalls(output);
    expect(markers).toHaveLength(0);
  });

  it('skips malformed JSON', () => {
    const output = '<!-- PITFALL: {not valid json} -->';
    const markers = extractPitfalls(output);
    expect(markers).toHaveLength(0);
  });

  it('skips markers missing required fields', () => {
    const output = '<!-- PITFALL: {"artifactPatterns":["src/**"]} -->';
    const markers = extractPitfalls(output);
    expect(markers).toHaveLength(0);
  });

  it('skips markers where artifactPatterns is not an array', () => {
    const output = '<!-- PITFALL: {"artifactPatterns":"src/**","description":"Bad"} -->';
    const markers = extractPitfalls(output);
    expect(markers).toHaveLength(0);
  });

  it('skips markers where description is not a string', () => {
    const output = '<!-- PITFALL: {"artifactPatterns":["src/**"],"description":42} -->';
    const markers = extractPitfalls(output);
    expect(markers).toHaveLength(0);
  });

  it('coerces artifactPatterns items to strings', () => {
    const output = '<!-- PITFALL: {"artifactPatterns":[1,2],"description":"nums"} -->';
    const markers = extractPitfalls(output);
    expect(markers).toHaveLength(1);
    expect(markers[0]!.artifactPatterns).toEqual(['1', '2']);
  });

  it('handles mixed valid and invalid markers', () => {
    const output = [
      '<!-- PITFALL: {bad json} -->',
      '<!-- PITFALL: {"artifactPatterns":["**/*.ts"],"description":"Valid"} -->',
    ].join('\n');
    const markers = extractPitfalls(output);
    expect(markers).toHaveLength(1);
    expect(markers[0]!.description).toBe('Valid');
  });
});
