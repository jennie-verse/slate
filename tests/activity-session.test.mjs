import test from 'node:test';
import assert from 'node:assert/strict';
import { sessionRecords } from '../src/activity-session.js';

test('usage-session records preserve wall-clock bounds and active seconds', () => {
  const rows = sessionRecords({ id: 'session-1', itemId: 'item-1', title: 'Item', itemType: 'item', startedAt: new Date(2026, 7, 31, 10, 2).getTime(), endedAt: new Date(2026, 7, 31, 10, 32).getTime(), activeSeconds: 1500 }, 'usage-session');
  assert.equal(rows.length, 1);
  assert.equal(rows[0].kind, 'usage-session');
  assert.equal(rows[0].data.activeSeconds, 1500);
  assert.match(rows[0].data.startedAt, /T10:02:00/);
  assert.match(rows[0].data.endedAt, /T10:32:00/);
});

test('usage-session records split safely at local midnight', () => {
  const rows = sessionRecords({ id: 'session-2', itemId: 'item-2', title: 'Item', startedAt: new Date(2026, 7, 31, 23, 50).getTime(), endedAt: new Date(2026, 8, 1, 0, 10).getTime(), activeSeconds: 1200 }, 'usage-session');
  assert.equal(rows.length, 2);
  assert.notEqual(rows[0].id, rows[1].id);
  assert.equal(rows.reduce((sum, row) => sum + row.data.activeSeconds, 0), 1200);
});
