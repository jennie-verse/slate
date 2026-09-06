import test from 'node:test';
import assert from 'node:assert/strict';
import { deploymentSourceUrl, pagesOwner, webappDataConfig } from '../src/deployment.js';

test('export source follows the actual deployment URL', () => {
  assert.equal(deploymentSourceUrl({ href: 'https://another.github.io/slate/index.html' }), 'https://another.github.io/slate/');
  assert.equal(deploymentSourceUrl({ href: 'https://draw.example/tools/slate/' }), 'https://draw.example/tools/slate/');
});

test('Journal owner follows GitHub Pages and refuses ambiguous custom domains', () => {
  assert.equal(pagesOwner({ hostname: 'another.github.io' }), 'another');
  assert.equal(webappDataConfig('t', { hostname: 'another.github.io' }).owner, 'another');
  assert.throws(() => pagesOwner({ hostname: 'draw.example' }), { code: 'PAGES_OWNER_UNRESOLVED' });
});
