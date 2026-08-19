import test from "node:test";
import assert from "node:assert/strict";
import { mergeBoardActivity } from "../src/journal-record.js";

const board = {
  id: "fixture-board", title: "Fixture sketch", createdAt: 1786971600000,
  updatedAt: 1786978800000, elementCount: 2, bytes: 999,
  elements: [{ id: "private-element", text: "must not leave", fileId: "private-image" }],
};

test("Slate board activity merges in semantic order and counts explicit opens", () => {
  let record = mergeBoardActivity(null, board, "opened", "2026-08-17T09:00:00-05:00");
  record = mergeBoardActivity(record, board, "edited", "2026-08-17T10:00:00-05:00");
  record = mergeBoardActivity(record, board, "opened", "2026-08-17T11:00:00-05:00");
  record = mergeBoardActivity(record, board, "export-requested", "2026-08-17T12:00:00-05:00");
  assert.deepEqual(record.data.actions, ["opened", "edited", "export-requested"]);
  assert.equal(record.data.openCount, 2);
  assert.equal(record.id, "fixture-board:2026-08-17");
});

test("projection contains stable metadata and excludes canvas content", () => {
  const serialized = JSON.stringify(mergeBoardActivity(null, board, "created", "2026-08-17T08:00:00-05:00"));
  assert.match(serialized, /Fixture sketch/);
  for (const privateText of ["must not leave", "private-element", "private-image", "elementCount", "bytes"]) {
    assert.equal(serialized.includes(privateText), false);
  }
});

test("only content fingerprints journal edits; viewport saves and automatic opens do not", async () => {
  const { readFile } = await import("node:fs/promises");
  const app = await readFile(new URL("../src/app.js", import.meta.url), "utf8");
  assert.match(app, /contentFingerprint\(\{ elements, background, files \}\)/);
  assert.match(app, /nextFingerprint !== this\.journalContentFingerprint/);
  assert.match(app, /openBoard\(board\.id, \{ journalOpened: true \}\)/);
  assert.match(app, /async openBoard\(id, \{ flush = true, journalOpened = false \} = \{\}\)/);
  assert.match(app, /JSON\.stringify\(\[elements, background, Object\.keys\(files \|\| \{\}\)\.sort\(\)\]\)/);
});

test("both sides of the comparison use the canonical element order", async () => {
  // The Scene sorts by order key and fills in any that are missing, so
  // loaded.elements and scene.toJSON() are NOT the same array for a board whose
  // stored content is not already canonical — a backup is written verbatim, so
  // restoring one made the very first save look like an edit the user never made.
  const { readFile } = await import("node:fs/promises");
  const app = await readFile(new URL("../src/app.js", import.meta.url), "utf8");
  const open = app.match(/async openBoard\([\s\S]*?\n  \}/)[0];
  assert.match(open, /elements: this\.scene\.toJSON\(\)/,
    "openBoard must fingerprint the canonical form, not the stored array");
  assert.ok(!/elements: loaded\.elements/.test(open));
});

test("a board that is off the journal costs nothing to fingerprint", async () => {
  // contentFingerprint used to run on every save whether or not the journal was
  // on — and the journal is off by default. It also kept the whole JSON: a
  // 2000-element freehand board is nearly 4 MB held for the session.
  const { readFile } = await import("node:fs/promises");
  const app = await readFile(new URL("../src/app.js", import.meta.url), "utf8");
  const body = app.match(/contentFingerprint\(\{ elements, background, files \}\) \{[\s\S]*?\n  \}/)[0];
  assert.match(body, /if \(!journal\.isJournalEnabled\(\)\) return null;/);
  assert.ok(body.indexOf("isJournalEnabled") < body.indexOf("JSON.stringify"),
    "the check has to come before the serialization, or it saves nothing");
  assert.match(body, /hash = Math\.imul/, "keep a digest, not the whole string");
  assert.ok(!/return JSON\.stringify/.test(body));
});

test("a saved credential can be removed again", async () => {
  // The token reaches a private repository and the key is shared by every app
  // on the origin. There was no way to take it back off the device.
  const { readFile } = await import("node:fs/promises");
  const journalSource = await readFile(new URL("../src/journal.js", import.meta.url), "utf8");
  const ui = await readFile(new URL("../src/journal-ui.js", import.meta.url), "utf8");
  assert.match(journalSource, /export function removeToken\(\)/);
  assert.match(journalSource, /localStorage\.removeItem\(TOKEN_KEY\)/);
  assert.match(journalSource, /clientPromise = null/);
  assert.match(ui, /text: "Remove token"/);
  assert.match(ui, /confirmDialog\(/, "removing a credential must be confirmed");
  assert.match(ui, /journal\.removeToken\(\)/);
  assert.match(ui, /toggleJournal\(false\)/, "removing the token must also switch the journal off");
});

test("all requested semantic paths are connected", async () => {
  const { readFile } = await import("node:fs/promises");
  const app = await readFile(new URL("../src/app.js", import.meta.url), "utf8");
  for (const action of ["created", "opened", "edited", "export-requested"]) {
    assert.match(app, new RegExp(`recordActivity\\([^\\n]+[\"']${action}[\"']`));
  }
});

