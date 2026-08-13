// Line and arrow.
//
// startBinding / endBinding stay null in stage 1 but are written into every
// element and preserved on import, so stage 2's arrow binding does not need a
// data migration (Build_Plan 5-1).

import { createElement } from "../model.js";
import { Actions } from "../actions.js";

function makeLinearTool({ id, label, shortcut }) {
  return {
    id,
    label,
    shortcut,
    cursor: "crosshair",
    propsSchema: id === "arrow" ? "arrow" : "line",

    onPointerDown(app, event) {
      const element = createElement(id, {
        ...app.styleForNew(id),
        x: event.x,
        y: event.y,
        width: 0,
        height: 0,
        points: [[0, 0], [0, 0]],
      });
      this.state = { element, origin: { x: event.x, y: event.y } };
      app.setDraft(element);
    },

    onPointerMove(app, event) {
      const state = this.state;
      if (!state) return;
      let dx = event.x - state.origin.x;
      let dy = event.y - state.origin.y;
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
      app.setDraft(state.element);
    },

    onPointerUp(app) {
      const state = this.state;
      this.state = null;
      app.setDraft(null);
      if (!state) return;
      const element = state.element;
      const [, [dx, dy]] = element.points;
      if (Math.hypot(dx, dy) < 3) {
        element.points = [[0, 0], [120, 0]];
        element.width = 120;
        element.height = 0;
      }
      element.lastCommittedPoint = element.points[element.points.length - 1];
      app.history.run(Actions.add([element]));
      app.setSelection(new Set([element.id]));
      app.afterCreate(element);
    },

    onCancel(app) {
      this.state = null;
      app.setDraft(null);
      app.requestRender();
    },
  };
}

export const lineTool = makeLinearTool({ id: "line", label: "Line", shortcut: "l" });
export const arrowTool = makeLinearTool({ id: "arrow", label: "Arrow", shortcut: "a" });
