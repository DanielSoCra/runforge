import { test } from 'node:test';
import assert from 'node:assert/strict';
import { extractPaths } from './check-traceability-paths.mjs';

test('extracts a single code_paths entry', () => {
  const yaml = ['FOO-BAR:', '  code_paths:', '    - packages/x/src/y.ts'].join('\n');
  const entries = extractPaths(yaml);
  assert.deepEqual(entries, [{ specId: 'FOO-BAR', path: 'packages/x/src/y.ts' }]);
});

test('extracts both code_paths and test_paths under the same spec', () => {
  const yaml = [
    'FOO-BAR:',
    '  code_paths:',
    '    - packages/x/src/y.ts',
    '  test_paths:',
    '    - packages/x/src/y.test.ts',
  ].join('\n');
  const entries = extractPaths(yaml);
  assert.deepEqual(entries, [
    { specId: 'FOO-BAR', path: 'packages/x/src/y.ts' },
    { specId: 'FOO-BAR', path: 'packages/x/src/y.test.ts' },
  ]);
});

test('skips an inline empty array', () => {
  const yaml = ['FOO-BAR:', '  code_paths: []', '  test_paths:', '    - packages/x/src/y.test.ts'].join('\n');
  const entries = extractPaths(yaml);
  assert.deepEqual(entries, [{ specId: 'FOO-BAR', path: 'packages/x/src/y.test.ts' }]);
});

test('a following non-list key ends the path block', () => {
  const yaml = ['FOO-BAR:', '  code_paths:', '    - packages/x/src/y.ts', '  status: draft'].join('\n');
  const entries = extractPaths(yaml);
  assert.deepEqual(entries, [{ specId: 'FOO-BAR', path: 'packages/x/src/y.ts' }]);
});

test('attributes paths to the correct spec across multiple entries', () => {
  const yaml = [
    'FOO-BAR:',
    '  code_paths:',
    '    - packages/x/src/a.ts',
    'BAZ-QUX:',
    '  code_paths:',
    '    - packages/y/src/b.ts',
  ].join('\n');
  const entries = extractPaths(yaml);
  assert.deepEqual(entries, [
    { specId: 'FOO-BAR', path: 'packages/x/src/a.ts' },
    { specId: 'BAZ-QUX', path: 'packages/y/src/b.ts' },
  ]);
});
