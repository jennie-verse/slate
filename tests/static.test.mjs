// Checks that do not need a browser: paths, cache version, offline rules.
// These are the ones that catch a broken GitHub Pages deploy before it happens.

import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync, existsSync } from "node:fs";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");
const read = (relative) => readFileSync(join(root, relative), "utf8");

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

test("optional cache entries that exist are real files", () => {
  const block = read("sw.js").match(/const OPTIONAL = \[([\s\S]*?)\];/)[1];
  const urls = [...block.matchAll(/"([^"]+)"/g)].map((match) => match[1]);
  for (const url of urls) {
    if (url.startsWith("./docs/")) continue;   // docs are allowed to be added later
    assert.ok(existsSync(join(root, url)), `optional precache missing: ${url}`);
  }
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
        || hit.startsWith("https://jennie-verse.github.io/slate/");   // our own source id
      assert.ok(allowed, `${file} references ${hit}`);
    }
  }
});

test("CSP blocks outbound connections", () => {
  const html = read("index.html");
  const csp = html.match(/Content-Security-Policy" content="([^"]+)"/)[1];
  assert.match(csp, /connect-src 'self'/, "connect-src must be limited to self");
  assert.ok(!/connect-src [^;]*https:\/\//.test(csp), "no remote origin may be allowed");
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
