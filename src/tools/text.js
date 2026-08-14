// Canvas text — free-standing, or bound inside a shape.
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
//
// Stage 2: tapping a shape with this tool puts the text INSIDE the shape
// (containerId + boundElements) rather than dropping a loose label on top of it
// (containers.js).

import { createElement } from "../model.js";
import { hitTestElement } from "../geometry.js";
import { canHoldText, boundTextIdOf } from "../containers.js";

export const textTool = {
  id: "text",
  label: "Text",
  shortcut: "t",
  cursor: "text",
  propsSchema: "text",

  onPointerDown(app, event) {
    const threshold = app.hitThreshold(event);

    // An existing loose text element is edited in place.
    const existing = app.scene.visible()
      .filter((element) => element.type === "text" && !element.locked && !element.containerId)
      .reverse()
      .find((element) => hitTestElement(element, event.x, event.y, threshold));
    if (existing) {
      app.editText(existing);
      return;
    }

    // A shape under the pointer takes the text inside it.
    const container = app.scene.visible()
      .filter((element) => canHoldText(element))
      .reverse()
      .find((element) => hitTestElement(
        { ...element, backgroundColor: "#fill" }, event.x, event.y, threshold,
      ));
    if (container) {
      const label = boundTextIdOf(container);
      if (label && app.scene.get(label)) app.editText(app.scene.get(label));
      else app.addBoundText(container);
      return;
    }

    const element = createElement("text", {
      ...app.styleForNew("text"),
      x: event.x,
      y: event.y - (app.style.fontSize || 20) / 2,
      width: 0,
      height: (app.style.fontSize || 20) * 1.25,
    });
    app.addElements([element]);
    app.editText(element, { isNew: true });
  },

  onPointerMove() {},
  onPointerUp() {},
  onCancel() {},
};
