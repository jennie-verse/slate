// Whole-app backup and restore.
//
// The envelope matches the other apps (schemaVersion + exportedAt + app), so a
// backup is recognisable months later and the restore path can refuse a file
// written by a newer build instead of half-reading it (migrate.js).

import { SCHEMA_VERSION, APP_BUILD } from "./version.js";
import { exportEverything, importEverything } from "./store.js";
import { migrate, SchemaTooNewError, readSchemaVersion } from "./migrate.js";
import { shareOrDownload } from "./export.js";
import { exportActivityLedger, replaceActivityLedger, validateActivityLedger } from "./journal.js";

export const BACKUP_TYPE = "slate-backup";

export async function buildBackup() {
  const data = await exportEverything();
  return {
    app: "slate",
    type: BACKUP_TYPE,
    schemaVersion: SCHEMA_VERSION,
    appBuild: APP_BUILD,
    exportedAt: new Date().toISOString(),
    boards: data.boards,
    contents: data.contents,
    settings: data.settings,
    journalActivity: exportActivityLedger(),
  };
}

export async function downloadBackup() {
  const payload = await buildBackup();
  const blob = new Blob([JSON.stringify(payload, null, 2)], { type: "application/json" });
  const filename = `slate-backup-${new Date().toISOString().slice(0, 10)}.json`;
  const result = await shareOrDownload(blob, filename);
  return { filename, result, boards: payload.boards.length };
}

export class BackupError extends Error {}

/** Structure check before anything is written. */
export function validateBackup(payload) {
  if (!payload || typeof payload !== "object") throw new BackupError("That file is not a slate backup.");
  if (payload.type !== BACKUP_TYPE && payload.app !== "slate") {
    throw new BackupError("That file is not a slate backup.");
  }
  if (!Array.isArray(payload.boards) || !Array.isArray(payload.contents)) {
    throw new BackupError("That backup is missing its boards.");
  }
  if (payload.journalActivity !== undefined) validateActivityLedger(payload.journalActivity);
  return true;
}

/**
 * @param {string} text raw file contents
 * @param {{replace?:boolean, onBeforeMigrate?:Function}} options
 */
export async function restoreBackup(text, { replace = false, onBeforeMigrate } = {}) {
  let payload;
  try {
    payload = JSON.parse(text);
  } catch {
    throw new BackupError("That file is not valid JSON.");
  }
  validateBackup(payload);

  // A backup from a newer slate is refused outright rather than partly read.
  const found = readSchemaVersion(payload);
  if (found > SCHEMA_VERSION) throw new SchemaTooNewError(found, SCHEMA_VERSION);

  const { payload: upgraded } = await migrate(payload, onBeforeMigrate);
  const journalActivity = upgraded.journalActivity === undefined
    ? undefined
    : validateActivityLedger(upgraded.journalActivity);

  await importEverything({
    boards: upgraded.boards || [],
    contents: upgraded.contents || [],
    settings: upgraded.settings || [],
  }, { replace });
  if (journalActivity !== undefined) replaceActivityLedger(journalActivity, { merge: !replace });

  return {
    boards: (upgraded.boards || []).filter((board) => !board.deletedAt).length,
    exportedAt: upgraded.exportedAt || null,
  };
}

export { SchemaTooNewError };
