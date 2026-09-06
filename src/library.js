// Saved shapes — the `.excalidrawlib` file format.
//
//   { type:"excalidrawlib", version:2, source,
//     libraryItems:[ { id, status, name, created, elements:[...] } ] }
//
// Items are stored normalised to the origin so an insert can drop them wherever
// the user points without carrying the coordinates they happened to be drawn at.
//
// Pure module apart from the settings read/write — no DOM.

import { SOURCE } from "./model.js";
import { readSetting, writeSetting } from "./store.js";
import { boundsOfMany } from "./geometry.js";
import { cloneElements } from "./model.js";
import { newId } from "./model.js";

export const LIBRARY_TYPE = "excalidrawlib";
export const LIBRARY_VERSION = 2;
const KEY = "library";
const MAX_ITEMS = 200;

export class LibraryError extends Error {}

export async function loadLibrary() {
  const stored = await readSetting(KEY, null);
  if (!Array.isArray(stored)) return [];
  return stored.filter((item) => item && Array.isArray(item.elements));
}

export async function saveLibrary(items) {
  await writeSetting(KEY, items.slice(0, MAX_ITEMS));
  return items;
}

/** Shift a set of elements so its top-left corner sits at (0, 0). */
export function normalise(elements) {
  const live = elements.filter((element) => !element.isDeleted);
  const box = boundsOfMany(live);
  if (!box) return live.map((element) => ({ ...element }));
  return live.map((element) => ({
    ...JSON.parse(JSON.stringify(element)),
    x: (element.x || 0) - box.x,
    y: (element.y || 0) - box.y,
  }));
}

/**
 * @param {object[]} elements
 * @param {string} name
 * @param {object} files the board's image map — only the entries this item
 *   actually references are copied in
 *
 * The original's library format has no place for images, so an item saved
 * there loses them. Saving the bytes alongside is an extension: another app
 * ignores the extra `files` key, and slate reads it back. The alternative is
 * an item that renders as a broken frame on every board but the one it was
 * saved from, which is data loss dressed up as a feature.
 */
export function makeItem(elements, name, files = {}) {
  const kept = normalise(elements);
  const used = {};
  for (const element of kept) {
    if (element.fileId && files[element.fileId]) used[element.fileId] = files[element.fileId];
  }
  return {
    id: newId(),
    status: "unpublished",
    name: name || "",
    created: Date.now(),
    elements: kept,
    files: used,
  };
}

/**
 * Fresh ids and relationships rewritten, then placed at a point.
 * @returns {{elements:object[], files:object}} the files must be merged into
 *   the target board, or an item with a photo in it arrives as a blank frame.
 */
export function instantiate(item, x, y) {
  const box = boundsOfMany(item.elements) || { x: 0, y: 0, width: 0, height: 0 };
  return {
    elements: cloneElements(item.elements, {
      // box.x/box.y are subtracted rather than assumed to be zero. makeItem
      // normalises to the origin, but parseFile cannot: an .excalidrawlib
      // written by the original keeps the coordinates its shapes were drawn at,
      // and ignoring them dropped every imported item outside the viewport.
      offsetX: x - box.width / 2 - (box.x || 0),
      offsetY: y - box.height / 2 - (box.y || 0),
    }),
    files: item.files || {},
  };
}

export function toFile(items) {
  return {
    type: LIBRARY_TYPE,
    version: LIBRARY_VERSION,
    source: SOURCE,
    libraryItems: items.map((item) => ({
      id: item.id,
      status: item.status || "unpublished",
      name: item.name || "",
      created: item.created || Date.now(),
      elements: item.elements,
      files: item.files || {},
    })),
  };
}

export function parseFile(text) {
  let data;
  try {
    data = JSON.parse(text);
  } catch {
    throw new LibraryError("That file is not valid JSON.");
  }
  if (data?.type !== LIBRARY_TYPE) throw new LibraryError("That file is not an Excalidraw library.");
  if (Number(data.version) > LIBRARY_VERSION) {
    throw new LibraryError(`This library uses format ${data.version}; slate reads ${LIBRARY_VERSION}.`);
  }
  // Version 1 stored a plain array of element arrays; version 2 wraps each in
  // an object. Both are accepted so an older download still opens.
  const raw = Array.isArray(data.libraryItems) ? data.libraryItems
    : Array.isArray(data.library) ? data.library : [];
  const items = [];
  for (const entry of raw) {
    const elements = Array.isArray(entry) ? entry : entry?.elements;
    if (!Array.isArray(elements) || !elements.length) continue;
    items.push({
      id: entry?.id || newId(),
      status: entry?.status || "unpublished",
      name: entry?.name || "",
      created: entry?.created || Date.now(),
      elements: elements.map((element) => ({ ...element })),
      // Absent in a file written by the original — an item from there simply
      // has no images to carry.
      files: (!Array.isArray(entry) && entry?.files) || {},
    });
  }
  if (!items.length) throw new LibraryError("That library has no shapes in it.");
  return items;
}

export function mergeItems(existing, incoming) {
  const seen = new Set(existing.map((item) => item.id));
  const added = incoming.filter((item) => !seen.has(item.id));
  return [...added, ...existing].slice(0, MAX_ITEMS);
}
