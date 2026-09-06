// One-time reset so the 2026.09.05 deploy behaves like a first release.
//
// Runs once, gated on a fixed stamp (NOT on APP_BUILD -- a later version
// bump must never re-trigger this wipe). Wipes ONLY slate's own local data:
// its IndexedDB database (boards/content/settings, see store.js) and its own
// localStorage keys (font step, theme, panel state, journal on/off, journal
// activity ledger, session ledger, sync context id/label).
//
// Deliberately leaves "sync.token.v1" untouched -- that key is shared by
// every app served from this origin (see the comment on removeToken() in
// journal.js), so clearing it here would sign every other app out too. It
// also never touches anything under ../shared/v1 or ../shared/v2 -- those
// modules and their storage belong to the whole origin, not to slate.
//
// Must be the FIRST import in app.js: the localStorage sweep has to finish
// before settings.js reads its keys at module-evaluation time.

const FRESH_START_STAMP = "2026.09.05-firstrelease1";
const MARKER_KEY = "slate.freshStartDone";
const DB_NAME = "slate";

const OWN_LOCAL_KEYS = [
  "slate:fontStep",
  "slate:theme",
  "slate:panelCollapsed",
  "slate:installHintSeen",
  "slate.journalEnabled.v1",
  "slate.journalActivity.v1",
  "slate.journalSessions.v1",
  "slate.syncContextId",
  "slate.syncContextLabel",
];

function alreadyDone() {
  try {
    return localStorage.getItem(MARKER_KEY) === FRESH_START_STAMP;
  } catch {
    return true; // no localStorage (private mode / non-browser) -- nothing to wipe
  }
}

function sweepLocalStorage() {
  for (const key of OWN_LOCAL_KEYS) {
    try { localStorage.removeItem(key); } catch { /* private mode */ }
  }
}

function deleteDatabase() {
  return new Promise((resolve) => {
    let request;
    try {
      request = indexedDB.deleteDatabase(DB_NAME);
    } catch {
      resolve();
      return;
    }
    request.onsuccess = () => resolve();
    request.onerror = () => resolve();
    request.onblocked = () => resolve();
  });
}

const needsReset = !alreadyDone();
if (needsReset) sweepLocalStorage();

/**
 * Resolves once the reset (if any) is complete. app.js awaits this before
 * touching IndexedDB, so a fresh load can never race the delete with a
 * store.open() that would recreate the database mid-wipe.
 */
export const ready = needsReset
  ? deleteDatabase().then(() => {
      try { localStorage.setItem(MARKER_KEY, FRESH_START_STAMP); } catch { /* private mode */ }
    })
  : Promise.resolve();
