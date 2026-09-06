// rough.js path generation and the cache in front of it.
//
// Generating a Drawable is not cheap. Without the cache, dragging one element
// re-rolls the sketchy geometry for every element on every frame. The cache key
// is every property that changes the shape — crucially including `seed`, which
// is what makes a redraw produce the SAME wobble instead of a new one.

import rough from "../vendor/rough.esm.js";
import { getStroke } from "../vendor/perfect-freehand.mjs";
import { FREEDRAW_SIZE_MULTIPLIER } from "./model.js";

const generator = rough.generator();
const cache = new Map();
const CACHE_LIMIT = 3000;

function dashFor(style, strokeWidth) {
  if (style === "dashed") return [8, 8 + strokeWidth * 2];
  if (style === "dotted") return [1.5, 6 + strokeWidth * 2];
  return undefined;
}

function optionsFor(element) {
  const options = {
    seed: element.seed || 1,
    roughness: element.roughness ?? 1,
    stroke: element.strokeColor || "#4A3A40",
    strokeWidth: element.strokeWidth || 1,
    preserveVertices: true,
    disableMultiStroke: element.roughness === 0,
  };
  const dash = dashFor(element.strokeStyle, element.strokeWidth || 1);
  if (dash) options.strokeLineDash = dash;

  if (element.backgroundColor && element.backgroundColor !== "transparent") {
    options.fill = element.backgroundColor;
    options.fillStyle = element.fillStyle || "hachure";
    options.fillWeight = (element.strokeWidth || 1) / 2;
    options.hachureGap = (element.strokeWidth || 1) * 4;
  }
  return options;
}

/** Excalidraw's adaptive corner radius: proportional, capped. */
export function cornerRadius(element) {
  if (!element.roundness) return 0;
  const size = Math.min(Math.abs(element.width), Math.abs(element.height));
  if (element.roundness.type === 2) return element.roundness.value ?? 32;
  return Math.min(size * 0.25, 32);
}

function roundedRectPath(width, height, radius) {
  const w = Math.abs(width);
  const h = Math.abs(height);
  const r = Math.min(radius, w / 2, h / 2);
  if (r <= 0) return `M 0 0 L ${w} 0 L ${w} ${h} L 0 ${h} Z`;
  return [
    `M ${r} 0`,
    `L ${w - r} 0`, `Q ${w} 0 ${w} ${r}`,
    `L ${w} ${h - r}`, `Q ${w} ${h} ${w - r} ${h}`,
    `L ${r} ${h}`, `Q 0 ${h} 0 ${h - r}`,
    `L 0 ${r}`, `Q 0 0 ${r} 0`,
  ].join(" ");
}

/**
 * Curved polyline through the given points, used for `arrowType: "round"`.
 * Quadratic segments through midpoints — the same visual family as the
 * original's curve handling, without pulling in a spline library.
 */
function smoothPath(points) {
  if (points.length < 2) return "";
  if (points.length === 2) {
    return `M ${points[0][0]} ${points[0][1]} L ${points[1][0]} ${points[1][1]}`;
  }
  const parts = [`M ${points[0][0]} ${points[0][1]}`];
  for (let i = 1; i < points.length - 1; i += 1) {
    const [cx, cy] = points[i];
    const midX = (points[i][0] + points[i + 1][0]) / 2;
    const midY = (points[i][1] + points[i + 1][1]) / 2;
    parts.push(`Q ${cx} ${cy} ${midX} ${midY}`);
  }
  const last = points[points.length - 1];
  parts.push(`L ${last[0]} ${last[1]}`);
  return parts.join(" ");
}

function cacheKey(element) {
  return [
    element.id, element.version, element.seed,
    Math.round(element.width * 100), Math.round(element.height * 100),
    element.strokeColor, element.backgroundColor, element.fillStyle,
    element.strokeWidth, element.strokeStyle, element.roughness,
    element.roundness ? element.roundness.type : 0,
    element.arrowType,
    element.points ? element.points.length : 0,
  ].join("|");
}

/** rough.js Drawable(s) for an element, cached. Returns an array. */
export function drawablesFor(element) {
  const key = cacheKey(element);
  const cached = cache.get(key);
  if (cached) return cached;

  const options = optionsFor(element);
  const width = element.width || 0;
  const height = element.height || 0;
  let drawables = [];

  switch (element.type) {
    case "rectangle": {
      const radius = cornerRadius(element);
      drawables = radius > 0
        ? [generator.path(roundedRectPath(width, height, radius), options)]
        : [generator.rectangle(0, 0, Math.abs(width), Math.abs(height), options)];
      break;
    }
    case "diamond": {
      const w = Math.abs(width);
      const h = Math.abs(height);
      drawables = [generator.polygon([[w / 2, 0], [w, h / 2], [w / 2, h], [0, h / 2]], options)];
      break;
    }
    case "ellipse":
      drawables = [generator.ellipse(
        Math.abs(width) / 2, Math.abs(height) / 2,
        Math.abs(width), Math.abs(height),
        options,
      )];
      break;
    case "line":
    case "arrow": {
      const points = element.points || [];
      if (points.length < 2) { drawables = []; break; }
      if (element.arrowType === "sharp" || points.length === 2) {
        drawables = [generator.linearPath(points, options)];
      } else {
        drawables = [generator.path(smoothPath(points), options)];
      }
      break;
    }
    default:
      drawables = [];
  }

  if (cache.size > CACHE_LIMIT) cache.clear();
  cache.set(key, drawables);
  return drawables;
}

export function clearShapeCache() {
  cache.clear();
}

/**
 * Outline polygon for a freedraw stroke.
 * `size` is strokeWidth * 4.25 — the multiplier the original passes to
 * perfect-freehand. Getting it wrong makes pen strokes visibly thinner or
 * fatter than excalidraw.com at the same setting. [16]
 */
export function freedrawOutline(element) {
  const points = element.points || [];
  if (!points.length) return [];
  const pressures = element.pressures || [];
  const input = points.map((point, index) => [
    point[0],
    point[1],
    element.simulatePressure ? 0.5 : (pressures[index] ?? 0.5),
  ]);
  return getStroke(input, {
    size: (element.strokeWidth || 1) * FREEDRAW_SIZE_MULTIPLIER,
    thinning: element.simulatePressure ? 0.6 : 0.5,
    smoothing: 0.5,
    streamline: 0.5,
    simulatePressure: !!element.simulatePressure,
    last: !!element.lastCommittedPoint,
  });
}

export function outlineToPath2D(outline) {
  if (!outline.length) return null;
  const path = new Path2D();
  path.moveTo(outline[0][0], outline[0][1]);
  for (let i = 1; i < outline.length; i += 1) path.lineTo(outline[i][0], outline[i][1]);
  path.closePath();
  return path;
}

export function outlineToSvgPath(outline) {
  if (!outline.length) return "";
  return `M ${outline.map((point) => `${round(point[0])} ${round(point[1])}`).join(" L ")} Z`;
}

function round(value) {
  return Math.round(value * 100) / 100;
}

/**
 * Arrowhead geometry in element-local coordinates.
 *
 * `_outline` variants share the geometry and only change how it is painted, so
 * the caller reads `filled` rather than re-deriving the kind. `dot` is the
 * original's legacy alias for `circle` and is drawn, not rewritten — the stored
 * value has to survive a round trip (Build_Plan 3-4).
 */
export function arrowheadShape(kind, points, atStart, strokeWidth) {
  if (!kind || points.length < 2) return null;
  const filled = !String(kind).endsWith("_outline");
  const base = String(kind).replace(/_outline$/, "") === "dot"
    ? "circle"
    : String(kind).replace(/_outline$/, "");
  const geometry = headGeometry(base, points, atStart, strokeWidth);
  if (!geometry || geometry.kind === "none") return null;
  return { ...geometry, filled };
}

function headGeometry(kind, points, atStart, strokeWidth) {
  const [tipX, tipY] = atStart ? points[0] : points[points.length - 1];
  const [fromX, fromY] = atStart ? points[1] : points[points.length - 2];
  const angle = Math.atan2(tipY - fromY, tipX - fromX);
  const size = Math.max(14, strokeWidth * 5);

  if (kind === "arrow") {
    const spread = 0.45;
    return {
      kind: "lines",
      lines: [
        [[tipX, tipY], [tipX - size * Math.cos(angle - spread), tipY - size * Math.sin(angle - spread)]],
        [[tipX, tipY], [tipX - size * Math.cos(angle + spread), tipY - size * Math.sin(angle + spread)]],
      ],
    };
  }
  if (kind === "bar") {
    const half = size / 2;
    const perpendicular = angle + Math.PI / 2;
    return {
      kind: "lines",
      lines: [[
        [tipX - half * Math.cos(perpendicular), tipY - half * Math.sin(perpendicular)],
        [tipX + half * Math.cos(perpendicular), tipY + half * Math.sin(perpendicular)],
      ]],
    };
  }
  if (kind === "circle") {
    return { kind: "circle", cx: tipX - (size / 3) * Math.cos(angle), cy: tipY - (size / 3) * Math.sin(angle), r: size / 3 };
  }
  if (kind === "triangle" || kind === "diamond") {
    const back = size * 0.9;
    const half = size * 0.42;
    const perpendicular = angle + Math.PI / 2;
    const baseX = tipX - back * Math.cos(angle);
    const baseY = tipY - back * Math.sin(angle);
    const left = [baseX - half * Math.cos(perpendicular), baseY - half * Math.sin(perpendicular)];
    const right = [baseX + half * Math.cos(perpendicular), baseY + half * Math.sin(perpendicular)];
    if (kind === "triangle") return { kind: "polygon", points: [[tipX, tipY], left, right] };
    const tailX = tipX - back * 2 * Math.cos(angle);
    const tailY = tipY - back * 2 * Math.sin(angle);
    return { kind: "polygon", points: [[tipX, tipY], left, [tailX, tailY], right] };
  }
  return { kind: "none" };
}
