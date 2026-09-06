// Pen / finger drawing.
//
// Two things here exist purely for Apple Pencil quality:
//   * getCoalescedEvents() recovers the points Safari batched between frames.
//     Without it a fast stroke on iPad renders as a visibly angular polyline.
//   * pressure is recorded per point, and simulatePressure is turned off when
//     the hardware actually reports it.
//
// Safari 18.2's coalesced events are missing `pointerId` and `target`, so
// nothing here reads those fields — only coordinates and pressure
// (Build_Plan 8-2).

import { createElement } from "../model.js";
import { Actions } from "../actions.js";

export const freedrawTool = {
  id: "freedraw",
  label: "Draw",
  shortcut: "p",
  cursor: "crosshair",
  propsSchema: "freedraw",

  onPointerDown(app, event) {
    const pen = event.pointerType === "pen";
    const element = createElement("freedraw", {
      ...app.styleForNew("freedraw"),
      x: event.x,
      y: event.y,
      width: 0,
      height: 0,
      points: [[0, 0]],
      pressures: [pen ? (event.pressure || 0.5) : 0.5],
      simulatePressure: !pen,
    });
    this.state = { element, origin: { x: event.x, y: event.y } };
    app.setDraft(element);
  },

  onPointerMove(app, event) {
    const state = this.state;
    if (!state) return;
    const points = state.element.points.slice();
    const pressures = state.element.pressures.slice();

    // Coalesced points first, then the event itself.
    for (const sample of event.samples || [{ x: event.x, y: event.y, pressure: event.pressure }]) {
      points.push([sample.x - state.origin.x, sample.y - state.origin.y]);
      pressures.push(state.element.simulatePressure ? 0.5 : (sample.pressure || 0.5));
    }

    let minX = 0; let minY = 0; let maxX = 0; let maxY = 0;
    for (const [px, py] of points) {
      if (px < minX) minX = px;
      if (py < minY) minY = py;
      if (px > maxX) maxX = px;
      if (py > maxY) maxY = py;
    }
    state.element = {
      ...state.element,
      points,
      pressures,
      width: maxX - minX,
      height: maxY - minY,
    };
    app.setDraft(state.element);
  },

  onPointerUp(app) {
    const state = this.state;
    this.state = null;
    app.setDraft(null);
    if (!state) return;
    const element = state.element;
    if (element.points.length < 2) {
      // A tap leaves a dot rather than nothing, which is what a pen would do.
      element.points = [[0, 0], [0.5, 0.5]];
      element.pressures = [0.5, 0.5];
    }
    // Normalise so x/y sits at the top-left of the stroke.
    let minX = Infinity; let minY = Infinity;
    for (const [px, py] of element.points) {
      if (px < minX) minX = px;
      if (py < minY) minY = py;
    }
    if (minX !== 0 || minY !== 0) {
      element.points = element.points.map(([px, py]) => [px - minX, py - minY]);
      element.x += minX;
      element.y += minY;
    }
    element.lastCommittedPoint = element.points[element.points.length - 1];
    app.history.run(Actions.add([element]));
    app.afterCreate(element, { keepTool: true });
  },

  onCancel(app) {
    this.state = null;
    app.setDraft(null);
    app.requestRender();
  },
};
