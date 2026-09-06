// Finding text on the canvas.
//
// The infinite canvas makes "I know I wrote that somewhere" a real problem —
// scrolling back to content only helps if everything is in one place. Matches
// are highlighted on the OVERLAY layer, which stage 1 built and left empty for
// exactly this (Expansion_Plan 2-6).
//
// Pure module — the caller injects the line measurer (Expansion_Plan 2-7).

import { rotatePoint, localBounds } from "./geometry.js";

/** Case-insensitive, accent-naive. Hangul compares fine under toLowerCase. */
function normalise(value) {
  return String(value ?? "").toLowerCase();
}

/**
 * All matches for `query`, in reading order (top-to-bottom, left-to-right).
 *
 * @param {object[]} elements
 * @param {string} query
 * @param {(line:string, element:object)=>number} measureLine
 * @returns {Array<{elementId:string, index:number, box:object}>}
 */
export function findMatches(elements, query, measureLine) {
  const needle = normalise(query).trim();
  if (!needle) return [];

  const results = [];
  for (const element of elements) {
    if (element.isDeleted || element.type !== "text") continue;
    const painted = String(element.text ?? "");
    if (!normalise(painted).includes(needle)) continue;

    const fontSize = element.fontSize || 20;
    const lineHeight = fontSize * (element.lineHeight || 1.25);
    const box = localBounds(element);
    const align = element.textAlign || "left";
    const lines = painted.split("\n");

    lines.forEach((line, lineIndex) => {
      const haystack = normalise(line);
      let from = 0;
      for (;;) {
        const at = haystack.indexOf(needle, from);
        if (at < 0) break;
        const before = line.slice(0, at);
        const match = line.slice(at, at + needle.length);
        const beforeWidth = measureLine(before, element);
        const matchWidth = Math.max(4, measureLine(match, element));
        const lineWidth = measureLine(line, element);
        const originX = align === "center" ? (box.width - lineWidth) / 2
          : align === "right" ? box.width - lineWidth : 0;

        results.push({
          elementId: element.id,
          index: results.length,
          box: quadFor(element, box, {
            x: originX + beforeWidth,
            y: lineIndex * lineHeight + lineHeight * 0.1,
            width: matchWidth,
            height: fontSize * 1.1,
          }),
        });
        from = at + Math.max(1, needle.length);
      }
    });
  }

  results.sort((a, b) => (a.box.y - b.box.y) || (a.box.x - b.box.x));
  return results.map((result, index) => ({ ...result, index }));
}

/** Local rectangle → world-space corner list, so rotated text still highlights. */
function quadFor(element, box, local) {
  const angle = element.angle || 0;
  const cx = box.x + box.width / 2;
  const cy = box.y + box.height / 2;
  const x = box.x + local.x;
  const y = box.y + local.y;
  const corners = [
    [x, y],
    [x + local.width, y],
    [x + local.width, y + local.height],
    [x, y + local.height],
  ].map(([px, py]) => rotatePoint(px, py, cx, cy, angle));
  const xs = corners.map((point) => point[0]);
  const ys = corners.map((point) => point[1]);
  const minX = Math.min(...xs);
  const minY = Math.min(...ys);
  return {
    corners,
    x: minX,
    y: minY,
    width: Math.max(...xs) - minX,
    height: Math.max(...ys) - minY,
  };
}

/* -------------------------------------------------------------------- links */

/**
 * Only http(s) is ever opened.
 *
 * `javascript:` and `data:` URLs in a link field are a stored-XSS vector: the
 * value arrives from an imported file, and a tap would run it with the app's
 * own origin. Everything outside the allow-list is rejected on the way in AND
 * on the way out.
 */
export function safeLink(value) {
  const raw = String(value ?? "").trim();
  if (!raw) return null;
  let url;
  try {
    url = new URL(raw, "https://example.invalid/");
  } catch {
    return null;
  }
  if (url.protocol !== "http:" && url.protocol !== "https:") return null;
  if (url.hostname === "example.invalid") return null;   // was a bare relative path
  return url.href;
}

/** What the user typed, tidied — "slate.app" becomes "https://slate.app". */
export function normaliseLinkInput(value) {
  const raw = String(value ?? "").trim();
  if (!raw) return null;
  if (/^[a-z][a-z0-9+.-]*:/i.test(raw)) return safeLink(raw);
  return safeLink(`https://${raw}`);
}

/** Where the link badge sits: the element's top-right corner. */
export function linkBadgeAt(element) {
  const box = localBounds(element);
  const angle = element.angle || 0;
  const cx = box.x + box.width / 2;
  const cy = box.y + box.height / 2;
  return rotatePoint(box.x + box.width, box.y, cx, cy, angle);
}
