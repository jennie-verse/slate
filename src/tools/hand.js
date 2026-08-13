// Hand — drag the canvas.
//
// Two-finger panning works with any tool selected; this one exists for
// one-finger panning while a drawing tool would otherwise draw.

export const handTool = {
  id: "hand",
  label: "Pan",
  shortcut: "h",
  cursor: "grab",
  propsSchema: "none",

  onPointerDown(app, event) {
    this.state = {
      originX: event.screenX,
      originY: event.screenY,
      scrollX: app.viewport.scrollX,
      scrollY: app.viewport.scrollY,
    };
  },

  onPointerMove(app, event) {
    const state = this.state;
    if (!state) return;
    app.setViewport({
      scrollX: state.scrollX + (event.screenX - state.originX) / app.viewport.zoom,
      scrollY: state.scrollY + (event.screenY - state.originY) / app.viewport.zoom,
    });
  },

  onPointerUp(app) {
    this.state = null;
    app.scheduleSave();
  },

  onCancel() {
    this.state = null;
  },
};
