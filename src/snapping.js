// Grid snap and object snap.
//
// Two different jobs that look alike:
//   grid    quantise a coordinate to a fixed step (default 20, the original's
//           DEFAULT_GRID_SIZE) — only when the user has turned the grid on;
//   object  while dragging, look for another element whose edge or centre is
//           within a few SCREEN pixels of the one being moved, and pull to it.
//
// The tolerance is a screen distance divided by zoom, exactly like hit-testing:
// a snap that gets stickier as you zoom out is a snap that fights you.
//
// Pure module — no DOM.

import { worldBounds } from "./geometry.js";

export const GRID_STEPS = [10, 20, 40];

export function snapValue(value, step) {
  if (!step) return value;
  return Math.round(value / step) * step;
}

/** Offset that lands `box` on the grid, moving it as little as possible. */
export function gridOffset(box, step) {
  if (!step) return { dx: 0, dy: 0 };
  return {
    dx: snapValue(box.x, step) - box.x,
    dy: snapValue(box.y, step) - box.y,
  };
}

/* ------------------------------------------------------------ object snap */

function edgesOf(box) {
  return {
    x: [box.x, box.x + box.width / 2, box.x + box.width],
    y: [box.y, box.y + box.height / 2, box.y + box.height],
  };
}

/**
 * Pull a moving box onto the edges and centres of nearby static boxes.
 *
 * @param {{x,y,width,height}} moving
 * @param {Array<{x,y,width,height}>} others
 * @param {number} threshold world-space tolerance (screen px ÷ zoom)
 * @returns {{dx:number, dy:number, guides:Array}}
 */
export function objectSnap(moving, others, threshold) {
  if (!moving || !others.length || threshold <= 0) return { dx: 0, dy: 0, guides: [] };
  const source = edgesOf(moving);
  let bestX = null;
  let bestY = null;

  for (const other of others) {
    const target = edgesOf(other);
    for (const value of source.x) {
      for (const candidate of target.x) {
        const distance = Math.abs(candidate - value);
        if (distance <= threshold && (!bestX || distance < bestX.distance)) {
          bestX = { distance, delta: candidate - value, at: candidate, other };
        }
      }
    }
    for (const value of source.y) {
      for (const candidate of target.y) {
        const distance = Math.abs(candidate - value);
        if (distance <= threshold && (!bestY || distance < bestY.distance)) {
          bestY = { distance, delta: candidate - value, at: candidate, other };
        }
      }
    }
  }

  const guides = [];
  const dx = bestX ? bestX.delta : 0;
  const dy = bestY ? bestY.delta : 0;

  if (bestX) {
    const box = bestX.other;
    guides.push({
      axis: "x",
      at: bestX.at,
      from: Math.min(box.y, moving.y + dy),
      to: Math.max(box.y + box.height, moving.y + dy + moving.height),
    });
  }
  if (bestY) {
    const box = bestY.other;
    guides.push({
      axis: "y",
      at: bestY.at,
      from: Math.min(box.x, moving.x + dx),
      to: Math.max(box.x + box.width, moving.x + dx + moving.width),
    });
  }
  return { dx, dy, guides };
}

/**
 * Candidate boxes to snap against: everything visible except what is moving.
 * Capped, because comparing against 2000 elements on every pointermove is how
 * a drag starts to stutter (Expansion_Plan 7 — performance ceiling).
 */
export function snapCandidates(scene, movingIds, viewBox, limit = 200) {
  const moving = movingIds instanceof Set ? movingIds : new Set(movingIds);
  const out = [];
  for (const element of scene.visible()) {
    if (moving.has(element.id)) continue;
    if (element.containerId) continue;
    const box = worldBounds(element);
    if (viewBox && (box.x > viewBox.x + viewBox.width || box.x + box.width < viewBox.x
      || box.y > viewBox.y + viewBox.height || box.y + box.height < viewBox.y)) continue;
    out.push(box);
    if (out.length >= limit) break;
  }
  return out;
}
