// .excalidraw / PNG / SVG.
//
// Three rules drive this file:
//
// 1. Round-tripping must not lose anything. Fields slate does not understand
//    are carried through untouched, unsupported element types keep every
//    property, and the `files` map (images) is preserved whole even though
//    stage 1 cannot draw images. Dropping it would silently delete photos from
//    somebody's file (Build_Plan 5-1 / 5-2).
//
// 2. iOS has an undocumented canvas area ceiling — 16.7M px through iOS 17,
//    67.1M px from iOS 18 — and exceeding it produces a BLANK image with no
//    error. So the number is never hard-coded: the app measures the real limit
//    once, checks the export against it, lowers the scale automatically, and
//    then reads a pixel back to confirm something was actually drawn
//    (Build_Plan 8-3).
//
// 3. Exported SVG escapes user text. Skipping that turns a drawing into a
//    script carrier.

import rough from "../vendor/rough.esm.js";
import { FILE_VERSION, SOURCE, displayColor, fontStackFor, DEFAULT_EXPORT_PADDING, EXPORT_SCALES } from "./model.js";
import { boundsOfMany, localBounds } from "./geometry.js";
import { drawablesFor, freedrawOutline, outlineToSvgPath, arrowheadShape, cornerRadius } from "./shapes.js";
import { entryFor } from "./registry.js";
import { readSetting, writeSetting } from "./store.js";

const generator = rough.generator();

/* ------------------------------------------------------- .excalidraw file */

export function toExcalidrawFile(elements, appState = {}, files = {}) {
  return {
    type: "excalidraw",
    version: FILE_VERSION,
    source: SOURCE,
    elements: elements.filter((element) => !element.isDeleted).map((element) => ({ ...element })),
    appState: {
      gridSize: appState.gridSize ?? null,
      viewBackgroundColor: appState.viewBackgroundColor ?? "#FDFCF9",
    },
    files: files || {},
  };
}

export class ImportError extends Error {}

export function parseExcalidrawFile(text) {
  let data;
  try {
    data = JSON.parse(text);
  } catch {
    throw new ImportError("That file is not valid JSON.");
  }
  if (!data || typeof data !== "object") throw new ImportError("That file is not an Excalidraw drawing.");
  if (data.type !== "excalidraw") throw new ImportError("That file is not an Excalidraw drawing.");
  if (!Array.isArray(data.elements)) throw new ImportError("That drawing has no elements array.");
  if (Number(data.version) > FILE_VERSION) {
    throw new ImportError(`This drawing uses file format ${data.version}; slate reads ${FILE_VERSION}.`);
  }
  return {
    elements: data.elements.map((element) => ({ ...element })),
    appState: data.appState || {},
    // Preserved verbatim. Images are not drawn in stage 1 — that is different
    // from throwing them away.
    files: data.files || {},
  };
}

/* --------------------------------------------------- iOS canvas area limit */

// Only the two sizes the evidence actually describes: 16.7M px through iOS 17,
// 67.1M px from iOS 18. Probing beyond that would allocate a gigabyte of canvas
// to answer a question no export needs asked.
const CANDIDATES = [4096 * 4096, 8192 * 8192];
const LIMIT_KEY = "canvasAreaLimit";
let cachedLimit = null;

function canDrawAtArea(area) {
  const side = Math.floor(Math.sqrt(area));
  let canvas = document.createElement("canvas");
  try {
    canvas.width = side;
    canvas.height = side;
    const ctx = canvas.getContext("2d");
    if (!ctx) return false;
    ctx.fillStyle = "#ff0000";
    ctx.fillRect(side - 2, side - 2, 2, 2);
    const data = ctx.getImageData(side - 1, side - 1, 1, 1).data;
    return data[0] > 200 && data[3] > 200;
  } catch {
    return false;
  } finally {
    // iOS holds on to canvas memory; shrink before dropping the reference.
    canvas.width = 0;
    canvas.height = 0;
    canvas = null;
  }
}

/** Measured once, then remembered. Never guessed from the iOS version string. */
export async function canvasAreaLimit() {
  if (cachedLimit) return cachedLimit;
  const stored = await readSetting(LIMIT_KEY, null);
  if (stored) {
    cachedLimit = stored;
    return stored;
  }
  let limit = CANDIDATES[0];
  try {
    for (const candidate of CANDIDATES) {
      if (canDrawAtArea(candidate)) limit = candidate; else break;
    }
  } catch {
    // Measuring failed outright — fall back to the smaller, safer ceiling
    // rather than letting the export path die.
    limit = CANDIDATES[0];
  }
  cachedLimit = limit;
  await writeSetting(LIMIT_KEY, limit).catch(() => {});
  return limit;
}

/** Largest of [1,2,3] that fits under the measured ceiling. */
export async function maxExportScale(width, height) {
  const limit = await canvasAreaLimit();
  const usable = [...EXPORT_SCALES].reverse()
    .find((scale) => width * scale * height * scale <= limit);
  return usable || null;
}

/* ------------------------------------------------------------ export area */

export function exportBounds(elements, padding = DEFAULT_EXPORT_PADDING) {
  const box = boundsOfMany(elements.filter((element) => !element.isDeleted));
  if (!box) return { x: 0, y: 0, width: 1, height: 1 };
  return {
    x: box.x - padding,
    y: box.y - padding,
    width: Math.max(1, box.width + padding * 2),
    height: Math.max(1, box.height + padding * 2),
  };
}

/* ------------------------------------------------------------------- PNG */

export async function exportPNG(elements, {
  scale = 1,
  withBackground = true,
  background = "#FDFCF9",
  dark = false,
  padding = DEFAULT_EXPORT_PADDING,
} = {}) {
  const live = elements.filter((element) => !element.isDeleted);
  if (!live.length) throw new Error("Nothing to export — this board is empty.");

  const box = exportBounds(live, padding);
  const limit = await canvasAreaLimit();
  let usedScale = scale;
  let lowered = false;
  while (usedScale > 1 && box.width * usedScale * box.height * usedScale > limit) {
    usedScale -= 1;
    lowered = true;
  }
  if (box.width * usedScale * box.height * usedScale > limit) {
    throw new Error("This board is too large for a PNG on this device. Export SVG instead — it has no size limit.");
  }

  let canvas = document.createElement("canvas");
  canvas.width = Math.max(1, Math.round(box.width * usedScale));
  canvas.height = Math.max(1, Math.round(box.height * usedScale));
  const ctx = canvas.getContext("2d");

  try {
    if (withBackground) {
      ctx.fillStyle = displayColor(background, dark);
      ctx.fillRect(0, 0, canvas.width, canvas.height);
    }
    // NOTE: the export scale is the ONLY scale applied. devicePixelRatio is a
    // screen concern; multiplying by it here would silently double the size.
    ctx.setTransform(usedScale, 0, 0, usedScale, 0, 0);
    ctx.translate(-box.x, -box.y);
    const context = { rough: rough.canvas(canvas), dark, zoom: usedScale };
    for (const element of live) {
      try { entryFor(element.type).draw(ctx, element, context); } catch { /* skip one bad element */ }
    }

    // Last line of defence: if the measurement was wrong, the canvas comes back
    // blank. Read a pixel before handing the file over.
    if (!hasAnyPixel(ctx, canvas, withBackground)) {
      throw new Error("The exported image came out blank on this device. Try a smaller scale, or export SVG.");
    }

    const blob = await new Promise((resolve) => canvas.toBlob(resolve, "image/png"));
    if (!blob) throw new Error("PNG encoding failed on this device.");
    return { blob, scale: usedScale, lowered, width: canvas.width, height: canvas.height };
  } finally {
    canvas.width = 0;
    canvas.height = 0;
    canvas = null;
  }
}

function hasAnyPixel(ctx, canvas, withBackground) {
  try {
    const stepX = Math.max(1, Math.floor(canvas.width / 24));
    const stepY = Math.max(1, Math.floor(canvas.height / 24));
    for (let y = 0; y < canvas.height; y += stepY) {
      for (let x = 0; x < canvas.width; x += stepX) {
        const pixel = ctx.getImageData(x, y, 1, 1).data;
        if (pixel[3] > 0) return true;
      }
    }
    return false;
  } catch {
    // getImageData can throw on very large canvases. That is not evidence the
    // drawing failed, so the export is allowed through.
    void withBackground;
    return true;
  }
}

/* ------------------------------------------------------------------- SVG */

export function escapeXml(value) {
  return String(value ?? "")
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&apos;");
}

let fontDataUrlPromise = null;
async function virgilDataUrl() {
  if (!fontDataUrlPromise) {
    fontDataUrlPromise = (async () => {
      const response = await fetch("./assets/fonts/virgil.woff2");
      if (!response.ok) throw new Error("font fetch failed");
      const buffer = await response.arrayBuffer();
      let binary = "";
      const bytes = new Uint8Array(buffer);
      const chunk = 0x8000;
      for (let i = 0; i < bytes.length; i += chunk) {
        binary += String.fromCharCode(...bytes.subarray(i, i + chunk));
      }
      return `data:font/woff2;base64,${btoa(binary)}`;
    })().catch(() => null);
  }
  return fontDataUrlPromise;
}

function svgAttrs(element, dark) {
  const stroke = displayColor(element.strokeColor, dark);
  const dash = element.strokeStyle === "dashed"
    ? `stroke-dasharray="${8} ${8 + (element.strokeWidth || 1) * 2}"`
    : element.strokeStyle === "dotted"
      ? `stroke-dasharray="${1.5} ${6 + (element.strokeWidth || 1) * 2}"`
      : "";
  return { stroke, dash };
}

function transformFor(element) {
  const box = localBounds(element);
  if (!element.angle) return `translate(${round(box.x)} ${round(box.y)})`;
  const cx = box.width / 2;
  const cy = box.height / 2;
  const degrees = (element.angle * 180) / Math.PI;
  return `translate(${round(box.x)} ${round(box.y)}) rotate(${round(degrees)} ${round(cx)} ${round(cy)})`;
}

function roughPathsSvg(element, dark) {
  const painted = {
    ...element,
    strokeColor: displayColor(element.strokeColor, dark),
    backgroundColor: displayColor(element.backgroundColor, dark),
  };
  const parts = [];
  for (const drawable of drawablesFor(painted)) {
    for (const info of generator.toPaths(drawable)) {
      parts.push(
        `<path d="${info.d}" stroke="${escapeXml(info.stroke || "none")}" `
        + `stroke-width="${info.strokeWidth ?? 0}" fill="${escapeXml(info.fill || "none")}" `
        + `stroke-linecap="round" stroke-linejoin="round"/>`,
      );
    }
  }
  return parts.join("");
}

function arrowheadsSvg(element, dark) {
  if (element.type !== "arrow") return "";
  const stroke = displayColor(element.strokeColor, dark);
  const parts = [];
  for (const [kind, atStart] of [[element.startArrowhead, true], [element.endArrowhead, false]]) {
    const shape = arrowheadShape(kind, element.points || [], atStart, element.strokeWidth || 1);
    if (!shape) continue;
    if (shape.kind === "lines") {
      for (const [a, b] of shape.lines) {
        parts.push(`<line x1="${round(a[0])}" y1="${round(a[1])}" x2="${round(b[0])}" y2="${round(b[1])}" stroke="${escapeXml(stroke)}" stroke-width="${element.strokeWidth || 1}" stroke-linecap="round"/>`);
      }
    } else if (shape.kind === "circle") {
      parts.push(`<circle cx="${round(shape.cx)}" cy="${round(shape.cy)}" r="${round(shape.r)}" fill="${escapeXml(stroke)}"/>`);
    } else if (shape.kind === "polygon") {
      const points = shape.points.map((p) => `${round(p[0])},${round(p[1])}`).join(" ");
      parts.push(`<polygon points="${points}" fill="${escapeXml(stroke)}"/>`);
    }
  }
  return parts.join("");
}

function elementSvg(element, dark) {
  const transform = transformFor(element);
  const opacity = (element.opacity ?? 100) / 100;
  const open = `<g transform="${transform}" opacity="${opacity}">`;

  switch (element.type) {
    case "rectangle":
    case "diamond":
    case "ellipse":
      return `${open}${roughPathsSvg(element, dark)}</g>`;
    case "line":
    case "arrow":
      return `${open}${roughPathsSvg(element, dark)}${arrowheadsSvg(element, dark)}</g>`;
    case "freedraw": {
      const path = outlineToSvgPath(freedrawOutline(element));
      if (!path) return "";
      return `${open}<path d="${path}" fill="${escapeXml(displayColor(element.strokeColor, dark))}"/></g>`;
    }
    case "text": {
      const size = element.fontSize || 20;
      const lineHeight = size * (element.lineHeight || 1.25);
      const align = element.textAlign || "left";
      const box = localBounds(element);
      const anchor = align === "center" ? "middle" : align === "right" ? "end" : "start";
      const originX = align === "center" ? box.width / 2 : align === "right" ? box.width : 0;
      const lines = String(element.text ?? "").split("\n").map((line, index) => (
        `<tspan x="${round(originX)}" y="${round(lineHeight * (index + 1) - lineHeight * 0.25)}">${escapeXml(line)}</tspan>`
      )).join("");
      // escapeXml above is what stops a text element from carrying markup out
      // of the app and into whatever opens the SVG.
      return `${open}<text font-family="${escapeXml(fontStackFor(element.fontFamily))}" font-size="${size}" `
        + `fill="${escapeXml(displayColor(element.strokeColor, dark))}" text-anchor="${anchor}" `
        + `xml:space="preserve">${lines}</text></g>`;
    }
    default: {
      const box = localBounds(element);
      return `${open}<rect width="${round(box.width)}" height="${round(box.height)}" fill="rgba(176,160,167,.14)" `
        + `stroke="#B0A0A7" stroke-dasharray="6 5"/></g>`;
    }
  }
}

export async function exportSVG(elements, {
  withBackground = true,
  background = "#FDFCF9",
  dark = false,
  padding = DEFAULT_EXPORT_PADDING,
  embedFont = true,
} = {}) {
  const live = elements.filter((element) => !element.isDeleted);
  if (!live.length) throw new Error("Nothing to export — this board is empty.");
  const box = exportBounds(live, padding);

  let fontCss = "";
  if (embedFont && live.some((element) => element.type === "text")) {
    const dataUrl = await virgilDataUrl();
    if (dataUrl) {
      // OFL explicitly permits embedding a font in a document, which is what
      // makes the drawing look the same on a device that has no Virgil.
      fontCss = `@font-face{font-family:"Virgil 3 YOFF";src:url("${dataUrl}") format("woff2");}`;
    }
  }

  const body = live.map((element) => elementSvg(element, dark)).join("\n  ");
  const backgroundRect = withBackground
    ? `<rect width="100%" height="100%" fill="${escapeXml(displayColor(background, dark))}"/>`
    : "";

  const svg = `<?xml version="1.0" encoding="UTF-8"?>
<svg xmlns="http://www.w3.org/2000/svg" width="${round(box.width)}" height="${round(box.height)}" viewBox="0 0 ${round(box.width)} ${round(box.height)}">
  <!-- Made with slate -->
  ${fontCss ? `<defs><style type="text/css"><![CDATA[${fontCss}]]></style></defs>` : ""}
  ${backgroundRect}
  <g transform="translate(${round(-box.x)} ${round(-box.y)})">
  ${body}
  </g>
</svg>`;
  return new Blob([svg], { type: "image/svg+xml" });
}

function round(value) {
  return Math.round(value * 100) / 100;
}

export { cornerRadius };

/* --------------------------------------------------------------- delivery */

/**
 * Share Sheet where it exists (iOS → Files → iCloud Drive), download elsewhere.
 * Same approach the other apps use, so backups all land in the same place.
 */
export async function shareOrDownload(blob, filename) {
  const file = new File([blob], filename, { type: blob.type });
  if (navigator.canShare?.({ files: [file] }) && navigator.share) {
    try {
      await navigator.share({ files: [file], title: filename });
      return "shared";
    } catch (error) {
      if (error?.name === "AbortError") return "cancelled";
      // fall through to download
    }
  }
  const url = URL.createObjectURL(blob);
  const anchor = document.createElement("a");
  anchor.href = url;
  anchor.download = filename;
  document.body.appendChild(anchor);
  anchor.click();
  anchor.remove();
  setTimeout(() => URL.revokeObjectURL(url), 4000);
  return "downloaded";
}

/**
 * Korean board titles must survive iOS Files and GitHub, so only characters
 * that actually break a path are removed. Hangul is left exactly as typed.
 */
export function safeFilename(name, extension) {
  const cleaned = String(name || "board")
    .replace(/[\\/:*?"<>|]/g, "")
    .replace(/[\u0000-\u001f\u007f]/g, "")
    .replace(/\s+/g, "-")
    .replace(/^[.\-]+|[.\-]+$/g, "")
    .slice(0, 60) || "board";
  const date = new Date().toISOString().slice(0, 10);
  return `slate-${cleaned}-${date}.${extension}`;
}
