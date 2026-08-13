// Schema version runner.
//
// Stage 1 has zero migration steps — but the runner ships anyway. Adding it
// later means every board saved before that day was never protected. The cost
// now is this file; the cost of not having it is data (Expansion_Plan 2-8).
//
// Two rules earn their keep immediately:
//   1. Data from a NEWER app is refused, not half-read. A backup made on an
//      updated device must not be partially parsed by an older build and
//      written back mangled.
//   2. A migration always leaves an automatic backup behind first.
//
// Pure module — no DOM.

import { SCHEMA_VERSION } from "./version.js";

/**
 * Ordered list of upgrade steps. Index i upgrades version i+1 → i+2.
 * Each step takes the whole payload and returns the whole payload.
 * @type {Array<(payload:object)=>object>}
 */
const STEPS = [
  // v1 → v2 goes here when the first schema change lands.
];

export class SchemaTooNewError extends Error {
  constructor(found, known) {
    super(`This file was made by a newer version of slate (schema ${found}; this build knows ${known}). Update slate before opening it.`);
    this.name = "SchemaTooNewError";
    this.found = found;
    this.known = known;
  }
}

export function readSchemaVersion(payload) {
  const raw = payload?.schemaVersion;
  const value = Number.isFinite(raw) ? Number(raw) : 1;
  return value < 1 ? 1 : value;
}

/**
 * @param {object} payload
 * @param {(payload:object, fromVersion:number)=>Promise<void>|void} [onBeforeMigrate]
 *        Called once, before any step runs, so the caller can snapshot.
 */
export async function migrate(payload, onBeforeMigrate) {
  const from = readSchemaVersion(payload);

  if (from > SCHEMA_VERSION) throw new SchemaTooNewError(from, SCHEMA_VERSION);
  if (from === SCHEMA_VERSION) return { payload, migrated: false, from, to: SCHEMA_VERSION };

  if (onBeforeMigrate) await onBeforeMigrate(payload, from);

  let current = payload;
  for (let version = from; version < SCHEMA_VERSION; version += 1) {
    const step = STEPS[version - 1];
    if (typeof step !== "function") {
      throw new Error(`missing migration step for schema ${version} → ${version + 1}`);
    }
    current = step(current);
  }
  current.schemaVersion = SCHEMA_VERSION;
  return { payload: current, migrated: true, from, to: SCHEMA_VERSION };
}

export function stampSchema(payload) {
  return { ...payload, schemaVersion: SCHEMA_VERSION };
}
