// Long-press / right-click menu.
//
// iPad has no right mouse button, so every action that a desktop app would
// hide behind one has to be reachable another way. Long press is that way, and
// the same menu opens on `contextmenu` for anyone using a trackpad or mouse.
//
// Layout rules that are not optional (Build_Plan 9):
//   * rows are at least 44px tall at every text size;
//   * the menu is flipped rather than clipped when it would leave the screen —
//     including under the on-screen keyboard;
//   * Escape and any outside tap close it, and focus returns to the canvas.

import { el } from "./ui.js";

const MIN_WIDTH = 216;
const EDGE = 8;

let current = null;

export function closeContextMenu() {
  if (!current) return;
  current.remove();
  current = null;
  document.removeEventListener("keydown", onKey, true);
}

function onKey(event) {
  if (event.key === "Escape" && !event.isComposing) {
    event.stopPropagation();
    closeContextMenu();
  }
}

/**
 * @param {{x:number, y:number, items:Array}} options
 * items: { label, hint?, onSelect, danger?, disabled? } or { separator: true }
 */
export function openContextMenu({ x, y, items }) {
  closeContextMenu();
  const usable = items.filter(Boolean);
  if (!usable.length) return null;

  const layer = el("div", "menu-layer", { role: "presentation" });
  const menu = el("div", "context-menu", { role: "menu", "aria-label": "Actions" });
  menu.style.minWidth = `${MIN_WIDTH}px`;

  for (const item of usable) {
    if (item.separator) {
      menu.appendChild(el("div", "context-separator", { role: "separator" }));
      continue;
    }
    const button = el("button", `context-item${item.danger ? " is-danger" : ""}`, {
      type: "button",
      role: "menuitem",
    });
    button.appendChild(el("span", "context-label", { text: item.label }));
    if (item.hint) button.appendChild(el("span", "context-hint", { text: item.hint }));
    if (item.disabled) button.disabled = true;
    button.addEventListener("click", () => {
      closeContextMenu();
      try {
        item.onSelect();
      } catch (error) {
        console.warn("[slate] context action failed:", error);
      }
    });
    menu.appendChild(button);
  }

  layer.appendChild(menu);
  document.body.appendChild(layer);
  current = layer;

  // Place it now that the size is known, flipping instead of overflowing.
  const rect = menu.getBoundingClientRect();
  const viewportWidth = window.visualViewport?.width ?? window.innerWidth;
  const viewportHeight = window.visualViewport?.height ?? window.innerHeight;
  let left = x;
  let top = y;
  if (left + rect.width > viewportWidth - EDGE) left = Math.max(EDGE, viewportWidth - rect.width - EDGE);
  if (top + rect.height > viewportHeight - EDGE) top = Math.max(EDGE, viewportHeight - rect.height - EDGE);
  menu.style.left = `${left}px`;
  menu.style.top = `${top}px`;

  layer.addEventListener("pointerdown", (event) => {
    if (event.target === layer) {
      event.preventDefault();
      closeContextMenu();
    }
  });
  document.addEventListener("keydown", onKey, true);
  setTimeout(() => menu.querySelector("button:not([disabled])")?.focus?.({ preventScroll: true }), 20);
  return { close: closeContextMenu };
}

export function contextMenuOpen() {
  return !!current;
}
