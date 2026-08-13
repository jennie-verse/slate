// Canvas text.
//
// The editor is a real <textarea> positioned over the canvas, because that is
// the only way to get the iOS keyboard, Korean IME composition and system
// autocorrect to behave.
//
// The size trick matters: iOS Safari zooms the page whenever a focused input is
// under 16px. Canvas text at 50% zoom with the M size (20px) renders at 10px,
// so obeying the house "inputs are 16px" rule is not enough on its own. The
// textarea therefore stays at 16px and is scaled with a CSS transform to match
// what the drawing shows — the page never zooms, and pinch zoom is still
// available to the user (Build_Plan 7-1).

import { createElement } from "../model.js";
import { Actions } from "../actions.js";
import { hitTestElement } from "../geometry.js";

export const textTool = {
  id: "text",
  label: "Text",
  shortcut: "t",
  cursor: "text",
  propsSchema: "text",

  onPointerDown(app, event) {
    const existing = app.scene.visible()
      .filter((element) => element.type === "text" && !element.locked)
      .reverse()
      .find((element) => hitTestElement(element, event.x, event.y, app.hitThreshold(event)));

    if (existing) {
      app.editText(existing);
      return;
    }

    const element = createElement("text", {
      ...app.styleForNew("text"),
      x: event.x,
      y: event.y - (app.style.fontSize || 20) / 2,
      width: 0,
      height: (app.style.fontSize || 20) * 1.25,
    });
    app.history.run(Actions.add([element]));
    app.editText(element, { isNew: true });
  },

  onPointerMove() {},
  onPointerUp() {},
  onCancel() {},
};
