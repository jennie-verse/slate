// Pure geometry. No `document`, no `window`, no canvas.
//
// Why the restriction: if the element count ever hits a performance ceiling,
// hit-testing and bounds work is the part that moves to a Web Worker. Mixing
// DOM access in here would make that move impossible (Expansion_Plan 2-7).
// Side benefit: tests/ runs this in plain Node with no browser.

export const TAU = Math.PI * 2;

export function clamp(value, low, high) {
  return value < low ? low : value > high ? high : value;
}

export function rotatePoint(x, y, cx, cy, angle) {
  if (!angle) return [x, y];
  const cos = Math.cos(angle);
  const sin = Math.sin(angle);
  const dx = x - cx;
  const dy = y - cy;
  return [cx + dx * cos - dy * sin, cy + dx * sin + dy * cos];
}

/** Axis-aligned box of an element ignoring its rotation. */
export function localBounds(element) {
  if (element.points && element.points.length) {
    let minX = Infinity;
    let minY = Infinity;
    let maxX = -Infinity;
    let maxY = -Infinity;
    for (const [px, py] of element.points) {
      if (px < minX) minX = px;
      if (py < minY) minY = py;
      if (px > maxX) maxX = px;
      if (py > maxY) maxY = py;
    }
    return {
      x: element.x + minX,
      y: element.y + minY,
      width: maxX - minX,
      height: maxY - minY,
    };
  }
  const width = element.width ?? 0;
  const height = element.height ?? 0;
  return {
    x: width < 0 ? element.x + width : element.x,
    y: height < 0 ? element.y + height : element.y,
    width: Math.abs(width),
    height: Math.abs(height),
  };
}

export function centerOf(element) {
  const box = localBounds(element);
  return [box.x + box.width / 2, box.y + box.height / 2];
}

/** Axis-aligned box that contains the element after rotation. */
export function worldBounds(element) {
  const box = localBounds(element);
  if (!element.angle) return box;
  const cx = box.x + box.width / 2;
  const cy = box.y + box.height / 2;
  const corners = [
    [box.x, box.y],
    [box.x + box.width, box.y],
    [box.x + box.width, box.y + box.height],
    [box.x, box.y + box.height],
  ].map(([px, py]) => rotatePoint(px, py, cx, cy, element.angle));
  const xs = corners.map((p) => p[0]);
  const ys = corners.map((p) => p[1]);
  const minX = Math.min(...xs);
  const minY = Math.min(...ys);
  return { x: minX, y: minY, width: Math.max(...xs) - minX, height: Math.max(...ys) - minY };
}

export function boundsOfMany(elements) {
  if (!elements.length) return null;
  let minX = Infinity;
  let minY = Infinity;
  let maxX = -Infinity;
  let maxY = -Infinity;
  for (const element of elements) {
    const box = worldBounds(element);
    if (box.x < minX) minX = box.x;
    if (box.y < minY) minY = box.y;
    if (box.x + box.width > maxX) maxX = box.x + box.width;
    if (box.y + box.height > maxY) maxY = box.y + box.height;
  }
  return { x: minX, y: minY, width: maxX - minX, height: maxY - minY };
}

export function boxesOverlap(a, b) {
  return !(a.x + a.width < b.x || b.x + b.width < a.x || a.y + a.height < b.y || b.y + b.height < a.y);
}

export function boxContains(outer, inner) {
  return inner.x >= outer.x
    && inner.y >= outer.y
    && inner.x + inner.width <= outer.x + outer.width
    && inner.y + inner.height <= outer.y + outer.height;
}

/** Map a world point into an element's unrotated local frame. */
export function toLocal(element, x, y) {
  const [cx, cy] = centerOf(element);
  return rotatePoint(x, y, cx, cy, -(element.angle || 0));
}

export function distanceToSegment(px, py, x1, y1, x2, y2) {
  const dx = x2 - x1;
  const dy = y2 - y1;
  const lengthSquared = dx * dx + dy * dy;
  if (lengthSquared === 0) return Math.hypot(px - x1, py - y1);
  let t = ((px - x1) * dx + (py - y1) * dy) / lengthSquared;
  t = clamp(t, 0, 1);
  return Math.hypot(px - (x1 + t * dx), py - (y1 + t * dy));
}

export function distanceToPolyline(px, py, points, offsetX = 0, offsetY = 0) {
  if (!points || points.length === 0) return Infinity;
  if (points.length === 1) {
    return Math.hypot(px - (points[0][0] + offsetX), py - (points[0][1] + offsetY));
  }
  let best = Infinity;
  for (let i = 1; i < points.length; i += 1) {
    const d = distanceToSegment(
      px, py,
      points[i - 1][0] + offsetX, points[i - 1][1] + offsetY,
      points[i][0] + offsetX, points[i][1] + offsetY,
    );
    if (d < best) best = d;
  }
  return best;
}

function distanceToRectOutline(px, py, box) {
  const { x, y, width: w, height: h } = box;
  return Math.min(
    distanceToSegment(px, py, x, y, x + w, y),
    distanceToSegment(px, py, x + w, y, x + w, y + h),
    distanceToSegment(px, py, x + w, y + h, x, y + h),
    distanceToSegment(px, py, x, y + h, x, y),
  );
}

function pointInRect(px, py, box) {
  return px >= box.x && px <= box.x + box.width && py >= box.y && py <= box.y + box.height;
}

function diamondPoints(box) {
  const { x, y, width: w, height: h } = box;
  return [
    [x + w / 2, y],
    [x + w, y + h / 2],
    [x + w / 2, y + h],
    [x, y + h / 2],
  ];
}

function pointInPolygon(px, py, polygon) {
  let inside = false;
  for (let i = 0, j = polygon.length - 1; i < polygon.length; j = i, i += 1) {
    const [xi, yi] = polygon[i];
    const [xj, yj] = polygon[j];
    const intersects = (yi > py) !== (yj > py)
      && px < ((xj - xi) * (py - yi)) / (yj - yi || Number.EPSILON) + xi;
    if (intersects) inside = !inside;
  }
  return inside;
}

function distanceToPolygonOutline(px, py, polygon) {
  let best = Infinity;
  for (let i = 0, j = polygon.length - 1; i < polygon.length; j = i, i += 1) {
    const d = distanceToSegment(px, py, polygon[j][0], polygon[j][1], polygon[i][0], polygon[i][1]);
    if (d < best) best = d;
  }
  return best;
}

function ellipseHit(px, py, box, threshold, filled) {
  const rx = box.width / 2 || Number.EPSILON;
  const ry = box.height / 2 || Number.EPSILON;
  const cx = box.x + rx;
  const cy = box.y + ry;
  const nx = (px - cx) / rx;
  const ny = (py - cy) / ry;
  const value = nx * nx + ny * ny;
  if (filled && value <= 1) return true;
  // Approximate distance to the ellipse outline, scaled back to world units.
  const scale = Math.min(rx, ry);
  return Math.abs(Math.sqrt(value) - 1) * scale <= threshold;
}

/**
 * Hit test in world coordinates.
 * `threshold` is already converted from screen pixels by the caller — the
 * tolerance a finger needs is a screen distance, so input.js divides by zoom
 * before calling in (Build_Plan 7-1).
 */
export function hitTestElement(element, x, y, threshold = 10) {
  if (element.isDeleted) return false;
  const [lx, ly] = toLocal(element, x, y);
  const box = localBounds(element);
  const filled = element.backgroundColor && element.backgroundColor !== "transparent";

  switch (element.type) {
    case "rectangle":
    case "image":
    case "frame":
    case "magicframe":
    case "iframe":
    case "embeddable":
      if (element.type !== "rectangle") return pointInRect(lx, ly, grow(box, threshold));
      if (filled && pointInRect(lx, ly, box)) return true;
      return distanceToRectOutline(lx, ly, box) <= threshold;
    case "text":
      return pointInRect(lx, ly, grow(box, threshold));
    case "diamond": {
      const polygon = diamondPoints(box);
      if (filled && pointInPolygon(lx, ly, polygon)) return true;
      return distanceToPolygonOutline(lx, ly, polygon) <= threshold;
    }
    case "ellipse":
      return ellipseHit(lx, ly, box, threshold, filled);
    case "line":
    case "arrow": {
      const distance = distanceToPolyline(lx, ly, element.points, element.x, element.y);
      if (distance <= threshold) return true;
      if (filled && element.points && element.points.length > 2) {
        const polygon = element.points.map(([px, py]) => [px + element.x, py + element.y]);
        return pointInPolygon(lx, ly, polygon);
      }
      return false;
    }
    case "freedraw": {
      const half = (element.strokeWidth || 1) * 2;
      return distanceToPolyline(lx, ly, element.points, element.x, element.y) <= threshold + half;
    }
    default:
      // Unregistered types are drawn as placeholders; keep them selectable so
      // they can be moved out of the way rather than being invisible traps.
      return pointInRect(lx, ly, grow(box, threshold));
  }
}

export function grow(box, amount) {
  return {
    x: box.x - amount,
    y: box.y - amount,
    width: box.width + amount * 2,
    height: box.height + amount * 2,
  };
}

/** Elements whose rotated box intersects (or is contained by) a selection box. */
export function elementsInBox(elements, box, { contained = false } = {}) {
  return elements.filter((element) => {
    if (element.isDeleted || element.locked) return false;
    const bounds = worldBounds(element);
    return contained ? boxContains(box, bounds) : boxesOverlap(box, bounds);
  });
}

export const HANDLE_KINDS = ["nw", "n", "ne", "e", "se", "s", "sw", "w", "rotate"];

/**
 * Handle positions in world space for a selection box.
 * `handleSize` and `rotateOffset` arrive already divided by zoom.
 */
export function handlePositions(box, angle = 0, rotateOffset = 24) {
  const cx = box.x + box.width / 2;
  const cy = box.y + box.height / 2;
  const raw = {
    nw: [box.x, box.y],
    n: [cx, box.y],
    ne: [box.x + box.width, box.y],
    e: [box.x + box.width, cy],
    se: [box.x + box.width, box.y + box.height],
    s: [cx, box.y + box.height],
    sw: [box.x, box.y + box.height],
    w: [box.x, cy],
    rotate: [cx, box.y - rotateOffset],
  };
  const positions = {};
  for (const key of Object.keys(raw)) {
    positions[key] = rotatePoint(raw[key][0], raw[key][1], cx, cy, angle);
  }
  return positions;
}

/**
 * Which handle is under the pointer.
 * Priority is fixed — corner, then edge, then rotate — so overlapping handles
 * at small sizes always resolve the same way (Build_Plan 7-1).
 */
export function handleAt(box, angle, x, y, threshold, rotateOffset) {
  const positions = handlePositions(box, angle, rotateOffset);
  const order = ["nw", "ne", "se", "sw", "n", "e", "s", "w", "rotate"];
  for (const kind of order) {
    const [hx, hy] = positions[kind];
    if (Math.hypot(x - hx, y - hy) <= threshold) return kind;
  }
  return null;
}

const OPPOSITE = { nw: "se", ne: "sw", se: "nw", sw: "ne", n: "s", s: "n", e: "w", w: "e" };

/**
 * New x/y/width/height for a resize drag.
 * Returns unnormalised width/height (they may go negative mid-drag); callers
 * normalise once the gesture ends.
 */
export function resizeBox(box, handle, x, y, { keepAspect = false } = {}) {
  let { x: bx, y: by, width, height } = box;
  const right = bx + width;
  const bottom = by + height;

  if (handle.includes("w")) { bx = x; width = right - x; }
  if (handle.includes("e")) { width = x - bx; }
  if (handle.includes("n")) { by = y; height = bottom - y; }
  if (handle.includes("s")) { height = y - by; }

  if (keepAspect && box.width > 0 && box.height > 0 && handle.length === 2) {
    const ratio = box.height / box.width;
    const signedHeight = Math.sign(height || 1) * Math.abs(width) * ratio;
    if (handle.includes("n")) by = bottom - signedHeight;
    height = signedHeight;
  }
  return { x: bx, y: by, width, height, anchor: OPPOSITE[handle] || null };
}

/** Scale a point list into a new box. Used by line/arrow/freedraw resizing. */
export function scalePoints(points, fromBox, toBox) {
  const scaleX = fromBox.width === 0 ? 1 : toBox.width / fromBox.width;
  const scaleY = fromBox.height === 0 ? 1 : toBox.height / fromBox.height;
  return points.map(([px, py]) => [px * scaleX, py * scaleY]);
}

/** Screen ↔ world. Elements are only ever stored in world coordinates. */
export function worldToScreen(x, y, viewport) {
  return [(x + viewport.scrollX) * viewport.zoom, (y + viewport.scrollY) * viewport.zoom];
}

export function screenToWorld(x, y, viewport) {
  return [x / viewport.zoom - viewport.scrollX, y / viewport.zoom - viewport.scrollY];
}

/** The world-space rectangle currently visible, padded for culling. */
export function viewportBounds(viewport, widthPx, heightPx, pad = 64) {
  const [x1, y1] = screenToWorld(-pad, -pad, viewport);
  const [x2, y2] = screenToWorld(widthPx + pad, heightPx + pad, viewport);
  // `+ 0` normalises -0, which otherwise leaks into saved state and comparisons.
  return { x: x1 + 0, y: y1 + 0, width: x2 - x1, height: y2 - y1 };
}

/** Zoom about a fixed screen point so pinch/anchor zoom stays put. */
export function zoomAt(viewport, nextZoom, screenX, screenY) {
  const clamped = clamp(nextZoom, 0.1, 10);
  const [worldX, worldY] = screenToWorld(screenX, screenY, viewport);
  return {
    zoom: clamped,
    scrollX: screenX / clamped - worldX,
    scrollY: screenY / clamped - worldY,
  };
}
