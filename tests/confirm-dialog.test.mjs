// confirmDialog must answer true when the confirm button is pressed. close()
// runs onClose (resolve(false)), so resolving after close() made every confirm
// (delete board, replace-all restore, reset canvas) silently answer "no".

import test from "node:test";
import assert from "node:assert/strict";

function fakeNode(tag) {
  const node = {
    tag, className: "", children: [], attrs: {}, listeners: {}, isConnected: false, textContent: "",
    classList: { add() {}, remove() {} },
    setAttribute(k, v) { this.attrs[k] = v; },
    appendChild(c) { this.children.push(c); c.parent = this; c.isConnected = this.isConnected; return c; },
    addEventListener(type, fn) { (this.listeners[type] ||= []).push(fn); },
    removeEventListener() {},
    remove() { this.isConnected = false; if (this.parent) this.parent.children = this.parent.children.filter((c) => c !== this); },
    focus() {},
    querySelector(sel) { return this._all().find((n) => sel.split(",").map((s) => s.trim()).includes(n.tag)) || null; },
    querySelectorAll() { return this._all(); },
    _all() { return this.children.flatMap((c) => [c, ...c._all()]); },
  };
  return node;
}

const docListeners = {};

test("confirmDialog resolves true on confirm and false on cancel", async () => {
  const body = fakeNode("body");
  body.isConnected = true;
  globalThis.document = {
    body,
    createElement: fakeNode,
    getElementById: () => null,
    addEventListener(type, fn) { (docListeners[type] ||= []).push(fn); },
    removeEventListener(type, fn) { docListeners[type] = (docListeners[type] || []).filter((f) => f !== fn); },
  };
  const { confirmDialog } = await import("../src/ui.js");

  const press = (label) => {
    const buttons = body._all().filter((n) => n.tag === "button" && n.textContent === label);
    assert.equal(buttons.length, 1, `button ${label} exists`);
    buttons[0].listeners.click.forEach((fn) => fn());
  };

  const yes = confirmDialog({ title: "t", message: "m", confirmLabel: "Delete" });
  press("Delete");
  assert.equal(await yes, true);

  const no = confirmDialog({ title: "t", message: "m", confirmLabel: "Delete" });
  press("Cancel");
  assert.equal(await no, false);
});

test("dismissing a confirm (X, Escape, backdrop) resolves null and never confirms", async () => {
  const { confirmDialog } = await import("../src/ui.js");
  const body = globalThis.document.body;
  const find = (pred) => body._all().filter(pred);

  // Close (X) button.
  let p = confirmDialog({ title: "t", message: "m", confirmLabel: "Delete" });
  find((n) => n.tag === "button" && n.attrs["aria-label"] === "Close")[0].listeners.click[0]();
  assert.equal(await p, null);

  // Escape.
  p = confirmDialog({ title: "t", message: "m", confirmLabel: "Delete" });
  docListeners.keydown.forEach((fn) => fn({ key: "Escape", stopPropagation() {} }));
  assert.equal(await p, null);

  // Backdrop pointerdown (tap outside).
  p = confirmDialog({ title: "t", message: "m", confirmLabel: "Delete" });
  const backdrop = find((n) => n.className === "backdrop")[0];
  backdrop.listeners.pointerdown[0]({ target: backdrop });
  assert.equal(await p, null);

  // Confirm settles once; a later close does not flip it.
  p = confirmDialog({ title: "t", message: "m", confirmLabel: "Delete" });
  const confirm = find((n) => n.tag === "button" && n.textContent === "Delete")[0];
  confirm.listeners.click[0]();
  confirm.listeners.click[0]();
  assert.equal(await p, true);
  assert.equal(find((n) => n.className === "backdrop").length, 0, "dialog removed");
});
