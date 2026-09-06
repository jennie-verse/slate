// The one and only path that changes elements.
//
// Tools call it. The property panel calls it. Keyboard shortcuts call it.
// Nothing reaches into scene.byId and edits an element in place.
//
// Why the discipline matters: an Action is DATA — { type, elementIds, changes }
// — so it can be recorded, replayed and serialised. Stage 1 gets undo for free
// out of that. Stage 3's command palette is literally a list of these. Cross-
// device sync in stage 4 needs a single interception point. Allowing "just this
// once, edit it directly" anywhere collapses all three (Expansion_Plan 2-1).
//
// tests/actions.test.mjs asserts that scene mutation only happens here.
//
// Pure module — no DOM.

import { keyBetween } from "./ordering.js";

/**
 * @param {Scene} scene
 * @param {{type:string, elements?:object[], elementIds?:string[], changes?:object|object[]}} action
 * @returns {{undo:object|null, ids:string[]}} an inverse action for history.js
 */
export function apply(scene, action) {
  switch (action.type) {
    case "add": {
      const added = action.elements.map((element) => scene.insert(element));
      return {
        ids: added.map((element) => element.id),
        undo: { type: "delete", elementIds: added.map((element) => element.id) },
      };
    }

    case "update": {
      const before = [];
      // Ids that were actually there. Skipping a missing element but keeping it
      // in the inverse would leave elementIds and changes different lengths, and
      // the undo would then read changes[i] for the wrong element — or undefined.
      const applied = [];
      const changesFor = (index) => (Array.isArray(action.changes) ? action.changes[index] : action.changes);
      action.elementIds.forEach((id, index) => {
        const element = scene.get(id);
        if (!element) return;
        const changes = changesFor(index);
        const previous = {};
        for (const key of Object.keys(changes)) previous[key] = clone(element[key]);
        applied.push(id);
        before.push(previous);
        scene.patch(id, clone(changes));
      });
      return {
        ids: applied,
        undo: { type: "update", elementIds: applied, changes: before },
      };
    }

    case "delete": {
      // Deliberately NOT filtering locked elements here. This is the inverse of
      // `add`, so refusing to delete a locked element would make undoing the
      // paste of a locked shape a no-op — and leave something on the canvas that
      // cannot be selected or removed. Whether the USER may delete a locked
      // element is a decision for the caller (app.deleteElements).
      const ids = action.elementIds.filter((id) => {
        const element = scene.get(id);
        return element && !element.isDeleted;
      });
      for (const id of ids) scene.remove(id);
      return { ids, undo: { type: "restore", elementIds: ids } };
    }

    case "restore": {
      const ids = action.elementIds;
      for (const id of ids) scene.restore(id);
      return { ids, undo: { type: "delete", elementIds: ids } };
    }

    case "reorder": {
      // to: "front" | "back" | "forward" | "backward"
      const ids = action.elementIds;
      const before = ids.map((id) => ({ index: scene.get(id)?.index ?? null }));
      const targets = ids
        .map((id) => scene.get(id))
        .filter(Boolean)
        .sort((a, b) => (a.index < b.index ? -1 : 1));

      if (action.to === "front") {
        for (const element of targets) scene.patch(element.id, { index: scene.indexTop() });
      } else if (action.to === "back") {
        for (const element of [...targets].reverse()) {
          scene.patch(element.id, { index: scene.indexBottom() });
        }
      } else if (action.to === "forward") {
        for (const element of [...targets].reverse()) {
          const neighbour = nextSibling(scene, element, ids, 1);
          if (neighbour) scene.patch(element.id, { index: scene.indexAbove(neighbour) });
        }
      } else if (action.to === "backward") {
        for (const element of targets) {
          const neighbour = nextSibling(scene, element, ids, -1);
          if (neighbour) scene.patch(element.id, { index: scene.indexBelow(neighbour) });
        }
      }
      return {
        ids,
        undo: { type: "update", elementIds: ids, changes: before },
      };
    }

    case "batch": {
      // Several actions that must undo as one step (e.g. duplicate + move).
      const undos = [];
      const ids = new Set();
      for (const step of action.actions) {
        const result = apply(scene, step);
        undos.unshift(result.undo);
        result.ids.forEach((id) => ids.add(id));
      }
      return {
        ids: [...ids],
        undo: { type: "batch", actions: undos.filter(Boolean) },
      };
    }

    default:
      throw new Error(`unknown action: ${action.type}`);
  }
}

function nextSibling(scene, element, movingIds, direction) {
  const list = scene.all().filter((item) => !item.isDeleted);
  const at = list.indexOf(element);
  for (let i = at + direction; i >= 0 && i < list.length; i += direction) {
    if (!movingIds.includes(list[i].id)) return list[i];
  }
  return null;
}

function clone(value) {
  if (Array.isArray(value)) return value.map(clone);
  if (value && typeof value === "object") return JSON.parse(JSON.stringify(value));
  return value;
}

/** Convenience builders so callers never hand-write action objects. */
export const Actions = {
  add: (elements) => ({ type: "add", elements }),
  update: (elementIds, changes) => ({ type: "update", elementIds, changes }),
  delete: (elementIds) => ({ type: "delete", elementIds }),
  reorder: (elementIds, to) => ({ type: "reorder", elementIds, to }),
  batch: (actions) => ({ type: "batch", actions }),
};

export { keyBetween };
