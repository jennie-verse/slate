// geometry.js must work with no browser at all.
//
// That is not a testing convenience — it is the escape hatch. If element counts
// ever make interaction sluggish, hit-testing and bounds are what move to a
// Web Worker, and that is only possible while this file stays DOM-free
// (Expansion_Plan 2-7). This suite failing to run IS the regression.

import test from "node:test";
import assert from "node:assert/strict";

import {
  hitTestElement, localBounds, worldBounds, boundsOfMany, boxesOverlap, boxContains,
  distanceToSegment, screenToWorld, worldToScreen, zoomAt, handleAt, resizeBox,
  scalePoints, elementsInBox, rotatePoint, clamp, viewportBounds,
} from "../src/geometry.js";
import { createElement } from "../src/model.js";

test("no DOM globals are reachable in this module's environment", () => {
  assert.equal(typeof globalThis.document, "undefined");
  assert.equal(typeof globalThis.window, "undefined");
});

function rect(props = {}) {
  return createElement("rectangle", { x: 10, y: 10, width: 100, height: 50, ...props });
}

test("bounds normalise negative width and height", () => {
  const box = localBounds({ x: 100, y: 100, width: -40, height: -20 });
  assert.deepEqual(box, { x: 60, y: 80, width: 40, height: 20 });
});

test("rotated bounds grow to contain the shape", () => {
  const element = rect({ angle: Math.PI / 4 });
  const box = worldBounds(element);
  assert.ok(box.width > 100, "a rotated box is wider than the unrotated one");
  assert.ok(box.height > 50);
});

test("hollow shapes are grabbed by their outline, filled ones anywhere inside", () => {
  const hollow = rect();
  assert.equal(hitTestElement(hollow, 60, 35, 4), false, "the middle of an unfilled rectangle is empty");
  assert.equal(hitTestElement(hollow, 10, 35, 4), true, "the left edge is a hit");

  const filled = rect({ backgroundColor: "#F7E3A8" });
  assert.equal(hitTestElement(filled, 60, 35, 4), true);
});

test("threshold widens the grab area — the finger-vs-pen rule", () => {
  const line = createElement("line", { x: 0, y: 0, points: [[0, 0], [100, 0]], width: 100, height: 0 });
  assert.equal(hitTestElement(line, 50, 9, 4), false, "a pen-sized tolerance stays tight");
  assert.equal(hitTestElement(line, 50, 9, 14), true, "a finger-sized tolerance reaches the same line");
});

test("ellipse and diamond hit-test on their real shape, not their box", () => {
  const ellipse = createElement("ellipse", { x: 0, y: 0, width: 100, height: 100, backgroundColor: "#B9D8EE" });
  assert.equal(hitTestElement(ellipse, 50, 50, 2), true, "centre is inside");
  assert.equal(hitTestElement(ellipse, 4, 4, 2), false, "the box corner is outside the ellipse");

  const diamond = createElement("diamond", { x: 0, y: 0, width: 100, height: 100, backgroundColor: "#CBE5B4" });
  assert.equal(hitTestElement(diamond, 50, 50, 2), true);
  assert.equal(hitTestElement(diamond, 6, 6, 2), false);
});

test("deleted elements are never hit", () => {
  assert.equal(hitTestElement(rect({ isDeleted: true }), 10, 35, 6), false);
});

test("rotation is accounted for when hit-testing", () => {
  const element = rect({ x: 0, y: 0, width: 100, height: 20, backgroundColor: "#F7E3A8", angle: Math.PI / 2 });
  // After a quarter turn about its centre the bar is vertical.
  assert.equal(hitTestElement(element, 50, 50, 2), true);
  assert.equal(hitTestElement(element, 95, 10, 2), false);
});

test("screen and world coordinates are inverses", () => {
  const viewport = { scrollX: 37, scrollY: -14, zoom: 1.75 };
  const [sx, sy] = worldToScreen(120, 80, viewport);
  const [wx, wy] = screenToWorld(sx, sy, viewport);
  assert.ok(Math.abs(wx - 120) < 1e-9);
  assert.ok(Math.abs(wy - 80) < 1e-9);
});

test("zoomAt keeps the anchor point still", () => {
  const viewport = { scrollX: 0, scrollY: 0, zoom: 1 };
  const before = screenToWorld(300, 200, viewport);
  const next = zoomAt(viewport, 2.5, 300, 200);
  const after = screenToWorld(300, 200, next);
  assert.ok(Math.abs(before[0] - after[0]) < 1e-9);
  assert.ok(Math.abs(before[1] - after[1]) < 1e-9);
});

test("zoom is clamped to a usable range", () => {
  assert.equal(zoomAt({ scrollX: 0, scrollY: 0, zoom: 1 }, 500, 0, 0).zoom, 10);
  assert.equal(zoomAt({ scrollX: 0, scrollY: 0, zoom: 1 }, 0.0001, 0, 0).zoom, 0.1);
  assert.equal(clamp(5, 0, 1), 1);
});

test("handle priority is corner, then edge, then rotate", () => {
  const box = { x: 0, y: 0, width: 100, height: 100 };
  // The nw corner and the n edge overlap at a large threshold; the corner wins.
  assert.equal(handleAt(box, 0, 0, 0, 60, 24), "nw");
  assert.equal(handleAt(box, 0, 50, 0, 8, 24), "n");
  assert.equal(handleAt(box, 0, 50, -24, 8, 24), "rotate");
  assert.equal(handleAt(box, 0, 50, 50, 8, 24), null, "the middle is not a handle");
});

test("resizing from a corner anchors the opposite one", () => {
  const box = { x: 0, y: 0, width: 100, height: 100 };
  const next = resizeBox(box, "se", 150, 120);
  assert.deepEqual({ x: next.x, y: next.y, width: next.width, height: next.height }, { x: 0, y: 0, width: 150, height: 120 });
  assert.equal(next.anchor, "nw");

  const fromNW = resizeBox(box, "nw", -20, -10);
  assert.equal(fromNW.x, -20);
  assert.equal(fromNW.width, 120);
});

test("shift-resize keeps the aspect ratio", () => {
  const box = { x: 0, y: 0, width: 100, height: 50 };
  const next = resizeBox(box, "se", 200, 999, { keepAspect: true });
  assert.equal(next.width, 200);
  assert.equal(next.height, 100);
});

test("point lists scale with their box", () => {
  const points = scalePoints([[0, 0], [10, 20]], { width: 10, height: 20 }, { width: 20, height: 10 });
  assert.deepEqual(points, [[0, 0], [20, 10]]);
});

test("marquee selects intersecting elements, and contained-only on request", () => {
  const a = rect({ x: 0, y: 0, width: 50, height: 50 });
  const b = rect({ x: 200, y: 200, width: 50, height: 50 });
  const box = { x: -10, y: -10, width: 40, height: 40 };
  assert.deepEqual(elementsInBox([a, b], box).map((e) => e.id), [a.id]);
  assert.deepEqual(elementsInBox([a, b], box, { contained: true }), []);
});

test("locked elements are excluded from marquee selection", () => {
  const locked = rect({ x: 0, y: 0, width: 50, height: 50, locked: true });
  assert.deepEqual(elementsInBox([locked], { x: -10, y: -10, width: 200, height: 200 }), []);
});

test("box helpers behave", () => {
  const outer = { x: 0, y: 0, width: 100, height: 100 };
  assert.equal(boxContains(outer, { x: 10, y: 10, width: 10, height: 10 }), true);
  assert.equal(boxContains(outer, { x: 90, y: 90, width: 20, height: 20 }), false);
  assert.equal(boxesOverlap(outer, { x: 90, y: 90, width: 20, height: 20 }), true);
  assert.equal(boxesOverlap(outer, { x: 500, y: 0, width: 10, height: 10 }), false);
});

test("boundsOfMany covers every element", () => {
  const box = boundsOfMany([
    rect({ x: 0, y: 0, width: 10, height: 10 }),
    rect({ x: 100, y: 40, width: 10, height: 10 }),
  ]);
  assert.deepEqual(box, { x: 0, y: 0, width: 110, height: 50 });
  assert.equal(boundsOfMany([]), null);
});

test("distance to a segment clamps at the endpoints", () => {
  assert.equal(distanceToSegment(0, 10, 0, 0, 10, 0), 10);
  assert.equal(distanceToSegment(-10, 0, 0, 0, 10, 0), 10);
});

test("rotatePoint round-trips", () => {
  const [x, y] = rotatePoint(10, 0, 0, 0, Math.PI / 2);
  const [bx, by] = rotatePoint(x, y, 0, 0, -Math.PI / 2);
  assert.ok(Math.abs(bx - 10) < 1e-9 && Math.abs(by) < 1e-9);
});

test("viewport culling box tracks scroll and zoom", () => {
  const box = viewportBounds({ scrollX: 0, scrollY: 0, zoom: 1 }, 800, 600, 0);
  assert.deepEqual(box, { x: 0, y: 0, width: 800, height: 600 });
  const zoomed = viewportBounds({ scrollX: 0, scrollY: 0, zoom: 2 }, 800, 600, 0);
  assert.equal(zoomed.width, 400);
});
