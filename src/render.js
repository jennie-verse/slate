// Three stacked canvases.
//
//   static       committed elements      redrawn only when elements change
//   interaction  selection, live stroke  redrawn every frame of a gesture
//   overlay      search highlight        redrawn on demand
//
// The overlay is nearly empty in stage 1 and ships anyway. Slipping a layer
// into the middle later means re-deriving the whole paint order
// (Expansion_Plan 2-6).
//
// The on-screen canvases are always viewport-sized; the infinite canvas is a
// coordinate transform, not a giant bitmap. That is why iOS's canvas area limit
// only ever bites on PNG export (export.js), never while drawing.

import rough from "../vendor/rough.esm.js";
import { entryFor } from "./registry.js";
import {
  worldBounds, boxesOverlap, viewportBounds, handlePositions, localBounds, rotatePoint,
} from "./geometry.js";
import { displayColor } from "./model.js";

export class Renderer {
  constructor(container) {
    this.container = container;
    this.layers = {};
    for (const name of ["static", "interaction", "overlay"]) {
      const canvas = document.createElement("canvas");
      canvas.className = `layer layer-${name}`;
      canvas.setAttribute("aria-hidden", "true");
      container.appendChild(canvas);
      this.layers[name] = { canvas, ctx: canvas.getContext("2d") };
    }
    this.rough = rough.canvas(this.layers.static.canvas);
    this.width = 0;
    this.height = 0;
    this.dpr = 1;
    this.staticDirty = true;
    this.overlayDirty = true;
  }

  resize(width, height, dpr) {
    this.width = width;
    this.height = height;
    this.dpr = dpr;
    for (const name of Object.keys(this.layers)) {
      const { canvas } = this.layers[name];
      canvas.width = Math.max(1, Math.round(width * dpr));
      canvas.height = Math.max(1, Math.round(height * dpr));
      canvas.style.width = `${width}px`;
      canvas.style.height = `${height}px`;
    }
    // rough binds to a canvas element; rebuild after a size change.
    this.rough = rough.canvas(this.layers.static.canvas);
    this.staticDirty = true;
    this.overlayDirty = true;
  }

  markStaticDirty() { this.staticDirty = true; }
  markOverlayDirty() { this.overlayDirty = true; }

  prepare(ctx, viewport) {
    ctx.setTransform(1, 0, 0, 1, 0, 0);
    ctx.clearRect(0, 0, ctx.canvas.width, ctx.canvas.height);
    ctx.setTransform(this.dpr * viewport.zoom, 0, 0, this.dpr * viewport.zoom, 0, 0);
    ctx.translate(viewport.scrollX, viewport.scrollY);
  }

  /**
   * @param {object} state { scene, viewport, dark, selection:Set, editingId, snapshot }
   */
  render(state) {
    const { viewport, dark } = state;
    if (this.staticDirty) {
      this.drawStatic(state);
      this.staticDirty = false;
    }
    this.drawInteraction(state);
    if (this.overlayDirty) {
      this.drawOverlay(state);
      this.overlayDirty = false;
    }
    void viewport; void dark;
  }

  drawStatic(state) {
    const { ctx } = this.layers.static;
    const { scene, viewport, dark, editingId } = state;
    this.prepare(ctx, viewport);
    const visibleBox = viewportBounds(viewport, this.width, this.height);
    const context = { rough: this.rough, dark, zoom: viewport.zoom };

    for (const element of scene.visible()) {
      if (element.id === editingId) continue;             // being typed into
      if (state.hiddenIds?.has(element.id)) continue;     // mid-drag preview
      if (!boxesOverlap(visibleBox, worldBounds(element))) continue;  // culled
      try {
        entryFor(element.type).draw(ctx, element, context);
      } catch {
        // One bad element must not take the whole board down with it.
      }
    }
    ctx.setTransform(1, 0, 0, 1, 0, 0);
  }

  drawInteraction(state) {
    const { ctx } = this.layers.interaction;
    const { viewport, dark, scene, selection, draft, selectionBox } = state;
    this.prepare(ctx, viewport);
    const context = { rough: rough.canvas(this.layers.interaction.canvas), dark, zoom: viewport.zoom };

    // Elements currently being dragged/resized are drawn here, not on static,
    // so the expensive layer stays untouched during the gesture.
    if (state.hiddenIds?.size) {
      for (const id of state.hiddenIds) {
        const element = scene.get(id);
        if (!element || element.isDeleted) continue;
        // Elements queued for the eraser are dimmed so the stroke shows what
        // will go before the pointer is lifted.
        const fading = state.fadingIds?.has(id);
        if (fading) { ctx.save(); ctx.globalAlpha = 0.32; }
        try { entryFor(element.type).draw(ctx, element, context); } catch { /* ignore */ }
        if (fading) ctx.restore();
      }
    }

    if (draft) {
      try { entryFor(draft.type).draw(ctx, draft, context); } catch { /* ignore */ }
    }

    const accent = dark ? "#EFB3C1" : "#8A4257";
    const selected = [...(selection || [])].map((id) => scene.get(id)).filter((e) => e && !e.isDeleted);

    if (selected.length) {
      ctx.lineWidth = 1 / viewport.zoom;
      ctx.strokeStyle = accent;
      ctx.setLineDash([4 / viewport.zoom, 3 / viewport.zoom]);
      for (const element of selected) {
        const box = localBounds(element);
        ctx.save();
        if (element.angle) {
          ctx.translate(box.x + box.width / 2, box.y + box.height / 2);
          ctx.rotate(element.angle);
          ctx.translate(-(box.width / 2), -(box.height / 2));
          ctx.strokeRect(-2 / viewport.zoom, -2 / viewport.zoom, box.width + 4 / viewport.zoom, box.height + 4 / viewport.zoom);
        } else {
          ctx.strokeRect(box.x - 2 / viewport.zoom, box.y - 2 / viewport.zoom, box.width + 4 / viewport.zoom, box.height + 4 / viewport.zoom);
        }
        ctx.restore();
      }
      ctx.setLineDash([]);

      if (state.handleBox) {
        this.drawHandles(ctx, state.handleBox, state.handleAngle || 0, viewport, dark);
      }
    }

    if (selectionBox) {
      ctx.setLineDash([4 / viewport.zoom, 3 / viewport.zoom]);
      ctx.strokeStyle = accent;
      ctx.fillStyle = dark ? "rgba(239,179,193,.12)" : "rgba(138,66,87,.08)";
      ctx.lineWidth = 1 / viewport.zoom;
      ctx.fillRect(selectionBox.x, selectionBox.y, selectionBox.width, selectionBox.height);
      ctx.strokeRect(selectionBox.x, selectionBox.y, selectionBox.width, selectionBox.height);
      ctx.setLineDash([]);
    }

    ctx.setTransform(1, 0, 0, 1, 0, 0);
  }

  drawHandles(ctx, box, angle, viewport, dark) {
    const size = 9 / viewport.zoom;
    const rotateOffset = 26 / viewport.zoom;
    const positions = handlePositions(box, angle, rotateOffset);
    ctx.lineWidth = 1.5 / viewport.zoom;
    ctx.strokeStyle = dark ? "#EFB3C1" : "#8A4257";
    ctx.fillStyle = dark ? "#241E22" : "#FFFFFF";

    const cx = box.x + box.width / 2;
    const cy = box.y + box.height / 2;
    const topMid = rotatePoint(cx, box.y, cx, cy, angle);
    const rotateAt = positions.rotate;
    ctx.beginPath();
    ctx.moveTo(topMid[0], topMid[1]);
    ctx.lineTo(rotateAt[0], rotateAt[1]);
    ctx.stroke();

    for (const [kind, [hx, hy]] of Object.entries(positions)) {
      ctx.beginPath();
      if (kind === "rotate") {
        ctx.arc(hx, hy, size / 1.7, 0, Math.PI * 2);
      } else {
        ctx.rect(hx - size / 2, hy - size / 2, size, size);
      }
      ctx.fill();
      ctx.stroke();
    }
  }

  drawOverlay(state) {
    const { ctx } = this.layers.overlay;
    const { viewport } = state;
    this.prepare(ctx, viewport);
    // Stage 1 uses the overlay for search highlights only; stage 3's laser and
    // frame labels and stage 4's remote cursors land here.
    if (state.highlights?.length) {
      ctx.fillStyle = state.dark ? "rgba(247,227,168,.22)" : "rgba(247,227,168,.55)";
      for (const box of state.highlights) {
        ctx.fillRect(box.x, box.y, box.width, box.height);
      }
    }
    ctx.setTransform(1, 0, 0, 1, 0, 0);
  }

  /** Canvas background is painted by CSS on the container, so exports control it separately. */
  applyBackground(color, dark) {
    this.container.style.background = displayColor(color, dark);
  }
}
