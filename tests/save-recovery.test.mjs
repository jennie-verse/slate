import assert from 'node:assert/strict';
import test from 'node:test';
import { readFileSync } from 'node:fs';
import vm from 'node:vm';

const source = readFileSync(new URL('../src/app.js', import.meta.url), 'utf8');
const classSource = source.slice(source.indexOf('class SlateApp {'), source.indexOf('\nfunction checkboxRow'));
function appHarness(globals = {}) {
  const App = vm.runInNewContext(`${classSource}; SlateApp`, {
    clearTimeout() {}, setTimeout() {}, SAVE_DEBOUNCE: 500,
    journal: { recordActivity: async () => {} }, toast() {}, console: { warn() {} },
    ...globals,
  });
  const app = Object.create(App.prototype);
  Object.assign(app, {
    board: { id: 'board', title: 'Keep me' }, boardEpoch: 0, saveGeneration: 0, savePromise: null,
    editing: null, files: {}, viewport: { scrollX: 0, scrollY: 0, zoom: 1 }, grid: { enabled: false },
    background: '#fff', journalContentFingerprint: null, elements: [{ id: 'first' }],
    pruneFiles() {}, contentFingerprint: () => null, cancelGesture() {},
    usageSessions: { clearItem() { throw new Error('must not leave failed board'); } },
  });
  app.scene = { toJSON: () => structuredClone(app.elements) };
  return app;
}

test('save calls share a queue and keep edits made during a storage write', async () => {
  const pending = [], writes = [];
  const app = appHarness({ saveBoard: (meta, content) => new Promise(resolve => {
    writes.push(structuredClone(content)); pending.push(() => resolve(meta));
  }) });
  const first = app.saveNow();
  app.elements.push({ id: 'latest' });
  app.scheduleSave();
  const second = app.saveNow({ blocking: true });
  pending.shift()();
  await new Promise(resolve => setImmediate(resolve));
  assert.equal(writes.length, 2);
  assert.equal(writes[0].elements.length, 1);
  assert.equal(writes[1].elements.length, 2);
  assert.notEqual(app.saveState, 'saved');
  pending.shift()();
  assert.deepEqual(await Promise.all([first, second]), [true, true]);
  assert.equal(app.saveState, 'saved');
});

test('failed local save keeps the current board and prevents a destructive switch', async () => {
  const app = appHarness({
    saveBoard: async () => { throw new Error('quota exceeded'); },
    loadBoard: () => { throw new Error('must not load another board'); },
  });
  assert.equal(await app.openBoard('other'), false);
  assert.equal(app.board.id, 'board');
  assert.equal(app.scene.toJSON()[0].id, 'first');
  assert.equal(app.saveState, 'error');
});

test('full backup receives the visible board even if its disk save failed', async () => {
  let options;
  const app = appHarness({
    saveBoard: async () => { throw new Error('quota exceeded'); },
    downloadBackup: async value => { options = value; return { boards: 1, filename: 'backup.json' }; },
  });
  app.elements.push({ id: 'unsaved' });
  await app.doBackup();
  assert.equal(options.currentBoard.meta.id, 'board');
  assert.equal(options.currentBoard.content.elements[1].id, 'unsaved');
});

test('restore saves before replacing data, then loads without flushing the old scene over it', async () => {
  const events = [];
  const app = appHarness({
    pickFile: async () => ({ text: async () => '{}' }), confirmDialog: async () => true,
    saveBoard: async meta => { events.push('save'); return meta; },
    restoreBackup: async () => { events.push('restore'); return { boards: 1 }; },
    listBoards: async () => [{ id: 'board' }],
  });
  app.openBoard = async (id, options) => { assert.equal(id, 'board'); assert.equal(options.flush, false); events.push('open'); };
  app.refreshProps = () => {};
  await app.doRestore();
  assert.deepEqual(events, ['save', 'restore', 'open']);
});

test('recovery backup overlays the live board while preserving other saved boards', async () => {
  const backupSource = readFileSync(new URL('../src/backup.js', import.meta.url), 'utf8');
  const body = backupSource.slice(backupSource.indexOf('export async function buildBackup'), backupSource.indexOf('export async function downloadBackup')).replace('export ', '');
  const disk = { boards: [{ id: 'board' }, { id: 'other' }], contents: [{ id: 'board', elements: [] }, { id: 'other', elements: [{ id: 'safe' }] }], settings: [] };
  const build = vm.runInNewContext(`${body}; buildBackup`, {
    exportEverything: async () => structuredClone(disk), estimateBytes: () => 99,
    SCHEMA_VERSION: 1, APP_BUILD: 'test', BACKUP_TYPE: 'slate-backup',
    exportActivityLedger: () => [], exportSessionLedger: () => [],
  });
  const backup = await build({ currentBoard: { meta: { id: 'board', title: 'Live' }, content: { elements: [{ id: 'unsaved' }, { id: 'deleted', isDeleted: true }], files: {} } } });
  assert.equal(backup.contents.find(row => row.id === 'board').elements[0].id, 'unsaved');
  assert.equal(backup.contents.find(row => row.id === 'other').elements[0].id, 'safe');
  assert.equal(backup.boards.find(row => row.id === 'board').elementCount, 1);
  assert.equal(backup.boards.length, 2);
});

test('legacy fresh-start entry point never removes user storage', async () => {
  const resetSource = readFileSync(new URL('../src/fresh-start.js', import.meta.url), 'utf8');
  const ready = vm.runInNewContext(resetSource.replace('export const ready', 'const ready') + '\nready', {
    localStorage: new Proxy({}, { get() { throw new Error('startup accessed destructive storage'); } }),
    indexedDB: new Proxy({}, { get() { throw new Error('startup accessed destructive storage'); } }),
  });
  await ready;
});
