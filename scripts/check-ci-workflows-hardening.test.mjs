import { test } from 'node:test';
import assert from 'node:assert/strict';
import { findMainConcurrencyViolations } from './check-ci-workflows.mjs';

const GOOD_GROUP = "ci-${{ github.ref == 'refs/heads/main' && github.sha || github.ref }}";
const BAD_GROUP = 'ci-${{ github.ref }}';

// --- multi-line dash-form `branches:` lists ---

test('flags dash-form branches: - main with a ref-only group', () => {
  const yaml = [
    'name: CI',
    '',
    'on:',
    '  push:',
    '    branches:',
    '      - main',
    '',
    'concurrency:',
    `  group: ${BAD_GROUP}`,
    "  cancel-in-progress: ${{ github.ref != 'refs/heads/main' }}",
  ].join('\n');
  const hits = findMainConcurrencyViolations(yaml, 'ci.yml');
  assert.equal(hits.length, 1);
  assert.equal(hits[0].line, 9);
});

test('accepts dash-form branches: - main with the conditional per-sha group', () => {
  const yaml = [
    'name: CI',
    '',
    'on:',
    '  push:',
    '    branches:',
    '      - main',
    '',
    'concurrency:',
    `  group: ${GOOD_GROUP}`,
    "  cancel-in-progress: ${{ github.ref != 'refs/heads/main' }}",
  ].join('\n');
  assert.equal(findMainConcurrencyViolations(yaml, 'ci.yml').length, 0);
});

test('does NOT flag dash-form branches: - develop with a ref-only group', () => {
  const yaml = [
    'name: CI',
    '',
    'on:',
    '  push:',
    '    branches:',
    '      - develop',
    '',
    'concurrency:',
    `  group: ${BAD_GROUP}`,
  ].join('\n');
  assert.equal(findMainConcurrencyViolations(yaml, 'ci.yml').length, 0);
});

// --- `push:` block with NO `branches:` filter ---

test('flags a branches-filter-less push: block with a ref-only group', () => {
  const yaml = [
    'name: CI',
    '',
    'on:',
    '  push:',
    '    paths:',
    '      - "**"',
    '',
    'concurrency:',
    `  group: ${BAD_GROUP}`,
  ].join('\n');
  const hits = findMainConcurrencyViolations(yaml, 'ci.yml');
  assert.equal(hits.length, 1);
  assert.equal(hits[0].line, 9);
});

test('accepts a branches-filter-less push: block with the conditional per-sha group', () => {
  const yaml = [
    'name: CI',
    '',
    'on:',
    '  push:',
    '    paths:',
    '      - "**"',
    '',
    'concurrency:',
    `  group: ${GOOD_GROUP}`,
  ].join('\n');
  assert.equal(findMainConcurrencyViolations(yaml, 'ci.yml').length, 0);
});

// --- shorthand `on:` values (`on: push`, `on: [push]`, `on: [push, pull_request]`) ---

test('flags shorthand on: push with a ref-only group', () => {
  const yaml = [
    'name: CI',
    '',
    'on: push',
    '',
    'concurrency:',
    `  group: ${BAD_GROUP}`,
  ].join('\n');
  const hits = findMainConcurrencyViolations(yaml, 'ci.yml');
  assert.equal(hits.length, 1);
  assert.equal(hits[0].line, 6);
});

test('accepts shorthand on: push with the conditional per-sha group', () => {
  const yaml = [
    'name: CI',
    '',
    'on: push',
    '',
    'concurrency:',
    `  group: ${GOOD_GROUP}`,
  ].join('\n');
  assert.equal(findMainConcurrencyViolations(yaml, 'ci.yml').length, 0);
});

test('flags shorthand on: [push] with a ref-only group', () => {
  const yaml = [
    'name: CI',
    '',
    'on: [push]',
    '',
    'concurrency:',
    `  group: ${BAD_GROUP}`,
  ].join('\n');
  const hits = findMainConcurrencyViolations(yaml, 'ci.yml');
  assert.equal(hits.length, 1);
  assert.equal(hits[0].line, 6);
});

test('accepts shorthand on: [push, pull_request] with the conditional per-sha group', () => {
  const yaml = [
    'name: CI',
    '',
    'on: [push, pull_request]',
    '',
    'concurrency:',
    `  group: ${GOOD_GROUP}`,
  ].join('\n');
  assert.equal(findMainConcurrencyViolations(yaml, 'ci.yml').length, 0);
});

test('flags shorthand on: [pull_request, push] with a ref-only group', () => {
  const yaml = [
    'name: CI',
    '',
    'on: [pull_request, push]',
    '',
    'concurrency:',
    `  group: ${BAD_GROUP}`,
  ].join('\n');
  const hits = findMainConcurrencyViolations(yaml, 'ci.yml');
  assert.equal(hits.length, 1);
  assert.equal(hits[0].line, 6);
});

test('does NOT flag shorthand on: pull_request (no push) with a ref-only group', () => {
  const yaml = [
    'name: CI',
    '',
    'on: [pull_request]',
    '',
    'concurrency:',
    `  group: ${BAD_GROUP}`,
  ].join('\n');
  assert.equal(findMainConcurrencyViolations(yaml, 'ci.yml').length, 0);
});
