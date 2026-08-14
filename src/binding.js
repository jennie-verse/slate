// Arrows attached to shapes.
//
// The data this needs was already written by stage 1 — `startBinding`,
// `endBinding` and `boundElements` have been round-tripped since the first
// build, so switching them on here needs no migration (Build_Plan 5-1).
//
// The stored shape of a binding matches excalidraw.com:
//   arrow.startBinding = { elementId, focus, gap }
//   shape.boundElements = [{ id, type: "arrow" | "text" }]
//
//   focus  signed perpendicular offset of the arrow's line from the shape
//          centre, in units of half the shape's short side. 0 aims at the
//          centre; ±1 grazes the edge.
//   gap    how far the arrow tip stops short of the outline.
//
// Both apps recompute the touch point from these numbers, so a drawing bound
// here stays bound when opened on excalidraw.com even though the tip may land a
// pixel or two differently.
//
// Pure module — no DOM.

import { localBounds, rotatePoint, clamp, worldBounds, hitTestElement } from "./geometry.js";

/** Types an arrow may attach to. Lines never bind — that matches the original. */
export const BINDABLE_TYPES = new Set([
  "rectangle", "diamond", "ellipse", "image", "text", "frame",
]);

export const DEFAULT_GAP = 4;
const MAX_GAP = 32;

export function isBindable(element) {
  return !!element
    && !element.isDeleted
    && !element.locked
    && BINDABLE_TYPES.has(element.type)
    && !element.containerId;      // text already living inside a shape
}

export function isBindingArrow(element) {
  return !!element && element.type === "arrow";
}

function halfSpan(box) {
  return Math.max(1, Math.min(Math.abs(box.width), Math.abs(box.height)) / 2);
}

function centreOf(box) {
  return [box.x + box.width / 2, box.y + box.height / 2];
}

/* ------------------------------------------------------------ ray geometry */

function segmentT(ax, ay, dx, dy, x1, y1, x2, y2) {
  // Where the ray (a + t·d) crosses the segment (p1 → p2), or null.
  const ex = x2 - x1;
  const ey = y2 - y1;
  const denominator = dx * ey - dy * ex;
  if (Math.abs(denominator) < 1e-9) return null;
  const t = ((x1 - ax) * ey - (y1 - ay) * ex) / denominator;
  const u = ((x1 - ax) * dy - (y1 - ay) * dx) / denominator;
  if (t < 0 || u < -1e-6 || u > 1 + 1e-6) return null;
  return t;
}

/**
 * Distance from an interior point to the shape outline along a unit direction.
 * Local (unrotated) coordinates.
 */
function rayExit(type, box, ax, ay, dx, dy) {
  if (box.width <= 0 || box.height <= 0) return 0;

  if (type === "ellipse") {
    const rx = box.width / 2;
    const ry = box.height / 2;
    const [cx, cy] = centreOf(box);
    const px = (ax - cx) / rx;
    const py = (ay - cy) / ry;
    const vx = dx / rx;
    const vy = dy / ry;
    const a = vx * vx + vy * vy;
    const b = 2 * (px * vx + py * vy);
    const c = px * px + py * py - 1;
    const discriminant = b * b - 4 * a * c;
    if (discriminant < 0 || a === 0) return 0;
    const root = Math.sqrt(discriminant);
    const t1 = (-b + root) / (2 * a);
    const t2 = (-b - root) / (2 * a);
    const t = Math.max(t1, t2);
    return t > 0 ? t : 0;
  }

  if (type === "diamond") {
    const [cx, cy] = centreOf(box);
    const corners = [
      [cx, box.y],
      [box.x + box.width, cy],
      [cx, box.y + box.height],
      [box.x, cy],
    ];
    let best = Infinity;
    for (let i = 0; i < 4; i += 1) {
      const p1 = corners[i];
      const p2 = corners[(i + 1) % 4];
      const t = segmentT(ax, ay, dx, dy, p1[0], p1[1], p2[0], p2[1]);
      if (t !== null && t >= 0 && t < best) best = t;
    }
    return Number.isFinite(best) ? best : 0;
  }

  // Rectangle and everything else: axis-aligned slab exit.
  const tx = dx > 0 ? (box.x + box.width - ax) / dx
    : dx < 0 ? (box.x - ax) / dx : Infinity;
  const ty = dy > 0 ? (box.y + box.height - ay) / dy
    : dy < 0 ? (box.y - ay) / dy : Infinity;
  const t = Math.min(tx, ty);
  return Number.isFinite(t) && t > 0 ? t : 0;
}

/* --------------------------------------------------------------- the maths */

/**
 * Focus value for an arrow end that is being attached to `shape`.
 * @param {object} shape
 * @param {number} tipX  the arrow point touching the shape (world)
 * @param {number} tipY
 * @param {number} adjX  the next point along the arrow (world)
 * @param {number} adjY
 */
export function focusFor(shape, tipX, tipY, adjX, adjY) {
  const box = localBounds(shape);
  const [cx, cy] = centreOf(box);
  const angle = shape.angle || 0;
  const [tx, ty] = rotatePoint(tipX, tipY, cx, cy, -angle);
  const [ax, ay] = rotatePoint(adjX, adjY, cx, cy, -angle);
  let dx = tx - ax;
  let dy = ty - ay;
  const length = Math.hypot(dx, dy);
  if (!length) return 0;
  dx /= length;
  dy /= length;
  // Perpendicular component of (adjacent − centre): how far the arrow's line
  // passes from the middle of the shape.
  const offset = (ax - cx) * -dy + (ay - cy) * dx;
  return clamp(offset / halfSpan(box), -1, 1);
}

/** How far the tip currently sits outside the outline. */
export function gapFor(shape, tipX, tipY) {
  const box = localBounds(shape);
  const [cx, cy] = centreOf(box);
  const angle = shape.angle || 0;
  const [tx, ty] = rotatePoint(tipX, tipY, cx, cy, -angle);
  let dx = tx - cx;
  let dy = ty - cy;
  const length = Math.hypot(dx, dy);
  if (!length) return DEFAULT_GAP;
  dx /= length;
  dy /= length;
  const edge = rayExit(shape.type, box, cx, cy, dx, dy);
  return clamp(Math.round(length - edge), 1, MAX_GAP);
}

/**
 * Where the arrow tip belongs now, given the shape and the arrow's other point.
 * @returns {[number, number]} world coordinates
 */
export function bindingPoint(shape, binding, towardX, towardY) {
  const box = localBounds(shape);
  const [cx, cy] = centreOf(box);
  const angle = shape.angle || 0;
  const [fx, fy] = rotatePoint(towardX, towardY, cx, cy, -angle);

  let dx = cx - fx;
  let dy = cy - fy;
  const distance = Math.hypot(dx, dy);
  if (!distance) return [cx, cy];
  dx /= distance;
  dy /= distance;

  const focus = clamp(binding?.focus || 0, -1, 1);
  const aimX = cx + -dy * focus * halfSpan(box);
  const aimY = cy + dx * focus * halfSpan(box);

  // Travel back out from the aim point towards the far end.
  let ex = fx - aimX;
  let ey = fy - aimY;
  const outward = Math.hypot(ex, ey);
  if (!outward) return rotatePoint(aimX, aimY, cx, cy, angle);
  ex /= outward;
  ey /= outward;

  const edge = rayExit(shape.type, box, aimX, aimY, ex, ey);
  const gap = clamp(binding?.gap ?? DEFAULT_GAP, 0, MAX_GAP);
  // Never overshoot the far point — a tiny shape under a long arrow would
  // otherwise push the tip past the other end and flip the arrow.
  const travel = Math.min(edge + gap, Math.max(0, outward - 1));
  return rotatePoint(aimX + ex * travel, aimY + ey * travel, cx, cy, angle);
}

/* ------------------------------------------------------- finding a target */

/**
 * The bindable shape under a point, topmost first.
 * The tolerance is generous on purpose: an arrow that lands a few pixels off a
 * box should still connect, which is the whole reason binding exists.
 */
export function bindableAt(scene, x, y, threshold, excludeId = null) {
  const elements = scene.visible();
  for (let i = elements.length - 1; i >= 0; i -= 1) {
    const element = elements[i];
    if (element.id === excludeId) continue;
    if (!isBindable(element)) continue;
    if (hitTestElement({ ...element, backgroundColor: "#fill" }, x, y, threshold)) return element;
  }
  return null;
}

/* --------------------------------------------------- reading relationships */

function boundList(element) {
  return Array.isArray(element?.boundElements) ? element.boundElements : [];
}

export function boundArrowsOf(element) {
  return boundList(element).filter((entry) => entry?.type === "arrow").map((entry) => entry.id);
}

export function boundTextOf(element) {
  const entry = boundList(element).find((item) => item?.type === "text");
  return entry ? entry.id : null;
}

export function withBound(element, id, type) {
  const list = boundList(element);
  if (list.some((entry) => entry.id === id)) return list.map((entry) => ({ ...entry }));
  return [...list.map((entry) => ({ ...entry })), { id, type }];
}

export function withoutBound(element, id) {
  const list = boundList(element);
  const next = list.filter((entry) => entry.id !== id).map((entry) => ({ ...entry }));
  return next.length ? next : null;
}

/**
 * Arrow ids that must be recalculated when `ids` move.
 * Includes arrows that are themselves in `ids` and bound at either end.
 */
export function affectedArrowIds(scene, ids) {
  const out = new Set();
  for (const id of ids) {
    const element = scene.get(id);
    if (!element || element.isDeleted) continue;
    if (isBindingArrow(element) && (element.startBinding || element.endBinding)) out.add(element.id);
    for (const arrowId of boundArrowsOf(element)) {
      const arrow = scene.get(arrowId);
      if (arrow && !arrow.isDeleted) out.add(arrowId);
    }
  }
  return [...out];
}

/* ------------------------------------------------------------ recalculation */

function endpointUpdate(scene, arrow) {
  const points = (arrow.points || []).map((point) => [point[0], point[1]]);
  if (points.length < 2) return null;

  const startShape = arrow.startBinding ? scene.get(arrow.startBinding.elementId) : null;
  const endShape = arrow.endBinding ? scene.get(arrow.endBinding.elementId) : null;
  const startLive = startShape && !startShape.isDeleted ? startShape : null;
  const endLive = endShape && !endShape.isDeleted ? endShape : null;
  if (!startLive && !endLive) return null;

  const world = points.map(([px, py]) => [arrow.x + px, arrow.y + py]);
  const last = world.length - 1;

  // Two passes so that an arrow bound at BOTH ends settles instead of chasing
  // an endpoint that moved during the first pass.
  for (let pass = 0; pass < 2; pass += 1) {
    if (startLive) {
      const toward = world[1];
      world[0] = bindingPoint(startLive, arrow.startBinding, toward[0], toward[1]);
    }
    if (endLive) {
      const toward = world[last - 1];
      world[last] = bindingPoint(endLive, arrow.endBinding, toward[0], toward[1]);
    }
  }

  const originX = world[0][0];
  const originY = world[0][1];
  const nextPoints = world.map(([px, py]) => [px - originX, py - originY]);

  let minX = Infinity;
  let minY = Infinity;
  let maxX = -Infinity;
  let maxY = -Infinity;
  for (const [px, py] of nextPoints) {
    if (px < minX) minX = px;
    if (py < minY) minY = py;
    if (px > maxX) maxX = px;
    if (py > maxY) maxY = py;
  }

  const changed = Math.abs(originX - arrow.x) > 0.01
    || Math.abs(originY - arrow.y) > 0.01
    || nextPoints.some((point, index) => Math.abs(point[0] - points[index][0]) > 0.01
      || Math.abs(point[1] - points[index][1]) > 0.01);
  if (!changed) return null;

  return {
    x: originX,
    y: originY,
    points: nextPoints,
    width: maxX - minX,
    height: maxY - minY,
  };
}

/**
 * The update Action payload that re-seats every arrow affected by a change.
 * Callers fold this into the same batch as the move so it undoes in one step.
 * @returns {{elementIds:string[], changes:object[]}|null}
 */
export function bindingUpdates(scene, ids) {
  const arrowIds = affectedArrowIds(scene, ids);
  if (!arrowIds.length) return null;
  const elementIds = [];
  const changes = [];
  for (const arrowId of arrowIds) {
    const arrow = scene.get(arrowId);
    if (!arrow || arrow.isDeleted) continue;
    const update = endpointUpdate(scene, arrow);
    if (!update) continue;
    elementIds.push(arrowId);
    changes.push(update);
  }
  return elementIds.length ? { elementIds, changes } : null;
}

/**
 * Bindings for an arrow that has just been drawn or dragged.
 * Returns the patches for the arrow AND for the shapes on either side, so the
 * caller can apply them as one Action.
 *
 * @returns {{arrow:object, shapes:Array<{id:string, changes:object}>}|null}
 */
export function bindingPatchFor(scene, arrow, { startTarget, endTarget }) {
  const points = arrow.points || [];
  if (points.length < 2) return null;
  const first = [arrow.x + points[0][0], arrow.y + points[0][1]];
  const second = [arrow.x + points[1][0], arrow.y + points[1][1]];
  const lastIndex = points.length - 1;
  const lastPoint = [arrow.x + points[lastIndex][0], arrow.y + points[lastIndex][1]];
  const beforeLast = [arrow.x + points[lastIndex - 1][0], arrow.y + points[lastIndex - 1][1]];

  const arrowChanges = {};
  const shapes = new Map();

  const previousStart = arrow.startBinding?.elementId || null;
  const previousEnd = arrow.endBinding?.elementId || null;
  const nextStart = startTarget?.id || null;
  const nextEnd = endTarget?.id || null;

  if (previousStart !== nextStart) {
    arrowChanges.startBinding = startTarget
      ? {
        elementId: startTarget.id,
        focus: focusFor(startTarget, first[0], first[1], second[0], second[1]),
        gap: gapFor(startTarget, first[0], first[1]),
      }
      : null;
  }
  if (previousEnd !== nextEnd) {
    arrowChanges.endBinding = endTarget
      ? {
        elementId: endTarget.id,
        focus: focusFor(endTarget, lastPoint[0], lastPoint[1], beforeLast[0], beforeLast[1]),
        gap: gapFor(endTarget, lastPoint[0], lastPoint[1]),
      }
      : null;
  }

  const detach = (id) => {
    if (!id || id === nextStart || id === nextEnd) return;
    const shape = scene.get(id);
    if (!shape) return;
    shapes.set(id, { boundElements: withoutBound(shape, arrow.id) });
  };
  const attach = (target) => {
    if (!target) return;
    const existing = shapes.get(target.id) || {};
    shapes.set(target.id, { ...existing, boundElements: withBound(scene.get(target.id) || target, arrow.id, "arrow") });
  };

  if (previousStart !== nextStart) { detach(previousStart); attach(startTarget); }
  if (previousEnd !== nextEnd) { detach(previousEnd); attach(endTarget); }

  if (!Object.keys(arrowChanges).length && !shapes.size) return null;
  return {
    arrow: arrowChanges,
    shapes: [...shapes.entries()].map(([id, changes]) => ({ id, changes })),
  };
}

/** Bounding box used to paint the "this is what you will attach to" outline. */
export function highlightBox(element) {
  return worldBounds(element);
}
