// Insert an image.
//
// The tool has no drag gesture: tapping the canvas opens the system file
// picker and drops the picture where the tap landed. That is deliberate — on
// iOS the picker has to be opened from inside a user gesture, and a
// draw-a-rectangle-first flow would put an async await in the middle of one.

export const imageTool = {
  id: "image",
  label: "Image",
  shortcut: "i",
  cursor: "crosshair",
  propsSchema: "image",

  onPointerDown(app, event) {
    this.state = { x: event.x, y: event.y };
  },

  onPointerMove() {},

  onPointerUp(app) {
    const state = this.state;
    this.state = null;
    if (!state) return;
    app.insertImageAt(state.x, state.y);
  },

  onCancel() {
    this.state = null;
  },
};
