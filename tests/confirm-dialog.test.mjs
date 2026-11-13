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

test("confirmDialog resolves true on confirm and false on cancel", async () => {
  const body = fakeNode("body");
  body.isConnected = true;
  globalThis.document = {
    body,
    createElement: fakeNode,
    getElementById: () => null,
    addEventListener() {},
    removeEventListener() {},
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
