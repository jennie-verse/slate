// Line and arrow.
//
// Stage 2 turns on what stage 1 reserved: an arrow drawn from inside one shape
// to another attaches to both, and stays attached when either is moved
// (Build_Plan 5-1, binding.js).
//
// Lines never bind. That is the original's rule and it is a good one — a line
// is a line, an arrow is a relationship.

import { createElement } from "../model.js";
import { Actions } from "../actions.js";
import { bindableAt, bindingPatchFor } from "../binding.js";

function makeLinearTool({ id, label, shortcut }) {
  const binds = id === "arrow";

  return {
    id,
    label,
    shortcut,
    cursor: "crosshair",
    propsSchema: id === "arrow" ? "arrow" : "line",

    onPointerDown(app, event) {
      const start = app.snapPoint(event.x, event.y);
      const element = createElement(id, {
        ...app.styleForNew(id),
        x: start.x,
        y: start.y,
        width: 0,
        height: 0,
        points: [[0, 0], [0, 0]],
      });
      const startTarget = binds ? bindableAt(app.scene, event.x, event.y, app.bindThreshold(event)) : null;
      this.state = { element, origin: start, startTarget };
      if (startTarget) app.setBindingTarget(startTarget);
      app.setDraft(element);
    },

    onPointerMove(app, event) {
      const state = this.state;
      if (!state) return;
      const snapped = app.snapPoint(event.x, event.y);
      let dx = snapped.x - state.origin.x;
      let dy = snapped.y - state.origin.y;
      if (event.shiftKey) {
        // Snap to 15° so straight and diagonal connectors are easy to hit.
        const step = Math.PI / 12;
        const angle = Math.round(Math.atan2(dy, dx) / step) * step;
        const length = Math.hypot(dx, dy);
        dx = Math.cos(angle) * length;
        dy = Math.sin(angle) * length;
      }
      state.element = {
        ...state.element,
        points: [[0, 0], [dx, dy]],
        width: Math.abs(dx),
        height: Math.abs(dy),
      };
      if (binds) {
        state.endTarget = bindableAt(app.scene, event.x, event.y, app.bindThreshold(event), state.startTarget?.id);
        app.setBindingTarget(state.endTarget || (Math.hypot(dx, dy) < 4 ? state.startTarget : null));
      }
      app.setDraft(state.element);
    },

    onPointerUp(app) {
      const state = this.state;
      this.state = null;
      app.setDraft(null);
      app.setBindingTarget(null);
      if (!state) return;

      const element = state.element;
      const [, [dx, dy]] = element.points;
      if (Math.hypot(dx, dy) < 3) {
        element.points = [[0, 0], [120, 0]];
        element.width = 120;
        element.height = 0;
      }
      element.lastCommittedPoint = element.points[element.points.length - 1];

      const startTarget = binds ? state.startTarget : null;
      const endTarget = binds && state.endTarget?.id !== startTarget?.id ? state.endTarget : null;

      if (startTarget || endTarget) {
        // The arrow, its bindings and the host shapes' boundElements go in as
        // ONE action, so a single undo takes the whole connection back out.
        const patch = bindingPatchFor(app.scene, element, { startTarget, endTarget });
        const steps = [Actions.add([element])];
        if (patch) {
          if (Object.keys(patch.arrow).length) {
            steps.push(Actions.update([element.id], patch.arrow));
          }
          for (const shape of patch.shapes) {
            steps.push(Actions.update([shape.id], shape.changes));
          }
        }
        app.history.run(Actions.batch(steps));
        app.syncBindings([element.id], { silent: true });
      } else {
        app.history.run(Actions.add([element]));
      }

      app.setSelection(new Set([element.id]));
      app.afterCreate(element);
    },

    onCancel(app) {
      this.state = null;
      app.setDraft(null);
      app.setBindingTarget(null);
      app.requestRender();
    },
  };
}

export const lineTool = makeLinearTool({ id: "line", label: "Line", shortcut: "l" });
export const arrowTool = makeLinearTool({ id: "arrow", label: "Arrow", shortcut: "a" });
