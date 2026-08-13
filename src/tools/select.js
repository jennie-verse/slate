// Selection, move, resize, rotate, marquee.
//
// Tools all share one lifecycle shape:
//   { id, label, shortcut, cursor, propsSchema,
//     onPointerDown, onPointerMove, onPointerUp, onCancel }
// so adding a tool in stage 3 (lasso, laser, frame) is one object, and the
// property panel needs no change because it reads propsSchema
// (Expansion_Plan 2-5).

import {
  localBounds, boundsOfMany, handleAt, elementsInBox, rotatePoint, scalePoints, resizeBox,
} from "../geometry.js";
import { entryFor } from "../registry.js";
import { Actions } from "../actions.js";

function selectedElements(app) {
  return [...app.selection].map((id) => app.scene.get(id)).filter((e) => e && !e.isDeleted);
}

function selectionBoxOf(app) {
  const elements = selectedElements(app);
  if (!elements.length) return null;
  if (elements.length === 1 && elements[0].angle) return localBounds(elements[0]);
  return boundsOfMany(elements);
}

function selectionAngleOf(app) {
  const elements = selectedElements(app);
  return elements.length === 1 ? (elements[0].angle || 0) : 0;
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
        };
        app.setDragging(this.state.ids);
        return;
      }
    }

    // 2. Topmost element under the pointer.
    const hit = app.elementAt(event.x, event.y, threshold);
    if (hit) {
      const additive = event.shiftKey;
      if (additive) {
        const next = new Set(app.selection);
        if (next.has(hit.id)) next.delete(hit.id); else next.add(hit.id);
        app.setSelection(next);
      } else if (!app.selection.has(hit.id)) {
        app.setSelection(new Set([hit.id]));
      }
      const elements = selectedElements(app);
      if (!elements.length) return;
      this.state = {
        mode: "move",
        origin: { x: event.x, y: event.y },
        before: elements.map((element) => ({ ...element })),
        ids: elements.map((element) => element.id),
        moved: false,
      };
      app.setDragging(this.state.ids);
      return;
    }

    // 3. Empty space — marquee.
    if (!event.shiftKey) app.setSelection(new Set());
    this.state = { mode: "marquee", origin: { x: event.x, y: event.y }, base: new Set(app.selection) };
  },

  onPointerMove(app, event) {
    const state = this.state;
    if (!state) return;

    if (state.mode === "marquee") {
      const box = {
        x: Math.min(state.origin.x, event.x),
        y: Math.min(state.origin.y, event.y),
        width: Math.abs(event.x - state.origin.x),
        height: Math.abs(event.y - state.origin.y),
      };
      app.setSelectionBox(box);
      const inside = elementsInBox(app.scene.visible(), box);
      const next = new Set(state.base);
      for (const element of inside) next.add(element.id);
      app.setSelection(next, { quiet: true });
      return;
    }

    if (state.mode === "move") {
      const dx = event.x - state.origin.x;
      const dy = event.y - state.origin.y;
      if (dx || dy) state.moved = true;
      const changes = state.before.map((element) => ({ x: element.x + dx, y: element.y + dy }));
      app.history.runSilent(Actions.update(state.ids, changes));
      app.requestRender();
      return;
    }

    if (state.mode === "resize") {
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
      app.requestRender();
      return;
    }

    if (state.mode === "rotate") {
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
      app.requestRender();
    }
  },

  onPointerUp(app) {
    const state = this.state;
    this.state = null;
    app.setSelectionBox(null);
    app.setDragging(null);
    if (!state) return;

    if (state.mode === "marquee") {
      app.requestRender();
      return;
    }
    if (state.mode === "move" && !state.moved) {
      app.markStatic();
      app.requestRender();
      return;
    }

    // The gesture already mutated the scene through apply(); record the inverse
    // so the whole drag undoes as one step rather than a hundred.
    const after = state.ids.map((id) => {
      const element = app.scene.get(id);
      const keys = ["x", "y", "width", "height", "angle", "points"];
      const snapshot = {};
      for (const key of keys) if (element && key in element) snapshot[key] = clone(element[key]);
      return snapshot;
    });
    const before = state.before.map((element) => {
      const keys = ["x", "y", "width", "height", "angle", "points"];
      const snapshot = {};
      for (const key of keys) if (key in element) snapshot[key] = clone(element[key]);
      return snapshot;
    });
    app.history.record(
      Actions.update(state.ids, before),
      Actions.update(state.ids, after),
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
    if (state?.before) {
      app.history.runSilent(Actions.update(state.ids, state.before.map((element) => ({
        x: element.x, y: element.y, width: element.width, height: element.height,
        angle: element.angle, points: clone(element.points),
      }))));
    }
    app.markStatic();
    app.requestRender();
  },
};

function clone(value) {
  return Array.isArray(value) ? value.map((item) => (Array.isArray(item) ? [...item] : item)) : value;
}
