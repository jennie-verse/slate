// File-format fidelity. Everything here protects a round trip through
// excalidraw.com — the claim the whole build rests on (Build_Plan 1, 5-1).

import test from "node:test";
import assert from "node:assert/strict";

import {
  toExcalidrawFile, parseExcalidrawFile, escapeXml, safeFilename, exportBounds, ImportError,
} from "../src/export.js";
import { createElement, FONT_FAMILY, fontStackFor, displayColor, STROKE_WIDTH, FREEDRAW_SIZE_MULTIPLIER, FONT_SIZES } from "../src/model.js";
import { migrate, SchemaTooNewError, readSchemaVersion } from "../src/migrate.js";
import { SCHEMA_VERSION } from "../src/version.js";
import { entryFor, isRegistered } from "../src/registry.js";

test("constants match the Excalidraw source", () => {
  // Verified against packages/common/src/constants.ts on 2026-08-13. A silent
  // drift here changes how files render without any visible error.
  assert.deepEqual(STROKE_WIDTH, { thin: 1, bold: 2, extraBold: 4 });
  assert.deepEqual(FONT_SIZES, { sm: 16, md: 20, lg: 28, xl: 36 });
  assert.equal(FONT_FAMILY.Virgil, 1);
  assert.equal(FONT_FAMILY.Excalifont, 5);
  assert.equal(FREEDRAW_SIZE_MULTIPLIER, 4.25);
});

test("exported envelope is what excalidraw.com expects", () => {
  const file = toExcalidrawFile([createElement("rectangle", { width: 10, height: 10 })]);
  assert.equal(file.type, "excalidraw");
  assert.equal(file.version, 2);
  assert.ok(Array.isArray(file.elements));
  assert.ok(file.appState);
  assert.ok(file.files);
});

test("round trip preserves fields slate does not understand", () => {
  const exotic = {
    id: "keep-me",
    type: "frame",
    x: 0, y: 0, width: 100, height: 80,
    name: "Frame 1",
    customData: { fromAnotherApp: true, nested: [1, 2, 3] },
    someFutureField: "do not drop",
  };
  const json = JSON.stringify(toExcalidrawFile([exotic]));
  const parsed = parseExcalidrawFile(json);
  const back = parsed.elements[0];
  assert.equal(back.name, "Frame 1");
  assert.deepEqual(back.customData, { fromAnotherApp: true, nested: [1, 2, 3] });
  assert.equal(back.someFutureField, "do not drop");

  const again = JSON.parse(JSON.stringify(toExcalidrawFile(parsed.elements)));
  assert.equal(again.elements[0].someFutureField, "do not drop", "a second round trip must not erode fields");
});

test("the files map survives even though images are not drawn yet", () => {
  // Losing this would delete photos from the user's own file on re-export.
  const files = { "img-1": { mimeType: "image/png", dataURL: "data:image/png;base64,AAAA", id: "img-1" } };
  const json = JSON.stringify(toExcalidrawFile([createElement("rectangle")], {}, files));
  const parsed = parseExcalidrawFile(json);
  assert.deepEqual(parsed.files, files);
});

test("unsupported element types fall through to the placeholder, not to nothing", () => {
  assert.equal(isRegistered("frame"), false);
  const entry = entryFor("frame");
  assert.equal(entry.placeholder, true);
  assert.equal(typeof entry.draw, "function");
  assert.equal(typeof entry.hitTest, "function");
});

test("font codes are preserved, only the drawn face is substituted", () => {
  // excalidraw.com's current default is Excalifont (5). slate bundles Virgil,
  // so it DRAWS with Virgil but must keep the 5 — rewriting it would change
  // the font on the other side, every single round trip.
  const text = createElement("text", { text: "hello", fontFamily: FONT_FAMILY.Excalifont });
  const json = JSON.stringify(toExcalidrawFile([text]));
  const back = parseExcalidrawFile(json).elements[0];
  assert.equal(back.fontFamily, 5, "the stored code must not be rewritten to 1");
  assert.match(fontStackFor(5), /Virgil/, "code 5 is drawn with the bundled hand-drawn face");
  assert.match(fontStackFor(1), /Virgil/);
  assert.match(fontStackFor(2), /Lexend/);
  assert.match(fontStackFor(3), /mono/);
  assert.match(fontStackFor(7), /Lexend/, "unbundled decorative faces fall back to Normal");
});

test("dark mode substitutes for display only", () => {
  assert.equal(displayColor("#4A3A40", false), "#4A3A40");
  assert.equal(displayColor("#4A3A40", true), "#EDE3E6");
  assert.equal(displayColor("transparent", true), "transparent");
  // A colour outside the palette still has to end up visible.
  const custom = displayColor("#101010", true);
  assert.notEqual(custom.toLowerCase(), "#101010");
});

test("import rejects files it cannot safely read", () => {
  assert.throws(() => parseExcalidrawFile("not json"), ImportError);
  assert.throws(() => parseExcalidrawFile('{"type":"something-else"}'), ImportError);
  assert.throws(() => parseExcalidrawFile('{"type":"excalidraw","version":2}'), ImportError);
  assert.throws(
    () => parseExcalidrawFile('{"type":"excalidraw","version":99,"elements":[]}'),
    ImportError,
    "a newer file format must be refused, not half-read",
  );
});

test("SVG export escapes user text", () => {
  const nasty = '<script>alert("x")</script> & <b>';
  const escaped = escapeXml(nasty);
  assert.ok(!escaped.includes("<script>"));
  assert.ok(!escaped.includes("<"));
  assert.ok(escaped.includes("&lt;script&gt;"));
  assert.ok(escaped.includes("&amp;"));
});

test("Korean filenames survive intact", () => {
  const name = safeFilename("회의 노트", "png");
  assert.match(name, /^slate-회의-노트-\d{4}-\d{2}-\d{2}\.png$/);
  assert.ok(!safeFilename("a/b:c*d", "svg").includes("/"));
  assert.match(safeFilename("", "json"), /^slate-board-/);
});

test("export bounds pad the drawing by 10px on each side", () => {
  const box = exportBounds([createElement("rectangle", { x: 100, y: 50, width: 40, height: 20 })]);
  assert.equal(box.x, 90);
  assert.equal(box.y, 40);
  assert.equal(box.width, 60);
  assert.equal(box.height, 40);
});

/* --------------------------------------------------------------- schema */

test("EXTENSION POINT 8 — data from a newer app is refused, never half-read", async () => {
  await assert.rejects(
    () => migrate({ schemaVersion: SCHEMA_VERSION + 1, boards: [] }),
    SchemaTooNewError,
  );
});

test("migration runner is a no-op at the current version and takes a snapshot first", async () => {
  let snapshots = 0;
  const result = await migrate({ schemaVersion: SCHEMA_VERSION }, () => { snapshots += 1; });
  assert.equal(result.migrated, false);
  assert.equal(snapshots, 0, "no backup is needed when nothing is migrated");
});

test("missing schemaVersion is treated as version 1", () => {
  assert.equal(readSchemaVersion({}), 1);
  assert.equal(readSchemaVersion({ schemaVersion: 0 }), 1);
  assert.equal(readSchemaVersion({ schemaVersion: 4 }), 4);
});

test("importing a drawing leaves the other person's deletions deleted", () => {
  // The format permits isDeleted elements and an Excalidraw autosave is full of
  // them. cloneElements clears isDeleted on every copy — that is what makes
  // paste work — so without a filter at the boundary every shape the sender had
  // deleted comes back to life in the middle of the imported drawing.
  const json = JSON.stringify({
    type: "excalidraw",
    version: 2,
    source: "https://excalidraw.com",
    elements: [
      { id: "keep", type: "rectangle", x: 0, y: 0, width: 10, height: 10 },
      { id: "gone", type: "rectangle", x: 20, y: 0, width: 10, height: 10, isDeleted: true },
    ],
    appState: {},
  });
  const parsed = parseExcalidrawFile(json);
  assert.equal(parsed.elements.length, 1, "the tombstone must not survive the import");
  assert.equal(parsed.elements[0].id, "keep");
});
