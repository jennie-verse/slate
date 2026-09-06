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

  // The overlay carries link and lock markers, which are derived from the same
  // elements the static layer draws — so anything that dirties one dirties both.
  markStaticDirty() { this.staticDirty = true; this.overlayDirty = true; }
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

    if (state.grid) this.drawGrid(ctx, viewport, visibleBox, state.grid, dark);

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

    if (state.bindingTarget) {
      this.drawBindingHighlight(ctx, state.bindingTarget, viewport, dark);
    }
    if (state.snapGuides?.length) {
      this.drawSnapGuides(ctx, state.snapGuides, viewport, dark);
    }

    const accent = dark ? "#EFB3C1" : "#8A4257";
    // A label inside a shape is selected together with its host; outlining both
    // just draws a box inside a box.
    const selected = [...(selection || [])]
      .map((id) => scene.get(id))
      .filter((e) => e && !e.isDeleted && !e.containerId);

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

  /**
   * Grid lines, drawn under the elements.
   * Lines are skipped entirely once they would be closer than 4 screen pixels
   * apart — at that point a grid is a grey wash, not a guide.
   */
  drawGrid(ctx, viewport, box, step, dark) {
    const spacing = step * viewport.zoom;
    if (spacing < 4) return;
    const major = step * 5;
    const startX = Math.floor(box.x / step) * step;
    const startY = Math.floor(box.y / step) * step;
    const thin = dark ? "rgba(237,227,230,.07)" : "rgba(74,58,64,.07)";
    const thick = dark ? "rgba(237,227,230,.15)" : "rgba(74,58,64,.15)";

    ctx.save();
    ctx.lineWidth = 1 / viewport.zoom;
    for (let x = startX; x <= box.x + box.width; x += step) {
      ctx.strokeStyle = Math.abs(x % major) < 0.001 ? thick : thin;
      ctx.beginPath();
      ctx.moveTo(x, box.y);
      ctx.lineTo(x, box.y + box.height);
      ctx.stroke();
    }
    for (let y = startY; y <= box.y + box.height; y += step) {
      ctx.strokeStyle = Math.abs(y % major) < 0.001 ? thick : thin;
      ctx.beginPath();
      ctx.moveTo(box.x, y);
      ctx.lineTo(box.x + box.width, y);
      ctx.stroke();
    }
    ctx.restore();
  }

  /** Dashed outline over the shape an arrow is about to attach to. */
  drawBindingHighlight(ctx, element, viewport, dark) {
    const box = worldBounds(element);
    const pad = 4 / viewport.zoom;
    ctx.save();
    ctx.setLineDash([6 / viewport.zoom, 4 / viewport.zoom]);
    ctx.lineWidth = 2 / viewport.zoom;
    ctx.strokeStyle = dark ? "#CBE5B4" : "#4E7238";
    ctx.strokeRect(box.x - pad, box.y - pad, box.width + pad * 2, box.height + pad * 2);
    ctx.setLineDash([]);
    ctx.restore();
  }

  /** Alignment guides while dragging. */
  drawSnapGuides(ctx, guides, viewport, dark) {
    ctx.save();
    ctx.strokeStyle = dark ? "#EFB3C1" : "#8A4257";
    ctx.lineWidth = 1 / viewport.zoom;
    ctx.setLineDash([3 / viewport.zoom, 3 / viewport.zoom]);
    for (const guide of guides) {
      ctx.beginPath();
      if (guide.axis === "x") {
        ctx.moveTo(guide.at, guide.from);
        ctx.lineTo(guide.at, guide.to);
      } else {
        ctx.moveTo(guide.from, guide.at);
        ctx.lineTo(guide.to, guide.at);
      }
      ctx.stroke();
    }
    ctx.setLineDash([]);
    ctx.restore();
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
    const { viewport, dark, scene } = state;
    this.prepare(ctx, viewport);

    // Search hits. Corners are carried through so rotated text highlights at
    // the same angle as the letters instead of in a fat axis-aligned box.
    if (state.highlights?.length) {
      for (const hit of state.highlights) {
        const active = hit.index === state.activeHighlight;
        ctx.fillStyle = active
          ? (dark ? "rgba(247,227,168,.46)" : "rgba(247,227,168,.85)")
          : (dark ? "rgba(247,227,168,.20)" : "rgba(247,227,168,.45)");
        const corners = hit.box?.corners;
        if (corners) {
          ctx.beginPath();
          ctx.moveTo(corners[0][0], corners[0][1]);
          for (let i = 1; i < corners.length; i += 1) ctx.lineTo(corners[i][0], corners[i][1]);
          ctx.closePath();
          ctx.fill();
        } else if (hit.box) {
          ctx.fillRect(hit.box.x, hit.box.y, hit.box.width, hit.box.height);
        }
      }
    }

    // Link and lock markers. Both are drawn as SHAPES, never colour alone, so
    // they still read at every text size and in both themes.
    if (scene && (state.showBadges ?? true)) {
      const size = 9 / viewport.zoom;
      for (const element of scene.visible()) {
        if (element.link) {
          const box = worldBounds(element);
          const x = box.x + box.width;
          const y = box.y;
          ctx.save();
          ctx.fillStyle = dark ? "#B9D8EE" : "#3E6C90";
          ctx.beginPath();
          ctx.arc(x, y, size, 0, Math.PI * 2);
          ctx.fill();
          ctx.strokeStyle = dark ? "#1C171A" : "#FFFFFF";
          ctx.lineWidth = 1.6 / viewport.zoom;
          ctx.beginPath();
          ctx.moveTo(x - size * 0.4, y + size * 0.25);
          ctx.lineTo(x + size * 0.1, y - size * 0.3);
          ctx.moveTo(x - size * 0.1, y + size * 0.3);
          ctx.lineTo(x + size * 0.4, y - size * 0.25);
          ctx.stroke();
          ctx.restore();
        }
        if (element.locked) {
          const box = worldBounds(element);
          ctx.save();
          ctx.strokeStyle = dark ? "rgba(237,227,230,.35)" : "rgba(74,58,64,.30)";
          ctx.lineWidth = 1 / viewport.zoom;
          ctx.setLineDash([2 / viewport.zoom, 4 / viewport.zoom]);
          ctx.strokeRect(box.x, box.y, box.width, box.height);
          ctx.setLineDash([]);
          ctx.restore();
        }
      }
    }
    ctx.setTransform(1, 0, 0, 1, 0, 0);
  }

  /** Canvas background is painted by CSS on the container, so exports control it separately. */
  applyBackground(color, dark) {
    this.container.style.background = displayColor(color, dark);
  }
}
