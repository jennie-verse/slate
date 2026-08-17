// Pointer, gesture and keyboard plumbing.
//
// Everything iOS-specific that a canvas app trips over lives here
// (Build_Plan 7-1 / 8-2):
//   * touch-action:none + overscroll-behavior:none on the surface, and Safari's
//     proprietary gesture events blocked, so pinch zoom is ours not the page's;
//   * setPointerCapture so a stroke survives the finger leaving the canvas;
//   * palm rejection — while a pen stroke is live, touch pointers are ignored;
//   * getCoalescedEvents() to recover the points Safari batched.

import { screenToWorld, zoomAt, clamp } from "./geometry.js";

const LONG_PRESS_MS = 480;
const LONG_PRESS_SLOP = 8;      // screen px of drift still counted as "held"

export class InputManager {
  constructor(app, surface) {
    this.app = app;
    this.surface = surface;
    this.activePointerId = null;
    this.penActive = false;
    this.touches = new Map();
    this.pinch = null;
    this.longPress = null;
    this.bind();
  }

  bind() {
    const surface = this.surface;
    surface.style.touchAction = "none";
    surface.addEventListener("pointerdown", this.onPointerDown, { passive: false });
    surface.addEventListener("pointermove", this.onPointerMove, { passive: false });
    surface.addEventListener("pointerup", this.onPointerUp);
    surface.addEventListener("pointercancel", this.onPointerCancel);
    surface.addEventListener("pointerleave", this.onPointerUp);
    surface.addEventListener("wheel", this.onWheel, { passive: false });
    // The browser menu is replaced, not just suppressed — a right click on a
    // desktop opens the same menu a long press opens on the iPad.
    surface.addEventListener("contextmenu", (event) => {
      event.preventDefault();
      this.cancelLongPress();
      // Same reason as the long-press path below: a right click can arrive with
      // the button still down mid-drag, and every menu item would then race the
      // drag that goes on writing over it.
      this.cancelActive();
      const world = this.toWorldEvent(event);
      this.app.openContextMenu(world, { clientX: event.clientX, clientY: event.clientY });
    });
    // Safari-only pinch events would zoom the page under the canvas.
    for (const type of ["gesturestart", "gesturechange", "gestureend"]) {
      surface.addEventListener(type, (event) => event.preventDefault());
    }
    window.addEventListener("keydown", this.onKeyDown);
  }

  destroy() {
    window.removeEventListener("keydown", this.onKeyDown);
  }

  toWorldEvent(event, samples) {
    const rect = this.surface.getBoundingClientRect();
    const screenX = event.clientX - rect.left;
    const screenY = event.clientY - rect.top;
    const [x, y] = screenToWorld(screenX, screenY, this.app.viewport);
    return {
      x,
      y,
      screenX,
      screenY,
      shiftKey: event.shiftKey,
      altKey: event.altKey,
      metaKey: event.metaKey || event.ctrlKey,
      pointerType: event.pointerType,
      pressure: event.pressure,
      samples,
    };
  }

  coalescedSamples(event) {
    const rect = this.surface.getBoundingClientRect();
    const raw = typeof event.getCoalescedEvents === "function" ? event.getCoalescedEvents() : null;
    const list = raw && raw.length ? raw : [event];
    return list.map((sample) => {
      // Safari 18.2 omits pointerId/target on coalesced events — only
      // coordinates and pressure are read here.
      const [x, y] = screenToWorld(
        sample.clientX - rect.left,
        sample.clientY - rect.top,
        this.app.viewport,
      );
      return { x, y, pressure: sample.pressure };
    });
  }

  onPointerDown = (event) => {
    if (this.app.isTextEditing() && event.target !== this.surface) return;
    this.surface.focus?.({ preventScroll: true });

    if (event.pointerType === "touch") {
      this.touches.set(event.pointerId, { x: event.clientX, y: event.clientY });
      if (this.penActive) return;                     // palm while the pen draws
      if (this.touches.size === 2) {
        this.cancelActive();
        this.startPinch();
        return;
      }
      if (this.touches.size > 2) return;
    }

    if (this.pinch) return;
    if (this.activePointerId !== null) return;
    if (event.pointerType === "pen") this.penActive = true;

    event.preventDefault();
    this.activePointerId = event.pointerId;
    try { this.surface.setPointerCapture(event.pointerId); } catch { /* not fatal */ }
    this.startLongPress(event);
    this.app.onPointerDown(this.toWorldEvent(event));
  };

  /* ------------------------------------------------------------ long press */

  startLongPress(event) {
    this.cancelLongPress();
    if (event.pointerType === "pen") return;   // a held pen is drawing, not asking
    const clientX = event.clientX;
    const clientY = event.clientY;
    this.longPress = {
      clientX,
      clientY,
      timer: setTimeout(() => {
        this.longPress = null;
        // Cancel the gesture in progress first, or the menu opens on top of a
        // half-finished drag that would commit as soon as the finger lifts.
        this.cancelActive();
        const world = this.toWorldEvent({
          clientX, clientY, shiftKey: false, altKey: false, pointerType: event.pointerType,
        });
        this.app.openContextMenu(world, { clientX, clientY });
      }, LONG_PRESS_MS),
    };
  }

  cancelLongPress() {
    if (!this.longPress) return;
    clearTimeout(this.longPress.timer);
    this.longPress = null;
  }

  trackLongPress(event) {
    if (!this.longPress) return;
    const drift = Math.hypot(event.clientX - this.longPress.clientX, event.clientY - this.longPress.clientY);
    if (drift > LONG_PRESS_SLOP) this.cancelLongPress();
  }

  onPointerMove = (event) => {
    if (event.pointerType === "touch" && this.touches.has(event.pointerId)) {
      this.touches.set(event.pointerId, { x: event.clientX, y: event.clientY });
    }
    if (this.pinch) {
      this.cancelLongPress();
      event.preventDefault();
      this.updatePinch();
      return;
    }
    if (event.pointerId !== this.activePointerId) return;
    if (this.penActive && event.pointerType === "touch") return;
    this.trackLongPress(event);
    event.preventDefault();
    this.app.onPointerMove(this.toWorldEvent(event, this.coalescedSamples(event)));
  };

  onPointerUp = (event) => {
    this.cancelLongPress();
    if (event.pointerType === "touch") this.touches.delete(event.pointerId);
    if (this.pinch && this.touches.size < 2) {
      this.pinch = null;
      this.app.scheduleSave();
    }
    if (event.pointerId !== this.activePointerId) return;
    this.activePointerId = null;
    if (event.pointerType === "pen") this.penActive = false;
    try { this.surface.releasePointerCapture(event.pointerId); } catch { /* already gone */ }
    this.app.onPointerUp(this.toWorldEvent(event));
  };

  onPointerCancel = (event) => {
    this.cancelLongPress();
    if (event.pointerType === "touch") this.touches.delete(event.pointerId);
    if (event.pointerId !== this.activePointerId) return;
    this.activePointerId = null;
    this.penActive = false;
    this.app.onPointerCancel();
  };

  cancelActive() {
    if (this.activePointerId === null) return;
    this.activePointerId = null;
    this.app.onPointerCancel();
  }

  startPinch() {
    const points = [...this.touches.values()];
    if (points.length < 2) return;
    const rect = this.surface.getBoundingClientRect();
    this.pinch = {
      distance: distanceBetween(points[0], points[1]),
      centerX: (points[0].x + points[1].x) / 2 - rect.left,
      centerY: (points[0].y + points[1].y) / 2 - rect.top,
      zoom: this.app.viewport.zoom,
      scrollX: this.app.viewport.scrollX,
      scrollY: this.app.viewport.scrollY,
    };
  }

  updatePinch() {
    const points = [...this.touches.values()];
    if (points.length < 2 || !this.pinch) return;
    const rect = this.surface.getBoundingClientRect();
    const distance = distanceBetween(points[0], points[1]);
    const centerX = (points[0].x + points[1].x) / 2 - rect.left;
    const centerY = (points[0].y + points[1].y) / 2 - rect.top;
    const ratio = distance / (this.pinch.distance || 1);

    // Zoom about the pinch centre, then translate by how far the centre moved,
    // so two fingers pan and zoom in one gesture.
    const zoomed = zoomAt(
      { zoom: this.pinch.zoom, scrollX: this.pinch.scrollX, scrollY: this.pinch.scrollY },
      this.pinch.zoom * ratio,
      this.pinch.centerX,
      this.pinch.centerY,
    );
    this.app.setViewport({
      zoom: zoomed.zoom,
      scrollX: zoomed.scrollX + (centerX - this.pinch.centerX) / zoomed.zoom,
      scrollY: zoomed.scrollY + (centerY - this.pinch.centerY) / zoomed.zoom,
    });
  }

  onWheel = (event) => {
    event.preventDefault();
    const rect = this.surface.getBoundingClientRect();
    const x = event.clientX - rect.left;
    const y = event.clientY - rect.top;
    if (event.ctrlKey || event.metaKey) {
      const next = this.app.viewport.zoom * Math.exp(-event.deltaY / 200);
      this.app.setViewport(zoomAt(this.app.viewport, next, x, y));
      return;
    }
    this.app.setViewport({
      scrollX: this.app.viewport.scrollX - event.deltaX / this.app.viewport.zoom,
      scrollY: this.app.viewport.scrollY - event.deltaY / this.app.viewport.zoom,
    });
  };

  onKeyDown = (event) => {
    const target = event.target;
    const typing = target instanceof HTMLElement
      && (target.tagName === "INPUT" || target.tagName === "TEXTAREA" || target.isContentEditable);
    // Never steal a key while a Korean IME is mid-composition.
    if (event.isComposing || event.keyCode === 229) return;
    this.app.onKeyDown(event, typing);
  };
}

function distanceBetween(a, b) {
  return Math.hypot(a.x - b.x, a.y - b.y);
}

export { clamp };
