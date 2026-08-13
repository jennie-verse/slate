// Shell, toolbar, sheet, dialogs.
//
// Layout is C — Rail + Sheet (design concepts 4). There is ONE set of tool
// buttons; a media query decides whether they sit in a left rail (iPad
// landscape) or a bottom bar (iPhone, iPad portrait). Building two DOM trees
// would double the review surface and let the two drift apart.
//
// Accessibility rules that are not optional here:
//   * every icon-only button carries aria-label;
//   * selected state is background + border + aria-pressed, never colour alone;
//   * touch targets stay 44px at every one of the six text sizes — only the
//     label shrinks.

export const icons = {
  selection: '<path d="M5 3l14 7-6 1.6L10.6 18z"/>',
  hand: '<path d="M9 11V5.5a1.5 1.5 0 013 0V11m0-1V4.5a1.5 1.5 0 013 0V11m0-.5V6.5a1.5 1.5 0 013 0V15a6 6 0 01-6 6h-1a6 6 0 01-6-6v-3.5a1.5 1.5 0 013 0V11"/>',
  rectangle: '<rect x="4" y="6" width="16" height="12" rx="2"/>',
  diamond: '<path d="M12 4l8 8-8 8-8-8z"/>',
  ellipse: '<ellipse cx="12" cy="12" rx="8" ry="6"/>',
  arrow: '<path d="M4 18L20 6M20 6h-6M20 6v6"/>',
  line: '<path d="M4 18L20 6"/>',
  freedraw: '<path d="M3 18c3 0 3-8 6-8s3 6 6 6 3-9 6-9"/>',
  text: '<path d="M5 6h14M12 6v13M9 19h6"/>',
  eraser: '<path d="M8 20l-4-4a2 2 0 010-3l8-8a2 2 0 013 0l4 4a2 2 0 010 3l-7 8zM7 13l5 5"/>',
  menu: '<path d="M4 7h16M4 12h16M4 17h16"/>',
  undo: '<path d="M9 7L4 12l5 5M4 12h9a6 6 0 010 12h-1"/>',
  redo: '<path d="M15 7l5 5-5 5M20 12h-9a6 6 0 000 12h1"/>',
  zoomOut: '<path d="M5 12h14"/>',
  zoomIn: '<path d="M12 5v14M5 12h14"/>',
  fit: '<path d="M4 9V4h5M20 9V4h-5M4 15v5h5M20 15v5h-5"/>',
  close: '<path d="M6 6l12 12M18 6L6 18"/>',
  chevron: '<path d="M9 6l6 6-6 6"/>',
  plus: '<path d="M12 5v14M5 12h14"/>',
};

export function svgIcon(name, size = 22) {
  return `<svg viewBox="0 0 24 24" width="${size}" height="${size}" fill="none" stroke="currentColor" `
    + `stroke-width="1.7" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true" focusable="false">`
    + `${icons[name] || ""}</svg>`;
}

export function el(tag, className, attrs = {}) {
  const node = document.createElement(tag);
  if (className) node.className = className;
  for (const [key, value] of Object.entries(attrs)) {
    if (value === null || value === undefined) continue;
    if (key === "text") node.textContent = value;
    else if (key === "html") node.innerHTML = value;
    else node.setAttribute(key, value);
  }
  return node;
}

/* ------------------------------------------------------------------ toasts */

let toastHost = null;

export function toast(message, { tone = "info", timeout = 3600 } = {}) {
  if (!toastHost) {
    toastHost = document.getElementById("toasts") || el("div", "toasts");
    toastHost.id = "toasts";
    toastHost.setAttribute("aria-live", "polite");
    if (!toastHost.parentNode) document.body.appendChild(toastHost);
  }
  const node = el("div", `toast toast-${tone}`, { role: "status" });
  node.textContent = message;
  toastHost.appendChild(node);
  setTimeout(() => {
    node.classList.add("is-leaving");
    setTimeout(() => node.remove(), 220);
  }, timeout);
  return node;
}

/* ----------------------------------------------------------------- dialogs */

let openDialogs = 0;

export function openDialog({ title, build, onClose, wide = false }) {
  const backdrop = el("div", "backdrop", { role: "presentation" });
  const dialog = el("div", `dialog${wide ? " dialog-wide" : ""}`, {
    role: "dialog",
    "aria-modal": "true",
    "aria-label": title,
  });
  const header = el("header", "dialog-head");
  header.appendChild(el("h2", "dialog-title", { text: title }));
  const closeButton = el("button", "icon-button", {
    type: "button", "aria-label": "Close", html: svgIcon("close", 20),
  });
  header.appendChild(closeButton);
  dialog.appendChild(header);

  const body = el("div", "dialog-body");
  dialog.appendChild(body);
  backdrop.appendChild(dialog);
  document.body.appendChild(backdrop);
  openDialogs += 1;

  const close = () => {
    if (!backdrop.isConnected) return;
    backdrop.remove();
    openDialogs = Math.max(0, openDialogs - 1);
    document.removeEventListener("keydown", onKey, true);
    onClose?.();
  };

  const onKey = (event) => {
    if (event.key === "Escape" && !event.isComposing) {
      event.stopPropagation();
      close();
      return;
    }
    if (event.key !== "Tab") return;
    const focusable = dialog.querySelectorAll(
      'button, [href], input, select, textarea, [tabindex]:not([tabindex="-1"])',
    );
    if (!focusable.length) return;
    const first = focusable[0];
    const last = focusable[focusable.length - 1];
    if (event.shiftKey && document.activeElement === first) {
      event.preventDefault();
      last.focus();
    } else if (!event.shiftKey && document.activeElement === last) {
      event.preventDefault();
      first.focus();
    }
  };

  closeButton.addEventListener("click", close);
  backdrop.addEventListener("pointerdown", (event) => {
    if (event.target === backdrop) close();
  });
  document.addEventListener("keydown", onKey, true);

  build(body, close);
  const target = body.querySelector("input, button, textarea, select") || closeButton;
  setTimeout(() => target.focus?.({ preventScroll: true }), 20);
  return { close, body, dialog };
}

export function anyDialogOpen() {
  return openDialogs > 0;
}

/**
 * Confirmation. Every destructive path in the app goes through here, and the
 * ones that can be undone say so on the button.
 */
export function confirmDialog({ title, message, confirmLabel = "OK", danger = false }) {
  return new Promise((resolve) => {
    openDialog({
      title,
      build: (body, close) => {
        body.appendChild(el("p", "dialog-text", { text: message }));
        const row = el("div", "dialog-actions");
        const cancel = el("button", "button", { type: "button", text: "Cancel" });
        const confirm = el("button", `button button-primary${danger ? " button-danger" : ""}`, {
          type: "button", text: confirmLabel,
        });
        cancel.addEventListener("click", () => { close(); resolve(false); });
        confirm.addEventListener("click", () => { close(); resolve(true); });
        row.appendChild(cancel);
        row.appendChild(confirm);
        body.appendChild(row);
      },
      onClose: () => resolve(false),
    });
  });
}

export function promptDialog({ title, label, value = "", confirmLabel = "Save" }) {
  return new Promise((resolve) => {
    let settled = false;
    openDialog({
      title,
      build: (body, close) => {
        const field = el("label", "field");
        field.appendChild(el("span", "field-label", { text: label }));
        const input = el("input", "input", { type: "text", value });
        field.appendChild(input);
        body.appendChild(field);
        const row = el("div", "dialog-actions");
        const cancel = el("button", "button", { type: "button", text: "Cancel" });
        const confirm = el("button", "button button-primary", { type: "button", text: confirmLabel });
        const done = (result) => { settled = true; close(); resolve(result); };
        cancel.addEventListener("click", () => done(null));
        confirm.addEventListener("click", () => done(input.value.trim() || null));
        // Enter must not commit while a Korean IME is still composing.
        input.addEventListener("keydown", (event) => {
          if (event.key === "Enter" && !event.isComposing && event.keyCode !== 229) {
            event.preventDefault();
            done(input.value.trim() || null);
          }
        });
        row.appendChild(cancel);
        row.appendChild(confirm);
        body.appendChild(row);
      },
      onClose: () => { if (!settled) resolve(null); },
    });
  });
}

/* ------------------------------------------------------------------- shell */

export function buildShell(root, { tools, onTool, onMenu, onUndo, onRedo, onZoom, onFit, onPanelToggle }) {
  root.textContent = "";
  const shell = el("div", "shell");

  const canvasHost = el("div", "canvas-host", { id: "canvas-host" });
  const surface = el("div", "surface", { tabindex: "0", "aria-label": "Drawing canvas" });
  canvasHost.appendChild(surface);
  shell.appendChild(canvasHost);

  /* top bar */
  const top = el("div", "topbar");
  const menuButton = el("button", "icon-button chip", {
    type: "button", "aria-label": "Menu", html: svgIcon("menu", 20),
  });
  menuButton.addEventListener("click", onMenu);
  top.appendChild(menuButton);

  const titleButton = el("button", "board-title chip", { type: "button", "aria-label": "Board name" });
  titleButton.textContent = "Untitled";
  top.appendChild(titleButton);

  const status = el("div", "save-status chip", { role: "status", "aria-live": "polite" });
  status.textContent = "Saved";
  top.appendChild(status);

  const spacer = el("div", "topbar-spacer");
  top.appendChild(spacer);

  const historyGroup = el("div", "chip chip-group");
  const undoButton = el("button", "icon-button", { type: "button", "aria-label": "Undo", html: svgIcon("undo", 18) });
  const redoButton = el("button", "icon-button", { type: "button", "aria-label": "Redo", html: svgIcon("redo", 18) });
  undoButton.addEventListener("click", onUndo);
  redoButton.addEventListener("click", onRedo);
  historyGroup.appendChild(undoButton);
  historyGroup.appendChild(redoButton);
  top.appendChild(historyGroup);

  const zoomGroup = el("div", "chip chip-group");
  const zoomOut = el("button", "icon-button zoom-step", { type: "button", "aria-label": "Zoom out", html: svgIcon("zoomOut", 18) });
  const zoomLabel = el("button", "zoom-label", { type: "button", "aria-label": "Reset zoom to 100%" });
  zoomLabel.textContent = "100%";
  const zoomIn = el("button", "icon-button zoom-step", { type: "button", "aria-label": "Zoom in", html: svgIcon("zoomIn", 18) });
  const fitButton = el("button", "icon-button zoom-fit", { type: "button", "aria-label": "Scroll back to content", html: svgIcon("fit", 18) });
  zoomOut.addEventListener("click", () => onZoom(-1));
  zoomIn.addEventListener("click", () => onZoom(1));
  zoomLabel.addEventListener("click", () => onZoom(0));
  fitButton.addEventListener("click", onFit);
  zoomGroup.appendChild(zoomOut);
  zoomGroup.appendChild(zoomLabel);
  zoomGroup.appendChild(zoomIn);
  zoomGroup.appendChild(fitButton);
  top.appendChild(zoomGroup);
  shell.appendChild(top);

  /* tools — one list, positioned by CSS */
  const toolbar = el("div", "toolbar", { role: "toolbar", "aria-label": "Tools" });
  const toolButtons = new Map();
  for (const tool of tools) {
    const button = el("button", "tool", {
      type: "button",
      "aria-label": `${tool.label} (${tool.shortcut.toUpperCase()})`,
      "aria-pressed": "false",
      title: `${tool.label} — ${tool.shortcut.toUpperCase()}`,
      html: svgIcon(tool.id, 22),
    });
    button.appendChild(el("span", "tool-label", { text: tool.label }));
    button.addEventListener("click", () => onTool(tool.id));
    toolbar.appendChild(button);
    toolButtons.set(tool.id, button);
  }
  shell.appendChild(toolbar);

  /* properties — side panel in rail layout, sheet in bar layout */
  const panel = el("aside", "panel", { "aria-label": "Properties" });
  const panelHandle = el("button", "panel-handle", {
    type: "button", "aria-label": "Collapse properties", "aria-expanded": "true", html: svgIcon("chevron", 18),
  });
  panelHandle.addEventListener("click", onPanelToggle);
  panel.appendChild(panelHandle);
  const panelBody = el("div", "panel-body");
  panel.appendChild(panelBody);
  shell.appendChild(panel);

  const empty = el("div", "empty-hint", { text: "Pick a tool and start drawing." });
  shell.appendChild(empty);

  root.appendChild(shell);

  return {
    shell, canvasHost, surface, toolbar, toolButtons, panel, panelBody, panelHandle,
    titleButton, status, undoButton, redoButton, zoomLabel, empty,
  };
}
