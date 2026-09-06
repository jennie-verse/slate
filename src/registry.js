// One table, one entry per element type: { draw, hitTest, bounds, resize }.
//
// The alternative — `switch (element.type)` repeated in the renderer, the hit
// tester, the bounds code and the serialiser — means adding a type in stage 3
// touches four places and misses one (Expansion_Plan 2-4).
//
// It also gives the "unsupported type" rule for free: anything not registered
// falls through to the placeholder entry, is drawn as a grey box marked
// uneditable, and keeps every one of its stored properties. Silently dropping
// it would corrupt files round-tripped through excalidraw.com.

import {
  hitTestElement, localBounds, worldBounds, scalePoints, resizeBox,
} from "./geometry.js";
import { drawablesFor, freedrawOutline, outlineToPath2D, arrowheadShape } from "./shapes.js";
import { displayColor, fontStackFor } from "./model.js";
import { imageFor, imageState } from "./images.js";

const registry = new Map();

export function register(type, entry) {
  registry.set(type, entry);
}

export function entryFor(type) {
  return registry.get(type) || PLACEHOLDER;
}

export function isRegistered(type) {
  return registry.has(type);
}

export function registeredTypes() {
  return [...registry.keys()];
}

/* -------------------------------------------------------------- shared bits */

function applyAlpha(ctx, element) {
  ctx.globalAlpha = (element.opacity ?? 100) / 100;
}

/** Move the canvas into the element's own frame so drawing code stays simple. */
function withTransform(ctx, element, drawFn) {
  const box = localBounds(element);
  ctx.save();
  applyAlpha(ctx, element);
  if (element.angle) {
    ctx.translate(box.x + box.width / 2, box.y + box.height / 2);
    ctx.rotate(element.angle);
    ctx.translate(-box.width / 2, -box.height / 2);
  } else {
    ctx.translate(box.x, box.y);
  }
  drawFn(ctx, box);
  ctx.restore();
}

/** rough.js paints from stored colours; dark mode swaps them at paint time only. */
function themed(element, dark) {
  if (!dark) return element;
  return {
    ...element,
    strokeColor: displayColor(element.strokeColor, true),
    backgroundColor: displayColor(element.backgroundColor, true),
  };
}

function drawRough(ctx, roughCanvas, element, dark) {
  withTransform(ctx, element, () => {
    for (const drawable of drawablesFor(themed(element, dark))) {
      roughCanvas.draw(drawable);
    }
  });
}

const shapeEntry = {
  draw: (ctx, element, context) => drawRough(ctx, context.rough, element, context.dark),
  hitTest: hitTestElement,
  bounds: worldBounds,
  resize: (element, handle, x, y, options) => {
    const box = localBounds(element);
    const next = resizeBox(box, handle, x, y, options);
    return { x: next.x, y: next.y, width: next.width, height: next.height };
  },
};

register("rectangle", shapeEntry);
register("diamond", shapeEntry);
register("ellipse", shapeEntry);

/* ----------------------------------------------------------- line and arrow */

const linearEntry = {
  draw: (ctx, element, context) => {
    const painted = themed(element, context.dark);
    withTransform(ctx, element, () => {
      for (const drawable of drawablesFor(painted)) context.rough.draw(drawable);
      if (element.type !== "arrow") return;
      const points = element.points || [];
      ctx.strokeStyle = painted.strokeColor;
      ctx.fillStyle = painted.strokeColor;
      ctx.lineWidth = element.strokeWidth || 1;
      ctx.lineCap = "round";
      ctx.lineJoin = "round";
      ctx.setLineDash([]);
      for (const [kind, atStart] of [[element.startArrowhead, true], [element.endArrowhead, false]]) {
        const shape = arrowheadShape(kind, points, atStart, element.strokeWidth || 1);
        if (!shape) continue;
        // Outline heads share the geometry and only swap fill for stroke.
        const paint = () => (shape.filled ? ctx.fill() : ctx.stroke());
        if (shape.kind === "lines") {
          ctx.beginPath();
          for (const [a, b] of shape.lines) {
            ctx.moveTo(a[0], a[1]);
            ctx.lineTo(b[0], b[1]);
          }
          ctx.stroke();
        } else if (shape.kind === "circle") {
          ctx.beginPath();
          ctx.arc(shape.cx, shape.cy, shape.r, 0, Math.PI * 2);
          paint();
        } else if (shape.kind === "polygon") {
          ctx.beginPath();
          ctx.moveTo(shape.points[0][0], shape.points[0][1]);
          for (let i = 1; i < shape.points.length; i += 1) ctx.lineTo(shape.points[i][0], shape.points[i][1]);
          ctx.closePath();
          paint();
        }
      }
    });
  },
  hitTest: hitTestElement,
  bounds: worldBounds,
  resize: (element, handle, x, y, options) => {
    const box = localBounds(element);
    const next = resizeBox(box, handle, x, y, options);
    const points = scalePoints(element.points || [], box, { width: next.width, height: next.height });
    return { x: next.x, y: next.y, width: next.width, height: next.height, points };
  },
};

register("line", linearEntry);
register("arrow", linearEntry);

/* -------------------------------------------------------------- freedraw */

register("freedraw", {
  draw: (ctx, element, context) => {
    const painted = themed(element, context.dark);
    withTransform(ctx, element, () => {
      const path = outlineToPath2D(freedrawOutline(element));
      if (!path) return;
      ctx.fillStyle = painted.strokeColor;
      ctx.fill(path);
    });
  },
  hitTest: hitTestElement,
  bounds: worldBounds,
  resize: (element, handle, x, y, options) => {
    const box = localBounds(element);
    const next = resizeBox(box, handle, x, y, options);
    const points = scalePoints(element.points || [], box, { width: next.width, height: next.height });
    return { x: next.x, y: next.y, width: next.width, height: next.height, points };
  },
});

/* ------------------------------------------------------------------ text */

export function measureText(ctx, element) {
  ctx.save();
  ctx.font = `${element.fontSize}px ${fontStackFor(element.fontFamily)}`;
  const lines = String(element.text ?? "").split("\n");
  let width = 0;
  for (const line of lines) width = Math.max(width, ctx.measureText(line || " ").width);
  ctx.restore();
  const lineHeight = element.fontSize * (element.lineHeight || 1.25);
  return { width: Math.ceil(width), height: Math.ceil(lines.length * lineHeight), lines, lineHeight };
}

register("text", {
  draw: (ctx, element, context) => {
    const painted = themed(element, context.dark);
    withTransform(ctx, element, (target, box) => {
      target.font = `${element.fontSize}px ${fontStackFor(element.fontFamily)}`;
      target.fillStyle = painted.strokeColor;
      target.textBaseline = "alphabetic";
      const lineHeight = element.fontSize * (element.lineHeight || 1.25);
      const lines = String(element.text ?? "").split("\n");
      const align = element.textAlign || "left";
      target.textAlign = align === "center" ? "center" : align === "right" ? "right" : "left";
      const originX = align === "center" ? box.width / 2 : align === "right" ? box.width : 0;
      lines.forEach((line, index) => {
        target.fillText(line, originX, lineHeight * (index + 1) - lineHeight * 0.25);
      });
    });
  },
  hitTest: hitTestElement,
  bounds: worldBounds,
  resize: (element, handle, x, y) => {
    // Text keeps its font size on resize; only the box moves. Scaling glyphs
    // here would fight autoResize and drift on every drag.
    const box = localBounds(element);
    const next = resizeBox(box, handle, x, y);
    return { x: next.x, y: next.y };
  },
});

/* ----------------------------------------------------------------- image */

register("image", {
  draw: (ctx, element, context) => {
    withTransform(ctx, element, (target, box) => {
      const bitmap = imageFor(element.fileId);
      if (bitmap && box.width > 0 && box.height > 0) {
        try {
          target.drawImage(bitmap, 0, 0, box.width, box.height);
          return;
        } catch {
          // A decoded-but-unusable bitmap falls through to the frame below.
        }
      }
      // Never leave a blank hole: an image that is still decoding, missing from
      // the files map, or broken all show a frame so the element stays findable
      // and movable rather than becoming an invisible trap.
      const state = imageState(element.fileId);
      target.save();
      target.setLineDash([5, 4]);
      target.lineWidth = 1.5;
      target.strokeStyle = context.dark ? "#8A7780" : "#B0A0A7";
      target.fillStyle = context.dark ? "rgba(138,119,128,.14)" : "rgba(176,160,167,.12)";
      target.fillRect(0, 0, box.width, box.height);
      target.strokeRect(0, 0, box.width, box.height);
      target.setLineDash([]);
      if (box.width > 80 && box.height > 26) {
        target.fillStyle = context.dark ? "#B0A0A7" : "#8A7780";
        target.font = `12px ${fontStackFor(2)}`;
        target.textAlign = "center";
        target.textBaseline = "middle";
        target.fillText(
          state === "loading" ? "Loading image…" : "Image not available",
          box.width / 2, box.height / 2,
        );
      }
      target.restore();
    });
  },
  hitTest: hitTestElement,
  bounds: worldBounds,
  resize: (element, handle, x, y, options) => {
    const box = localBounds(element);
    // Images keep their aspect ratio by default — a stretched photo is almost
    // never what was wanted. Shift is the escape hatch, same as everywhere else.
    const next = resizeBox(box, handle, x, y, { keepAspect: !options?.keepAspect });
    return { x: next.x, y: next.y, width: next.width, height: next.height };
  },
});

/* ----------------------------------------------------------- placeholder */

const PLACEHOLDER = {
  placeholder: true,
  draw: (ctx, element, context) => {
    const box = localBounds(element);
    if (box.width <= 0 || box.height <= 0) return;
    ctx.save();
    ctx.globalAlpha = 0.85;
    ctx.setLineDash([6, 5]);
    ctx.lineWidth = 1.5;
    ctx.strokeStyle = context.dark ? "#8A7780" : "#B0A0A7";
    ctx.fillStyle = context.dark ? "rgba(138,119,128,.14)" : "rgba(176,160,167,.14)";
    ctx.fillRect(box.x, box.y, box.width, box.height);
    ctx.strokeRect(box.x, box.y, box.width, box.height);
    ctx.setLineDash([]);
    ctx.fillStyle = context.dark ? "#B0A0A7" : "#8A7780";
    ctx.font = `12px ${fontStackFor(2)}`;
    ctx.textAlign = "center";
    ctx.textBaseline = "middle";
    if (box.height > 26 && box.width > 70) {
      ctx.fillText(`${element.type} — not editable here`, box.x + box.width / 2, box.y + box.height / 2);
    }
    ctx.restore();
  },
  hitTest: hitTestElement,
  bounds: worldBounds,
  resize: (element, handle, x, y) => {
    const box = localBounds(element);
    const next = resizeBox(box, handle, x, y);
    return { x: next.x, y: next.y, width: next.width, height: next.height };
  },
};

export { PLACEHOLDER };
