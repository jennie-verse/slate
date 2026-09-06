// The element set for one board, plus its ordering cache.
//
// Nothing outside this module mutates an element. Every change goes through
// actions.js → apply(). That single funnel is what makes undo, and later the
// command palette and cross-device merge, possible at all (Expansion_Plan 2-1).
//
// Pure module — no DOM.

import { compareIndex, ensureIndices, keyBetween } from "./ordering.js";
import { stampChange } from "./model.js";

export class Scene {
  constructor(elements = []) {
    this.byId = new Map();
    this.order = [];
    this.replaceAll(elements);
  }

  replaceAll(elements) {
    this.byId = new Map();
    const list = elements.map((element) => ({ ...element }));
    list.sort(compareIndex);
    ensureIndices(list);
    for (const element of list) this.byId.set(element.id, element);
    this.resort();
  }

  resort() {
    this.order = [...this.byId.values()].sort(compareIndex);
  }

  get(id) {
    return this.byId.get(id);
  }

  /** Live, ordered, includes tombstones. */
  all() {
    return this.order;
  }

  /** What gets drawn. */
  visible() {
    return this.order.filter((element) => !element.isDeleted);
  }

  /**
   * Insert at the top of the stack.
   * Ordering is a field on the element, never the array position, so that a
   * reorder can merge later (Expansion_Plan 2-3).
   */
  insert(element) {
    const last = this.order[this.order.length - 1];
    const copy = { ...element };
    if (!copy.index) copy.index = keyBetween(last ? last.index : undefined, undefined);
    this.byId.set(copy.id, copy);
    this.resort();
    return copy;
  }

  /** Apply a field patch and stamp the change. Internal — call via actions.js. */
  patch(id, changes) {
    const element = this.byId.get(id);
    if (!element) return null;
    Object.assign(element, changes);
    stampChange(element);
    if ("index" in changes) this.resort();
    return element;
  }

  remove(id) {
    return this.patch(id, { isDeleted: true });
  }

  restore(id) {
    return this.patch(id, { isDeleted: false });
  }

  /** Index that places an element directly above `target`. */
  indexAbove(target) {
    const list = this.order;
    const at = list.indexOf(target);
    const next = list[at + 1];
    return keyBetween(target.index, next ? next.index : undefined);
  }

  indexBelow(target) {
    const list = this.order;
    const at = list.indexOf(target);
    const previous = list[at - 1];
    return keyBetween(previous ? previous.index : undefined, target.index);
  }

  indexTop() {
    const last = this.order[this.order.length - 1];
    return keyBetween(last ? last.index : undefined, undefined);
  }

  indexBottom() {
    const first = this.order[0];
    return keyBetween(undefined, first ? first.index : undefined);
  }

  /** Plain array for saving/exporting. */
  toJSON() {
    return this.order.map((element) => ({ ...element }));
  }

  get length() {
    return this.order.length;
  }
}
