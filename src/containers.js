// Text that lives inside a shape, and labels that ride on an arrow.
//
// The stored form is excalidraw.com's: the text stays a normal `text` element
// with `containerId` pointing at its host, and the host lists it in
// `boundElements` as `{ id, type: "text" }`. Nothing new is invented, so a
// labelled box drawn here opens as a labelled box there.
//
//   text            the WRAPPED string that is painted
//   originalText    what was typed, unwrapped — the source of truth
//
// Rewriting `originalText` on a re-wrap would slowly destroy the user's line
// breaks, so wrapping only ever produces `text` (Build_Plan 5-1).
//
// Pure module — the caller injects a line-measuring function so this file never
// touches a canvas (Expansion_Plan 2-7).

import { BOUND_TEXT_PADDING } from "./model.js";
import { localBounds } from "./geometry.js";

export const PADDING = BOUND_TEXT_PADDING;

export const TEXT_CONTAINER_TYPES = new Set(["rectangle", "diamond", "ellipse", "image", "arrow"]);

export function canHoldText(element) {
  return !!element
    && !element.isDeleted
    && !element.locked
    && TEXT_CONTAINER_TYPES.has(element.type)
    && !element.containerId;
}

export function isBoundText(element) {
  return !!element && element.type === "text" && !!element.containerId;
}

/** The id of the label living inside `element`, if it has one. */
export function boundTextIdOf(element) {
  const list = Array.isArray(element?.boundElements) ? element.boundElements : [];
  const entry = list.find((item) => item?.type === "text");
  return entry ? entry.id : null;
}

/**
 * Usable text width inside a container.
 * A diamond and an ellipse waste the corners, so the original narrows the text
 * box rather than letting letters spill outside the outline.
 */
export function usableWidth(container) {
  const box = localBounds(container);
  const width = Math.abs(box.width);
  if (container.type === "ellipse") return Math.max(24, width / Math.SQRT2 - PADDING * 2);
  if (container.type === "diamond") return Math.max(24, width / 2 - PADDING * 2);
  if (container.type === "arrow") return Math.max(48, Math.hypot(box.width, box.height) - PADDING * 2);
  return Math.max(24, width - PADDING * 2);
}

export function usableHeightFor(container, textHeight) {
  const box = localBounds(container);
  const height = Math.abs(box.height);
  if (container.type === "ellipse") return Math.max(height, (textHeight + PADDING * 2) * Math.SQRT2);
  if (container.type === "diamond") return Math.max(height, (textHeight + PADDING * 2) * 2);
  return Math.max(height, textHeight + PADDING * 2);
}

/* ------------------------------------------------------------------ wrapping */

const BREAK_BEFORE = /[\s]/;

/**
 * Greedy wrap.
 * Korean and Japanese run without spaces, so a run that cannot be split on
 * whitespace is broken between characters rather than being allowed to
 * overflow — which is what "한글 줄바꿈" actually needs.
 *
 * @param {string} source
 * @param {number} maxWidth
 * @param {(line:string)=>number} measure
 */
export function wrapText(source, maxWidth, measure) {
  const paragraphs = String(source ?? "").split("\n");
  const out = [];
  for (const paragraph of paragraphs) {
    if (!paragraph) { out.push(""); continue; }
    if (measure(paragraph) <= maxWidth) { out.push(paragraph); continue; }
    // Every paragraph must produce at least one line. A run of spaces wider
    // than the box otherwise falls through every branch below and vanishes,
    // silently shifting the rest of the label up a line.
    const startedAt = out.length;

    let line = "";
    let pending = "";
    const flush = () => {
      if (line) out.push(line);
      line = "";
    };
    const words = paragraph.split(/(\s+)/);

    for (const word of words) {
      if (!word) continue;
      const candidate = line + pending + word;
      if (measure(candidate) <= maxWidth) {
        line = candidate;
        pending = "";
        continue;
      }
      if (BREAK_BEFORE.test(word)) {
        // Trailing whitespace never starts the next line.
        pending = "";
        flush();
        continue;
      }
      if (line) flush();
      pending = "";
      // A single run that is still too wide: break it character by character.
      let chunk = "";
      for (const character of word) {
        if (chunk && measure(chunk + character) > maxWidth) {
          out.push(chunk);
          chunk = character;
        } else {
          chunk += character;
        }
      }
      line = chunk;
    }
    flush();
    if (out.length === startedAt) out.push("");
  }
  return out;
}

/* ------------------------------------------------------------------- layout */

/**
 * Geometry for a container and the text inside it.
 *
 * @param {object} container
 * @param {object} text
 * @param {(line:string, element:object)=>number} measureLine
 * @returns {{text:object, container:object|null}} patches (empty objects if nothing moved)
 */
export function layoutBoundText(container, text, measureLine) {
  const fontSize = text.fontSize || 20;
  const lineHeight = text.lineHeight || 1.25;
  const maxWidth = usableWidth(container);
  const measure = (line) => measureLine(line || " ", text);
  const lines = wrapText(text.originalText ?? text.text ?? "", maxWidth, measure);
  const wrapped = lines.join("\n");

  let width = 0;
  for (const line of lines) width = Math.max(width, measure(line));
  const height = Math.max(1, lines.length) * fontSize * lineHeight;

  if (container.type === "arrow") {
    const box = localBounds(container);
    const points = container.points || [];
    let midX = box.x + box.width / 2;
    let midY = box.y + box.height / 2;
    if (points.length >= 2) {
      const a = points[0];
      const b = points[points.length - 1];
      midX = container.x + (a[0] + b[0]) / 2;
      midY = container.y + (a[1] + b[1]) / 2;
    }
    return {
      text: {
        text: wrapped,
        width: Math.ceil(width),
        height: Math.ceil(height),
        x: midX - width / 2,
        y: midY - height / 2,
        textAlign: "center",
        verticalAlign: "middle",
        autoResize: false,
      },
      container: null,
    };
  }

  const box = localBounds(container);
  const neededHeight = usableHeightFor(container, height);
  const containerPatch = Math.abs(neededHeight - Math.abs(box.height)) > 0.5
    ? { height: neededHeight }
    : null;
  const effectiveHeight = containerPatch ? neededHeight : Math.abs(box.height);

  return {
    text: {
      text: wrapped,
      width: Math.ceil(maxWidth),
      height: Math.ceil(height),
      x: box.x + (Math.abs(box.width) - maxWidth) / 2,
      y: box.y + (effectiveHeight - height) / 2,
      textAlign: text.textAlign || "center",
      verticalAlign: "middle",
      autoResize: false,
    },
    container: containerPatch,
  };
}

/**
 * Update payloads for every container/label pair touched by a change.
 * Shaped like an Action so the caller can fold it into one undo step.
 *
 * @returns {{elementIds:string[], changes:object[]}|null}
 */
export function containerUpdates(scene, ids, measureLine) {
  const pairs = new Map();   // containerId → textId

  const consider = (element) => {
    if (!element || element.isDeleted) return;
    if (isBoundText(element)) {
      const container = scene.get(element.containerId);
      if (container && !container.isDeleted) pairs.set(container.id, element.id);
      return;
    }
    const list = Array.isArray(element.boundElements) ? element.boundElements : [];
    for (const entry of list) {
      if (entry?.type !== "text") continue;
      const text = scene.get(entry.id);
      if (text && !text.isDeleted) pairs.set(element.id, entry.id);
    }
  };

  for (const id of ids) consider(scene.get(id));
  if (!pairs.size) return null;

  const elementIds = [];
  const changes = [];
  for (const [containerId, textId] of pairs) {
    const container = scene.get(containerId);
    const text = scene.get(textId);
    if (!container || !text) continue;
    const layout = layoutBoundText(container, text, measureLine);
    const textPatch = differing(text, layout.text);
    if (textPatch) { elementIds.push(textId); changes.push(textPatch); }
    if (layout.container) {
      const containerPatch = differing(container, layout.container);
      if (containerPatch) { elementIds.push(containerId); changes.push(containerPatch); }
    }
  }
  return elementIds.length ? { elementIds, changes } : null;
}

function differing(element, patch) {
  const out = {};
  for (const [key, value] of Object.entries(patch)) {
    const current = element[key];
    if (typeof value === "number" && typeof current === "number") {
      if (Math.abs(value - current) > 0.01) out[key] = value;
    } else if (current !== value) {
      out[key] = value;
    }
  }
  return Object.keys(out).length ? out : null;
}

/** Every id that must disappear alongside `ids` — labels follow their host. */
export function withBoundText(scene, ids) {
  const out = new Set(ids);
  for (const id of ids) {
    const element = scene.get(id);
    if (!element) continue;
    const list = Array.isArray(element.boundElements) ? element.boundElements : [];
    for (const entry of list) {
      if (entry?.type === "text" && scene.get(entry.id)) out.add(entry.id);
    }
  }
  return [...out];
}
