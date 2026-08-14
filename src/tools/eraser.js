// Eraser — drag across elements to delete them.
//
// Deletion is a tombstone via the ordinary delete Action, so one undo brings
// back everything erased in a single stroke.

export const eraserTool = {
  id: "eraser",
  label: "Eraser",
  shortcut: "e",
  cursor: "crosshair",
  propsSchema: "none",

  onPointerDown(app, event) {
    this.state = { ids: new Set() };
    this.onPointerMove(app, event);
  },

  onPointerMove(app, event) {
    const state = this.state;
    if (!state) return;
    const threshold = app.hitThreshold(event);
    for (const sample of event.samples || [{ x: event.x, y: event.y }]) {
      const hit = app.elementAt(sample.x, sample.y, threshold);
      if (hit && !hit.locked) state.ids.add(hit.id);
    }
    app.setFading(state.ids);
    app.requestRender();
  },

  onPointerUp(app) {
    const state = this.state;
    this.state = null;
    app.setFading(null);
    if (!state || !state.ids.size) return;
    // A label goes with the shape it lives in — leaving the text floating where
    // the box used to be is never what erasing a box meant.
    app.deleteElements([...state.ids]);
    app.setSelection(new Set());
    app.markStatic();
    app.requestRender();
    app.scheduleSave();
  },

  onCancel(app) {
    this.state = null;
    app.setFading(null);
    app.requestRender();
  },
};
