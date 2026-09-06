// Board records — the thing excalidraw.com does not have.
//
// Board size is recorded on every save and shown in the list. That number is
// not decoration: the stage-4 entry condition is "measure how big a board
// actually gets", and this makes the measurement accumulate on its own rather
// than needing a separate exercise later (Expansion_Plan 4-3).

import {
  listBoards, getBoard, putBoardMeta, readContent, writeContent, writeContentRaw,
  deleteBoard, restoreBoard, purgeBoard, estimateBytes, readPreviousContent,
} from "./store.js";
import { newId, DEFAULT_CANVAS_BACKGROUND } from "./model.js";
import { SCHEMA_VERSION } from "./version.js";

export const DEFAULT_APP_STATE = {
  scrollX: 0,
  scrollY: 0,
  zoom: 1,
  viewBackgroundColor: DEFAULT_CANVAS_BACKGROUND,
};

export async function createBoard(title = "Untitled") {
  const now = Date.now();
  const meta = {
    id: newId(),
    title,
    createdAt: now,
    updatedAt: now,
    elementCount: 0,
    bytes: 0,
    schemaVersion: SCHEMA_VERSION,
  };
  await putBoardMeta(meta);
  await writeContentRaw(meta.id, { elements: [], appState: { ...DEFAULT_APP_STATE }, files: {} });
  return meta;
}

export async function loadBoard(id) {
  const meta = await getBoard(id);
  if (!meta) return null;
  const content = await readContent(id);
  return {
    meta,
    elements: content?.elements || [],
    appState: { ...DEFAULT_APP_STATE, ...(content?.appState || {}) },
    files: content?.files || {},
  };
}

export async function saveBoard(meta, { elements, appState, files }) {
  const content = { elements, appState, files: files || {} };
  const bytes = estimateBytes(content);
  await writeContent(meta.id, content);
  const next = {
    ...meta,
    updatedAt: Date.now(),
    elementCount: elements.filter((element) => !element.isDeleted).length,
    bytes,
    schemaVersion: SCHEMA_VERSION,
  };
  await putBoardMeta(next);
  return next;
}

export async function renameBoard(id, title) {
  const meta = await getBoard(id);
  if (!meta) return null;
  meta.title = title;
  meta.updatedAt = Date.now();
  await putBoardMeta(meta);
  return meta;
}

export function formatBytes(bytes) {
  if (!bytes) return "0 KB";
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${Math.round(bytes / 1024)} KB`;
  return `${(bytes / 1024 / 1024).toFixed(1)} MB`;
}

export function formatDate(timestamp) {
  if (!timestamp) return "";
  const date = new Date(timestamp);
  const now = new Date();
  const sameDay = date.toDateString() === now.toDateString();
  if (sameDay) return date.toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" });
  return date.toLocaleDateString();
}

export {
  listBoards, getBoard, deleteBoard, restoreBoard, purgeBoard, readPreviousContent,
};
