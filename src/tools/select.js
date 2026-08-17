// Selection, move, resize, rotate, marquee.
//
// Tools all share one lifecycle shape:
//   { id, label, shortcut, cursor, propsSchema,
//     onPointerDown, onPointerMove, onPointerUp, onCancel }
// so adding a tool in stage 3 (lasso, laser, frame) is one object, and the
// property panel needs no change because it reads propsSchema
// (Expansion_Plan 2-5).
//
// Stage 2 adds three things to the drag path, all of which have to survive undo
// as ONE step with the move that caused them:
//   * bound arrows re-seat themselves as their shapes move (binding.js);
//   * labels inside shapes are relaid out (containers.js);
//   * grid and object snapping pull the drag onto round numbers (snapping.js).

import {
  localBounds, boundsOfMany, handleAt, elementsInBox, rotatePoint, scalePoints, resizeBox,
  worldBounds,
} from "../geometry.js";
import { entryFor } from "../registry.js";
import { Actions } from "../actions.js";
import { expandSelection, outerGroupId } from "../arrange.js";
import { objectSnap, snapCandidates } from "../snapping.js";

// `text` is here because resizing a container re-WRAPS its label: the wrapped
// string changes as part of the drag, so leaving it out of the snapshot means
// undo restores the box's size and keeps the new line breaks.
const DRAG_KEYS = ["x", "y", "width", "height", "angle", "points", "text"];

function selectedElements(app) {
  return [...app.selection].map((id) => app.scene.get(id)).filter((e) => e && !e.isDeleted);
}

function selectionBoxOf(app) {
  const elements = selectedElements(app).filter((element) => !element.containerId);
  if (!elements.length) return null;
  if (elements.length === 1 && elements[0].angle) return localBounds(elements[0]);
  return boundsOfMany(elements);
}

function selectionAngleOf(app) {
  const elements = selectedElements(app).filter((element) => !element.containerId);
  return elements.length === 1 ? (elements[0].angle || 0) : 0;
}

function snapshot(element) {
  const out = {};
  for (const key of DRAG_KEYS) {
    if (element && key in element) out[key] = clone(element[key]);
  }
  return out;
}

export const selectTool = {
  id: "selection",
  label: "Select",
  shortcut: "v",
  cursor: "default",
  propsSchema: "selection",

  onPointerDown(app, event) {
    const threshold = app.hitThreshold(event);
    const box = selectionBoxOf(app);
    const angle = selectionAngleOf(app);

    // 1. A handle beats everything else, so a handle sitting on top of another
    //    element is still grabbable.
    if (box) {
      const handle = handleAt(box, angle, event.x, event.y, app.handleThreshold(event), 26 / app.viewport.zoom);
      if (handle) {
        const elements = selectedElements(app);
        this.state = {
          mode: handle === "rotate" ? "rotate" : "resize",
          handle,
          startBox: box,
          startAngle: angle,
          origin: { x: event.x, y: event.y },
          before: elements.map((element) => ({ ...element })),
          ids: elements.map((element) => element.id),
          extraIds: app.bindingCompanions(elements.map((element) => element.id)),
          moved: false,
        };
        this.state.extraBefore = this.state.extraIds.map((id) => snapshot(app.scene.get(id)));
        app.setDragging([...this.state.ids, ...this.state.extraIds]);
        return;
      }
    }

    // 2. Topmost element under the pointer. A tap on a link badge opens it
    //    instead of starting a drag.
    if (app.linkBadgeAtPoint(event.x, event.y)) {
      const target = app.linkBadgeAtPoint(event.x, event.y);
      this.state = { mode: "link", target };
      return;
    }

    const hit = app.elementAt(event.x, event.y, threshold);
    if (hit) {
      const additive = event.shiftKey;
      // Clicking any member of a group takes the whole group, unless the group
      // is already the selection and the user is drilling in with a shift-tap.
      const grouped = expandSelection(app.scene, [hit.id]);
      if (additive) {
        const next = new Set(app.selection);
        const alreadyIn = next.has(hit.id);
        for (const id of grouped) {
          if (alreadyIn) next.delete(id); else next.add(id);
        }
        app.setSelection(next);
      } else if (!app.selection.has(hit.id)) {
        app.setSelection(grouped);
      }
      const elements = selectedElements(app);
      if (!elements.length) return;
      const ids = elements.map((element) => element.id);
      this.state = {
        mode: "move",
        origin: { x: event.x, y: event.y },
        before: elements.map((element) => ({ ...element })),
        ids,
        extraIds: app.bindingCompanions(ids),
        moved: false,
        startBox: boundsOfMany(elements.filter((element) => !element.containerId)),
        candidates: null,
      };
      this.state.extraBefore = this.state.extraIds.map((id) => snapshot(app.scene.get(id)));
      app.setDragging([...ids, ...this.state.extraIds]);
      return;
    }

    // 3. Empty space — marquee.
    if (!event.shiftKey) app.setSelection(new Set());
    this.state = { mode: "marquee", origin: { x: event.x, y: event.y }, base: new Set(app.selection) };
  },

  onPointerMove(app, event) {
    const state = this.state;
    if (!state || state.mode === "link") return;

    if (state.mode === "marquee") {
      const box = {
        x: Math.min(state.origin.x, event.x),
        y: Math.min(state.origin.y, event.y),
        width: Math.abs(event.x - state.origin.x),
        height: Math.abs(event.y - state.origin.y),
      };
      app.setSelectionBox(box);
      const inside = elementsInBox(app.scene.visible(), box).filter((element) => !element.containerId);
      const next = new Set(state.base);
      for (const id of expandSelection(app.scene, inside.map((element) => element.id))) next.add(id);
      app.setSelection(next, { quiet: true });
      return;
    }

    if (state.mode === "move") {
      let dx = event.x - state.origin.x;
      let dy = event.y - state.origin.y;
      if (dx || dy) state.moved = true;

      const snap = this.resolveSnap(app, state, dx, dy, event);
      dx = snap.dx;
      dy = snap.dy;
      app.setSnapGuides(snap.guides);

      const changes = state.before.map((element) => ({ x: element.x + dx, y: element.y + dy }));
      app.history.runSilent(Actions.update(state.ids, changes));
      app.syncBindings(state.ids, { silent: true });
      app.requestRender();
      return;
    }

    if (state.mode === "resize") {
      state.moved = true;
      const keepAspect = event.shiftKey;
      const changes = state.before.map((element) => {
        if (state.ids.length === 1) {
          return entryFor(element.type).resize(element, state.handle, event.x, event.y, { keepAspect });
        }
        // Multi-select resize scales each element inside the group box.
        const next = resizeBox(state.startBox, state.handle, event.x, event.y, { keepAspect });
        const scaleX = state.startBox.width === 0 ? 1 : next.width / state.startBox.width;
        const scaleY = state.startBox.height === 0 ? 1 : next.height / state.startBox.height;
        const patch = {
          x: next.x + (element.x - state.startBox.x) * scaleX,
          y: next.y + (element.y - state.startBox.y) * scaleY,
        };
        if (element.points) {
          patch.points = scalePoints(element.points, { width: 1, height: 1 }, { width: scaleX, height: scaleY });
        } else if (element.type !== "text") {
          patch.width = element.width * scaleX;
          patch.height = element.height * scaleY;
        }
        return patch;
      });
      app.history.runSilent(Actions.update(state.ids, changes));
      app.syncBindings(state.ids, { silent: true });
      app.requestRender();
      return;
    }

    if (state.mode === "rotate") {
      state.moved = true;
      const cx = state.startBox.x + state.startBox.width / 2;
      const cy = state.startBox.y + state.startBox.height / 2;
      let angle = Math.atan2(event.y - cy, event.x - cx) + Math.PI / 2;
      if (event.shiftKey) angle = Math.round(angle / (Math.PI / 12)) * (Math.PI / 12);
      const changes = state.before.map((element) => {
        if (state.ids.length === 1) return { angle };
        const delta = angle - state.startAngle;
        const [nx, ny] = rotatePoint(element.x, element.y, cx, cy, delta);
        return { x: nx, y: ny, angle: (element.angle || 0) + delta };
      });
      app.history.runSilent(Actions.update(state.ids, changes));
      app.syncBindings(state.ids, { silent: true });
      app.requestRender();
    }
  },

  /** Grid first, then objects — the grid is explicit, object snap is a guess. */
  resolveSnap(app, state, dx, dy, event) {
    if (event.altKey || !state.startBox) return { dx, dy, guides: [] };

    let nextDx = dx;
    let nextDy = dy;
    const step = app.gridStep();
    if (step) {
      nextDx = Math.round((state.startBox.x + dx) / step) * step - state.startBox.x;
      nextDy = Math.round((state.startBox.y + dy) / step) * step - state.startBox.y;
      return { dx: nextDx, dy: nextDy, guides: [] };
    }
    if (!app.objectSnapEnabled()) return { dx, dy, guides: [] };

    if (!state.candidates) {
      state.candidates = snapCandidates(
        app.scene,
        new Set([...state.ids, ...state.extraIds]),
        app.visibleWorldBox(),
      );
    }
    const moving = {
      x: state.startBox.x + dx,
      y: state.startBox.y + dy,
      width: state.startBox.width,
      height: state.startBox.height,
    };
    const result = objectSnap(moving, state.candidates, 6 / app.viewport.zoom);
    return { dx: dx + result.dx, dy: dy + result.dy, guides: result.guides };
  },

  onPointerUp(app, event) {
    const state = this.state;
    this.state = null;
    app.setSelectionBox(null);
    app.setDragging(null);
    app.setSnapGuides(null);
    if (!state) return;

    if (state.mode === "link") {
      // Grabbing a badge is not a tap on the canvas: letting the double-tap
      // detector see it too opens the link twice AND starts a label editor.
      app.consumeTap();
      if (app.linkBadgeAtPoint(event?.x ?? 0, event?.y ?? 0)?.id === state.target?.id) {
        app.openLink(state.target);
      }
      return;
    }
    if (state.mode === "marquee") {
      app.requestRender();
      return;
    }
    // A handle that was pressed and released without moving changed nothing.
    // Recording it anyway pushes a no-op onto the undo stack and — because
    // history.record clears the redo stack — throws away work the user could
    // still have got back. Only `move` used to guard this.
    if (!state.moved) {
      app.consumeTap();
      app.markStatic();
      app.requestRender();
      return;
    }
    app.consumeTap();

    // Labels get relaid out now rather than on every frame: wrapping measures
    // text, and doing that per pointermove is the difference between a smooth
    // drag and a stuttering one.
    app.syncBindings(state.ids, { silent: true, layout: true });

    // The gesture already mutated the scene through apply(); record the inverse
    // so the whole drag — including the arrows that followed it — undoes as one
    // step rather than a hundred.
    const ids = [...state.ids, ...state.extraIds];
    const before = [...state.before.map(snapshot), ...state.extraBefore];
    const after = ids.map((id) => snapshot(app.scene.get(id)));

    app.history.record(
      Actions.update(ids, before),
      Actions.update(ids, after),
    );
    app.markStatic();
    app.requestRender();
    app.scheduleSave();
  },

  onCancel(app) {
    const state = this.state;
    this.state = null;
    app.setSelectionBox(null);
    app.setDragging(null);
    app.setSnapGuides(null);
    if (state?.before) {
      const ids = [...state.ids, ...(state.extraIds || [])];
      const before = [...state.before.map(snapshot), ...(state.extraBefore || [])];
      app.history.runSilent(Actions.update(ids, before));
    }
    app.markStatic();
    app.requestRender();
  },
};

function clone(value) {
  return Array.isArray(value) ? value.map((item) => (Array.isArray(item) ? [...item] : item)) : value;
}

export { outerGroupId, worldBounds };
