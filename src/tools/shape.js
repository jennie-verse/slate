// Rectangle, diamond, ellipse — one factory, three registrations.

import { createElement } from "../model.js";
import { Actions } from "../actions.js";

function makeShapeTool({ id, label, shortcut }) {
  return {
    id,
    label,
    shortcut,
    cursor: "crosshair",
    propsSchema: "shape",

    onPointerDown(app, event) {
      const origin = app.snapPoint(event.x, event.y);
      const element = createElement(id, {
        ...app.styleForNew(id),
        x: origin.x,
        y: origin.y,
        width: 0,
        height: 0,
      });
      this.state = { element, origin };
      app.setDraft(element);
    },

    onPointerMove(app, event) {
      const state = this.state;
      if (!state) return;
      const corner = app.snapPoint(event.x, event.y);
      let width = corner.x - state.origin.x;
      let height = corner.y - state.origin.y;
      if (event.shiftKey) {
        const size = Math.max(Math.abs(width), Math.abs(height));
        width = Math.sign(width || 1) * size;
        height = Math.sign(height || 1) * size;
      }
      state.element = {
        ...state.element,
        x: width < 0 ? state.origin.x + width : state.origin.x,
        y: height < 0 ? state.origin.y + height : state.origin.y,
        width: Math.abs(width),
        height: Math.abs(height),
      };
      app.setDraft(state.element);
    },

    onPointerUp(app) {
      const state = this.state;
      this.state = null;
      app.setDraft(null);
      if (!state) return;
      const element = state.element;
      // A tap with no drag would leave a zero-size ghost that can never be
      // selected again — give it a default size instead of discarding it.
      if (element.width < 2 && element.height < 2) {
        element.x -= 60;
        element.y -= 40;
        element.width = 120;
        element.height = 80;
      }
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

export const rectangleTool = makeShapeTool({ id: "rectangle", label: "Rectangle", shortcut: "r" });
export const diamondTool = makeShapeTool({ id: "diamond", label: "Diamond", shortcut: "d" });
export const ellipseTool = makeShapeTool({ id: "ellipse", label: "Ellipse", shortcut: "o" });
