// Copy, paste and "copy styles".
//
// The wire format is excalidraw.com's clipboard JSON, so a selection copied
// here pastes there and the other way round:
//   { type: "excalidraw/clipboard", elements: [...], files: {...} }
//
// The system clipboard is asked first and an in-memory buffer is the fallback.
// iOS refuses clipboard reads outside a user gesture and Safari can reject them
// outright, so the fallback is not optional — without it, copy/paste would work
// on the desktop and silently do nothing on the iPad this app is FOR.

import { cloneElements } from "./model.js";

export const CLIPBOARD_TYPE = "excalidraw/clipboard";

/** Properties "copy styles" carries. Geometry and identity are never included. */
export const STYLE_KEYS = [
  "strokeColor", "backgroundColor", "fillStyle", "strokeWidth", "strokeStyle",
  "roughness", "opacity", "roundness", "fontSize", "fontFamily", "textAlign",
  "startArrowhead", "endArrowhead", "arrowType",
];

let buffer = null;        // { elements, files }
let styleBuffer = null;   // plain object of STYLE_KEYS

export function hasBuffer() {
  return !!buffer?.elements?.length;
}

export function hasStyleBuffer() {
  return !!styleBuffer;
}

export function copyStyles(element) {
  if (!element) return null;
  const style = {};
  for (const key of STYLE_KEYS) {
    if (key in element && element[key] !== undefined) style[key] = element[key];
  }
  styleBuffer = style;
  return style;
}

export function pasteStyles() {
  return styleBuffer ? { ...styleBuffer } : null;
}

function payloadFor(elements, files) {
  const used = {};
  for (const element of elements) {
    if (element.fileId && files?.[element.fileId]) used[element.fileId] = files[element.fileId];
  }
  return { type: CLIPBOARD_TYPE, version: 1, elements: elements.map((element) => ({ ...element })), files: used };
}

/**
 * Put a selection on the clipboard.
 * Always fills the internal buffer, then tries the system clipboard as a bonus.
 */
export async function writeElements(elements, files) {
  const payload = payloadFor(elements, files);
  buffer = { elements: payload.elements, files: payload.files };
  try {
    if (navigator.clipboard?.writeText) {
      await navigator.clipboard.writeText(JSON.stringify(payload));
      return "system";
    }
  } catch {
    // Denied or unavailable — the internal buffer already has it.
  }
  return "internal";
}

function parsePayload(text) {
  if (!text || typeof text !== "string") return null;
  const trimmed = text.trim();
  if (!trimmed.startsWith("{")) return null;
  let data;
  try {
    data = JSON.parse(trimmed);
  } catch {
    return null;
  }
  if (data?.type !== CLIPBOARD_TYPE || !Array.isArray(data.elements)) return null;
  return { elements: data.elements, files: data.files || {} };
}

/**
 * Read the clipboard.
 * @returns {Promise<{elements:object[], files:object, text?:string}|null>}
 */
export async function readElements() {
  try {
    if (navigator.clipboard?.readText) {
      const text = await navigator.clipboard.readText();
      const parsed = parsePayload(text);
      if (parsed) return parsed;
      if (text && text.trim()) return { elements: [], files: {}, text };
    }
  } catch {
    // Safari throws when the read is not tied to a gesture. Fall through.
  }
  if (buffer?.elements?.length) return { elements: buffer.elements, files: buffer.files };
  return null;
}

/** Fresh ids and relationships rewritten to stay inside the pasted set. */
export function materialise(elements, offset) {
  return cloneElements(elements, offset);
}

/** PNG/SVG onto the system clipboard, where the browser allows it. */
export async function writeImageBlob(blob) {
  if (!navigator.clipboard?.write || typeof ClipboardItem === "undefined") {
    throw new Error("This browser cannot put images on the clipboard. Use Export instead.");
  }
  await navigator.clipboard.write([new ClipboardItem({ [blob.type]: blob })]);
}

export function clearBuffers() {
  buffer = null;
  styleBuffer = null;
}
