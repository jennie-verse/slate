// IndexedDB. Boards, board contents, image blobs, settings.
//
// Two defences that exist because of the focus app's 2026-08-09 data loss:
//   * every board write keeps the PREVIOUS copy in `board:<id>:prev`, so a bug
//     or a bad migration cannot destroy the only copy of a drawing;
//   * deletes are tombstones, never "it is not here so it must be gone".
//
// iOS Safari has a long-standing bug where the first IndexedDB open of a
// session can fail outright, so open() retries once before giving up.

const DB_NAME = "slate";
const DB_VERSION = 1;

const STORE_BOARDS = "boards";      // { id, title, createdAt, updatedAt, elementCount, bytes, deletedAt }
const STORE_CONTENT = "content";    // { id, elements, appState, files }
const STORE_SETTINGS = "settings";  // { key, value }

let dbPromise = null;

function openOnce() {
  return new Promise((resolve, reject) => {
    let request;
    try {
      request = indexedDB.open(DB_NAME, DB_VERSION);
    } catch (error) {
      reject(error);
      return;
    }
    request.onupgradeneeded = () => {
      const db = request.result;
      if (!db.objectStoreNames.contains(STORE_BOARDS)) {
        db.createObjectStore(STORE_BOARDS, { keyPath: "id" });
      }
      if (!db.objectStoreNames.contains(STORE_CONTENT)) {
        db.createObjectStore(STORE_CONTENT, { keyPath: "id" });
      }
      if (!db.objectStoreNames.contains(STORE_SETTINGS)) {
        db.createObjectStore(STORE_SETTINGS, { keyPath: "key" });
      }
    };
    request.onsuccess = () => resolve(request.result);
    request.onerror = () => reject(request.error || new Error("IndexedDB open failed"));
    request.onblocked = () => reject(new Error("IndexedDB blocked by another tab"));
  });
}

export function open() {
  if (!dbPromise) {
    dbPromise = openOnce().catch(async (first) => {
      // Known iOS Safari flake: retry once before surfacing the failure.
      await new Promise((resolve) => setTimeout(resolve, 120));
      try {
        return await openOnce();
      } catch {
        dbPromise = null;
        throw first;
      }
    });
  }
  return dbPromise;
}

function tx(db, storeNames, mode) {
  const transaction = db.transaction(storeNames, mode);
  return {
    transaction,
    done: new Promise((resolve, reject) => {
      transaction.oncomplete = () => resolve();
      transaction.onerror = () => reject(transaction.error);
      transaction.onabort = () => reject(transaction.error || new Error("transaction aborted"));
    }),
  };
}

function request(req) {
  return new Promise((resolve, reject) => {
    req.onsuccess = () => resolve(req.result);
    req.onerror = () => reject(req.error);
  });
}

/* ------------------------------------------------------------------ boards */

export async function listBoards({ includeDeleted = false } = {}) {
  const db = await open();
  const { transaction } = tx(db, [STORE_BOARDS], "readonly");
  const all = await request(transaction.objectStore(STORE_BOARDS).getAll());
  const rows = includeDeleted ? all : all.filter((board) => !board.deletedAt);
  return rows.sort((a, b) => (b.updatedAt || 0) - (a.updatedAt || 0));
}

export async function getBoard(id) {
  const db = await open();
  const { transaction } = tx(db, [STORE_BOARDS], "readonly");
  return request(transaction.objectStore(STORE_BOARDS).get(id));
}

export async function putBoardMeta(meta) {
  const db = await open();
  const { transaction, done } = tx(db, [STORE_BOARDS], "readwrite");
  transaction.objectStore(STORE_BOARDS).put(meta);
  await done;
  return meta;
}

/** Tombstone, not removal — "absent locally" must never imply "deleted". */
export async function deleteBoard(id) {
  const meta = await getBoard(id);
  if (!meta) return null;
  meta.deletedAt = Date.now();
  meta.updatedAt = Date.now();
  return putBoardMeta(meta);
}

export async function restoreBoard(id) {
  const meta = await getBoard(id);
  if (!meta) return null;
  delete meta.deletedAt;
  meta.updatedAt = Date.now();
  return putBoardMeta(meta);
}

/** Hard removal, used only by "reset everything" after an explicit confirmation. */
export async function purgeBoard(id) {
  const db = await open();
  const { transaction, done } = tx(db, [STORE_BOARDS, STORE_CONTENT], "readwrite");
  transaction.objectStore(STORE_BOARDS).delete(id);
  transaction.objectStore(STORE_CONTENT).delete(id);
  transaction.objectStore(STORE_CONTENT).delete(`${id}:prev`);
  await done;
}

/* ----------------------------------------------------------------- content */

export async function readContent(id) {
  const db = await open();
  const { transaction } = tx(db, [STORE_CONTENT], "readonly");
  return request(transaction.objectStore(STORE_CONTENT).get(id));
}

export async function readPreviousContent(id) {
  return readContent(`${id}:prev`);
}

/**
 * Write board contents, keeping exactly one previous copy.
 * One slot, oldest discarded. Costs one board's worth of space and buys back
 * the case where the app overwrites the only copy with something broken.
 */
export async function writeContent(id, content) {
  const db = await open();
  const { transaction, done } = tx(db, [STORE_CONTENT], "readwrite");
  const store = transaction.objectStore(STORE_CONTENT);
  const existing = await request(store.get(id));
  if (existing) store.put({ ...existing, id: `${id}:prev` });
  store.put({ ...content, id });
  await done;
}

export async function writeContentRaw(id, content) {
  const db = await open();
  const { transaction, done } = tx(db, [STORE_CONTENT], "readwrite");
  transaction.objectStore(STORE_CONTENT).put({ ...content, id });
  await done;
}

/* ---------------------------------------------------------------- settings */

export async function readSetting(key, fallback = null) {
  const db = await open();
  const { transaction } = tx(db, [STORE_SETTINGS], "readonly");
  const row = await request(transaction.objectStore(STORE_SETTINGS).get(key));
  return row ? row.value : fallback;
}

export async function writeSetting(key, value) {
  const db = await open();
  const { transaction, done } = tx(db, [STORE_SETTINGS], "readwrite");
  transaction.objectStore(STORE_SETTINGS).put({ key, value });
  await done;
}

export async function readAllSettings() {
  const db = await open();
  const { transaction } = tx(db, [STORE_SETTINGS], "readonly");
  const rows = await request(transaction.objectStore(STORE_SETTINGS).getAll());
  const out = {};
  for (const row of rows) out[row.key] = row.value;
  return out;
}

/* -------------------------------------------------------- bulk / diagnostics */

export async function exportEverything() {
  const db = await open();
  const { transaction } = tx(db, [STORE_BOARDS, STORE_CONTENT, STORE_SETTINGS], "readonly");
  const boards = await request(transaction.objectStore(STORE_BOARDS).getAll());
  const contents = await request(transaction.objectStore(STORE_CONTENT).getAll());
  const settings = await request(transaction.objectStore(STORE_SETTINGS).getAll());
  return {
    boards,
    // ":prev" rows are a local safety net, not user data — they are not exported.
    contents: contents.filter((row) => !row.id.endsWith(":prev")),
    settings,
  };
}

export async function importEverything({ boards = [], contents = [], settings = [] }, { replace = false } = {}) {
  const db = await open();
  const { transaction, done } = tx(db, [STORE_BOARDS, STORE_CONTENT, STORE_SETTINGS], "readwrite");
  const boardStore = transaction.objectStore(STORE_BOARDS);
  const contentStore = transaction.objectStore(STORE_CONTENT);
  const settingStore = transaction.objectStore(STORE_SETTINGS);
  if (replace) {
    boardStore.clear();
    contentStore.clear();
  }
  for (const board of boards) boardStore.put(board);
  for (const content of contents) contentStore.put(content);
  for (const setting of settings) settingStore.put(setting);
  await done;
}

/** Rough byte size of a board, shown in the board list. Feeds the stage-4 entry condition. */
export function estimateBytes(content) {
  try {
    return new Blob([JSON.stringify(content)]).size;
  } catch {
    return JSON.stringify(content).length;
  }
}

export async function storageEstimate() {
  if (!navigator.storage?.estimate) return null;
  try {
    return await navigator.storage.estimate();
  } catch {
    return null;
  }
}
