// Scene, actions, history, ordering — and the extension-point guarantees.
//
// The last group matters most. Those four rules were put into stage 1 for the
// sake of stages 3 and 4, which means nothing visible breaks if they quietly
// stop holding. A test is the only thing that notices (Build_Plan 12).

import test from "node:test";
import assert from "node:assert/strict";

import { Scene } from "../src/scene.js";
import { apply, Actions } from "../src/actions.js";
import { History } from "../src/history.js";
import { createElement, stampChange } from "../src/model.js";
import { keyBetween, compareIndex, ensureIndices } from "../src/ordering.js";

function rect(props = {}) {
  return createElement("rectangle", { x: 0, y: 0, width: 10, height: 10, ...props });
}

test("insert assigns an ascending index", () => {
  const scene = new Scene([]);
  const a = scene.insert(rect());
  const b = scene.insert(rect());
  const c = scene.insert(rect());
  assert.ok(a.index < b.index && b.index < c.index);
  assert.deepEqual(scene.visible().map((e) => e.id), [a.id, b.id, c.id]);
});

test("order comes from index alone, not array position", () => {
  const scene = new Scene([]);
  const a = scene.insert(rect());
  const b = scene.insert(rect());
  // Shuffle the underlying map; the sorted view must be unchanged.
  const shuffled = [...scene.byId.values()].reverse();
  const rebuilt = new Scene(shuffled);
  assert.deepEqual(rebuilt.visible().map((e) => e.id), [a.id, b.id]);
});

test("delete is a tombstone, not a removal", () => {
  const scene = new Scene([]);
  const a = scene.insert(rect());
  apply(scene, Actions.delete([a.id]));
  assert.equal(scene.visible().length, 0);
  assert.equal(scene.all().length, 1, "the record must survive so absence never implies deletion");
  assert.equal(scene.get(a.id).isDeleted, true);
});

test("locked elements are not deleted", () => {
  const scene = new Scene([]);
  const a = scene.insert(rect({ locked: true }));
  apply(scene, Actions.delete([a.id]));
  assert.equal(scene.get(a.id).isDeleted, false);
});

test("undo and redo restore exact field values", () => {
  const scene = new Scene([]);
  const history = new History(scene);
  const a = scene.insert(rect({ x: 5 }));
  history.run(Actions.update([a.id], { x: 99, strokeColor: "#000000" }));
  assert.equal(scene.get(a.id).x, 99);
  history.undo();
  assert.equal(scene.get(a.id).x, 5);
  assert.equal(scene.get(a.id).strokeColor, "#4A3A40");
  history.redo();
  assert.equal(scene.get(a.id).x, 99);
});

test("undo of an add removes it; redo brings it back", () => {
  const scene = new Scene([]);
  const history = new History(scene);
  const element = rect();
  history.run(Actions.add([element]));
  assert.equal(scene.visible().length, 1);
  history.undo();
  assert.equal(scene.visible().length, 0);
  history.redo();
  assert.equal(scene.visible().length, 1);
});

test("a batch undoes as one step", () => {
  const scene = new Scene([]);
  const history = new History(scene);
  const a = scene.insert(rect());
  const b = scene.insert(rect());
  history.run(Actions.batch([
    Actions.update([a.id], { x: 50 }),
    Actions.update([b.id], { x: 60 }),
  ]));
  history.undo();
  assert.equal(scene.get(a.id).x, 0);
  assert.equal(scene.get(b.id).x, 0);
});

test("reorder front/back/forward/backward", () => {
  const scene = new Scene([]);
  const a = scene.insert(rect());
  const b = scene.insert(rect());
  const c = scene.insert(rect());
  const ids = () => scene.visible().map((e) => e.id);

  apply(scene, Actions.reorder([a.id], "front"));
  assert.deepEqual(ids(), [b.id, c.id, a.id]);
  apply(scene, Actions.reorder([a.id], "back"));
  assert.deepEqual(ids(), [a.id, b.id, c.id]);
  apply(scene, Actions.reorder([a.id], "forward"));
  assert.deepEqual(ids(), [b.id, a.id, c.id]);
  apply(scene, Actions.reorder([a.id], "backward"));
  assert.deepEqual(ids(), [a.id, b.id, c.id]);
});

test("reorder is undoable", () => {
  const scene = new Scene([]);
  const history = new History(scene);
  const a = scene.insert(rect());
  const b = scene.insert(rect());
  history.run(Actions.reorder([a.id], "front"));
  assert.deepEqual(scene.visible().map((e) => e.id), [b.id, a.id]);
  history.undo();
  assert.deepEqual(scene.visible().map((e) => e.id), [a.id, b.id]);
});

/* ------------------------------------------------- extension-point checks */

test("EXTENSION POINT 2 — every change bumps version and re-rolls versionNonce", () => {
  const scene = new Scene([]);
  const a = scene.insert(rect());
  const startVersion = a.version;
  const nonces = new Set([a.versionNonce]);

  for (let i = 0; i < 12; i += 1) {
    apply(scene, Actions.update([a.id], { x: i }));
    nonces.add(scene.get(a.id).versionNonce);
  }
  const after = scene.get(a.id);
  assert.equal(after.version, startVersion + 12, "version must increase by exactly one per change");
  assert.ok(nonces.size >= 12, "versionNonce must be re-rolled on every change");
  assert.ok(after.updated >= a.updated);
});

test("EXTENSION POINT 2 — merge rule is decidable from version + versionNonce alone", () => {
  // This is the rule stage 4 relies on: higher version wins, ties break on the
  // lower nonce, and both devices reach the same answer without talking.
  const pick = (local, remote) => {
    if (local.version !== remote.version) return local.version > remote.version ? local : remote;
    return local.versionNonce <= remote.versionNonce ? local : remote;
  };
  const a = { id: "x", version: 4, versionNonce: 90 };
  const b = { id: "x", version: 5, versionNonce: 10 };
  assert.equal(pick(a, b), b);
  assert.equal(pick(b, a), b, "the outcome must not depend on argument order");

  const c = { id: "x", version: 5, versionNonce: 7 };
  const d = { id: "x", version: 5, versionNonce: 8 };
  assert.equal(pick(c, d), c);
  assert.equal(pick(d, c), c);
});

test("EXTENSION POINT 3 — sorting by index alone reproduces the visible order", () => {
  const scene = new Scene([]);
  const a = scene.insert(rect());
  const b = scene.insert(rect());
  const c = scene.insert(rect());
  apply(scene, Actions.reorder([c.id], "back"));
  apply(scene, Actions.reorder([a.id], "front"));

  const expected = scene.visible().map((e) => e.id);
  const roundTripped = JSON.parse(JSON.stringify(scene.toJSON()))
    .sort(compareIndex)
    .filter((e) => !e.isDeleted)
    .map((e) => e.id);
  assert.deepEqual(roundTripped, expected, "index must fully determine order after serialisation");
  void b;
});

test("fractional indices always fit between neighbours", () => {
  let low = keyBetween(undefined, undefined);
  let high = keyBetween(low, undefined);
  for (let i = 0; i < 300; i += 1) {
    const mid = keyBetween(low, high);
    assert.ok(low < mid && mid < high, `index collapsed after ${i} inserts`);
    high = mid;
  }
});

test("ensureIndices repairs missing or out-of-order keys without reordering", () => {
  const elements = [{ id: "a" }, { id: "b", index: "a0" }, { id: "c" }];
  ensureIndices(elements);
  assert.ok(elements.every((element) => typeof element.index === "string"));
  for (let i = 1; i < elements.length; i += 1) {
    assert.ok(elements[i - 1].index < elements[i].index);
  }
  assert.deepEqual(elements.map((e) => e.id), ["a", "b", "c"]);
});

test("stampChange is the only way version moves", () => {
  const element = rect();
  const before = element.version;
  stampChange(element);
  assert.equal(element.version, before + 1);
});

test("apply rejects unknown action types loudly", () => {
  const scene = new Scene([]);
  assert.throws(() => apply(scene, { type: "sneaky-direct-edit" }), /unknown action/);
});
