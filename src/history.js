// Undo / redo, built on top of actions.js rather than beside it.
//
// Every entry is the inverse Action returned by apply(). Because Actions are
// data, this file has no knowledge of tools, elements or rendering.
//
// Pure module — no DOM.

import { apply } from "./actions.js";

const LIMIT = 200;

export class History {
  constructor(scene) {
    this.scene = scene;
    this.undoStack = [];
    this.redoStack = [];
  }

  clear() {
    this.undoStack = [];
    this.redoStack = [];
  }

  /** Run an action and record how to take it back. */
  run(action) {
    const result = apply(this.scene, action);
    if (result.undo) {
      this.undoStack.push({ undo: result.undo, redo: action });
      if (this.undoStack.length > LIMIT) this.undoStack.shift();
      this.redoStack = [];
    }
    return result;
  }

  /** Run without recording — used for live drag previews that record on release. */
  runSilent(action) {
    return apply(this.scene, action);
  }

  /** Record a step whose forward action already happened (drag gestures). */
  record(undoAction, redoAction) {
    this.undoStack.push({ undo: undoAction, redo: redoAction });
    if (this.undoStack.length > LIMIT) this.undoStack.shift();
    this.redoStack = [];
  }

  get canUndo() {
    return this.undoStack.length > 0;
  }

  get canRedo() {
    return this.redoStack.length > 0;
  }

  undo() {
    const entry = this.undoStack.pop();
    if (!entry) return null;
    // Applying the inverse returns ITS inverse — which is exactly the action
    // that redoes the original change. Re-running the recorded forward action
    // instead would replay stale field values.
    const result = apply(this.scene, entry.undo);
    this.redoStack.push({ undo: entry.undo, redo: result.undo });
    return result;
  }

  redo() {
    const entry = this.redoStack.pop();
    if (!entry) return null;
    const result = apply(this.scene, entry.redo);
    this.undoStack.push({ undo: result.undo, redo: entry.redo });
    return result;
  }
}
