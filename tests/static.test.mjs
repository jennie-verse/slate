// Checks that do not need a browser: paths, cache version, offline rules.
// These are the ones that catch a broken GitHub Pages deploy before it happens.

import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync, existsSync, readdirSync } from "node:fs";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");
const read = (relative) => readFileSync(join(root, relative), "utf8");

function walk(directory, out = []) {
  for (const entry of readdirSync(join(root, directory), { withFileTypes: true })) {
    const path = `${directory}/${entry.name}`;
    if (entry.isDirectory()) walk(path, out);
    else if (entry.name.endsWith(".js")) out.push(`./${path}`);
  }
  return out;
}

test("service worker VERSION matches APP_BUILD", () => {
  const sw = read("sw.js").match(/const VERSION = "([^"]+)"/)[1];
  const app = read("src/version.js").match(/APP_BUILD = "([^"]+)"/)[1];
  assert.equal(sw, app, "sw.js VERSION and src/version.js APP_BUILD must be bumped together");
});

test("every precached shell file exists", () => {
  const block = read("sw.js").match(/const APP_SHELL = \[([\s\S]*?)\];/)[1];
  const urls = [...block.matchAll(/"([^"]+)"/g)].map((match) => match[1]);
  assert.ok(urls.length > 20, "APP_SHELL looks truncated");
  for (const url of urls) {
    if (url === "./") continue;
    assert.ok(existsSync(join(root, url)), `precached but missing on disk: ${url}`);
  }
});

test("every source module is precached", () => {
  // The other direction of the test above, and the one that actually bites:
  // adding a file and forgetting APP_SHELL leaves the app working online and
  // broken offline — with no error anywhere (stage 2 kickoff note, 6).
  const block = read("sw.js").match(/const APP_SHELL = \[([\s\S]*?)\];/)[1];
  const listed = new Set([...block.matchAll(/"([^"]+)"/g)].map((match) => match[1]));
  for (const file of walk("src")) {
    assert.ok(listed.has(file), `${file} exists but is not in APP_SHELL — it will be missing offline`);
  }
  assert.ok(listed.has("./vendor/rough.esm.js"));
  assert.ok(listed.has("./vendor/perfect-freehand.mjs"));
});

test("optional cache entries that exist are real files", () => {
  const block = read("sw.js").match(/const OPTIONAL = \[([\s\S]*?)\];/)[1];
  const urls = [...block.matchAll(/"([^"]+)"/g)].map((match) => match[1]);
  for (const url of urls) {
    if (url.startsWith("./docs/")) continue;   // docs are allowed to be added later
    if (url === "../shared/v1/sync.js" || url === "../shared/v2/journal.js") continue;
    assert.ok(existsSync(join(root, url)), `optional precache missing: ${url}`);
  }
  assert.ok(urls.includes("../shared/v1/sync.js"));
  assert.ok(urls.includes("../shared/v2/journal.js"));
});

test("no absolute or cross-origin asset paths", () => {
  // GitHub Pages serves this from /slate/, so a leading slash breaks every path.
  for (const file of ["index.html", "sw.js", "manifest.webmanifest", "assets/app.css"]) {
    const text = read(file);
    assert.ok(!/(src|href)="\//.test(text), `${file} uses a root-absolute path`);
    assert.ok(!/url\(["']?\//.test(text), `${file} uses a root-absolute url()`);
  }
});

test("no external network references in shipped code", () => {
  const files = [
    "index.html", "sw.js", "assets/app.css",
    "src/app.js", "src/export.js", "src/store.js", "src/model.js", "src/ui.js",
  ];
  for (const file of files) {
    const text = read(file);
    const hits = [...text.matchAll(/https?:\/\/[^\s"')]+/g)].map((match) => match[0]);
    for (const hit of hits) {
      const allowed = hit.startsWith("http://www.w3.org/")            // SVG namespace
        || hit.startsWith("https://jennie-verse.github.io/slate/")    // our own source id
        || hit.startsWith("https://api.github.com");                  // opt-in journal metadata
      assert.ok(allowed, `${file} references ${hit}`);
    }
  }
});

test("CSP allows only the journal API as an outbound connection", () => {
  const html = read("index.html");
  const csp = html.match(/Content-Security-Policy" content="([^"]+)"/)[1];
  assert.match(csp, /connect-src 'self' https:\/\/api\.github\.com;/);
  assert.ok(!/connect-src [^;]*https:\/\/(?!api\.github\.com)/.test(csp), "no other remote origin may be allowed");
  assert.match(csp, /object-src 'none'/);
  assert.match(csp, /base-uri 'none'/);
});

test(".nojekyll is present", () => {
  assert.ok(existsSync(join(root, ".nojekyll")));
});

test("manifest has no orientation lock", () => {
  const manifest = JSON.parse(read("manifest.webmanifest"));
  assert.equal(manifest.orientation, undefined, "slate supports portrait and landscape");
  assert.equal(manifest.start_url, "./");
  assert.equal(manifest.scope, "./");
});

test("icons are declared and present", () => {
  const manifest = JSON.parse(read("manifest.webmanifest"));
  for (const icon of manifest.icons) {
    assert.ok(existsSync(join(root, icon.src)), `missing icon ${icon.src}`);
  }
  assert.ok(existsSync(join(root, "icons/apple-touch-icon.png")));
});

test("bundled libraries match the audited sizes", () => {
  const rough = readFileSync(join(root, "vendor/rough.esm.js"));
  const freehand = readFileSync(join(root, "vendor/perfect-freehand.mjs"));
  assert.equal(rough.length, 27748, "rough.esm.js is not the audited 4.6.6 build");
  assert.ok(freehand.length > 4000 && freehand.length < 5000, "perfect-freehand size changed unexpectedly");
});

test("third-party licences are shipped", () => {
  for (const file of [
    "licenses/rough-MIT.txt",
    "licenses/perfect-freehand-MIT.txt",
    "licenses/Lexend-OFL.txt",
    "licenses/Virgil-OFL.txt",
    "THIRD_PARTY_NOTICES.md",
  ]) {
    assert.ok(existsSync(join(root, file)), `missing ${file}`);
  }
});

test("inputs are pinned to 16px so iOS never auto-zooms the page", () => {
  const css = read("assets/app.css");
  assert.match(css, /input,\s*textarea,\s*select\s*\{\s*font-size:\s*var\(--fs-input\)/);
  assert.match(css, /--fs-input:\s*16px/);
});

test("touch targets stay 44px", () => {
  const css = read("assets/app.css");
  assert.match(css, /--tap:\s*44px/);
  assert.match(css, /\.tool\s*\{[^}]*min-height:\s*48px/s);
});

test("service worker registration survives a late start()", () => {
  // start() awaits IndexedDB, so `load` has normally already fired by the time
  // registerServiceWorker() runs. Gating registration purely on a `load`
  // listener silently ships the app with no offline support at all — it was
  // shipped that way once and the browser check caught it.
  const app = read("src/app.js");
  const body = app.match(/registerServiceWorker\(\)\s*\{[\s\S]*?\n  \}/)[0];
  assert.match(body, /document\.readyState === "complete"/, "must register immediately when the page has already loaded");
  assert.match(body, /serviceWorker\.register\("\.\/sw\.js"\)/);
});

test("a sync that follows history.run() must merge, not stack", () => {
  // syncBindings() re-seats bound arrows and re-wraps labels AFTER the change
  // that caused them. Recording that as its own undo entry means one Ctrl+Z
  // takes back the consequence and leaves the cause — boxes aligned, arrows
  // where they were. Every non-gesture caller therefore passes merge: true;
  // gesture callers pass silent: true and record the whole drag themselves.
  for (const file of ["src/app.js", "src/props.js"]) {
    const text = read(file);
    for (const call of text.matchAll(/syncBindings\(([^;]*?)\)\s*;/gs)) {
      const args = call[1];
      assert.ok(
        /silent:\s*true/.test(args) || /merge:\s*true/.test(args),
        `${file}: syncBindings(${args.trim().slice(0, 70)}) must be silent (mid-gesture) or merge (after a run)`,
      );
    }
  }
});

test("keyboard nudging moves bound arrows too", () => {
  // Arrow keys move elements exactly like dragging does. Forgetting to sync
  // leaves the arrows behind, and nothing about the code looks wrong.
  const app = read("src/app.js");
  const block = app.match(/\["ArrowUp", "ArrowDown", "ArrowLeft", "ArrowRight"\][\s\S]*?\n      return;/)[0];
  assert.match(block, /nudgeSelection\(/, "the arrow-key handler must delegate to nudgeSelection");
  const nudge = app.match(/nudgeSelection\(dx, dy\) \{[\s\S]*?\n  \}/)[0];
  assert.match(nudge, /syncBindings\(/, "nudgeSelection must sync bindings");
});

test("every command that moves or removes things refuses mid-gesture", () => {
  // The property panel and the context menu sit OUTSIDE the canvas, so tapping
  // one never interrupts the finger that is still dragging. The command then
  // runs, the next pointermove rewrites the same elements from the drag\'s own
  // `before` snapshot — silently undoing it — and the undo entry recorded on
  // release restores a mid-drag position the user never chose. On an iPad this
  // is a two-handed tap, not an edge case.
  const app = read("src/app.js");
  const commands = [
    "duplicateSelection", "groupSelection", "ungroupSelection", "setLocked", "unlockAll",
    "align", "distribute", "flip", "reorderSelection", "deleteSelection", "nudgeSelection", "paste",
  ];
  for (const name of commands) {
    const body = app.match(new RegExp(`\\n  (?:async )?${name}\\([^)]*\\) \\{[\\s\\S]*?\\n  \\}`))[0];
    assert.match(body, /refuseDuringGesture\(\)/, `${name}() must refuse while a gesture is live`);
  }
  // cut deletes; plain copy is harmless and stays available.
  const copy = app.match(/\n  async copySelection\([\s\S]*?\n  \}/)[0];
  assert.match(copy, /cut && this\.refuseDuringGesture\(\)/);
});

test("the eraser can still delete from inside its own gesture", () => {
  // deleteElements is the primitive and must stay unguarded — the eraser sweep
  // IS a gesture. Guarding it would make the eraser stop erasing.
  const app = read("src/app.js");
  const body = app.match(/\n  deleteElements\(ids\) \{[\s\S]*?\n  \}/)[0];
  assert.ok(!/refuseDuringGesture/.test(body), "deleteElements is the primitive; guard deleteSelection instead");
  assert.match(read("src/tools/eraser.js"), /app\.deleteElements\(/);
});

test("the panel and the context menu delete through deleteSelection", () => {
  assert.ok(!/app\.deleteElements\(/.test(read("src/props.js")),
    "the property panel must go through the guarded deleteSelection");
  const menu = read("src/app.js").match(/label: "Delete",[\s\S]*?\n      \}\);/)[0];
  assert.match(menu, /deleteSelection\(/);
});

test("switching board cancels the gesture before anything is saved", () => {
  // A drag straddling the swap commits its stroke into the NEXT board\'s
  // history and persists the old board at an arbitrary half-dragged point —
  // permanently, because the undo entry that would take it back went to the
  // wrong board.
  const app = read("src/app.js");
  for (const name of ["openBoard", "openBoardList", "newBoard"]) {
    const body = app.match(new RegExp(`\\n  async ${name}\\([^)]*\\) \\{[\\s\\S]*?\\n  \\}`))[0];
    assert.match(body, /cancelGesture\(\)/, `${name}() must cancel the live gesture`);
  }
  const swap = app.match(/\n  async openBoard\([\s\S]*?\n  \}/)[0];
  assert.match(swap, /if \(this\.editing\) this\.commitText\(\);/,
    "a half-typed label belongs to the board being left");
  assert.ok(swap.indexOf("commitText()") < swap.indexOf("saveNow"),
    "commit before the flush, or the text is written after the board it belongs to");
  const list = app.match(/\n  async openBoardList\(\) \{[\s\S]*?await this\.saveNow\(\);/)[0];
  assert.ok(list.indexOf("cancelGesture()") < list.indexOf("saveNow()"),
    "cancel before the save, or the mid-drag position is what gets written");
});

test("switching board flushes pending writes, except where that would resurrect one", () => {
  // scheduleSave debounces, and an image insert can finish while the board list
  // is open. Replacing the scene without flushing drops that work silently.
  const app = read("src/app.js");
  const body = app.match(/\n  async openBoard\([\s\S]*?\n  \}/)[0];
  assert.match(body, /flush && this\.board/, "openBoard must flush before it swaps the scene");
  assert.ok(body.indexOf("saveNow") < body.indexOf("loadBoard"), "flush before the new board is loaded");
  // ...but not when the board being left has just been deleted.
  const removal = app.match(/await deleteBoard\(board\.id\);[\s\S]*?toast\(`Deleted/)[0];
  for (const call of removal.matchAll(/openBoard\(([^;]*?)\)\s*;/g)) {
    assert.match(call[1], /flush: false/, "saving a just-deleted board puts it straight back");
  }
});

test("both context-menu paths cancel the gesture", () => {
  // The long press already did. A right click did not, so every menu item
  // raced the drag that went on writing over it.
  const input = read("src/input.js");
  const listener = input.match(/addEventListener\("contextmenu"[\s\S]*?\n    \}\);/)[0];
  assert.match(listener, /this\.cancelActive\(\)/);
});

test("every await that precedes a board write re-checks the board", () => {
  // The user can switch board during a file picker, an image decode or a
  // clipboard permission prompt. Writing into whatever board is open NOW puts
  // the work somewhere they never chose — or loses it entirely.
  const app = read("src/app.js");
  const image = app.match(/\n  async insertImageAt\([\s\S]*?\n  \}/)[0];
  assert.equal((image.match(/this\.boardEpoch !== boardAtPick/g) || []).length, 2,
    "insertImageAt awaits twice — the picker AND readImageFile — so it must check twice");
  assert.ok(image.indexOf("readImageFile") < image.lastIndexOf("boardAtPick"),
    "the second check must come after the decode, not before it");
  for (const name of ["paste", "copySelection"]) {
    const body = app.match(new RegExp(`\\n  async ${name}\\([^)]*\\) \\{[\\s\\S]*?\\n  \\}`))[0];
    assert.match(body, /this\.boardEpoch !== board/, `${name}() must re-check the board after its await`);
  }
});

test("the board epoch is bumped before openBoard awaits anything", () => {
  // Comparing board ids across an await is not enough. openBoard cancels the
  // gesture, flushes the pending save and loads the new board BEFORE it
  // reassigns this.board, so an image decode finishing inside that window still
  // matched the old id, wrote into the scene being replaced, and vanished with
  // it. The epoch moves at the START of the switch, so the window closes.
  const app = read("src/app.js");
  const body = app.match(/\n  async openBoard\([\s\S]*?\n  \}/)[0];
  const bump = body.indexOf("this.boardEpoch += 1");
  assert.ok(bump > 0, "openBoard must bump the epoch");
  assert.ok(bump < body.indexOf("await"), "the bump has to happen before the first await");
});

test("importing a drawing does not resurrect the other person's deletions", () => {
  // cloneElements clears isDeleted on every copy — that is what makes paste
  // work. The .excalidraw format permits tombstones and an autosave is full of
  // them, so the filter has to happen at the import boundary. Export already
  // filters on the way out; this is the same rule in the other direction.
  const body = read("src/export.js").match(/export function parseExcalidrawFile\([\s\S]*?\n\}/)[0];
  assert.match(body, /filter\(\(element\) => !element\?\.isDeleted\)/,
    "parseExcalidrawFile must drop tombstones");
  assert.match(read("src/model.js"), /copy\.isDeleted = false;/);
});

test("Cancel and an empty box are different answers", () => {
  // promptDialog collapsed "" to null, so Cancel on Save-to-library was
  // indistinguishable from confirming with no name — and it saved anyway.
  const ui = read("src/ui.js");
  const body = ui.match(/export function promptDialog\([\s\S]*?\n\}/)[0];
  assert.ok(!/input\.value\.trim\(\) \|\| null/.test(body),
    "an empty box must resolve as \"\", not as null");
  assert.match(body, /cancel\.addEventListener\("click", \(\) => done\(null\)\)/);
  const app = read("src/app.js");
  const save = app.match(/\n  async addSelectionToLibrary\(\) \{[\s\S]*?\n  \}/)[0];
  assert.match(save, /name === null/, "Cancel must not save an item");
});

test("live-preview controls record their own undo step", () => {
  // runSilent() mutates elements immediately, so a later history.run() would
  // capture the ALREADY-CHANGED value as "before" and undo would do nothing.
  // Anything that previews live must pair runSilent with history.record().
  for (const file of ["src/props.js", "src/tools/select.js"]) {
    const text = read(file);
    if (!text.includes("runSilent")) continue;
    assert.match(text, /history\.record\(/, `${file} previews live but never records an undo step`);
  }
});

test("a gesture that moved nothing records no undo step", () => {
  // history.record() clears the redo stack. A press-and-release on a resize
  // handle with zero movement therefore threw away work the user could still
  // have redone — only `move` used to be guarded.
  const text = read("src/tools/select.js");
  assert.match(text, /if \(!state\.moved\) \{[\s\S]{0,200}?return;/,
    "onPointerUp must bail out before history.record when nothing moved");
  for (const mode of ["resize", "rotate"]) {
    const block = text.match(new RegExp(`if \\(state\\.mode === "${mode}"\\) \\{[\\s\\S]*?\\n    \\}`))[0];
    assert.match(block, /state\.moved = true/, `${mode} must record that it moved`);
  }
});

test("undo, redo and delete refuse to fire mid-gesture", () => {
  // Undoing with a finger still down deletes the element the drag keeps
  // mutating, and the record() on release destroys the redo entry that would
  // have brought it back — the element is gone for good.
  const app = read("src/app.js");
  assert.match(app, /gestureInFlight\(\)\s*\{/);
  for (const method of ["undo", "redo"]) {
    const body = app.match(new RegExp(`\\n  ${method}\\(\\) \\{[\\s\\S]*?\\n  \\}`))[0];
    assert.match(body, /gestureInFlight\(\)/, `${method}() must check for a live gesture`);
  }
});

test("the double-tap detector ignores gestures that were not plain taps", () => {
  // It runs after EVERY selection pointer-up. Without this, a double tap on a
  // link badge opened the link twice and started a label editor on top.
  const app = read("src/app.js");
  const body = app.match(/handleDoubleTap\(event\) \{[\s\S]*?\n  \}/)[0];
  assert.match(body, /this\.tapConsumed/, "handleDoubleTap must respect consumeTap()");
  assert.match(read("src/tools/select.js"), /app\.consumeTap\(\)/);
});

test("IME composition handlers survive the editor being committed", () => {
  // compositionend fires AFTER commitText() has cleared this.editing when the
  // textarea is blurred mid-composition — a Korean-input-only TypeError.
  const app = read("src/app.js");
  for (const event of ["compositionstart", "compositionend"]) {
    const line = app.match(new RegExp(`"${event}", \\(\\) => \\{[^}]*\\}`))[0];
    assert.match(line, /if \(this\.editing\)/, `${event} must guard on this.editing`);
  }
});

test("a label is never added to a host that is already gone", () => {
  const body = read("src/app.js").match(/commitBoundText\(\{[\s\S]*?\n  \}/)[0];
  assert.match(body, /!host \|\| host\.isDeleted/,
    "committing into a deleted container leaves an unselectable ghost");
});
