// Wiring. State lives here; every module below stays unaware of the others.

import { APP_BUILD } from "./version.js";
import { Scene } from "./scene.js";
import { History } from "./history.js";
import { Actions } from "./actions.js";
import { Renderer } from "./render.js";
import { InputManager } from "./input.js";
import { TOOLS, toolById, NUMBER_SHORTCUTS } from "./tools/index.js";
import { renderProps } from "./props.js";
import { entryFor } from "./registry.js";
import {
  newId, DEFAULT_ELEMENT_STYLE, CANVAS_BACKGROUNDS, displayColor, fontStackFor,
  cloneElements, createElement, DEFAULT_GRID_SIZE,
} from "./model.js";
import {
  boundsOfMany, localBounds, zoomAt, clamp, viewportBounds, worldBounds, screenToWorld,
} from "./geometry.js";
import {
  buildShell, toast, openDialog, confirmDialog, promptDialog, el, svgIcon, anyDialogOpen,
  pickFile,
} from "./ui.js";
import { openContextMenu, contextMenuOpen } from "./contextmenu.js";
import {
  bindingUpdates, affectedArrowIds, withBound, withoutBound,
} from "./binding.js";
import {
  containerUpdates, layoutBoundText, canHoldText, boundTextIdOf, withBoundText,
  usableWidth, wrapText,
} from "./containers.js";
import {
  groupPatch, ungroupPatch, lockPatch, alignPatch, distributePatch, flipPatch,
  expandSelection, outerGroupId,
} from "./arrange.js";
import { GRID_STEPS, snapValue } from "./snapping.js";
import {
  writeElements, readElements, materialise, copyStyles, pasteStyles,
  hasStyleBuffer, writeImageBlob,
} from "./clipboard.js";
import {
  readImageFile, createImageElement, setFileSource, onImageReady, forgetImages,
  usedFileIds, ensureImagesReady, ImageError, ACCEPT as IMAGE_ACCEPT,
} from "./images.js";
import { findMatches, normaliseLinkInput, safeLink } from "./search.js";
import {
  loadLibrary, saveLibrary, makeItem, instantiate, toFile as libraryFile,
  parseFile as parseLibraryFile, mergeItems, LibraryError,
} from "./library.js";
import {
  settings, applyFontStep, resetFontStep, applyTheme, isDark, FONT_STEPS,
  setPanelCollapsed, isStandalone, isIOS, markInstallHintSeen,
} from "./settings.js";
import {
  createBoard, loadBoard, saveBoard, renameBoard, listBoards, deleteBoard,
  purgeBoard, formatBytes, formatDate, DEFAULT_APP_STATE, readPreviousContent,
} from "./boards.js";
import { readSetting, writeSetting, storageEstimate } from "./store.js";
import {
  toExcalidrawFile, parseExcalidrawFile, exportPNG, exportSVG, shareOrDownload,
  safeFilename, maxExportScale, ImportError,
} from "./export.js";
import { downloadBackup, restoreBackup, BackupError, SchemaTooNewError } from "./backup.js";
import * as journal from "./journal.js";
import { appendJournalSettings } from "./journal-ui.js";
import { createSessionTracker } from "./activity-session.js";

const SAVE_DEBOUNCE = 700;
const LAST_BOARD_KEY = "lastBoardId";

class SlateApp {
  constructor(root) {
    this.root = root;
    this.scene = new Scene([]);
    this.history = new History(this.scene);
    this.viewport = { scrollX: 0, scrollY: 0, zoom: 1 };
    this.selection = new Set();
    this.style = { ...DEFAULT_ELEMENT_STYLE };
    this.activeTool = toolById("selection");
    this.draft = null;
    this.selectionBox = null;
    this.draggingIds = null;
    this.fadingIds = null;
    this.board = null;
    // Bumped the instant a board switch STARTS. Comparing board ids across an
    // await is not enough: openBoard cancels, flushes and loads before it
    // reassigns this.board, so an async insert finishing inside that window
    // still sees the old id, writes into the scene that is being replaced, and
    // the work disappears with it.
    this.boardEpoch = 0;
    this.files = {};
    this.editing = null;
    this.saveTimer = null;
    this.saveState = "saved";
    this.journalContentFingerprint = null;
    this.frame = null;
    this.usageSessions = createSessionTracker({
      kind: "usage-session", itemType: "drawing-board", storageKey: "slate.journalSessions.v1",
      onRecord: (record) => journal.recordSession(record),
    });

    /* stage 2 */
    this.snapGuides = null;
    this.bindingTarget = null;
    this.grid = { enabled: false, size: DEFAULT_GRID_SIZE };
    this.snapToObjects = true;
    this.search = null;          // { query, matches, active }
    this.lastTap = null;
    this.tapConsumed = false;
  }

  /* ------------------------------------------------------------- lifecycle */

  async start() {
    applyTheme(settings.theme);
    applyFontStep(settings.fontStepIndex);

    this.dom = buildShell(this.root, {
      tools: TOOLS,
      onTool: (id) => this.selectTool(id),
      onMenu: () => this.openMenu(),
      onUndo: () => this.undo(),
      onRedo: () => this.redo(),
      onZoom: (direction) => this.stepZoom(direction),
      onFit: () => this.scrollBackToContent(),
      onPanelToggle: () => this.togglePanel(),
    });

    this.renderer = new Renderer(this.dom.canvasHost);
    this.input = new InputManager(this, this.dom.surface);
    // Bound to document (not just the canvas surface) so that typing inside a
    // text-input overlay still keeps the usage session alive — Grove uses the
    // same document-level + screen-state pattern.
    document.addEventListener("pointerdown", () => { if (this.board) this.usageSessions.signal(); }, { passive: true });
    document.addEventListener("wheel", () => { if (this.board) this.usageSessions.signal(); }, { passive: true });
    document.addEventListener("keydown", () => { if (this.board) this.usageSessions.signal(); });
    // An image finishing its decode is the one thing that changes the picture
    // without any action from the user — repaint when it lands.
    onImageReady(() => {
      this.markStatic();
      this.requestRender();
    });
    this.dom.titleButton.addEventListener("click", () => this.renameCurrentBoard());
    if (settings.panelCollapsed) this.dom.shell.classList.add("panel-collapsed");

    window.addEventListener("resize", () => this.fitCanvas());
    window.visualViewport?.addEventListener("resize", () => this.syncVisualViewport());
    window.visualViewport?.addEventListener("scroll", () => this.syncVisualViewport());
    window.matchMedia?.("(prefers-color-scheme: dark)").addEventListener?.("change", () => {
      if (settings.theme === "auto") this.applyThemeNow();
    });

    // iOS can discard the tab without warning — force a final write on the way out.
    window.addEventListener("pagehide", () => { this.usageSessions.stop(); this.saveNow({ blocking: true }); });
    document.addEventListener("visibilitychange", () => {
      if (document.visibilityState === "hidden") { this.usageSessions.stop(); this.saveNow({ blocking: true }); }
      else if (this.board) this.usageSessions.start({ id: this.board.id, title: this.board.title || "Untitled", itemType: "drawing-board" });
    });

    this.fitCanvas();
    this.selectTool("selection");
    await this.openInitialBoard();
    this.refreshProps();
    this.updateChrome();
    this.maybeShowInstallHint();
  }

  async openInitialBoard() {
    try {
      const boards = await listBoards();
      const lastId = await readSetting(LAST_BOARD_KEY, null);
      const target = boards.find((board) => board.id === lastId) || boards[0];
      if (target) {
        await this.openBoard(target.id);
        return;
      }
      const created = await createBoard("Untitled");
      await this.openBoard(created.id);
    } catch (error) {
      // A storage failure at boot must be visible, not a blank screen.
      this.setSaveState("error");
      toast("Could not open local storage. Your drawings are safe, but nothing can be saved right now.", { tone: "error", timeout: 9000 });
      console.warn("[slate] storage unavailable:", error?.message || error);
    }
  }

  async openBoard(id, { flush = true, journalOpened = false } = {}) {
    this.usageSessions.clearItem();
    this.boardEpoch += 1;
    // Order matters. Cancel first so nothing is still writing, then flush, then
    // swap: a debounced save (or an image insert that finished while the board
    // list was open) is otherwise thrown away with the scene it belonged to.
    this.cancelGesture();
    // The textarea normally commits itself on blur when the dialog takes focus.
    // Doing it explicitly does not depend on that: the half-typed label belongs
    // to the board being left, and it has to be committed before the flush, not
    // after the swap.
    if (this.editing) this.commitText();
    if (flush && this.board) await this.saveNow({ blocking: true });
    const loaded = await loadBoard(id);
    if (!loaded) return;
    this.board = loaded.meta;
    this.scene = new Scene(loaded.elements);
    this.history = new History(this.scene);
    this.files = loaded.files || {};
    // Images are decoded per board; carrying another board's bitmaps around is
    // wasted memory on a device that has little of it.
    forgetImages();
    setFileSource(this.files);
    this.viewport = {
      scrollX: loaded.appState.scrollX ?? 0,
      scrollY: loaded.appState.scrollY ?? 0,
      zoom: loaded.appState.zoom ?? 1,
    };
    this.background = loaded.appState.viewBackgroundColor || DEFAULT_APP_STATE.viewBackgroundColor;
    // scene.toJSON(), not loaded.elements: the Scene sorts by order key and
    // fills in any that are missing, so a board restored from a backup (which
    // is written verbatim) would otherwise look "edited" on its very first save
    // without the user touching anything.
    this.journalContentFingerprint = this.contentFingerprint({
      elements: this.scene.toJSON(),
      background: this.background,
      files: this.files,
    });
    // gridSize is the original's appState field: a number when the grid is on,
    // null when it is off. Storing it that way keeps the round trip honest.
    this.grid = {
      enabled: !!loaded.appState.gridSize,
      size: loaded.appState.gridSize || DEFAULT_GRID_SIZE,
    };
    this.snapToObjects = loaded.appState.objectsSnapModeEnabled !== false;
    this.search = null;
    this.selection = new Set();
    await writeSetting(LAST_BOARD_KEY, id).catch(() => {});
    this.applyBackground();
    this.markStatic();
    this.requestRender();
    this.updateChrome();
    this.setSaveState("saved");
    if (journalOpened) journal.recordActivity(this.board, "opened").catch(() => {});
    this.usageSessions.start({ id: this.board.id, title: this.board.title || "Untitled", itemType: "drawing-board" });
  }

  /* ---------------------------------------------------------------- canvas */

  fitCanvas() {
    const rect = this.dom.canvasHost.getBoundingClientRect();
    const dpr = Math.min(window.devicePixelRatio || 1, 3);
    this.renderer.resize(rect.width, rect.height, dpr);
    this.requestRender();
    if (this.editing) this.positionEditor();
  }

  syncVisualViewport() {
    // iOS does not shrink the layout viewport when the keyboard opens, so the
    // sheet and its buttons have to be moved by hand (Build_Plan 7-1).
    const vv = window.visualViewport;
    if (!vv) return;
    const inset = Math.max(0, window.innerHeight - vv.height - vv.offsetTop);
    document.documentElement.style.setProperty("--keyboard-inset", `${inset}px`);
    if (this.editing) this.positionEditor();
  }

  requestRender() {
    if (this.frame) return;
    this.frame = requestAnimationFrame(() => {
      this.frame = null;
      this.renderer.render({
        scene: this.scene,
        viewport: this.viewport,
        dark: this.isDark(),
        selection: this.selection,
        draft: this.draft,
        selectionBox: this.selectionBox,
        hiddenIds: this.hiddenSet(),
        fadingIds: this.fadingIds,
        editingId: this.editing?.element.id ?? null,
        handleBox: this.handleBox(),
        handleAngle: this.handleAngle(),
        grid: this.grid.enabled ? this.grid.size : 0,
        snapGuides: this.snapGuides,
        bindingTarget: this.bindingTarget,
        highlights: this.search?.matches || null,
        activeHighlight: this.search?.active ?? -1,
      });
      this.updateZoomLabel();
    });
  }

  hiddenSet() {
    const set = new Set();
    if (this.draggingIds) for (const id of this.draggingIds) set.add(id);
    if (this.fadingIds) for (const id of this.fadingIds) set.add(id);
    return set.size ? set : null;
  }

  markStatic() {
    this.renderer.markStaticDirty();
  }

  handleBox() {
    const elements = this.selectedElements();
    if (!elements.length) return null;
    if (elements.length === 1 && elements[0].angle) return localBounds(elements[0]);
    return boundsOfMany(elements);
  }

  handleAngle() {
    const elements = this.selectedElements();
    return elements.length === 1 ? (elements[0].angle || 0) : 0;
  }

  setViewport(partial) {
    this.viewport = { ...this.viewport, ...partial };
    this.viewport.zoom = clamp(this.viewport.zoom, 0.1, 10);
    this.markStatic();
    this.requestRender();
    if (this.editing) this.positionEditor();
  }

  stepZoom(direction) {
    const rect = this.dom.canvasHost.getBoundingClientRect();
    if (direction === 0) {
      this.setViewport(zoomAt(this.viewport, 1, rect.width / 2, rect.height / 2));
      return;
    }
    const factor = direction > 0 ? 1.2 : 1 / 1.2;
    this.setViewport(zoomAt(this.viewport, this.viewport.zoom * factor, rect.width / 2, rect.height / 2));
    this.scheduleSave();
  }

  /** Infinite canvas needs a way home — otherwise getting lost is unrecoverable. */
  scrollBackToContent() {
    const elements = this.scene.visible();
    const rect = this.dom.canvasHost.getBoundingClientRect();
    if (!elements.length) {
      this.setViewport({ scrollX: rect.width / 2, scrollY: rect.height / 2, zoom: 1 });
      toast("This board is empty.");
      return;
    }
    const box = boundsOfMany(elements);
    const margin = 60;
    const zoom = clamp(Math.min(
      (rect.width - margin * 2) / Math.max(box.width, 1),
      (rect.height - margin * 2) / Math.max(box.height, 1),
    ), 0.1, 2);
    this.setViewport({
      zoom,
      scrollX: rect.width / (2 * zoom) - (box.x + box.width / 2),
      scrollY: rect.height / (2 * zoom) - (box.y + box.height / 2),
    });
    this.scheduleSave();
  }

  updateZoomLabel() {
    if (!this.dom) return;
    const percent = Math.round(this.viewport.zoom * 100);
    if (this.dom.zoomLabel.textContent !== `${percent}%`) {
      this.dom.zoomLabel.textContent = `${percent}%`;
    }
  }

  applyBackground() {
    this.renderer.applyBackground(this.background || DEFAULT_APP_STATE.viewBackgroundColor, this.isDark());
  }

  applyThemeNow() {
    applyTheme(settings.theme);
    this.applyBackground();
    this.markStatic();
    this.requestRender();
    this.refreshProps();
  }

  isDark() {
    return isDark();
  }

  /* ----------------------------------------------------------------- tools */

  selectTool(id) {
    this.activeTool.onCancel?.(this);
    this.activeTool = toolById(id);
    if (id !== "selection") this.setSelection(new Set(), { quiet: true });
    for (const [toolId, button] of this.dom.toolButtons) {
      const active = toolId === id;
      button.classList.toggle("is-on", active);
      button.setAttribute("aria-pressed", active ? "true" : "false");
    }
    this.dom.surface.style.cursor = this.activeTool.cursor || "default";
    this.refreshProps();
    this.requestRender();
  }

  styleForNew(type) {
    const style = {
      strokeColor: this.style.strokeColor,
      backgroundColor: this.style.backgroundColor,
      fillStyle: this.style.fillStyle,
      strokeWidth: this.style.strokeWidth,
      strokeStyle: this.style.strokeStyle,
      roughness: this.style.roughness,
      opacity: this.style.opacity,
    };
    if (type === "rectangle" || type === "diamond" || type === "ellipse") {
      style.roundness = this.style.roundness ?? { type: 3 };
    }
    if (type === "arrow" || type === "line") {
      style.arrowType = this.style.arrowType;
      if (type === "arrow") {
        style.startArrowhead = this.style.startArrowhead ?? null;
        style.endArrowhead = this.style.endArrowhead ?? "arrow";
      }
    }
    if (type === "text") {
      style.fontSize = this.style.fontSize;
      style.fontFamily = this.style.fontFamily;
      style.textAlign = this.style.textAlign;
    }
    return style;
  }

  setStyle(changes) {
    this.style = { ...this.style, ...changes };
  }

  refreshProps() {
    if (!this.dom) return;
    renderProps(this.dom.panelBody, this);
    this.dom.empty.hidden = this.scene.visible().length > 0;
  }

  togglePanel() {
    const collapsed = !this.dom.shell.classList.contains("panel-collapsed");
    this.dom.shell.classList.toggle("panel-collapsed", collapsed);
    this.dom.panelHandle.setAttribute("aria-expanded", collapsed ? "false" : "true");
    this.dom.panelHandle.setAttribute("aria-label", collapsed ? "Expand properties" : "Collapse properties");
    setPanelCollapsed(collapsed);
  }

  /* -------------------------------------------------------- pointer routing */

  hitThreshold(event) {
    // Tolerance is a SCREEN distance divided by zoom, and fingers get more room
    // than a pen. Thin lines being unselectable by finger is the single most
    // common complaint about apps like this (Build_Plan 7-1).
    const screenPixels = event?.pointerType === "pen" ? 6 : 12;
    return screenPixels / this.viewport.zoom;
  }

  handleThreshold(event) {
    const screenPixels = event?.pointerType === "pen" ? 12 : 22;
    return screenPixels / this.viewport.zoom;
  }

  /** How close an arrow end has to land to attach. Deliberately forgiving. */
  bindThreshold(event) {
    const screenPixels = event?.pointerType === "pen" ? 10 : 18;
    return screenPixels / this.viewport.zoom;
  }

  elementAt(x, y, threshold) {
    const elements = this.scene.visible();
    for (let i = elements.length - 1; i >= 0; i -= 1) {
      const element = elements[i];
      if (element.locked) continue;
      if (!entryFor(element.type).hitTest(element, x, y, threshold)) continue;
      // A label belongs to its shape: tapping the words picks up the box.
      if (element.containerId) {
        const container = this.scene.get(element.containerId);
        if (container && !container.isDeleted && !container.locked) return container;
        continue;
      }
      return element;
    }
    return null;
  }

  onPointerDown(event) {
    if (this.editing) this.commitText();
    this.tapConsumed = false;
    this.activeTool.onPointerDown?.(this, event);
  }

  /**
   * "That pointer-up was not a plain tap on the canvas."
   * A handle drag, a marquee, a badge press and a real move all end in
   * onPointerUp, and the double-tap detector cannot tell them apart on its own.
   */
  consumeTap() {
    this.tapConsumed = true;
    this.lastTap = null;
  }

  onPointerMove(event) {
    this.activeTool.onPointerMove?.(this, event);
  }

  onPointerUp(event) {
    this.activeTool.onPointerUp?.(this, event);
    this.handleDoubleTap(event);
    this.refreshProps();
  }

  onPointerCancel() {
    this.activeTool.onCancel?.(this);
  }

  setDraft(element) {
    this.draft = element;
    this.requestRender();
  }

  setDragging(ids) {
    this.draggingIds = ids ? new Set(ids) : null;
    this.markStatic();
  }

  setFading(ids) {
    this.fadingIds = ids ? new Set(ids) : null;
    this.markStatic();
  }

  setSelectionBox(box) {
    this.selectionBox = box;
    this.requestRender();
  }

  setSelection(ids, { quiet = false } = {}) {
    this.selection = ids instanceof Set ? ids : new Set(ids);
    if (!quiet) this.refreshProps();
    this.requestRender();
  }

  selectedElements() {
    return [...this.selection].map((id) => this.scene.get(id)).filter((e) => e && !e.isDeleted);
  }

  afterCreate(_element, { keepTool = false } = {}) {
    this.markStatic();
    this.requestRender();
    this.refreshProps();
    this.scheduleSave();
    // Drawing tools stay active so several strokes in a row are natural;
    // shape tools hand back to selection so the new shape can be adjusted.
    if (!keepTool) this.selectTool("selection");
  }

  duplicateSelection() {
    if (this.refuseDuringGesture()) return;
    const elements = this.selectedElements();
    if (!elements.length) return;
    // cloneElements rewrites ids AND the relationships between them, so a
    // duplicated box keeps its own label and its own arrow instead of sharing
    // the original's (model.js).
    const copies = cloneElements(elements, { offsetX: 16, offsetY: 16 });
    this.history.run(Actions.add(copies));
    this.setSelection(new Set(copies.filter((element) => !element.containerId).map((element) => element.id)));
    this.markStatic();
    this.requestRender();
    this.scheduleSave();
  }

  /* ------------------------------------------------------ scene conveniences */

  addElements(elements) {
    this.history.run(Actions.add(elements));
    this.markStatic();
    this.requestRender();
    this.scheduleSave();
    return elements;
  }

  /**
   * Delete, taking labels with their hosts and cleaning up bindings.
   *
   * Locked elements are skipped HERE rather than in actions.js: the low-level
   * delete has to be able to remove anything, because it is also the inverse of
   * `add` — see the note there.
   */
  /**
   * The delete the user asked for — keyboard, property panel and context menu
   * all arrive here. `deleteElements` below stays unguarded on purpose: the
   * eraser is itself a gesture and calls it from inside one.
   */
  deleteSelection(ids = null) {
    if (this.refuseDuringGesture()) return;
    const list = (ids || [...this.selection]).filter((id) => {
      const element = this.scene.get(id);
      return element && !element.isDeleted;
    });
    if (!list.length) return;
    this.deleteElements(list);
    this.setSelection(new Set());
  }

  /** Arrow keys move elements exactly as a drag does, bound arrows and all. */
  nudgeSelection(dx, dy) {
    if (this.refuseDuringGesture()) return;
    const ids = [...this.selection].filter((id) => this.scene.get(id));
    if (!ids.length) return;
    const changes = ids.map((id) => {
      const element = this.scene.get(id);
      return { x: element.x + dx, y: element.y + dy };
    });
    this.history.run(Actions.update(ids, changes));
    // Nudging moves elements exactly like dragging does, so bound arrows and
    // labels have to follow it too.
    this.syncBindings(ids, { layout: true, merge: true });
    this.markStatic();
    this.requestRender();
    this.scheduleSave();
  }

  deleteElements(ids) {
    const unlocked = [...ids].filter((id) => {
      const element = this.scene.get(id);
      return element && !element.isDeleted && !element.locked;
    });
    const full = withBoundText(this.scene, unlocked).filter((id) => !this.scene.get(id)?.locked);
    if (!full.length) return;
    const steps = [Actions.delete(full)];

    // A surviving shape must forget the arrow or label that just went, or the
    // element would keep a boundElements entry pointing at a tombstone — which
    // then re-attaches to nothing after an undo.
    const gone = new Set(full);
    const detached = new Map();
    const removeFrom = (shapeId, boundId) => {
      if (!shapeId || gone.has(shapeId)) return;
      const shape = this.scene.get(shapeId);
      if (!shape) return;
      const source = detached.has(shapeId)
        ? { boundElements: detached.get(shapeId) }
        : shape;
      detached.set(shapeId, withoutBound(source, boundId));
    };

    for (const id of full) {
      const element = this.scene.get(id);
      if (!element) continue;
      if (element.type === "arrow") {
        removeFrom(element.startBinding?.elementId, id);
        removeFrom(element.endBinding?.elementId, id);
      }
      if (element.containerId) removeFrom(element.containerId, id);
    }
    for (const [id, boundElements] of detached) {
      steps.push(Actions.update([id], { boundElements }));
    }

    this.history.run(steps.length === 1 ? steps[0] : Actions.batch(steps));
    this.markStatic();
    this.requestRender();
    this.refreshProps();
    this.scheduleSave();
  }

  /* -------------------------------------------------------------- snapping */

  gridStep() {
    return this.grid.enabled ? this.grid.size : 0;
  }

  objectSnapEnabled() {
    return this.snapToObjects;
  }

  /** Where a new element's corner should actually land. */
  snapPoint(x, y) {
    const step = this.gridStep();
    if (!step) return { x, y };
    return { x: snapValue(x, step), y: snapValue(y, step) };
  }

  setSnapGuides(guides) {
    const next = guides?.length ? guides : null;
    if (!next && !this.snapGuides) return;
    this.snapGuides = next;
    this.requestRender();
  }

  setBindingTarget(element) {
    if (this.bindingTarget?.id === element?.id) return;
    this.bindingTarget = element || null;
    this.requestRender();
  }

  visibleWorldBox() {
    const rect = this.dom.canvasHost.getBoundingClientRect();
    return viewportBounds(this.viewport, rect.width, rect.height, 0);
  }

  toggleGrid() {
    this.grid = { ...this.grid, enabled: !this.grid.enabled };
    this.markStatic();
    this.requestRender();
    this.scheduleSave();
    toast(this.grid.enabled ? `Grid on — ${this.grid.size}px` : "Grid off");
  }

  setGridSize(size) {
    this.grid = { enabled: true, size };
    this.markStatic();
    this.requestRender();
    this.scheduleSave();
  }

  toggleObjectSnap() {
    this.snapToObjects = !this.snapToObjects;
    this.scheduleSave();
    toast(this.snapToObjects ? "Snap to objects on" : "Snap to objects off");
  }

  /* --------------------------------------------------- bindings and labels */

  /**
   * Measuring one line of an element's text.
   * Wrapping and search both need it, and both are pure modules — so the canvas
   * stays here and gets passed in (Expansion_Plan 2-7).
   */
  measureLine = (line, element) => {
    const ctx = this.renderer.layers.static.ctx;
    ctx.save();
    ctx.font = `${element.fontSize || 20}px ${fontStackFor(element.fontFamily)}`;
    const width = ctx.measureText(line ?? "").width;
    ctx.restore();
    return width;
  };

  /** Elements that follow `ids` around: bound arrows and bound labels. */
  bindingCompanions(ids) {
    const moving = new Set(ids);
    const out = new Set();
    const arrows = affectedArrowIds(this.scene, ids);
    for (const id of arrows) {
      if (!moving.has(id)) out.add(id);
    }
    // Labels of the moved elements AND of the arrows that are about to follow
    // them — an arrow label is re-centred on the arrow's new midpoint, so it
    // has to be in the snapshot or undo leaves it floating where the arrow was.
    for (const id of withBoundText(this.scene, [...ids, ...arrows])) {
      if (!moving.has(id)) out.add(id);
    }
    // A label's own geometry changes when its container resizes.
    for (const id of ids) {
      const element = this.scene.get(id);
      if (element?.containerId && !moving.has(element.containerId)) out.add(element.containerId);
    }
    return [...out];
  }

  /**
   * Re-seat bound arrows (and optionally re-wrap labels) after `ids` changed.
   *
   *   silent  keep it out of the undo stack entirely — the caller is mid-gesture
   *           and records the whole drag as one step when the finger lifts.
   *   merge   fold it into the step that just went on the stack. Anything that
   *           calls history.run() and then syncs MUST use this, or one undo
   *           takes back the consequence and leaves the cause behind.
   */
  syncBindings(ids, { silent = false, layout = false, merge = false } = {}) {
    const steps = [];
    const arrows = bindingUpdates(this.scene, ids);
    if (arrows) steps.push(Actions.update(arrows.elementIds, arrows.changes));
    if (layout) {
      const labels = containerUpdates(this.scene, [...ids, ...(arrows?.elementIds || [])], this.measureLine);
      if (labels) steps.push(Actions.update(labels.elementIds, labels.changes));
    }
    if (!steps.length) return null;
    const action = steps.length === 1 ? steps[0] : Actions.batch(steps);
    if (silent) return this.history.runSilent(action);
    if (merge) {
      const result = this.history.runSilent(action);
      this.history.mergeIntoLast(result.undo, action);
      return result;
    }
    return this.history.run(action);
  }

  /** Start a label inside a shape, creating the text element if there is none. */
  addBoundText(container) {
    const existingId = boundTextIdOf(container);
    const existing = existingId ? this.scene.get(existingId) : null;
    if (existing && !existing.isDeleted) {
      this.editText(existing);
      return existing;
    }
    const text = createElement("text", {
      ...this.styleForNew("text"),
      containerId: container.id,
      textAlign: "center",
      verticalAlign: "middle",
      autoResize: false,
      x: container.x,
      y: container.y,
      width: 0,
      height: (this.style.fontSize || 20) * 1.25,
    });
    // Deliberately NOT added to the scene yet. Tapping a box and changing your
    // mind must leave no element and no undo step behind — adding first and
    // deleting on cancel leaves a tombstone and a dangling boundElements entry.
    this.editText(text, { isNew: true, container });
    return text;
  }

  /* ------------------------------------------------------------------ links */

  linkBadgeAtPoint(x, y) {
    const radius = 12 / this.viewport.zoom;
    const elements = this.scene.visible();
    for (let i = elements.length - 1; i >= 0; i -= 1) {
      const element = elements[i];
      if (!element.link || element.containerId) continue;
      const box = worldBounds(element);
      if (Math.hypot(x - (box.x + box.width), y - box.y) <= radius) return element;
    }
    return null;
  }

  openLink(element) {
    // A double tap on the badge is one intent, not two.
    const now = Date.now();
    if (this.lastLink && this.lastLink.id === element?.id && now - this.lastLink.at < 700) return;
    this.lastLink = { id: element?.id, at: now };
    // Validated again here, not just when it was typed: the value may have
    // arrived from an imported file (search.js).
    const href = safeLink(element?.link);
    if (!href) {
      toast("That link is not a web address slate will open.", { tone: "warn" });
      return;
    }
    window.open(href, "_blank", "noopener,noreferrer");
  }

  async editLink() {
    const [element] = this.selectedElements().filter((item) => !item.containerId);
    if (!element) return;
    const value = await promptDialog({
      title: element.link ? "Edit link" : "Add link",
      label: "Web address",
      value: element.link || "",
      confirmLabel: "Save",
    });
    if (value === null) return;
    const href = normaliseLinkInput(value);
    if (value.trim() && !href) {
      toast("Only http and https links can be added.", { tone: "warn", timeout: 5000 });
      return;
    }
    this.history.run(Actions.update([element.id], { link: href }));
    this.markStatic();
    this.requestRender();
    this.refreshProps();
    this.scheduleSave();
  }

  /* ------------------------------------------------------ arrange operations */

  /** Every arrange action shares this: run it, then repaint and save. */
  runPatch(patch, message) {
    if (!patch) return false;
    this.history.run(Actions.update(patch.elementIds, patch.changes));
    this.syncBindings(patch.elementIds, { layout: true, merge: true });
    this.markStatic();
    this.requestRender();
    this.refreshProps();
    this.scheduleSave();
    if (message) toast(message);
    return true;
  }

  groupSelection() {
    if (this.refuseDuringGesture()) return;
    const ids = this.selectedElements()
      .filter((element) => !element.containerId)
      .map((element) => element.id);
    if (ids.length < 2) {
      toast("Select two or more things to group.", { tone: "warn" });
      return;
    }
    const patch = groupPatch(this.scene, ids);
    if (!patch) return;
    this.history.run(Actions.update(patch.elementIds, patch.changes));
    this.setSelection(expandSelection(this.scene, patch.elementIds));
    this.markStatic();
    this.requestRender();
    this.scheduleSave();
    toast(`Grouped ${patch.elementIds.length} items.`);
  }

  ungroupSelection() {
    if (this.refuseDuringGesture()) return;
    const ids = this.selectedElements().map((element) => element.id);
    const patch = ungroupPatch(this.scene, ids);
    if (!patch) {
      toast("Nothing in the selection is grouped.", { tone: "warn" });
      return;
    }
    this.runPatch(patch, "Ungrouped.");
  }

  setLocked(locked) {
    if (this.refuseDuringGesture()) return;
    const ids = this.selectedElements().map((element) => element.id);
    const patch = lockPatch(this.scene, withBoundText(this.scene, ids), locked);
    if (!patch) return;
    this.history.run(Actions.update(patch.elementIds, patch.changes));
    if (locked) this.setSelection(new Set());
    this.markStatic();
    this.requestRender();
    this.refreshProps();
    this.scheduleSave();
    toast(locked ? "Locked — tap Menu → Unlock all to release." : "Unlocked.");
  }

  unlockAll() {
    if (this.refuseDuringGesture()) return;
    const ids = this.scene.visible().filter((element) => element.locked).map((element) => element.id);
    if (!ids.length) {
      toast("Nothing on this board is locked.");
      return;
    }
    const patch = lockPatch(this.scene, ids, false);
    this.history.run(Actions.update(patch.elementIds, patch.changes));
    this.setSelection(new Set(ids.filter((id) => !this.scene.get(id)?.containerId)));
    this.markStatic();
    this.requestRender();
    this.refreshProps();
    this.scheduleSave();
    toast(`Unlocked ${ids.length} item${ids.length === 1 ? "" : "s"}.`);
  }

  align(mode) {
    if (this.refuseDuringGesture()) return;
    const ids = this.selectedElements().map((element) => element.id);
    const patch = alignPatch(this.scene, ids, mode);
    if (!patch) {
      toast("Select two or more things to align.", { tone: "warn" });
      return;
    }
    this.runPatch(patch);
  }

  distribute(axis) {
    if (this.refuseDuringGesture()) return;
    const ids = this.selectedElements().map((element) => element.id);
    const patch = distributePatch(this.scene, ids, axis);
    if (!patch) {
      toast("Select three or more things to distribute.", { tone: "warn" });
      return;
    }
    this.runPatch(patch);
  }

  flip(axis) {
    if (this.refuseDuringGesture()) return;
    const ids = this.selectedElements().map((element) => element.id);
    const patch = flipPatch(this.scene, withBoundText(this.scene, ids), axis);
    if (!patch) return;
    this.runPatch(patch);
  }

  /* ----------------------------------------------------------- clipboard */

  async copySelection({ cut = false } = {}) {
    if (cut && this.refuseDuringGesture()) return;
    const elements = this.selectedElements();
    if (!elements.length) return;
    const boardAtCopy = this.boardEpoch;
    const full = withBoundText(this.scene, elements.map((element) => element.id))
      .map((id) => this.scene.get(id))
      .filter(Boolean);
    const where = await writeElements(full, this.files);
    if (cut) {
      // Cut deletes AFTER an await. If the board changed underneath, deleting
      // by id on the new board is at best a no-op and at worst the wrong
      // elements — the copy already succeeded, so stop at that.
      if (this.boardEpoch !== boardAtCopy) {
        toast("The board changed while copying — the items were copied, not cut.", { tone: "warn" });
        return;
      }
      this.deleteElements(elements.map((element) => element.id));
      this.setSelection(new Set());
    }
    toast(where === "system"
      ? `${cut ? "Cut" : "Copied"} ${full.length} item${full.length === 1 ? "" : "s"}.`
      : `${cut ? "Cut" : "Copied"} inside slate — this browser would not give up the system clipboard.`);
  }

  async paste(at) {
    if (this.refuseDuringGesture()) return;
    const boardAtRead = this.boardEpoch;
    const payload = await readElements();
    if (!payload) {
      toast("Nothing to paste.", { tone: "warn" });
      return;
    }
    // Reading the system clipboard can sit behind a permission prompt that
    // leaves the page fully usable, so the board can change mid-read.
    if (this.boardEpoch !== boardAtRead) {
      toast("The board changed while the clipboard was being read — nothing was pasted.", { tone: "warn" });
      return;
    }
    const rect = this.dom.canvasHost.getBoundingClientRect();
    const centre = at || screenToWorld(rect.width / 2, rect.height / 2, this.viewport);
    const target = Array.isArray(centre) ? { x: centre[0], y: centre[1] } : centre;

    if (!payload.elements.length && payload.text) {
      const element = createElement("text", {
        ...this.styleForNew("text"),
        x: target.x,
        y: target.y,
        text: payload.text,
        originalText: payload.text,
      });
      const layout = this.measureLine;
      const lines = payload.text.split("\n");
      element.width = Math.ceil(Math.max(...lines.map((line) => layout(line || " ", element))));
      element.height = Math.ceil(lines.length * element.fontSize * 1.25);
      this.addElements([element]);
      this.setSelection(new Set([element.id]));
      toast("Pasted text.");
      return;
    }

    const box = boundsOfMany(payload.elements.filter((element) => !element.isDeleted));
    const copies = materialise(payload.elements, {
      offsetX: box ? target.x - (box.x + box.width / 2) : 0,
      offsetY: box ? target.y - (box.y + box.height / 2) : 0,
    });
    if (payload.files && Object.keys(payload.files).length) {
      this.files = { ...this.files, ...payload.files };
      setFileSource(this.files);
    }
    this.addElements(copies);
    this.setSelection(new Set(copies.filter((element) => !element.containerId).map((element) => element.id)));
    toast(`Pasted ${copies.length} item${copies.length === 1 ? "" : "s"}.`);
  }

  copySelectionStyles() {
    const [element] = this.selectedElements().filter((item) => !item.containerId);
    if (!element) return;
    copyStyles(element);
    toast("Style copied — select something else and paste it.");
  }

  pasteSelectionStyles() {
    const style = pasteStyles();
    const ids = this.selectedElements().map((element) => element.id);
    if (!style || !ids.length) {
      toast("Copy a style first.", { tone: "warn" });
      return;
    }
    this.history.run(Actions.update(ids, style));
    this.syncBindings(ids, { layout: true, merge: true });
    this.markStatic();
    this.requestRender();
    this.refreshProps();
    this.scheduleSave();
    toast("Style applied.");
  }

  async copyImageToClipboard(kind) {
    const elements = this.selectedElements().length
      ? withBoundText(this.scene, this.selectedElements().map((element) => element.id)).map((id) => this.scene.get(id))
      : this.scene.visible();
    if (!elements.length) {
      toast("Nothing to copy.", { tone: "warn" });
      return;
    }
    try {
      await ensureImagesReady(elements);
      const blob = kind === "svg"
        ? await exportSVG(elements, { withBackground: true, background: this.background, dark: false })
        : (await exportPNG(elements, { scale: 2, withBackground: true, background: this.background, dark: false })).blob;
      await writeImageBlob(blob);
      toast(`${kind.toUpperCase()} copied to the clipboard.`);
    } catch (error) {
      toast(error.message || "Could not copy that image.", { tone: "error", timeout: 7000 });
    }
  }

  /* -------------------------------------------------------------- images */

  async insertImageAt(x, y) {
    const boardAtPick = this.boardEpoch;
    const file = await pickFile({ accept: IMAGE_ACCEPT });
    if (!file) { this.selectTool("selection"); return; }
    // The picker is async and the user can switch boards while it is open —
    // dropping the photo onto whatever board happens to be open now would put
    // it somewhere they never chose.
    if (this.boardEpoch !== boardAtPick) {
      toast("The board changed while the picker was open — the image was not added.", { tone: "warn" });
      this.selectTool("selection");
      return;
    }
    {
      try {
        const result = await readImageFile(file);
        // Decoding, downscaling and hashing a phone photo takes long enough for
        // a board switch to land in the middle of it — the picker guard above
        // only covers the wait before this one.
        if (this.boardEpoch !== boardAtPick) {
          toast("The board changed while the image was being prepared — it was not added.", { tone: "warn" });
          this.selectTool("selection");
          return;
        }
        this.files = { ...this.files, [result.fileId]: result.entry };
        setFileSource(this.files);
        const element = createImageElement({
          fileId: result.fileId,
          width: result.width,
          height: result.height,
          x,
          y,
          maxWidth: Math.min(480, this.visibleWorldBox().width * 0.6),
        });
        this.addElements([element]);
        this.setSelection(new Set([element.id]));
        this.selectTool("selection");
        if (result.shrunk) {
          toast("Image added — it was made smaller so the board stays inside this device's storage.", { timeout: 6000 });
        } else {
          toast("Image added.");
        }
      } catch (error) {
        const message = error instanceof ImageError ? error.message : "That image could not be added.";
        toast(message, { tone: "error", timeout: 7000 });
        this.selectTool("selection");
      }
    }
  }

  /**
   * Drop image data no element points at any more.
   * Tombstones count as users: an erased photo has to survive until the undo
   * history that could bring it back is gone with the session.
   */
  pruneFiles() {
    const used = usedFileIds(this.scene.all());
    let changed = false;
    const next = {};
    for (const [id, entry] of Object.entries(this.files)) {
      if (used.has(id)) next[id] = entry; else changed = true;
    }
    if (!changed) return;
    this.files = next;
    setFileSource(this.files);
  }

  /* -------------------------------------------------------------- text edit */

  isTextEditing() {
    return !!this.editing;
  }

  editText(element, { isNew = false, container = null } = {}) {
    this.commitText();
    const textarea = el("textarea", "text-editor", {
      "aria-label": "Text",
      spellcheck: "false",
      autocapitalize: "sentences",
    });
    // A label edits the text as TYPED, never the wrapped copy — otherwise every
    // edit would bake the current line breaks into the source (containers.js).
    textarea.value = (element.containerId ? element.originalText : element.text) || "";
    this.dom.canvasHost.appendChild(textarea);
    const host = container || (element.containerId ? this.scene.get(element.containerId) : null);
    this.editing = { element, textarea, isNew, container: host, composing: false };

    // Korean IME: while composing, Enter and Escape belong to the IME.
    // These can fire AFTER commitText() has already cleared this.editing —
    // blurring mid-composition does exactly that — so they must not assume it.
    textarea.addEventListener("compositionstart", () => { if (this.editing) this.editing.composing = true; });
    textarea.addEventListener("compositionend", () => { if (this.editing) this.editing.composing = false; });
    textarea.addEventListener("input", () => this.positionEditor());
    textarea.addEventListener("keydown", (event) => {
      if (event.isComposing || event.keyCode === 229 || this.editing?.composing) return;
      if (event.key === "Escape") {
        event.preventDefault();
        this.commitText();
      } else if (event.key === "Enter" && (event.metaKey || event.ctrlKey)) {
        event.preventDefault();
        this.commitText();
      }
    });
    textarea.addEventListener("blur", () => this.commitText());

    this.markStatic();
    this.positionEditor();
    this.requestRender();
    setTimeout(() => textarea.focus({ preventScroll: true }), 10);
  }

  positionEditor() {
    if (!this.editing) return;
    const { element, textarea, container } = this.editing;
    const fontSize = element.fontSize || 20;
    const lineHeight = element.lineHeight || 1.25;
    const displaySize = fontSize * this.viewport.zoom;
    // The textarea stays at 16px so iOS never auto-zooms the page, and a CSS
    // transform scales it to the size the drawing actually shows. Setting
    // font-size to displaySize directly would trip iOS's <16px rule as soon as
    // the canvas is zoomed out (Build_Plan 7-1).
    const scale = displaySize / 16;

    let worldX = element.x;
    let worldY = element.y;
    let cssWidth = null;
    let align = element.textAlign || "left";
    let lineCount = textarea.value.split("\n").length;

    if (container && !container.isDeleted) {
      // Inside a shape the editor occupies the same box the wrapped text will,
      // so what is typed sits exactly where it will land.
      const usable = usableWidth(container);
      const box = localBounds(container);
      const wrapped = wrapText(textarea.value, usable, (line) => this.measureLine(line || " ", element));
      lineCount = Math.max(1, wrapped.length);
      const height = lineCount * fontSize * lineHeight;
      worldX = box.x + (Math.abs(box.width) - usable) / 2;
      worldY = box.y + (Math.abs(box.height) - height) / 2;
      // World units → the textarea's own 16px coordinate space.
      cssWidth = (usable * 16) / fontSize;
      align = "center";
    }

    const [screenX, screenY] = [
      (worldX + this.viewport.scrollX) * this.viewport.zoom,
      (worldY + this.viewport.scrollY) * this.viewport.zoom,
    ];

    textarea.style.left = `${screenX}px`;
    textarea.style.top = `${screenY}px`;
    textarea.style.fontSize = "16px";
    textarea.style.lineHeight = String(lineHeight);
    textarea.style.fontFamily = fontStackFor(element.fontFamily);
    textarea.style.color = displayColor(element.strokeColor, this.isDark());
    textarea.style.textAlign = align;
    textarea.style.transform = `scale(${scale})`;
    textarea.style.transformOrigin = "left top";
    if (cssWidth) {
      textarea.style.width = `${Math.max(32, cssWidth)}px`;
      textarea.style.whiteSpace = "pre-wrap";
    } else {
      const columns = Math.max(6, ...textarea.value.split("\n").map((line) => line.length + 1));
      textarea.style.width = `${columns}ch`;
      textarea.style.whiteSpace = "pre";
    }
    textarea.style.height = `${lineCount * 16 * lineHeight + 6}px`;
  }

  commitText() {
    const editing = this.editing;
    if (!editing) return;
    this.editing = null;
    const { element, textarea, isNew, container } = editing;
    const text = textarea.value;
    textarea.remove();

    if (container) {
      this.commitBoundText(editing, text);
      return;
    }

    if (!text.trim()) {
      // A new element was never added, so there is nothing to take back. An
      // existing one that has been emptied is removed: an invisible,
      // unselectable text element is a trap on the canvas.
      if (!isNew) this.history.run(Actions.delete([element.id]));
    } else {
      const ctx = this.renderer.layers.static.ctx;
      ctx.save();
      ctx.font = `${element.fontSize}px ${fontStackFor(element.fontFamily)}`;
      const lines = text.split("\n");
      let width = 0;
      for (const line of lines) width = Math.max(width, ctx.measureText(line || " ").width);
      ctx.restore();
      const height = lines.length * element.fontSize * (element.lineHeight || 1.25);
      const changes = {
        text,
        // originalText must move with text or excalidraw.com shows the old
        // string when the file is reopened there (Build_Plan 5-1).
        originalText: text,
        width: Math.ceil(width),
        height: Math.ceil(height),
      };
      if (isNew) {
        this.history.run(Actions.add([{ ...element, ...changes }]));
      } else {
        this.history.run(Actions.update([element.id], changes));
      }
      this.setSelection(new Set([element.id]));
    }
    this.markStatic();
    this.requestRender();
    this.refreshProps();
    this.scheduleSave();
  }

  /** The label branch of commitText — wrapping, and growing the host to fit. */
  commitBoundText({ element, isNew, container }, text) {
    const host = this.scene.get(container.id);
    // The host can be deleted while its label is being typed. Adding the label
    // anyway leaves a text element pointing at a tombstone: elementAt() skips
    // past it, so it can never be selected, moved or deleted again.
    if (!host || host.isDeleted) {
      if (!isNew) this.history.run(Actions.delete([element.id]));
      this.markStatic();
      this.requestRender();
      return;
    }
    const emptied = !text.trim();

    if (isNew && emptied) {
      // Never added to the scene, so there is nothing to take back out.
      this.markStatic();
      this.requestRender();
      return;
    }

    if (emptied) {
      this.history.run(Actions.batch([
        Actions.delete([element.id]),
        Actions.update([host.id], { boundElements: withoutBound(host, element.id) }),
      ]));
    } else {
      const draft = { ...element, text, originalText: text };
      const layout = layoutBoundText(host, draft, this.measureLine);
      const steps = [];
      if (isNew) {
        steps.push(Actions.add([{ ...draft, ...layout.text }]));
        steps.push(Actions.update([host.id], {
          boundElements: withBound(host, element.id, "text"),
        }));
      } else {
        steps.push(Actions.update([element.id], { originalText: text, ...layout.text }));
      }
      if (layout.container) steps.push(Actions.update([host.id], layout.container));
      this.history.run(steps.length === 1 ? steps[0] : Actions.batch(steps));
      // The host may have grown; anything attached to it has to follow — as
      // part of the SAME undo step, not a second one.
      this.syncBindings([host.id], { layout: true, merge: true });
      this.setSelection(new Set([host.id]));
    }

    this.markStatic();
    this.requestRender();
    this.refreshProps();
    this.scheduleSave();
  }

  /* ------------------------------------------------------------------ save */

  setSaveState(state) {
    this.saveState = state;
    if (!this.dom) return;
    const labels = { saved: "Saved", saving: "Saving…", dirty: "Not saved", error: "Not saved" };
    this.dom.status.textContent = labels[state] || "";
    this.dom.status.dataset.state = state;
  }

  scheduleSave() {
    if (!this.board) return;
    this.setSaveState("dirty");
    clearTimeout(this.saveTimer);
    // Debounced so nothing is written mid-stroke.
    this.saveTimer = setTimeout(() => this.saveNow(), SAVE_DEBOUNCE);
  }

  /**
   * A short digest of what is on the board, used only to tell a real edit from
   * a viewport-only save.
   *
   * Two things matter here. It returns null when the journal is off — which is
   * the default — so nobody pays for a feature they never turned on. And it
   * keeps a digest rather than the JSON: a 2000-element freehand board is
   * nearly 4 MB of text, and holding that for the whole session while
   * re-comparing it on every save costs far more than the flag it produces.
   */
  contentFingerprint({ elements, background, files }) {
    if (!journal.isJournalEnabled()) return null;
    const text = JSON.stringify([elements, background, Object.keys(files || {}).sort()]);
    let hash = 0x811c9dc5;
    for (let i = 0; i < text.length; i += 1) {
      hash ^= text.charCodeAt(i);
      hash = Math.imul(hash, 0x01000193) >>> 0;
    }
    return `${text.length}:${hash.toString(16)}`;
  }

  async saveNow({ blocking = false } = {}) {
    if (!this.board) return;
    clearTimeout(this.saveTimer);
    if (!blocking) this.setSaveState("saving");
    // Images whose element is gone for good would otherwise stay in storage
    // for ever. Tombstoned elements still count as users, so undo still works.
    this.pruneFiles();
    const payload = {
      elements: this.scene.toJSON(),
      appState: {
        scrollX: this.viewport.scrollX,
        scrollY: this.viewport.scrollY,
        zoom: this.viewport.zoom,
        viewBackgroundColor: this.background,
        gridSize: this.grid.enabled ? this.grid.size : null,
        objectsSnapModeEnabled: this.snapToObjects,
      },
      files: this.files,
    };
    const nextFingerprint = this.contentFingerprint({
      elements: payload.elements,
      background: payload.appState.viewBackgroundColor,
      files: payload.files,
    });
    const contentChanged = this.journalContentFingerprint !== null && nextFingerprint !== this.journalContentFingerprint;
    try {
      this.board = await saveBoard(this.board, payload);
      this.journalContentFingerprint = nextFingerprint;
      this.setSaveState("saved");
      if (contentChanged) journal.recordActivity(this.board, "edited", { at: this.board.updatedAt }).catch(() => {});
    } catch (error) {
      // Never fail silently: a full quota or an IndexedDB error means the
      // drawing only exists in memory, and the user needs to know now.
      this.setSaveState("error");
      toast("Could not save. Export a backup now — Menu → Backup.", { tone: "error", timeout: 10000 });
      console.warn("[slate] save failed:", error?.message || error);
    }
  }

  /* -------------------------------------------------------------- search */

  openSearch() {
    let input = null;
    const dialog = openDialog({
      title: "Find on this board",
      build: (body, close) => {
        const field = el("label", "field");
        field.appendChild(el("span", "field-label", { text: "Text to find" }));
        input = el("input", "input", { type: "text", value: this.search?.query || "" });
        field.appendChild(input);
        body.appendChild(field);

        const count = el("p", "dialog-note", { text: "Type to search." });
        body.appendChild(count);

        const run = () => {
          const matches = findMatches(this.scene.visible(), input.value, this.measureLine);
          this.search = matches.length
            ? { query: input.value, matches, active: 0 }
            : { query: input.value, matches: [], active: -1 };
          count.textContent = input.value.trim()
            ? (matches.length ? `${matches.length} match${matches.length === 1 ? "" : "es"}.` : "No matches.")
            : "Type to search.";
          this.renderer.markOverlayDirty();
          this.requestRender();
          if (matches.length) this.goToMatch(0);
        };

        // Korean IME: recompute on composition end, not on every keystroke
        // while a syllable is still being assembled.
        input.addEventListener("input", () => { if (!input.composing) run(); });
        input.addEventListener("compositionstart", () => { input.composing = true; });
        input.addEventListener("compositionend", () => { input.composing = false; run(); });
        input.addEventListener("keydown", (event) => {
          if (event.key !== "Enter" || event.isComposing || event.keyCode === 229) return;
          event.preventDefault();
          this.stepMatch(event.shiftKey ? -1 : 1);
        });

        const row = el("div", "dialog-actions");
        const previous = el("button", "button", { type: "button", text: "Previous" });
        const next = el("button", "button", { type: "button", text: "Next" });
        const done = el("button", "button button-primary", { type: "button", text: "Done" });
        previous.addEventListener("click", () => this.stepMatch(-1));
        next.addEventListener("click", () => this.stepMatch(1));
        done.addEventListener("click", close);
        row.appendChild(previous);
        row.appendChild(next);
        row.appendChild(done);
        body.appendChild(row);
        if (input.value) run();
      },
      onClose: () => {
        this.search = null;
        this.renderer.markOverlayDirty();
        this.requestRender();
      },
    });
    return dialog;
  }

  stepMatch(direction) {
    if (!this.search?.matches?.length) return;
    const total = this.search.matches.length;
    const next = ((this.search.active + direction) % total + total) % total;
    this.goToMatch(next);
  }

  goToMatch(index) {
    const hit = this.search?.matches?.[index];
    if (!hit) return;
    this.search.active = index;
    const rect = this.dom.canvasHost.getBoundingClientRect();
    const box = hit.box;
    this.setViewport({
      scrollX: rect.width / (2 * this.viewport.zoom) - (box.x + box.width / 2),
      scrollY: rect.height / (2 * this.viewport.zoom) - (box.y + box.height / 2),
    });
    this.renderer.markOverlayDirty();
    this.requestRender();
  }

  /* ------------------------------------------------------------- library */

  async openLibrary() {
    const items = await loadLibrary();
    openDialog({
      title: "Shape library",
      wide: true,
      build: (body, close) => {
        const selected = this.selectedElements().filter((element) => !element.containerId);
        const actions = el("div", "dialog-actions");
        const add = el("button", "button button-primary", {
          type: "button", text: `Add selection (${selected.length})`,
        });
        add.disabled = !selected.length;
        add.addEventListener("click", async () => {
          close();
          await this.addSelectionToLibrary();
        });
        const importButton = el("button", "button", { type: "button", text: "Import…" });
        importButton.addEventListener("click", () => { close(); this.importLibrary(); });
        const exportButton = el("button", "button", { type: "button", text: "Export…" });
        exportButton.disabled = !items.length;
        exportButton.addEventListener("click", async () => { close(); await this.exportLibrary(items); });
        actions.appendChild(importButton);
        actions.appendChild(exportButton);
        actions.appendChild(add);
        body.appendChild(actions);

        if (!items.length) {
          body.appendChild(el("p", "dialog-text", {
            text: "Nothing saved yet. Select some shapes on the canvas and choose “Add selection” to keep them here.",
          }));
          return;
        }

        const list = el("div", "library-list");
        for (const item of items) {
          const row = el("div", "library-row");
          const insert = el("button", "library-insert", { type: "button" });
          insert.appendChild(el("span", "library-name", {
            text: item.name || `${item.elements.length} shape${item.elements.length === 1 ? "" : "s"}`,
          }));
          insert.appendChild(el("span", "library-meta", {
            text: `${item.elements.length} element${item.elements.length === 1 ? "" : "s"}`,
          }));
          insert.addEventListener("click", () => {
            close();
            this.insertLibraryItem(item);
          });
          row.appendChild(insert);

          const remove = el("button", "icon-button", {
            type: "button", "aria-label": `Remove ${item.name || "item"}`, html: svgIcon("close", 18),
          });
          remove.addEventListener("click", async () => {
            const rest = items.filter((entry) => entry.id !== item.id);
            await saveLibrary(rest);
            close();
            toast("Removed from the library.");
          });
          row.appendChild(remove);
          list.appendChild(row);
        }
        body.appendChild(list);
      },
    });
  }

  async addSelectionToLibrary() {
    const ids = this.selectedElements().map((element) => element.id);
    const elements = withBoundText(this.scene, ids).map((id) => this.scene.get(id)).filter(Boolean);
    if (!elements.length) return;
    const name = await promptDialog({
      title: "Save to library", label: "Name (optional)", value: "", confirmLabel: "Save",
    });
    // null is Cancel; "" is Save with the name left blank, which is allowed
    // here. They were the same value until promptDialog learned to tell them
    // apart, so Cancel used to save an unnamed item.
    if (name === null) return;
    const items = await loadLibrary();
    await saveLibrary([makeItem(elements, name || "", this.files), ...items]);
    toast("Saved to the library.");
  }

  insertLibraryItem(item) {
    const rect = this.dom.canvasHost.getBoundingClientRect();
    const [cx, cy] = screenToWorld(rect.width / 2, rect.height / 2, this.viewport);
    const { elements, files } = instantiate(item, cx, cy);
    // Images are stored per board, so an item carrying one has to bring its
    // bytes across or it lands as an empty frame.
    if (files && Object.keys(files).length) {
      this.files = { ...this.files, ...files };
      setFileSource(this.files);
    }
    this.addElements(elements);
    this.setSelection(new Set(elements.filter((element) => !element.containerId).map((element) => element.id)));
    toast(`Inserted ${elements.length} element${elements.length === 1 ? "" : "s"}.`);
  }

  async exportLibrary(items) {
    const blob = new Blob([JSON.stringify(libraryFile(items))], { type: "application/json" });
    await shareOrDownload(blob, safeFilename("library", "excalidrawlib"));
    toast("Library exported.");
  }

  async importLibrary() {
    const file = await pickFile({ accept: ".excalidrawlib,application/json,.json" });
    if (!file) return;
    {
      try {
        const incoming = parseLibraryFile(await file.text());
        const existing = await loadLibrary();
        const merged = mergeItems(existing, incoming);
        await saveLibrary(merged);
        toast(`Added ${merged.length - existing.length} library item${merged.length - existing.length === 1 ? "" : "s"}.`);
      } catch (error) {
        const message = error instanceof LibraryError ? error.message : "Could not read that library file.";
        toast(message, { tone: "error", timeout: 7000 });
      }
    }
  }

  /* -------------------------------------------------------- context menu */

  openContextMenu(world, screen) {
    if (this.editing) this.commitText();
    const hit = this.elementAt(world.x, world.y, this.hitThreshold(world));
    if (hit && !this.selection.has(hit.id)) {
      this.setSelection(expandSelection(this.scene, [hit.id]));
    }
    const selected = this.selectedElements().filter((element) => !element.containerId);
    const single = selected.length === 1 ? selected[0] : null;
    const grouped = selected.some((element) => outerGroupId(element));

    const items = [];
    if (selected.length) {
      items.push({ label: "Cut", hint: "⌘X", onSelect: () => this.copySelection({ cut: true }) });
      items.push({ label: "Copy", hint: "⌘C", onSelect: () => this.copySelection() });
    }
    items.push({ label: "Paste", hint: "⌘V", onSelect: () => this.paste(world) });

    if (selected.length) {
      items.push({ separator: true });
      items.push({ label: "Duplicate", hint: "⌘D", onSelect: () => this.duplicateSelection() });
      if (single && canHoldText(single)) {
        items.push({
          label: boundTextIdOf(single) ? "Edit label" : "Add label",
          onSelect: () => this.addBoundText(this.scene.get(single.id)),
        });
      }
      items.push({
        label: single?.link ? "Edit link" : "Add link",
        onSelect: () => this.editLink(),
        disabled: !single,
      });
      items.push({ separator: true });
      items.push({ label: "Copy styles", onSelect: () => this.copySelectionStyles(), disabled: !single });
      items.push({ label: "Paste styles", onSelect: () => this.pasteSelectionStyles(), disabled: !hasStyleBuffer() });
      items.push({ separator: true });
      if (selected.length > 1) {
        items.push({ label: "Group", hint: "⌘G", onSelect: () => this.groupSelection() });
      }
      if (grouped) {
        items.push({ label: "Ungroup", hint: "⇧⌘G", onSelect: () => this.ungroupSelection() });
      }
      items.push({ label: "Lock", onSelect: () => this.setLocked(true) });
      items.push({ separator: true });
      items.push({ label: "Bring to front", onSelect: () => this.reorderSelection("front") });
      items.push({ label: "Send to back", onSelect: () => this.reorderSelection("back") });
      items.push({ separator: true });
      items.push({
        label: "Delete",
        hint: "⌫",
        danger: true,
        onSelect: () => this.deleteSelection(selected.map((element) => element.id)),
      });
    } else {
      items.push({ separator: true });
      items.push({ label: "Select all", hint: "⌘A", onSelect: () => this.selectAll() });
      items.push({ label: this.grid.enabled ? "Hide grid" : "Show grid", hint: "⌘'", onSelect: () => this.toggleGrid() });
      items.push({ label: "Zoom to fit", hint: "⇧1", onSelect: () => this.scrollBackToContent() });
    }

    openContextMenu({ x: screen.clientX, y: screen.clientY, items });
  }

  reorderSelection(to) {
    if (this.refuseDuringGesture()) return;
    const ids = this.selectedElements().map((element) => element.id);
    if (!ids.length) return;
    this.history.run(Actions.reorder(ids, to));
    this.markStatic();
    this.requestRender();
    this.scheduleSave();
  }

  selectAll() {
    const ids = this.scene.visible()
      .filter((element) => !element.locked && !element.containerId)
      .map((element) => element.id);
    this.setSelection(expandSelection(this.scene, ids));
  }

  zoomToSelection() {
    const elements = this.selectedElements();
    if (!elements.length) {
      this.scrollBackToContent();
      return;
    }
    const box = boundsOfMany(elements);
    const rect = this.dom.canvasHost.getBoundingClientRect();
    const margin = 60;
    const zoom = clamp(Math.min(
      (rect.width - margin * 2) / Math.max(box.width, 1),
      (rect.height - margin * 2) / Math.max(box.height, 1),
    ), 0.1, 4);
    this.setViewport({
      zoom,
      scrollX: rect.width / (2 * zoom) - (box.x + box.width / 2),
      scrollY: rect.height / (2 * zoom) - (box.y + box.height / 2),
    });
    this.scheduleSave();
  }

  /** Double tap: edit a label, or start one on a shape that has none. */
  handleDoubleTap(event) {
    if (this.tapConsumed) return false;
    if (this.activeTool.id !== "selection" || this.editing) return false;
    const now = Date.now();
    const previous = this.lastTap;
    this.lastTap = { x: event.x, y: event.y, at: now };
    if (!previous) return false;
    const near = Math.hypot(event.x - previous.x, event.y - previous.y) * this.viewport.zoom < 16;
    if (now - previous.at > 320 || !near) return false;
    this.lastTap = null;

    const threshold = this.hitThreshold(event);
    const hit = this.elementAt(event.x, event.y, threshold);
    if (hit?.type === "text" && !hit.containerId) {
      this.editText(hit);
      return true;
    }
    const container = hit && canHoldText(hit) ? hit : this.containerAt(event.x, event.y, threshold);
    if (container) {
      this.addBoundText(container);
      return true;
    }
    return false;
  }

  /**
   * A shape that can hold text, hit as if it were filled.
   * Selecting an unfilled box still needs its outline — that is the original's
   * rule and changing it would make overlapping shapes unpickable. But putting
   * text IN one is a different intent, and the inside is the obvious target.
   */
  containerAt(x, y, threshold) {
    const elements = this.scene.visible();
    for (let i = elements.length - 1; i >= 0; i -= 1) {
      const element = elements[i];
      if (!canHoldText(element)) continue;
      if (entryFor(element.type).hitTest({ ...element, backgroundColor: "#fill" }, x, y, threshold)) {
        return element;
      }
    }
    return null;
  }

  /* -------------------------------------------------------------- shortcuts */

  onKeyDown(event, typing) {
    if (typing || anyDialogOpen() || contextMenuOpen()) return;
    const meta = event.metaKey || event.ctrlKey;

    if (meta && event.key.toLowerCase() === "z") {
      event.preventDefault();
      if (event.shiftKey) this.redo(); else this.undo();
      return;
    }
    if (meta && event.key.toLowerCase() === "y") {
      event.preventDefault();
      this.redo();
      return;
    }
    if (meta && event.key.toLowerCase() === "a") {
      event.preventDefault();
      this.selectAll();
      return;
    }
    if (meta && event.key.toLowerCase() === "d") {
      event.preventDefault();
      this.duplicateSelection();
      return;
    }
    if (meta && event.key.toLowerCase() === "g") {
      event.preventDefault();
      if (event.shiftKey) this.ungroupSelection(); else this.groupSelection();
      return;
    }
    if (meta && event.key.toLowerCase() === "c") {
      event.preventDefault();
      this.copySelection();
      return;
    }
    if (meta && event.key.toLowerCase() === "x") {
      event.preventDefault();
      this.copySelection({ cut: true });
      return;
    }
    if (meta && event.key.toLowerCase() === "v") {
      event.preventDefault();
      this.paste();
      return;
    }
    if (meta && event.key.toLowerCase() === "f") {
      event.preventDefault();
      this.openSearch();
      return;
    }
    if (meta && event.key === "'") {
      event.preventDefault();
      this.toggleGrid();
      return;
    }
    if (meta && (event.key === "]" || event.key === "[")) {
      event.preventDefault();
      this.reorderSelection(event.key === "]"
        ? (event.shiftKey ? "front" : "forward")
        : (event.shiftKey ? "back" : "backward"));
      return;
    }
    if (meta) return;

    if (event.key === "Delete" || event.key === "Backspace") {
      if (!this.selection.size) return;
      event.preventDefault();
      this.deleteSelection();
      return;
    }
    if (event.key === "Escape") {
      this.activeTool.onCancel?.(this);
      this.setSelection(new Set());
      return;
    }
    if (event.key === "Enter" && this.selection.size >= 1) {
      const [element] = this.selectedElements().filter((item) => !item.containerId);
      if (element?.type === "text") {
        event.preventDefault();
        this.editText(element);
        return;
      }
      if (canHoldText(element)) {
        event.preventDefault();
        this.addBoundText(element);
      }
      return;
    }
    if (event.shiftKey && (event.key === "1" || event.key === "!")) {
      event.preventDefault();
      this.scrollBackToContent();
      return;
    }
    if (event.shiftKey && (event.key === "2" || event.key === "@")) {
      event.preventDefault();
      this.zoomToSelection();
      return;
    }
    if (event.shiftKey && ["H", "V"].includes(event.key.toUpperCase()) && this.selection.size) {
      event.preventDefault();
      this.flip(event.key.toUpperCase() === "H" ? "x" : "y");
      return;
    }
    if (["ArrowUp", "ArrowDown", "ArrowLeft", "ArrowRight"].includes(event.key) && this.selection.size) {
      event.preventDefault();
      const step = event.shiftKey ? 20 : 2;
      this.nudgeSelection(
        event.key === "ArrowLeft" ? -step : event.key === "ArrowRight" ? step : 0,
        event.key === "ArrowUp" ? -step : event.key === "ArrowDown" ? step : 0,
      );
      return;
    }

    const key = event.key.toLowerCase();
    const byLetter = TOOLS.find((tool) => tool.shortcut === key);
    if (byLetter) {
      event.preventDefault();
      this.selectTool(byLetter.id);
      return;
    }
    if (NUMBER_SHORTCUTS[event.key]) {
      event.preventDefault();
      this.selectTool(NUMBER_SHORTCUTS[event.key]);
    }
  }

  /** A finger is down: a drag, a stroke, a marquee or an eraser sweep is live. */
  gestureInFlight() {
    return this.input?.activePointerId !== null
      || !!this.draggingIds || !!this.draft || !!this.selectionBox || !!this.fadingIds;
  }

  /**
   * Refuse a command because a gesture is running, and say why.
   *
   * Anything that changes geometry has to bow out: the drag in progress
   * rewrites the same elements from its own `before` snapshot on the very next
   * pointermove, so the command is silently undone — and the undo entry it
   * recorded restores a mid-drag position the user never chose. Two hands on an
   * iPad make this ordinary, not an edge case: the property panel and the
   * context menu sit outside the canvas, so tapping them never interrupts the
   * finger that is still dragging.
   */
  refuseDuringGesture() {
    if (!this.gestureInFlight()) return false;
    toast("Finish the drag first.", { tone: "warn" });
    return true;
  }

  /**
   * Abort whatever the finger is doing, right now.
   *
   * Switching board saves the current one and then replaces `scene` and
   * `history`. A gesture straddling that swap commits its stroke into the NEXT
   * board's history, and persists the old board at whatever half-dragged
   * position it had reached — permanently, because the undo entry that would
   * take it back landed on the wrong board. The long-press menu already does
   * this; every path that replaces the scene needs it too.
   */
  cancelGesture() {
    if (!this.gestureInFlight()) return;
    if (this.input?.activePointerId !== null) this.input.cancelActive();
    else this.activeTool?.onCancel?.(this);
    this.setDragging(null);
    this.setSelectionBox(null);
    this.setSnapGuides(null);
    this.setDraft(null);
  }

  undo() {
    // Undoing under a live gesture is incoherent and destructive: the drag goes
    // on mutating the element that was just deleted, and the record() on
    // release throws away the redo entry that would have brought it back.
    if (this.gestureInFlight()) return;
    if (!this.history.canUndo) return;
    this.history.undo();
    this.pruneSelection();
    this.markStatic();
    this.requestRender();
    this.refreshProps();
    this.scheduleSave();
  }

  redo() {
    if (this.gestureInFlight()) return;
    if (!this.history.canRedo) return;
    this.history.redo();
    this.pruneSelection();
    this.markStatic();
    this.requestRender();
    this.refreshProps();
    this.scheduleSave();
  }

  pruneSelection() {
    const next = new Set();
    for (const id of this.selection) {
      const element = this.scene.get(id);
      if (element && !element.isDeleted) next.add(id);
    }
    this.selection = next;
  }

  updateChrome() {
    if (!this.dom) return;
    this.dom.titleButton.textContent = this.board?.title || "Untitled";
    this.dom.undoButton.disabled = !this.history.canUndo;
    this.dom.redoButton.disabled = !this.history.canRedo;
    this.dom.empty.hidden = this.scene.visible().length > 0;
  }

  /* ----------------------------------------------------------------- menus */

  openMenu() {
    openDialog({
      title: "Menu",
      build: (body, close) => {
        const list = el("div", "menu-list");
        const item = (label, description, handler, tone) => {
          const button = el("button", `menu-item${tone ? ` menu-${tone}` : ""}`, { type: "button" });
          button.appendChild(el("span", "menu-item-label", { text: label }));
          if (description) button.appendChild(el("span", "menu-item-desc", { text: description }));
          button.addEventListener("click", async () => {
            close();
            try {
              await handler();
            } catch (error) {
              // A menu action that dies silently looks like a dead button.
              toast(error?.message || "That action could not be completed.", { tone: "error", timeout: 7000 });
              console.warn("[slate] menu action failed:", error);
            }
          });
          list.appendChild(button);
        };
        item("Boards", "Open, rename or delete a board", () => this.openBoardList());
        item("New board", "Start an empty canvas", () => this.newBoard());
        item("Find on this board", "Search the text you have written", () => this.openSearch());
        item("Shape library", "Save and reuse shapes", () => this.openLibrary());
        item(
          this.grid.enabled ? `Hide grid (${this.grid.size}px)` : "Show grid",
          "Snap new shapes to a fixed step",
          () => this.toggleGrid(),
        );
        item("Grid and snapping", "Grid size, snap to objects", () => this.openSnapDialog());
        item("Canvas background", "Change this board's paper colour", () => this.openBackgroundDialog());
        // Also reachable from the top bar on wide screens; on a phone the top
        // bar has no room for it, and losing the viewport on an infinite canvas
        // needs a way back that is always present.
        item("Scroll back to content", "Bring the drawing into view", () => this.scrollBackToContent());
        item("Zoom to selection", null, () => this.zoomToSelection());
        item("Reset zoom to 100%", null, () => this.stepZoom(0));
        item("Unlock all", "Release everything locked on this board", () => this.unlockAll());
        item("Export image", "PNG or SVG", () => this.openExportDialog());
        item("Copy image to clipboard", "PNG of the selection, or the board", () => this.copyImageToClipboard("png"));
        item("Export .excalidraw", "Opens on excalidraw.com", () => this.exportExcalidraw());
        item("Import .excalidraw", "Add a drawing to this board", () => this.importExcalidraw());
        item("Backup all boards", "One JSON file with everything", () => this.doBackup());
        item("Restore from backup", "Replace or merge", () => this.doRestore());
        item("Settings", "Text size, theme, storage", () => this.openSettings());
        item("Reset this canvas", "Delete every element on this board", () => this.resetCanvas(), "danger");
        body.appendChild(list);
      },
    });
  }

  async newBoard() {
    this.cancelGesture();
    const title = await promptDialog({ title: "New board", label: "Board name", value: "Untitled", confirmLabel: "Create" });
    if (title === null) return;
    const name = title.trim() || "Untitled";
    await this.saveNow();
    const meta = await createBoard(name);
    await this.openBoard(meta.id);
    journal.recordActivity(meta, "created", { at: meta.createdAt }).catch(() => {});
    this.refreshProps();
    toast(`Created "${name}".`);
  }

  async renameCurrentBoard() {
    if (!this.board) return;
    const title = await promptDialog({ title: "Rename board", label: "Board name", value: this.board.title });
    if (!title) return;
    this.board = await renameBoard(this.board.id, title);
    this.updateChrome();
    journal.recordActivity(this.board, "edited", { at: this.board.updatedAt }).catch(() => {});
  }

  async openBoardList() {
    // Before saveNow, not after: a live drag would otherwise be written to disk
    // at an arbitrary mid-drag point, with no undo entry left to take it back.
    this.cancelGesture();
    await this.saveNow();
    const boards = await listBoards();
    const estimate = await storageEstimate();
    openDialog({
      title: "Boards",
      wide: true,
      build: (body, close) => {
        if (estimate?.usage) {
          body.appendChild(el("p", "dialog-note", {
            text: `Using ${formatBytes(estimate.usage)} of this device's storage.`,
          }));
        }
        const list = el("div", "board-list");
        for (const board of boards) {
          const row = el("div", `board-row${board.id === this.board?.id ? " is-current" : ""}`);
          const openButton = el("button", "board-open", { type: "button" });
          openButton.appendChild(el("span", "board-name", { text: board.title }));
          openButton.appendChild(el("span", "board-meta", {
            // Board size is shown on purpose — it is the measurement stage 4
            // needs before sync can be designed (Expansion_Plan 4-3).
            text: `${board.elementCount || 0} items · ${formatBytes(board.bytes || 0)} · ${formatDate(board.updatedAt)}`,
          }));
          openButton.addEventListener("click", async () => {
            close();
            await this.openBoard(board.id, { journalOpened: true });
            this.refreshProps();
          });
          row.appendChild(openButton);

          const remove = el("button", "icon-button board-delete", {
            type: "button", "aria-label": `Delete ${board.title}`, html: svgIcon("close", 18),
          });
          remove.addEventListener("click", async () => {
            const ok = await confirmDialog({
              title: "Delete board",
              message: `Delete "${board.title}"? It is removed from the list but stays recoverable from a backup.`,
              confirmLabel: "Delete",
              danger: true,
            });
            if (!ok) return;
            await deleteBoard(board.id);
            close();
            if (board.id === this.board?.id) {
              const rest = await listBoards();
              // flush: false — the current board has just been deleted, and
              // saving it on the way out would put it straight back.
              if (rest.length) await this.openBoard(rest[0].id, { flush: false });
              else await this.openBoard((await createBoard("Untitled")).id, { flush: false });
              this.refreshProps();
            }
            toast(`Deleted "${board.title}".`);
          });
          row.appendChild(remove);
          list.appendChild(row);
        }
        if (!boards.length) list.appendChild(el("p", "dialog-text", { text: "No boards yet." }));
        body.appendChild(list);

        const actions = el("div", "dialog-actions");
        const create = el("button", "button button-primary", { type: "button", text: "New board" });
        create.addEventListener("click", async () => { close(); await this.newBoard(); });
        actions.appendChild(create);
        body.appendChild(actions);
      },
    });
  }

  openSnapDialog() {
    openDialog({
      title: "Grid and snapping",
      build: (body) => {
        body.appendChild(checkboxRow("Show grid", this.grid.enabled, (value) => {
          this.grid = { ...this.grid, enabled: value };
          this.markStatic();
          this.requestRender();
          this.scheduleSave();
        }));

        const sizeGroup = el("div", "prop-group");
        sizeGroup.appendChild(el("div", "prop-label", { text: "Grid size" }));
        const sizeRow = el("div", "prop-row");
        for (const size of GRID_STEPS) {
          const button = el("button", `opt${this.grid.size === size ? " is-on" : ""}`, {
            type: "button",
            text: String(size),
            "aria-label": `${size} pixels`,
            "aria-pressed": this.grid.size === size ? "true" : "false",
          });
          button.addEventListener("click", () => {
            this.setGridSize(size);
            for (const sibling of sizeRow.children) {
              const on = sibling === button;
              sibling.classList.toggle("is-on", on);
              sibling.setAttribute("aria-pressed", on ? "true" : "false");
            }
          });
          sizeRow.appendChild(button);
        }
        sizeGroup.appendChild(sizeRow);
        body.appendChild(sizeGroup);

        body.appendChild(checkboxRow("Snap to other objects", this.snapToObjects, (value) => {
          this.snapToObjects = value;
          this.scheduleSave();
        }));
        // Two snaps that would fight each other, so only one is ever live.
        body.appendChild(el("p", "dialog-note", {
          text: "With the grid on, dragging snaps to the grid. With it off, dragging lines up with other objects instead. Hold Option while dragging to turn snapping off for one move.",
        }));
      },
    });
  }

  openBackgroundDialog() {
    openDialog({
      title: "Canvas background",
      build: (body, close) => {
        const row = el("div", "prop-row");
        for (const entry of CANVAS_BACKGROUNDS) {
          const button = el("button", `swatch${this.background === entry.light ? " is-on" : ""}`, {
            type: "button", "aria-label": entry.name, "aria-pressed": this.background === entry.light ? "true" : "false",
            title: entry.name,
          });
          const chip = el("span", "swatch-chip");
          chip.style.background = displayColor(entry.light, this.isDark());
          button.appendChild(chip);
          button.addEventListener("click", () => {
            this.background = entry.light;
            this.applyBackground();
            this.scheduleSave();
            close();
          });
          row.appendChild(button);
        }
        body.appendChild(row);
      },
    });
  }

  /* --------------------------------------------------------------- exports */

  async openExportDialog() {
    const elements = this.scene.visible();
    if (!elements.length) {
      toast("This board is empty — nothing to export.", { tone: "warn" });
      return;
    }
    const box = boundsOfMany(elements);
    const allowed = await maxExportScale(box.width + 20, box.height + 20);

    openDialog({
      title: "Export image",
      build: (body, close) => {
        const state = { scale: Math.min(2, allowed || 1), background: true, dark: false, embedFont: true };

        const scaleGroup = el("div", "prop-group");
        scaleGroup.appendChild(el("div", "prop-label", { text: "PNG scale" }));
        const scaleRow = el("div", "prop-row");
        for (const scale of [1, 2, 3]) {
          const disabled = allowed !== null && scale > allowed;
          const button = el("button", `opt${state.scale === scale ? " is-on" : ""}`, {
            type: "button", text: `${scale}x`, "aria-pressed": state.scale === scale ? "true" : "false",
            "aria-label": `${scale} times`,
          });
          if (disabled) {
            button.disabled = true;
            button.title = "Too large for this device";
          }
          button.addEventListener("click", () => {
            state.scale = scale;
            for (const sibling of scaleRow.children) {
              const on = sibling === button;
              sibling.classList.toggle("is-on", on);
              sibling.setAttribute("aria-pressed", on ? "true" : "false");
            }
          });
          scaleRow.appendChild(button);
        }
        scaleGroup.appendChild(scaleRow);
        body.appendChild(scaleGroup);
        if (allowed !== null && allowed < 3) {
          body.appendChild(el("p", "dialog-note", {
            text: `This device can render up to ${allowed}x for a board this size. Larger scales are turned off; SVG has no limit.`,
          }));
        }

        body.appendChild(checkboxRow("Include background", state.background, (value) => { state.background = value; }));
        body.appendChild(checkboxRow("Export in dark colours", state.dark, (value) => { state.dark = value; }));
        body.appendChild(checkboxRow("Embed handwriting font (SVG)", state.embedFont, (value) => { state.embedFont = value; }));
        body.appendChild(el("p", "dialog-note", {
          text: "Embedding keeps the handwriting look on devices without the font. It adds about 60 KB.",
        }));

        const actions = el("div", "dialog-actions");
        const png = el("button", "button button-primary", { type: "button", text: "Export PNG" });
        const svg = el("button", "button", { type: "button", text: "Export SVG" });
        png.addEventListener("click", async () => {
          close();
          await this.doExportPNG(state);
        });
        svg.addEventListener("click", async () => {
          close();
          await this.doExportSVG(state);
        });
        actions.appendChild(svg);
        actions.appendChild(png);
        body.appendChild(actions);
      },
    });
  }

  async doExportPNG(state) {
    journal.recordActivity(this.board, "export-requested").catch(() => {});
    try {
      const result = await exportPNG(this.scene.visible(), {
        scale: state.scale,
        withBackground: state.background,
        background: this.background,
        dark: state.dark,
      });
      await shareOrDownload(result.blob, safeFilename(this.board?.title, "png"));
      if (result.lowered) {
        toast(`Exported at ${result.scale}x — this device could not render the size you picked.`, { tone: "warn", timeout: 6000 });
      } else {
        toast(`Exported PNG (${result.width}×${result.height}).`);
      }
    } catch (error) {
      toast(error.message || "PNG export failed.", { tone: "error", timeout: 7000 });
    }
  }

  async doExportSVG(state) {
    journal.recordActivity(this.board, "export-requested").catch(() => {});
    try {
      const blob = await exportSVG(this.scene.visible(), {
        withBackground: state.background,
        background: this.background,
        dark: state.dark,
        embedFont: state.embedFont,
      });
      await shareOrDownload(blob, safeFilename(this.board?.title, "svg"));
      toast("Exported SVG.");
    } catch (error) {
      toast(error.message || "SVG export failed.", { tone: "error", timeout: 7000 });
    }
  }

  async exportExcalidraw() {
    const elements = this.scene.visible();
    if (!elements.length) {
      toast("This board is empty — nothing to export.", { tone: "warn" });
      return;
    }
    journal.recordActivity(this.board, "export-requested").catch(() => {});
    const file = toExcalidrawFile(elements, {
      viewBackgroundColor: this.background,
    }, this.files);
    const blob = new Blob([JSON.stringify(file)], { type: "application/json" });
    await shareOrDownload(blob, safeFilename(this.board?.title, "excalidraw"));
    toast("Exported .excalidraw — it opens on excalidraw.com.");
  }

  async importExcalidraw() {
    const file = await pickFile({ accept: ".excalidraw,application/json,.json" });
    if (!file) return;
    {
      try {
        const parsed = parseExcalidrawFile(await file.text());
        if (!parsed.elements.length) {
          toast("That drawing has no elements.", { tone: "warn" });
          return;
        }
        // New ids so an import can never collide with what is already here —
        // but the RELATIONSHIPS have to be rewritten to match, or every label,
        // arrow binding and group in the imported file points at a dead id and
        // the drawing silently comes apart (model.js). `keepSeed` leaves the
        // hand-drawn wobble exactly as it was in the file.
        const incoming = cloneElements(parsed.elements, { keepSeed: true });
        this.history.run(Actions.add(incoming));
        // The files map rides along untouched. Stage 1 cannot draw images, but
        // dropping them would delete photos from the user's own file on the
        // next export (Build_Plan 5-2).
        this.files = { ...this.files, ...(parsed.files || {}) };
        this.setSelection(new Set(incoming.map((element) => element.id)));
        this.markStatic();
        this.requestRender();
        this.refreshProps();
        this.scheduleSave();
        const unsupported = incoming.filter((element) => !entryFor(element.type) || entryFor(element.type).placeholder);
        const imageCount = Object.keys(parsed.files || {}).length;
        let message = `Imported ${incoming.length} elements.`;
        if (unsupported.length) message += ` ${unsupported.length} are shown as placeholders and kept intact.`;
        if (imageCount) message += ` ${imageCount} image${imageCount > 1 ? "s" : ""} preserved.`;
        toast(message, { timeout: 7000 });
        this.scrollBackToContent();
      } catch (error) {
        const message = error instanceof ImportError ? error.message : "Could not read that file.";
        toast(message, { tone: "error", timeout: 7000 });
      }
    }
  }

  async doBackup() {
    try {
      await this.saveNow();
      const result = await downloadBackup();
      toast(`Backup ready — ${result.boards} board${result.boards === 1 ? "" : "s"} (${result.filename}).`, { timeout: 6000 });
    } catch (error) {
      toast(error.message || "Backup failed.", { tone: "error", timeout: 7000 });
    }
  }

  async doRestore() {
    const file = await pickFile({ accept: "application/json,.json" });
    if (!file) return;
    {
      const text = await file.text();
      const replace = await confirmDialog({
        title: "Restore backup",
        message: "Replace everything on this device with the backup? Choose Cancel to merge the backup in instead, keeping your current boards.",
        confirmLabel: "Replace all",
        danger: true,
      });
      try {
        const result = await restoreBackup(text, {
          replace,
          onBeforeMigrate: async () => {
            // A migration always leaves a copy behind first.
            await downloadBackup().catch(() => {});
          },
        });
        toast(`Restored ${result.boards} board${result.boards === 1 ? "" : "s"}.`);
        const boards = await listBoards();
        if (boards.length) await this.openBoard(boards[0].id);
        this.refreshProps();
      } catch (error) {
        const message = error instanceof SchemaTooNewError || error instanceof BackupError
          ? error.message
          : "Could not restore that file.";
        toast(message, { tone: "error", timeout: 9000 });
      }
    }
  }

  async resetCanvas() {
    const ids = this.scene.visible().map((element) => element.id);
    if (!ids.length) {
      toast("This board is already empty.");
      return;
    }
    const locked = this.scene.visible().filter((element) => element.locked).length;
    const ok = await confirmDialog({
      title: "Reset this canvas",
      // Reset takes locked elements too — it is an explicit, confirmed action,
      // and leaving them behind after saying "all" would be a lie. The message
      // names them so it is not a surprise.
      message: `Delete all ${ids.length} elements on "${this.board?.title}"?`
        + (locked ? ` This includes ${locked} locked one${locked === 1 ? "" : "s"}.` : "")
        + " You can undo this straight afterwards.",
      confirmLabel: "Delete all",
      danger: true,
    });
    if (!ok) return;
    this.history.run(Actions.delete(ids));
    this.setSelection(new Set());
    this.markStatic();
    this.requestRender();
    this.refreshProps();
    this.scheduleSave();
    toast("Canvas cleared — Undo brings it back.", { timeout: 6000 });
  }

  /* -------------------------------------------------------------- settings */

  openSettings() {
    openDialog({
      title: "Settings",
      build: (body) => {
        /* text size */
        const sizeGroup = el("div", "prop-group");
        sizeGroup.appendChild(el("div", "prop-label", { text: "App text size" }));
        const sizeRow = el("div", "prop-row");
        FONT_STEPS.forEach((size, index) => {
          const button = el("button", `opt${settings.fontStepIndex === index ? " is-on" : ""}`, {
            type: "button", text: String(size),
            "aria-label": `${size} pixels`,
            "aria-pressed": settings.fontStepIndex === index ? "true" : "false",
          });
          button.addEventListener("click", () => {
            applyFontStep(index);
            for (const sibling of sizeRow.children) {
              const on = sibling === button;
              sibling.classList.toggle("is-on", on);
              sibling.setAttribute("aria-pressed", on ? "true" : "false");
            }
            this.fitCanvas();
          });
          sizeRow.appendChild(button);
        });
        sizeGroup.appendChild(sizeRow);
        body.appendChild(sizeGroup);
        // The two text sizes are genuinely different things; say so once here
        // rather than letting people hunt for why one control does nothing.
        body.appendChild(el("p", "dialog-note", {
          text: "Text size changes the app's own labels. Text on the canvas uses the S/M/L/XL property and scales with zoom.",
        }));
        const reset = el("button", "button", { type: "button", text: "Reset to 12px" });
        reset.addEventListener("click", () => {
          resetFontStep();
          for (const [index, sibling] of [...sizeRow.children].entries()) {
            const on = index === 3;
            sibling.classList.toggle("is-on", on);
            sibling.setAttribute("aria-pressed", on ? "true" : "false");
          }
          this.fitCanvas();
        });
        body.appendChild(reset);

        /* theme */
        const themeGroup = el("div", "prop-group");
        themeGroup.appendChild(el("div", "prop-label", { text: "Theme" }));
        const themeRow = el("div", "prop-row");
        for (const [label, value] of [["Auto", "auto"], ["Light", "light"], ["Dark", "dark"]]) {
          const button = el("button", `opt opt-wide${settings.theme === value ? " is-on" : ""}`, {
            type: "button", text: label,
            "aria-pressed": settings.theme === value ? "true" : "false",
          });
          button.addEventListener("click", () => {
            settings.theme = value;
            this.applyThemeNow();
            for (const sibling of themeRow.children) {
              const on = sibling === button;
              sibling.classList.toggle("is-on", on);
              sibling.setAttribute("aria-pressed", on ? "true" : "false");
            }
          });
          themeRow.appendChild(button);
        }
        themeGroup.appendChild(themeRow);
        body.appendChild(themeGroup);

        appendJournalSettings({ body, el, checkboxRow, toast, listBoards, confirmDialog });

        /* diagnostics */
        const info = el("div", "prop-group");
        info.appendChild(el("div", "prop-label", { text: "About" }));
        // Showing the build makes "deployed" versus "running here" answerable.
        info.appendChild(el("p", "dialog-note", { text: `Build ${APP_BUILD}` }));
        info.appendChild(el("p", "dialog-note", {
          text: isStandalone()
            ? "Running from the Home Screen."
            : "Running in the browser. Home Screen apps keep their drawings in a separate store from Safari.",
        }));
        body.appendChild(info);

        const recover = el("button", "button", { type: "button", text: "Recover previous version of this board" });
        recover.addEventListener("click", () => this.recoverPrevious());
        body.appendChild(recover);
      },
    });
  }

  /** The one-slot safety net from store.js, surfaced where it can be reached. */
  async recoverPrevious() {
    if (!this.board) return;
    const previous = await readPreviousContent(this.board.id);
    if (!previous?.elements) {
      toast("No previous version is stored for this board yet.", { tone: "warn" });
      return;
    }
    const ok = await confirmDialog({
      title: "Recover previous version",
      message: `Replace the current board with the previously saved version (${previous.elements.filter((e) => !e.isDeleted).length} elements)? The current version stays in the undo history.`,
      confirmLabel: "Recover",
    });
    if (!ok) return;
    // Swap the whole element set, then start a fresh history — the version
    // being replaced is already on disk as the new :prev slot after the next
    // save, so this is reversible in one more step rather than zero.
    this.scene.replaceAll(previous.elements);
    this.history = new History(this.scene);
    this.selection = new Set();
    this.markStatic();
    this.requestRender();
    this.refreshProps();
    this.scheduleSave();
    toast("Recovered the previous saved version.");
  }

  /* ------------------------------------------------------- install hinting */

  maybeShowInstallHint() {
    if (settings.installHintSeen || isStandalone() || !isIOS()) return;
    markInstallHintSeen();
    setTimeout(() => {
      openDialog({
        title: "Add slate to your Home Screen",
        build: (body, close) => {
          body.appendChild(el("p", "dialog-text", {
            text: "slate works offline once it is on your Home Screen, and Home Screen apps keep their drawings in a separate store from Safari — so it is worth adding it before you start drawing.",
          }));
          body.appendChild(el("p", "dialog-text", {
            text: "Share → Add to Home Screen.",
          }));
          const actions = el("div", "dialog-actions");
          const ok = el("button", "button button-primary", { type: "button", text: "Got it" });
          ok.addEventListener("click", close);
          actions.appendChild(ok);
          body.appendChild(actions);
        },
      });
    }, 1200);
  }
}

function checkboxRow(label, checked, onChange) {
  const row = el("label", "check-row");
  const input = el("input", null, { type: "checkbox" });
  input.checked = checked;
  input.addEventListener("change", () => onChange(input.checked));
  row.appendChild(input);
  row.appendChild(el("span", null, { text: label }));
  return row;
}

/* --------------------------------------------------------------- bootstrap */

const root = document.getElementById("app");
const app = new SlateApp(root);
app.start().catch((error) => {
  console.error("[slate] failed to start:", error);
  root.textContent = "";
  const notice = el("div", "boot-error");
  notice.appendChild(el("h1", null, { text: "slate could not start" }));
  notice.appendChild(el("p", null, { text: error?.message || String(error) }));
  root.appendChild(notice);
});

// Keep the selection/undo chrome in step without threading a callback through
// every call site.
setInterval(() => app.updateChrome(), 400);

export { SlateApp };
