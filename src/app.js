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
} from "./model.js";
import { boundsOfMany, localBounds, zoomAt, clamp } from "./geometry.js";
import {
  buildShell, toast, openDialog, confirmDialog, promptDialog, el, svgIcon, anyDialogOpen,
} from "./ui.js";
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
    this.files = {};
    this.editing = null;
    this.saveTimer = null;
    this.saveState = "saved";
    this.frame = null;
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
    this.dom.titleButton.addEventListener("click", () => this.renameCurrentBoard());
    if (settings.panelCollapsed) this.dom.shell.classList.add("panel-collapsed");

    window.addEventListener("resize", () => this.fitCanvas());
    window.visualViewport?.addEventListener("resize", () => this.syncVisualViewport());
    window.visualViewport?.addEventListener("scroll", () => this.syncVisualViewport());
    window.matchMedia?.("(prefers-color-scheme: dark)").addEventListener?.("change", () => {
      if (settings.theme === "auto") this.applyThemeNow();
    });

    // iOS can discard the tab without warning — force a final write on the way out.
    window.addEventListener("pagehide", () => this.saveNow({ blocking: true }));
    document.addEventListener("visibilitychange", () => {
      if (document.visibilityState === "hidden") this.saveNow({ blocking: true });
    });

    this.fitCanvas();
    this.selectTool("selection");
    await this.openInitialBoard();
    this.refreshProps();
    this.updateChrome();
    this.maybeShowInstallHint();
    this.registerServiceWorker();
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

  async openBoard(id) {
    const loaded = await loadBoard(id);
    if (!loaded) return;
    this.board = loaded.meta;
    this.scene = new Scene(loaded.elements);
    this.history = new History(this.scene);
    this.files = loaded.files || {};
    this.viewport = {
      scrollX: loaded.appState.scrollX ?? 0,
      scrollY: loaded.appState.scrollY ?? 0,
      zoom: loaded.appState.zoom ?? 1,
    };
    this.background = loaded.appState.viewBackgroundColor || DEFAULT_APP_STATE.viewBackgroundColor;
    this.selection = new Set();
    await writeSetting(LAST_BOARD_KEY, id).catch(() => {});
    this.applyBackground();
    this.markStatic();
    this.requestRender();
    this.updateChrome();
    this.setSaveState("saved");
  }

  registerServiceWorker() {
    if (!("serviceWorker" in navigator)) return;
    // start() is async and awaits IndexedDB before reaching here, so `load` has
    // usually ALREADY fired by now — a listener added at this point would never
    // run and the app would silently ship with no offline support at all.
    const register = () => {
      navigator.serviceWorker.register("./sw.js").catch((error) => {
        // Offline support is a bonus; the app still works without it.
        console.warn("[slate] service worker registration failed:", error?.message || error);
      });
    };
    if (document.readyState === "complete") register();
    else window.addEventListener("load", register, { once: true });
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

  elementAt(x, y, threshold) {
    const elements = this.scene.visible();
    for (let i = elements.length - 1; i >= 0; i -= 1) {
      const element = elements[i];
      if (element.locked) continue;
      if (entryFor(element.type).hitTest(element, x, y, threshold)) return element;
    }
    return null;
  }

  onPointerDown(event) {
    if (this.editing) this.commitText();
    this.activeTool.onPointerDown?.(this, event);
  }

  onPointerMove(event) {
    this.activeTool.onPointerMove?.(this, event);
  }

  onPointerUp(event) {
    this.activeTool.onPointerUp?.(this, event);
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
    const elements = this.selectedElements();
    if (!elements.length) return;
    const copies = elements.map((element) => ({
      ...JSON.parse(JSON.stringify(element)),
      id: newId(),
      index: null,
      x: element.x + 16,
      y: element.y + 16,
      version: 1,
      updated: Date.now(),
    }));
    this.history.run(Actions.add(copies));
    this.setSelection(new Set(copies.map((element) => element.id)));
    this.markStatic();
    this.requestRender();
    this.scheduleSave();
  }

  /* -------------------------------------------------------------- text edit */

  isTextEditing() {
    return !!this.editing;
  }

  editText(element, { isNew = false } = {}) {
    this.commitText();
    const textarea = el("textarea", "text-editor", {
      "aria-label": "Text",
      spellcheck: "false",
      autocapitalize: "sentences",
    });
    textarea.value = element.text || "";
    this.dom.canvasHost.appendChild(textarea);
    this.editing = { element, textarea, isNew, composing: false };

    // Korean IME: while composing, Enter and Escape belong to the IME.
    textarea.addEventListener("compositionstart", () => { this.editing.composing = true; });
    textarea.addEventListener("compositionend", () => { this.editing.composing = false; });
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
    const { element, textarea } = this.editing;
    const displaySize = (element.fontSize || 20) * this.viewport.zoom;
    // The textarea stays at 16px so iOS never auto-zooms the page, and a CSS
    // transform scales it to the size the drawing actually shows. Setting
    // font-size to displaySize directly would trip iOS's <16px rule as soon as
    // the canvas is zoomed out (Build_Plan 7-1).
    const scale = displaySize / 16;
    const [screenX, screenY] = [
      (element.x + this.viewport.scrollX) * this.viewport.zoom,
      (element.y + this.viewport.scrollY) * this.viewport.zoom,
    ];
    const lines = textarea.value.split("\n");
    const columns = Math.max(6, ...lines.map((line) => line.length + 1));

    textarea.style.left = `${screenX}px`;
    textarea.style.top = `${screenY}px`;
    textarea.style.fontSize = "16px";
    textarea.style.lineHeight = String(element.lineHeight || 1.25);
    textarea.style.fontFamily = fontStackFor(element.fontFamily);
    textarea.style.color = displayColor(element.strokeColor, this.isDark());
    textarea.style.textAlign = element.textAlign || "left";
    textarea.style.transform = `scale(${scale})`;
    textarea.style.transformOrigin = "left top";
    textarea.style.width = `${columns}ch`;
    textarea.style.height = `${lines.length * 16 * (element.lineHeight || 1.25) + 6}px`;
  }

  commitText() {
    const editing = this.editing;
    if (!editing) return;
    this.editing = null;
    const { element, textarea, isNew } = editing;
    const text = textarea.value;
    textarea.remove();

    if (!text.trim()) {
      // An empty text element is invisible and unselectable — remove it rather
      // than leaving a trap on the canvas.
      this.history.run(Actions.delete([element.id]));
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
        this.history.runSilent(Actions.update([element.id], changes));
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

  async saveNow({ blocking = false } = {}) {
    if (!this.board) return;
    clearTimeout(this.saveTimer);
    if (!blocking) this.setSaveState("saving");
    const payload = {
      elements: this.scene.toJSON(),
      appState: {
        scrollX: this.viewport.scrollX,
        scrollY: this.viewport.scrollY,
        zoom: this.viewport.zoom,
        viewBackgroundColor: this.background,
      },
      files: this.files,
    };
    try {
      this.board = await saveBoard(this.board, payload);
      this.setSaveState("saved");
    } catch (error) {
      // Never fail silently: a full quota or an IndexedDB error means the
      // drawing only exists in memory, and the user needs to know now.
      this.setSaveState("error");
      toast("Could not save. Export a backup now — Menu → Backup.", { tone: "error", timeout: 10000 });
      console.warn("[slate] save failed:", error?.message || error);
    }
  }

  /* -------------------------------------------------------------- shortcuts */

  onKeyDown(event, typing) {
    if (typing || anyDialogOpen()) return;
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
      this.setSelection(new Set(this.scene.visible().filter((element) => !element.locked).map((e) => e.id)));
      return;
    }
    if (meta && event.key.toLowerCase() === "d") {
      event.preventDefault();
      this.duplicateSelection();
      return;
    }
    if (meta) return;

    if (event.key === "Delete" || event.key === "Backspace") {
      const ids = [...this.selection];
      if (!ids.length) return;
      event.preventDefault();
      this.history.run(Actions.delete(ids));
      this.setSelection(new Set());
      this.markStatic();
      this.requestRender();
      this.scheduleSave();
      return;
    }
    if (event.key === "Escape") {
      this.activeTool.onCancel?.(this);
      this.setSelection(new Set());
      return;
    }
    if (event.key === "Enter" && this.selection.size === 1) {
      const element = this.selectedElements()[0];
      if (element?.type === "text") {
        event.preventDefault();
        this.editText(element);
      }
      return;
    }
    if (["ArrowUp", "ArrowDown", "ArrowLeft", "ArrowRight"].includes(event.key) && this.selection.size) {
      event.preventDefault();
      const step = event.shiftKey ? 20 : 2;
      const dx = event.key === "ArrowLeft" ? -step : event.key === "ArrowRight" ? step : 0;
      const dy = event.key === "ArrowUp" ? -step : event.key === "ArrowDown" ? step : 0;
      const ids = [...this.selection];
      const changes = ids.map((id) => {
        const element = this.scene.get(id);
        return { x: element.x + dx, y: element.y + dy };
      });
      this.history.run(Actions.update(ids, changes));
      this.markStatic();
      this.requestRender();
      this.scheduleSave();
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

  undo() {
    if (!this.history.canUndo) return;
    this.history.undo();
    this.pruneSelection();
    this.markStatic();
    this.requestRender();
    this.refreshProps();
    this.scheduleSave();
  }

  redo() {
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
        item("Canvas background", "Change this board's paper colour", () => this.openBackgroundDialog());
        // Also reachable from the top bar on wide screens; on a phone the top
        // bar has no room for it, and losing the viewport on an infinite canvas
        // needs a way back that is always present.
        item("Scroll back to content", "Bring the drawing into view", () => this.scrollBackToContent());
        item("Reset zoom to 100%", null, () => this.stepZoom(0));
        item("Export image", "PNG or SVG", () => this.openExportDialog());
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
    const title = await promptDialog({ title: "New board", label: "Board name", value: "Untitled", confirmLabel: "Create" });
    if (!title) return;
    await this.saveNow();
    const meta = await createBoard(title);
    await this.openBoard(meta.id);
    this.refreshProps();
    toast(`Created "${title}".`);
  }

  async renameCurrentBoard() {
    if (!this.board) return;
    const title = await promptDialog({ title: "Rename board", label: "Board name", value: this.board.title });
    if (!title) return;
    this.board = await renameBoard(this.board.id, title);
    this.updateChrome();
  }

  async openBoardList() {
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
            await this.openBoard(board.id);
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
              if (rest.length) await this.openBoard(rest[0].id);
              else await this.openBoard((await createBoard("Untitled")).id);
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
    const file = toExcalidrawFile(elements, {
      viewBackgroundColor: this.background,
    }, this.files);
    const blob = new Blob([JSON.stringify(file)], { type: "application/json" });
    await shareOrDownload(blob, safeFilename(this.board?.title, "excalidraw"));
    toast("Exported .excalidraw — it opens on excalidraw.com.");
  }

  importExcalidraw() {
    const input = el("input", null, { type: "file", accept: ".excalidraw,application/json,.json" });
    input.style.display = "none";
    document.body.appendChild(input);
    input.addEventListener("change", async () => {
      const file = input.files?.[0];
      input.remove();
      if (!file) return;
      try {
        const parsed = parseExcalidrawFile(await file.text());
        if (!parsed.elements.length) {
          toast("That drawing has no elements.", { tone: "warn" });
          return;
        }
        // New ids so an import can never collide with what is already here.
        const incoming = parsed.elements.map((element) => ({ ...element, id: newId(), index: null }));
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
    });
    input.click();
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

  doRestore() {
    const input = el("input", null, { type: "file", accept: "application/json,.json" });
    input.style.display = "none";
    document.body.appendChild(input);
    input.addEventListener("change", async () => {
      const file = input.files?.[0];
      input.remove();
      if (!file) return;
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
    });
    input.click();
  }

  async resetCanvas() {
    const ids = this.scene.visible().map((element) => element.id);
    if (!ids.length) {
      toast("This board is already empty.");
      return;
    }
    const ok = await confirmDialog({
      title: "Reset this canvas",
      message: `Delete all ${ids.length} elements on "${this.board?.title}"? You can undo this straight afterwards.`,
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
