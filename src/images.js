// Images on the canvas.
//
// Stage 1 already carried the `files` map through import and export untouched,
// so this only has to start DRAWING what was already being kept safe
// (Build_Plan 5-2). The stored shape is the original's:
//
//   element  { type:"image", fileId, status:"saved", scale:[1,1], ... }
//   files    { [fileId]: { id, mimeType, dataURL, created, lastRetrieved } }
//
// Two decisions worth knowing about:
//
//   * `fileId` is the SHA-1 of the bytes, like the original — so the same photo
//     dropped on two boards is stored once, and re-importing a file the board
//     already has adds no bytes at all.
//   * anything over the size budget is re-encoded smaller BEFORE it is stored.
//     A phone photo is 4 MB of base64 in IndexedDB otherwise, and the browser
//     silently stops saving once the quota is gone — which on this app means
//     losing a drawing, not just an image.

import { createElement, newId } from "./model.js";

export const MAX_PIXELS = 1600;          // long edge after downscaling
export const MAX_STORED_BYTES = 900_000; // roughly 1.2 MB as base64
export const ACCEPT = "image/png,image/jpeg,image/webp,image/gif,image/svg+xml";

const cache = new Map();       // fileId → { image, state }
const pending = new Set();

// The renderer, the PNG exporter and the library thumbnails all need the same
// decoded bitmaps, and threading the files map through four call signatures
// bought nothing. The app points this at the open board's files instead.
let fileSource = {};
let readyCallback = null;

export function setFileSource(files) {
  fileSource = files || {};
}

export function onImageReady(callback) {
  readyCallback = callback;
}

export class ImageError extends Error {}

/* ------------------------------------------------------------------ hashing */

async function sha1Hex(buffer) {
  if (!globalThis.crypto?.subtle?.digest) return null;
  try {
    const digest = await crypto.subtle.digest("SHA-1", buffer);
    return [...new Uint8Array(digest)].map((byte) => byte.toString(16).padStart(2, "0")).join("");
  } catch {
    return null;
  }
}

/* -------------------------------------------------------------- downscaling */

function loadBitmap(dataURL) {
  return new Promise((resolve, reject) => {
    const image = new Image();
    image.onload = () => resolve(image);
    image.onerror = () => reject(new ImageError("That image could not be read."));
    image.src = dataURL;
  });
}

function toDataURL(buffer, mimeType) {
  const bytes = new Uint8Array(buffer);
  let binary = "";
  const chunk = 0x8000;
  for (let i = 0; i < bytes.length; i += chunk) {
    binary += String.fromCharCode(...bytes.subarray(i, i + chunk));
  }
  return `data:${mimeType};base64,${btoa(binary)}`;
}

async function shrink(dataURL, mimeType) {
  const image = await loadBitmap(dataURL);
  const longEdge = Math.max(image.naturalWidth, image.naturalHeight);
  const ratio = Math.min(1, MAX_PIXELS / (longEdge || 1));
  const width = Math.max(1, Math.round(image.naturalWidth * ratio));
  const height = Math.max(1, Math.round(image.naturalHeight * ratio));

  let canvas = document.createElement("canvas");
  try {
    canvas.width = width;
    canvas.height = height;
    const ctx = canvas.getContext("2d");
    if (!ctx) return { dataURL, mimeType, width: image.naturalWidth, height: image.naturalHeight };
    ctx.drawImage(image, 0, 0, width, height);
    // PNG keeps transparency; everything else is smaller as JPEG.
    const targetType = mimeType === "image/png" ? "image/png" : "image/jpeg";
    const encoded = canvas.toDataURL(targetType, 0.86);
    return { dataURL: encoded, mimeType: targetType, width, height };
  } finally {
    canvas.width = 0;
    canvas.height = 0;
    canvas = null;
  }
}

/* -------------------------------------------------------------- file intake */

/**
 * Turn a picked file into a files-map entry plus the natural size.
 * @returns {Promise<{fileId:string, entry:object, width:number, height:number, shrunk:boolean}>}
 */
export async function readImageFile(file) {
  if (!file) throw new ImageError("No file was chosen.");
  if (!/^image\//.test(file.type)) throw new ImageError("That file is not an image.");

  const buffer = await file.arrayBuffer();
  let mimeType = file.type;
  let dataURL = toDataURL(buffer, mimeType);
  let width = 0;
  let height = 0;
  let shrunk = false;

  if (mimeType === "image/svg+xml") {
    // SVG is already small and scales cleanly; measure it but never re-encode.
    const image = await loadBitmap(dataURL);
    width = image.naturalWidth || 300;
    height = image.naturalHeight || 200;
  } else {
    const probe = await loadBitmap(dataURL);
    width = probe.naturalWidth;
    height = probe.naturalHeight;
    if (buffer.byteLength > MAX_STORED_BYTES || Math.max(width, height) > MAX_PIXELS) {
      const smaller = await shrink(dataURL, mimeType);
      dataURL = smaller.dataURL;
      mimeType = smaller.mimeType;
      width = smaller.width;
      height = smaller.height;
      shrunk = true;
    }
  }

  const fileId = (await sha1Hex(buffer)) || newId();
  const now = Date.now();
  return {
    fileId,
    width,
    height,
    shrunk,
    entry: { id: fileId, mimeType, dataURL, created: now, lastRetrieved: now },
  };
}

/** An image element sized to fit comfortably in the current view. */
export function createImageElement({ fileId, width, height, x, y, maxWidth = 480 }) {
  const ratio = Math.min(1, maxWidth / Math.max(width, 1));
  const drawWidth = Math.max(16, Math.round(width * ratio));
  const drawHeight = Math.max(16, Math.round(height * ratio));
  return createElement("image", {
    fileId,
    status: "saved",
    scale: [1, 1],
    crop: null,
    x: x - drawWidth / 2,
    y: y - drawHeight / 2,
    width: drawWidth,
    height: drawHeight,
  });
}

/* ------------------------------------------------------------------- cache */

/**
 * The decoded bitmap for a file id, or null while it loads.
 * The ready callback fires once per image so the renderer can mark the static
 * layer dirty instead of redrawing every frame on the chance one arrived.
 */
export function imageFor(fileId) {
  if (!fileId) return null;
  const cached = cache.get(fileId);
  if (cached) return cached.state === "ready" ? cached.image : null;
  const entry = fileSource?.[fileId];
  if (!entry?.dataURL || pending.has(fileId)) return null;

  pending.add(fileId);
  const image = new Image();
  const record = { image, state: "loading" };
  cache.set(fileId, record);
  image.onload = () => {
    record.state = "ready";
    pending.delete(fileId);
    readyCallback?.(fileId);
  };
  image.onerror = () => {
    record.state = "error";
    pending.delete(fileId);
    readyCallback?.(fileId);
  };
  image.src = entry.dataURL;
  return null;
}

/** Blocking variant for export: waits for every referenced image to decode. */
export async function ensureImagesReady(elements) {
  const ids = [...usedFileIds(elements)].filter((id) => fileSource?.[id]);
  await Promise.all(ids.map((id) => new Promise((resolve) => {
    if (imageFor(id)) { resolve(); return; }
    const record = cache.get(id);
    if (!record || record.state !== "loading") { resolve(); return; }
    const done = () => resolve();
    record.image.addEventListener("load", done, { once: true });
    record.image.addEventListener("error", done, { once: true });
    setTimeout(done, 4000);
  })));
}

export function dataUrlFor(fileId) {
  return fileSource?.[fileId]?.dataURL || null;
}

export function imageState(fileId) {
  return cache.get(fileId)?.state || "missing";
}

export function forgetImages() {
  cache.clear();
  pending.clear();
}

/** Files still referenced by at least one element — used to drop orphans. */
export function usedFileIds(elements) {
  const used = new Set();
  for (const element of elements) {
    if (element.fileId) used.add(element.fileId);
  }
  return used;
}
