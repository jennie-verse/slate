// Groups, lock, align, distribute, flip.
//
// Everything here returns an Action payload rather than touching the scene, so
// the single write path in actions.js still holds (Expansion_Plan 2-1).
//
// Groups follow the original's field exactly: `groupIds` runs innermost first,
// so grouping appends and ungrouping pops the last entry. Nesting therefore
// works without a second concept.
//
// Pure module — no DOM.

import { localBounds, worldBounds, boundsOfMany } from "./geometry.js";
import { newId } from "./model.js";

/* ------------------------------------------------------------------ groups */

export function outerGroupId(element) {
  const ids = element?.groupIds;
  return Array.isArray(ids) && ids.length ? ids[ids.length - 1] : null;
}

export function membersOfGroup(scene, groupId) {
  if (!groupId) return [];
  return scene.visible().filter((element) => outerGroupId(element) === groupId);
}

/**
 * Selecting one member of a group selects the group.
 * Bound labels come along too — a box and its text are one thing to the user.
 */
export function expandSelection(scene, ids) {
  const out = new Set();
  const add = (element) => {
    if (!element || element.isDeleted) return;
    out.add(element.id);
    const list = Array.isArray(element.boundElements) ? element.boundElements : [];
    for (const entry of list) {
      if (entry?.type !== "text") continue;
      const text = scene.get(entry.id);
      if (text && !text.isDeleted) out.add(text.id);
    }
  };
  for (const id of ids) {
    const element = scene.get(id);
    if (!element) continue;
    const groupId = outerGroupId(element);
    if (groupId) for (const member of membersOfGroup(scene, groupId)) add(member);
    else add(element);
  }
  return out;
}

/** Bound labels are moved by their container, never selected on their own. */
export function withoutBoundText(scene, ids) {
  return [...ids].filter((id) => {
    const element = scene.get(id);
    return element && !element.containerId;
  });
}

export function groupPatch(scene, ids) {
  const elements = ids.map((id) => scene.get(id)).filter((element) => element && !element.isDeleted);
  if (elements.length < 2) return null;
  const groupId = newId();
  return {
    groupId,
    elementIds: elements.map((element) => element.id),
    changes: elements.map((element) => ({
      groupIds: [...(element.groupIds || []), groupId],
    })),
  };
}

export function ungroupPatch(scene, ids) {
  const elements = ids.map((id) => scene.get(id)).filter((element) => element && !element.isDeleted);
  const grouped = elements.filter((element) => outerGroupId(element));
  if (!grouped.length) return null;
  return {
    elementIds: grouped.map((element) => element.id),
    changes: grouped.map((element) => ({ groupIds: (element.groupIds || []).slice(0, -1) })),
  };
}

export function lockPatch(scene, ids, locked) {
  const elements = ids.map((id) => scene.get(id)).filter((element) => element && !element.isDeleted);
  if (!elements.length) return null;
  return {
    elementIds: elements.map((element) => element.id),
    changes: elements.map(() => ({ locked })),
  };
}

/* ------------------------------------------------------------------- units */

/**
 * Align and distribute treat a group as one object, otherwise the members fly
 * apart the first time either is used.
 */
function unitsOf(scene, ids) {
  const elements = ids
    .map((id) => scene.get(id))
    .filter((element) => element && !element.isDeleted && !element.locked && !element.containerId);
  const byGroup = new Map();
  const units = [];
  for (const element of elements) {
    const groupId = outerGroupId(element);
    if (!groupId) {
      units.push({ elements: [element] });
      continue;
    }
    if (!byGroup.has(groupId)) {
      const unit = { elements: [] };
      byGroup.set(groupId, unit);
      units.push(unit);
    }
    byGroup.get(groupId).elements.push(element);
  }
  for (const unit of units) unit.box = boundsOfMany(unit.elements);
  return units.filter((unit) => unit.box);
}

function moveUnit(unit, dx, dy, elementIds, changes) {
  if (!dx && !dy) return;
  for (const element of unit.elements) {
    elementIds.push(element.id);
    changes.push({ x: element.x + dx, y: element.y + dy });
  }
}

export const ALIGN_MODES = ["left", "centerX", "right", "top", "centerY", "bottom"];

export function alignPatch(scene, ids, mode) {
  const units = unitsOf(scene, ids);
  if (units.length < 2) return null;
  const outer = boundsOfMany(units.flatMap((unit) => unit.elements));
  const elementIds = [];
  const changes = [];

  for (const unit of units) {
    let dx = 0;
    let dy = 0;
    switch (mode) {
      case "left": dx = outer.x - unit.box.x; break;
      case "right": dx = (outer.x + outer.width) - (unit.box.x + unit.box.width); break;
      case "centerX": dx = (outer.x + outer.width / 2) - (unit.box.x + unit.box.width / 2); break;
      case "top": dy = outer.y - unit.box.y; break;
      case "bottom": dy = (outer.y + outer.height) - (unit.box.y + unit.box.height); break;
      case "centerY": dy = (outer.y + outer.height / 2) - (unit.box.y + unit.box.height / 2); break;
      default: break;
    }
    moveUnit(unit, dx, dy, elementIds, changes);
  }
  return elementIds.length ? { elementIds, changes } : null;
}

/** Equal GAPS between boxes, which is what "distribute" is actually asked for. */
export function distributePatch(scene, ids, axis) {
  const units = unitsOf(scene, ids);
  if (units.length < 3) return null;
  const horizontal = axis === "x";
  const sorted = [...units].sort((a, b) => (horizontal ? a.box.x - b.box.x : a.box.y - b.box.y));

  const first = sorted[0].box;
  const last = sorted[sorted.length - 1].box;
  const span = horizontal
    ? (last.x + last.width) - first.x
    : (last.y + last.height) - first.y;
  const used = sorted.reduce((total, unit) => total + (horizontal ? unit.box.width : unit.box.height), 0);
  const gap = (span - used) / (sorted.length - 1);

  const elementIds = [];
  const changes = [];
  let cursor = horizontal ? first.x : first.y;
  for (const unit of sorted) {
    const current = horizontal ? unit.box.x : unit.box.y;
    const delta = cursor - current;
    moveUnit(unit, horizontal ? delta : 0, horizontal ? 0 : delta, elementIds, changes);
    cursor += (horizontal ? unit.box.width : unit.box.height) + gap;
  }
  return elementIds.length ? { elementIds, changes } : null;
}

/* -------------------------------------------------------------------- flip */

function mirrorPatch(element, axis, mirror) {
  const box = localBounds(element);
  const angle = element.angle || 0;

  if (axis === "x") {
    const nextX = 2 * mirror - (box.x + box.width);
    if (element.points?.length) {
      const points = element.points.map(([px, py]) => [-px, py]);
      const minX = Math.min(...points.map((point) => point[0]));
      return { points, x: nextX - minX, angle: -angle };
    }
    return { x: nextX, width: Math.abs(element.width || 0), angle: -angle };
  }

  const nextY = 2 * mirror - (box.y + box.height);
  if (element.points?.length) {
    const points = element.points.map(([px, py]) => [px, -py]);
    const minY = Math.min(...points.map((point) => point[1]));
    return { points, y: nextY - minY, angle: -angle };
  }
  return { y: nextY, height: Math.abs(element.height || 0), angle: -angle };
}

export function flipPatch(scene, ids, axis) {
  const elements = ids
    .map((id) => scene.get(id))
    .filter((element) => element && !element.isDeleted && !element.locked);
  if (!elements.length) return null;
  const box = boundsOfMany(elements);
  if (!box) return null;
  const mirror = axis === "x" ? box.x + box.width / 2 : box.y + box.height / 2;

  const elementIds = [];
  const changes = [];
  for (const element of elements) {
    elementIds.push(element.id);
    changes.push(mirrorPatch(element, axis, mirror));
  }
  return { elementIds, changes };
}

export { worldBounds };
