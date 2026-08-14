// Stage 2: binding, labels, arrange, snapping, search, links.
//
// These are the invariants that break silently. An arrow that quietly stops
// following its shape, a label that drifts outside its box, a paste that keeps
// pointing at the element it was copied FROM — none of them throw, and none of
// them are visible in a screenshot until the drawing is already wrong.

import test from "node:test";
import assert from "node:assert/strict";

import { Scene } from "../src/scene.js";
import { History } from "../src/history.js";
import { Actions } from "../src/actions.js";
import { createElement, cloneElements, ARROWHEADS } from "../src/model.js";
import {
  bindingPatchFor, bindingUpdates, affectedArrowIds, bindableAt, focusFor, gapFor, bindingPoint,
} from "../src/binding.js";
import { wrapText, layoutBoundText, usableWidth, withBoundText } from "../src/containers.js";
import {
  alignPatch, distributePatch, flipPatch, groupPatch, ungroupPatch, expandSelection,
} from "../src/arrange.js";
import { objectSnap, snapValue, gridOffset } from "../src/snapping.js";
import { findMatches, safeLink, normaliseLinkInput } from "../src/search.js";
import { arrowheadShape } from "../src/shapes.js";
import { STYLE_KEYS } from "../src/clipboard.js";
import { normalise, makeItem, parseFile, toFile } from "../src/library.js";

/** Monospace-ish stand-in so the pure modules can be measured without a canvas. */
const measure = (line, element) => String(line).length * ((element?.fontSize || 20) * 0.5);

function sceneWith(...elements) {
  const scene = new Scene(elements);
  return { scene, history: new History(scene) };
}

function boundArrow() {
  const boxA = createElement("rectangle", { x: 0, y: 0, width: 100, height: 60 });
  const boxB = createElement("rectangle", { x: 300, y: 0, width: 100, height: 60 });
  const arrow = createElement("arrow", {
    x: 50, y: 30, width: 300, height: 0, points: [[0, 0], [300, 0]],
  });
  const { scene, history } = sceneWith(boxA, boxB, arrow);
  const patch = bindingPatchFor(scene, scene.get(arrow.id), {
    startTarget: scene.get(boxA.id),
    endTarget: scene.get(boxB.id),
  });
  history.run(Actions.batch([
    Actions.update([arrow.id], patch.arrow),
    ...patch.shapes.map((shape) => Actions.update([shape.id], shape.changes)),
  ]));
  const sync = (ids) => {
    const update = bindingUpdates(scene, ids);
    if (update) history.runSilent(Actions.update(update.elementIds, update.changes));
  };
  sync([arrow.id]);
  return { scene, history, sync, boxA, boxB, arrow };
}

/* ------------------------------------------------------------------ binding */

test("binding writes both sides of the relationship", () => {
  const { scene, boxA, boxB, arrow } = boundArrow();
  assert.equal(scene.get(arrow.id).startBinding.elementId, boxA.id);
  assert.equal(scene.get(arrow.id).endBinding.elementId, boxB.id);
  assert.equal(scene.get(boxA.id).boundElements.length, 1);
  assert.equal(scene.get(boxA.id).boundElements[0].type, "arrow");
  assert.equal(scene.get(boxB.id).boundElements[0].id, arrow.id);
});

test("a bound arrow follows the shape it points at", () => {
  const { scene, history, sync, boxB, arrow } = boundArrow();
  const before = JSON.stringify(scene.get(arrow.id).points);
  history.run(Actions.update([boxB.id], { x: 320, y: 240 }));
  sync([boxB.id]);
  assert.notEqual(JSON.stringify(scene.get(arrow.id).points), before);

  const live = scene.get(arrow.id);
  const tipX = live.x + live.points[1][0];
  const tipY = live.y + live.points[1][1];
  // The tip stops at the outline, never inside the box.
  assert.ok(tipX <= 321 || tipY <= 241, `tip landed inside the shape at ${tipX},${tipY}`);
});

test("a bound arrow follows a RESIZE, not just a move", () => {
  const { scene, history, sync, boxB, arrow } = boundArrow();
  const before = JSON.stringify(scene.get(arrow.id).points);
  history.run(Actions.update([boxB.id], { x: 200, width: 200 }));
  sync([boxB.id]);
  assert.notEqual(JSON.stringify(scene.get(arrow.id).points), before);
});

test("moving BOTH ends keeps the arrow between them", () => {
  const { scene, history, sync, boxA, boxB, arrow } = boundArrow();
  history.run(Actions.update([boxA.id, boxB.id], [{ y: 400 }, { y: 400 }]));
  sync([boxA.id, boxB.id]);
  const live = scene.get(arrow.id);
  const startY = live.y + live.points[0][1];
  const endY = live.y + live.points[1][1];
  assert.ok(startY > 350 && startY < 500, `start ${startY}`);
  assert.ok(endY > 350 && endY < 500, `end ${endY}`);
});

test("affectedArrowIds finds arrows through either direction", () => {
  const { scene, boxA, arrow } = boundArrow();
  assert.deepEqual(affectedArrowIds(scene, [boxA.id]), [arrow.id]);
  assert.deepEqual(affectedArrowIds(scene, [arrow.id]), [arrow.id]);
});

test("a deleted host leaves the arrow alone rather than throwing", () => {
  const { scene, history, sync, boxB, arrow } = boundArrow();
  history.run(Actions.delete([boxB.id]));
  assert.doesNotThrow(() => sync([arrow.id]));
  assert.ok(scene.get(arrow.id));
});

test("focus and gap round-trip through bindingPoint", () => {
  const shape = createElement("rectangle", { x: 0, y: 0, width: 100, height: 60 });
  // An arrow arriving from the right, aimed above the centre line.
  const focus = focusFor(shape, 100, 20, 300, 20);
  const gap = gapFor(shape, 104, 20);
  assert.ok(focus >= -1 && focus <= 1, `focus out of range: ${focus}`);
  assert.ok(gap >= 1 && gap <= 32, `gap out of range: ${gap}`);
  const [x, y] = bindingPoint(shape, { focus, gap }, 300, 20);
  assert.ok(x >= 100 && x < 140, `x landed at ${x}`);
  assert.ok(y > -10 && y < 70, `y landed at ${y}`);
});

test("binding never picks a line, only bindable shapes", () => {
  const line = createElement("line", { x: 0, y: 0, width: 100, height: 0, points: [[0, 0], [100, 0]] });
  const box = createElement("rectangle", { x: 0, y: 0, width: 100, height: 60 });
  const { scene } = sceneWith(line, box);
  assert.equal(bindableAt(scene, 50, 30, 10)?.id, box.id);
  const onlyLine = new Scene([line]);
  assert.equal(bindableAt(onlyLine, 50, 0, 10), null);
});

/* ------------------------------------------------------------------- labels */

test("wrapping breaks Korean between characters and loses nothing", () => {
  const source = "가나다라마바사아자차카타파하";
  const lines = wrapText(source, 60, (line) => measure(line, { fontSize: 20 }));
  assert.ok(lines.length > 1, "should have wrapped");
  assert.equal(lines.join(""), source);
});

test("wrapping keeps explicit newlines", () => {
  const lines = wrapText("a\nb\nc", 400, (line) => measure(line, { fontSize: 20 }));
  assert.deepEqual(lines, ["a", "b", "c"]);
});

test("a word longer than the box is broken rather than overflowing", () => {
  const lines = wrapText("supercalifragilistic", 40, (line) => measure(line, { fontSize: 20 }));
  assert.ok(lines.length > 1);
  assert.ok(lines.every((line) => measure(line, { fontSize: 20 }) <= 40 || line.length === 1));
});

test("a label is laid out inside its host and grows it when needed", () => {
  const host = createElement("rectangle", { x: 10, y: 10, width: 120, height: 60 });
  const short = createElement("text", { containerId: host.id, text: "hi", originalText: "hi", fontSize: 20 });
  const shortLayout = layoutBoundText(host, short, measure);
  assert.equal(shortLayout.container, null, "a short label must not resize the host");
  assert.ok(shortLayout.text.x >= host.x - 0.5);
  assert.ok(shortLayout.text.x + shortLayout.text.width <= host.x + host.width + 0.5);

  const long = createElement("text", {
    containerId: host.id, fontSize: 20,
    text: "one two three four five six seven eight nine ten",
    originalText: "one two three four five six seven eight nine ten",
  });
  const longLayout = layoutBoundText(host, long, measure);
  assert.ok(longLayout.container.height > host.height, "host must grow to fit");
  assert.ok(longLayout.text.y >= host.y - 0.5);
});

test("originalText is never overwritten by the wrapped copy", () => {
  const host = createElement("rectangle", { x: 0, y: 0, width: 80, height: 40 });
  const label = createElement("text", {
    containerId: host.id, fontSize: 20,
    text: "alpha beta gamma", originalText: "alpha beta gamma",
  });
  const layout = layoutBoundText(host, label, measure);
  assert.ok(layout.text.text.includes("\n"), "should have wrapped");
  assert.ok(!("originalText" in layout.text), "layout must not rewrite originalText");
});

test("an ellipse gives its label less room than a rectangle", () => {
  const box = createElement("rectangle", { x: 0, y: 0, width: 200, height: 100 });
  const ellipse = createElement("ellipse", { x: 0, y: 0, width: 200, height: 100 });
  assert.ok(usableWidth(ellipse) < usableWidth(box));
});

test("deleting a host takes its label with it", () => {
  const host = createElement("rectangle", { x: 0, y: 0, width: 80, height: 40 });
  const label = createElement("text", { containerId: host.id, text: "x", originalText: "x" });
  host.boundElements = [{ id: label.id, type: "text" }];
  const { scene } = sceneWith(host, label);
  assert.deepEqual(withBoundText(scene, [host.id]).sort(), [host.id, label.id].sort());
});

/* ------------------------------------------------------------------ arrange */

function threeBoxes() {
  const boxes = [
    createElement("rectangle", { x: 0, y: 0, width: 40, height: 40 }),
    createElement("rectangle", { x: 100, y: 20, width: 40, height: 40 }),
    createElement("rectangle", { x: 300, y: 60, width: 40, height: 40 }),
  ];
  const { scene, history } = sceneWith(...boxes);
  return { scene, history, ids: boxes.map((box) => box.id) };
}

test("align pulls everything to the same edge", () => {
  const { scene, history, ids } = threeBoxes();
  const patch = alignPatch(scene, ids, "top");
  history.run(Actions.update(patch.elementIds, patch.changes));
  assert.ok(ids.every((id) => Math.abs(scene.get(id).y) < 1e-6));
});

test("distribute equalises the gaps", () => {
  const { scene, history, ids } = threeBoxes();
  const patch = distributePatch(scene, ids, "x");
  history.run(Actions.update(patch.elementIds, patch.changes));
  const xs = ids.map((id) => scene.get(id).x).sort((a, b) => a - b);
  assert.ok(Math.abs((xs[1] - xs[0]) - (xs[2] - xs[1])) < 1e-6);
});

test("distribute needs three items and align needs two", () => {
  const { scene, ids } = threeBoxes();
  assert.equal(distributePatch(scene, ids.slice(0, 2), "x"), null);
  assert.equal(alignPatch(scene, ids.slice(0, 1), "top"), null);
});

test("flip mirrors inside the selection without changing its extent", () => {
  const { scene, history, ids } = threeBoxes();
  const before = ids.map((id) => scene.get(id).x);
  const patch = flipPatch(scene, ids, "x");
  history.run(Actions.update(patch.elementIds, patch.changes));
  const after = ids.map((id) => scene.get(id).x);
  assert.notDeepEqual(after, before);
  assert.ok(Math.abs(Math.min(...after) - Math.min(...before)) < 1e-6);
});

test("flipping a line negates its points instead of its width", () => {
  const line = createElement("line", {
    x: 0, y: 0, width: 100, height: 50, points: [[0, 0], [100, 50]],
  });
  const { scene, history } = sceneWith(line);
  const patch = flipPatch(scene, [line.id], "x");
  history.run(Actions.update(patch.elementIds, patch.changes));
  const flipped = scene.get(line.id);
  assert.deepEqual(flipped.points[1], [-100, 50].map((v, i) => (i === 0 ? -100 : 50)));
});

test("group appends and ungroup pops, so nesting works", () => {
  const { scene, history, ids } = threeBoxes();
  const first = groupPatch(scene, ids);
  history.run(Actions.update(first.elementIds, first.changes));
  const second = groupPatch(scene, ids);
  history.run(Actions.update(second.elementIds, second.changes));
  assert.equal(scene.get(ids[0]).groupIds.length, 2);

  const undoOuter = ungroupPatch(scene, ids);
  history.run(Actions.update(undoOuter.elementIds, undoOuter.changes));
  assert.equal(scene.get(ids[0]).groupIds.length, 1);
  assert.equal(scene.get(ids[0]).groupIds[0], first.groupId);
});

test("selecting one member of a group selects the whole group", () => {
  const { scene, history, ids } = threeBoxes();
  const patch = groupPatch(scene, ids);
  history.run(Actions.update(patch.elementIds, patch.changes));
  assert.equal(expandSelection(scene, [ids[0]]).size, 3);
});

/* ------------------------------------------------------------ cloning */

test("cloning rewrites relationships that stay inside the set", () => {
  const box = createElement("rectangle", { x: 0, y: 0, width: 80, height: 50 });
  const label = createElement("text", { containerId: box.id, text: "x", originalText: "x" });
  box.boundElements = [{ id: label.id, type: "text" }];
  box.groupIds = ["g"];
  label.groupIds = ["g"];

  const [boxCopy, labelCopy] = cloneElements([box, label]);
  assert.notEqual(boxCopy.id, box.id);
  assert.equal(labelCopy.containerId, boxCopy.id);
  assert.equal(boxCopy.boundElements[0].id, labelCopy.id);
  assert.equal(boxCopy.groupIds[0], labelCopy.groupIds[0]);
  assert.notEqual(boxCopy.groupIds[0], "g");
});

test("cloning DROPS relationships that point outside the set", () => {
  const box = createElement("rectangle", { x: 0, y: 0, width: 80, height: 50 });
  const arrow = createElement("arrow", {
    points: [[0, 0], [50, 0]],
    startBinding: { elementId: box.id, focus: 0, gap: 4 },
  });
  const [copy] = cloneElements([arrow]);
  assert.equal(copy.startBinding, null, "a pasted arrow must not grab the original's shape");
});

test("cloning resets version so a copy is not mistaken for a newer edit", () => {
  const box = createElement("rectangle", { version: 42 });
  const [copy] = cloneElements([box]);
  assert.equal(copy.version, 1);
  assert.notEqual(copy.versionNonce, box.versionNonce);
});

/* ------------------------------------------------------------------ snapping */

test("grid snapping quantises to the step", () => {
  assert.equal(snapValue(23, 20), 20);
  assert.equal(snapValue(31, 20), 40);
  assert.deepEqual(gridOffset({ x: 23, y: 31 }, 20), { dx: -3, dy: 9 });
});

test("object snap pulls only within the tolerance", () => {
  const moving = { x: 103, y: 0, width: 40, height: 40 };
  const other = [{ x: 100, y: 0, width: 40, height: 40 }];
  assert.ok(Math.abs(objectSnap(moving, other, 6).dx + 3) < 1e-9);
  assert.equal(objectSnap({ ...moving, x: 140 }, other, 6).dx, 0);
});

test("object snap reports a guide for whatever it snapped to", () => {
  const result = objectSnap(
    { x: 103, y: 0, width: 40, height: 40 },
    [{ x: 100, y: 0, width: 40, height: 40 }],
    6,
  );
  assert.ok(result.guides.length > 0);
  assert.ok(result.guides.every((guide) => guide.axis === "x" || guide.axis === "y"));
});

/* -------------------------------------------------------------- search/links */

test("search finds Korean and ignores case for Latin", () => {
  const text = createElement("text", {
    x: 0, y: 0, width: 200, height: 25, fontSize: 20,
    text: "회의 노트 Meeting", originalText: "회의 노트 Meeting",
  });
  assert.equal(findMatches([text], "노트", measure).length, 1);
  assert.equal(findMatches([text], "MEETING", measure).length, 1);
  assert.equal(findMatches([text], "zzz", measure).length, 0);
  assert.equal(findMatches([text], "", measure).length, 0);
});

test("search returns a highlight quad, not just an element id", () => {
  const text = createElement("text", {
    x: 5, y: 5, width: 200, height: 25, fontSize: 20, text: "find me", originalText: "find me",
  });
  const [hit] = findMatches([text], "me", measure);
  assert.equal(hit.elementId, text.id);
  assert.equal(hit.box.corners.length, 4);
  assert.ok(hit.box.width > 0 && hit.box.height > 0);
});

test("only http and https links are ever accepted", () => {
  assert.equal(safeLink("javascript:alert(1)"), null);
  assert.equal(safeLink("data:text/html,<script>alert(1)</script>"), null);
  assert.equal(safeLink("file:///etc/passwd"), null);
  assert.equal(safeLink("  "), null);
  assert.equal(safeLink("https://example.com/a"), "https://example.com/a");
  assert.equal(normaliseLinkInput("example.com"), "https://example.com/");
  assert.equal(normaliseLinkInput("javascript:alert(1)"), null);
});

/* ------------------------------------------------------------- arrowheads */

test("outline arrowheads share the geometry and only change the paint", () => {
  const points = [[0, 0], [50, 0]];
  const solid = arrowheadShape("triangle", points, false, 2);
  const outline = arrowheadShape("triangle_outline", points, false, 2);
  assert.equal(solid.filled, true);
  assert.equal(outline.filled, false);
  assert.deepEqual(solid.points, outline.points);
});

test("the legacy `dot` arrowhead still draws as a circle", () => {
  assert.equal(arrowheadShape("dot", [[0, 0], [50, 0]], false, 2).kind, "circle");
});

test("the arrowhead list carries the three outline variants", () => {
  for (const kind of ["circle_outline", "triangle_outline", "diamond_outline"]) {
    assert.ok(ARROWHEADS.includes(kind), `${kind} missing from the picker`);
  }
});

/* ---------------------------------------------------------------- library */

test("library items are stored at the origin and re-placed on insert", () => {
  const box = createElement("rectangle", { x: 500, y: 400, width: 40, height: 40 });
  const [normalised] = normalise([box]);
  assert.equal(normalised.x, 0);
  assert.equal(normalised.y, 0);
});

test("a library file round-trips", () => {
  const item = makeItem([createElement("rectangle", { x: 0, y: 0, width: 10, height: 10 })], "box");
  const parsed = parseFile(JSON.stringify(toFile([item])));
  assert.equal(parsed.length, 1);
  assert.equal(parsed[0].name, "box");
  assert.equal(parsed[0].elements.length, 1);
});

test("copy-styles never carries geometry or identity", () => {
  for (const forbidden of ["id", "x", "y", "width", "height", "points", "angle", "seed", "version"]) {
    assert.ok(!STYLE_KEYS.includes(forbidden), `${forbidden} must not be a style key`);
  }
});

/* ------------------------------------------------- one action, one undo step */

test("mergeIntoLast folds a consequence into the step that caused it", () => {
  const box = createElement("rectangle", { x: 0, y: 0, width: 100, height: 60 });
  const arrow = createElement("arrow", {
    x: 200, y: 30, width: 100, height: 0, points: [[0, 0], [100, 0]],
  });
  const { scene, history } = sceneWith(box, arrow);
  const patch = bindingPatchFor(scene, scene.get(arrow.id), {
    startTarget: scene.get(box.id), endTarget: null,
  });
  history.run(Actions.batch([
    Actions.update([arrow.id], patch.arrow),
    ...patch.shapes.map((shape) => Actions.update([shape.id], shape.changes)),
  ]));
  const settle = bindingUpdates(scene, [arrow.id]);
  if (settle) history.runSilent(Actions.update(settle.elementIds, settle.changes));
  history.clear();

  const boxBefore = scene.get(box.id).y;
  const arrowBefore = JSON.stringify(scene.get(arrow.id).points);

  // Move the box, then let the arrow follow — the way every non-drag caller does.
  const move = Actions.update([box.id], { y: 300 });
  history.run(move);
  const follow = bindingUpdates(scene, [box.id]);
  const result = history.runSilent(Actions.update(follow.elementIds, follow.changes));
  history.mergeIntoLast(result.undo, Actions.update(follow.elementIds, follow.changes));

  assert.equal(history.undoStack.length, 1, "the follow-up must not be its own undo step");
  assert.notEqual(JSON.stringify(scene.get(arrow.id).points), arrowBefore, "the arrow should have followed");

  history.undo();
  assert.equal(scene.get(box.id).y, boxBefore, "one undo must put the box back");
  assert.equal(
    JSON.stringify(scene.get(arrow.id).points), arrowBefore,
    "the SAME undo must put the arrow back — otherwise the drawing is left half-undone",
  );

  history.redo();
  assert.equal(scene.get(box.id).y, 300, "redo restores the box");
  assert.notEqual(JSON.stringify(scene.get(arrow.id).points), arrowBefore, "redo restores the arrow");
});

test("mergeIntoLast is a no-op when there is nothing to merge into", () => {
  const { history } = sceneWith(createElement("rectangle", {}));
  history.clear();
  assert.equal(history.mergeIntoLast({ type: "update", elementIds: [], changes: {} }, null), false);
  assert.equal(history.undoStack.length, 0);
});
