// Single build stamp for the app shell.
//
// This must always match VERSION in ../sw.js. A Service Worker serves the
// cached build first, so a freshly deployed fix can sit unused while the old
// build keeps running. Settings shows this string, so "what is actually running
// on this device" is readable without guessing.
export const APP_BUILD = "2026.08.26-journal-ledger-backup1";

// Storage schema version. Bumped only alongside a migration step in migrate.js.
export const SCHEMA_VERSION = 1;
