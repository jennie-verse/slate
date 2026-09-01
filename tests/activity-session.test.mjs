import test from 'node:test';
import assert from 'node:assert/strict';
import { sessionRecords, createSessionTracker } from '../src/activity-session.js';

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


/* ── in-memory localStorage stand-in so createSessionTracker can run in Node ── */
function makeStorage() {
  const map = new Map();
  return {
    getItem: (k) => (map.has(k) ? map.get(k) : null),
    setItem: (k, v) => map.set(k, String(v)),
    removeItem: (k) => map.delete(k),
  };
}

function makeClock(start) {
  let t = start;
  return { now: () => t, advance: (ms) => { t += ms; return t; }, get: () => t };
}

function withTracker(fn) {
  const originalStorage = globalThis.localStorage;
  globalThis.localStorage = makeStorage();
  try { return fn(); } finally { globalThis.localStorage = originalStorage; }
}

const IDLE_MS = 5 * 60 * 1000;

test('idle boundary ends the session and caps activeSeconds at the idle limit', () => withTracker(() => {
  const clock = makeClock(Date.now());
  let visible = true;
  const records = [];
  const tracker = createSessionTracker({
    kind: 'usage-session', itemType: 'document', storageKey: 'test.idle',
    onRecord: (r) => records.push(r), now: clock.now, isVisible: () => visible,
  });
  tracker.start({ id: 'doc-1', title: 'Doc' }, clock.now());
  clock.advance(60 * 1000);
  tracker.signal(clock.now());
  // Jump past the idle horizon without any further signal — heartbeat would
  // normally catch this, but we drive it directly to make the boundary exact.
  clock.advance(IDLE_MS + 1000);
  tracker.heartbeat();
  assert.equal(records.length, 1, 'idle timeout must publish exactly one session');
  // activeSeconds accrues from session start up to (lastSignalAt + idle limit),
  // never past it — the idle overrun itself is excluded.
  assert.equal(records[0].data.activeSeconds, 60 + IDLE_MS / 1000, 'active time is capped at the idle horizon, not the overrun past it');
  assert.equal(tracker.active(), false);
}));

test('signal() after idle timeout starts a second session with a new ID', () => withTracker(() => {
  const clock = makeClock(Date.now());
  const records = [];
  const tracker = createSessionTracker({
    kind: 'usage-session', itemType: 'document', storageKey: 'test.resume',
    onRecord: (r) => records.push(r), now: clock.now, isVisible: () => true,
  });
  tracker.start({ id: 'doc-1', title: 'Doc' }, clock.now());
  clock.advance(30 * 1000);
  tracker.signal(clock.now());
  clock.advance(IDLE_MS + 1000);
  const resumed = tracker.signal(clock.now());
  assert.equal(resumed, true, 'signal() after idle must resume with a new session, not return false');
  clock.advance(30 * 1000);
  tracker.stop(clock.now());
  assert.equal(records.length, 2, 'two distinct sessions must be published');
  const ids = records.map((r) => r.id.split(':')[0]);
  assert.notEqual(ids[0], ids[1], 'the resumed session must not reuse the first session ID');
}));

test('background then resume produces two sessions, not one merged range', () => withTracker(() => {
  const clock = makeClock(Date.now());
  let visible = true;
  const records = [];
  const tracker = createSessionTracker({
    kind: 'usage-session', itemType: 'document', storageKey: 'test.bg',
    onRecord: (r) => records.push(r), now: clock.now, isVisible: () => visible,
  });
  tracker.start({ id: 'doc-1', title: 'Doc' }, clock.now());
  clock.advance(10 * 60 * 1000);
  tracker.signal(clock.now());
  visible = false;
  tracker.heartbeat(); // simulates the visibilitychange -> stop() call site
  clock.advance(2 * 60 * 60 * 1000);
  visible = true;
  const resumed = tracker.signal(clock.now());
  assert.equal(resumed, true);
  clock.advance(10 * 60 * 1000);
  tracker.stop(clock.now());
  assert.equal(records.length, 2, 'background gap must not be folded into one long session');
  const ids = new Set(records.map((r) => r.id.split(':')[0]));
  assert.equal(ids.size, 2);
}));

test('switching items ends the previous session', () => withTracker(() => {
  const clock = makeClock(Date.now());
  const records = [];
  const tracker = createSessionTracker({
    kind: 'usage-session', itemType: 'document', storageKey: 'test.switch',
    onRecord: (r) => records.push(r), now: clock.now, isVisible: () => true,
  });
  tracker.start({ id: 'doc-1', title: 'Doc 1' }, clock.now());
  clock.advance(60 * 1000);
  tracker.start({ id: 'doc-2', title: 'Doc 2' }, clock.now());
  clock.advance(60 * 1000);
  tracker.stop(clock.now());
  assert.equal(records.length, 2);
  assert.equal(records[0].data.itemId, 'doc-1');
  assert.equal(records[1].data.itemId, 'doc-2');
}));

test('a session with zero activeSeconds is never recorded', () => withTracker(() => {
  const clock = makeClock(Date.now());
  const records = [];
  const tracker = createSessionTracker({
    kind: 'usage-session', itemType: 'document', storageKey: 'test.zero',
    onRecord: (r) => records.push(r), now: clock.now, isVisible: () => true,
  });
  tracker.start({ id: 'doc-1', title: 'Doc' }, clock.now());
  // No advance, no signal: stop immediately at the same instant.
  tracker.stop(clock.now());
  assert.equal(records.length, 0);
}));

test('clearItem() prevents signal() from resuming after idle, stop() alone does not', () => withTracker(() => {
  const clock = makeClock(Date.now());
  const records = [];
  const tracker = createSessionTracker({
    kind: 'usage-session', itemType: 'document', storageKey: 'test.clear',
    onRecord: (r) => records.push(r), now: clock.now, isVisible: () => true,
  });
  tracker.start({ id: 'doc-1', title: 'Doc' }, clock.now());
  clock.advance(60 * 1000);
  tracker.stop(clock.now());
  // stop() alone (e.g. idle timeout) must still allow a later signal() to resume.
  clock.advance(1000);
  assert.equal(tracker.signal(clock.now()), true, 'stop() must not clear currentItem');
  clock.advance(1000);
  tracker.clearItem(clock.now());
  // After clearItem() (leaving the document/board entirely), signal() must not resume.
  assert.equal(tracker.signal(clock.now()), false, 'clearItem() must clear currentItem so signal() cannot resume');
}));
