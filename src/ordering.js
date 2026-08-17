// Fractional indexing — element order lives in the element, not in the array.
//
// Why: array position cannot be merged. If two devices each reorder, there is
// no way to combine the results. An index string travels with the element, so
// reordering becomes an ordinary field change that merges like any other
// (Build_Plan 5-1, Expansion_Plan 2-3).
//
// The array in scene.js is only a sorted cache of these keys.
//
// Algorithm follows the well-known base-62 order-key scheme: a one-character
// "integer head" encodes how many digits the integer part has, and an optional
// fractional tail is inserted between neighbours.
//
// Pure module — no DOM. Tested in tests/ordering.test.mjs.

const DIGITS = "0123456789ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz";
const SMALLEST = DIGITS[0];
const LARGEST = DIGITS[DIGITS.length - 1];

function headLength(head) {
  if (head >= "a" && head <= "z") return head.charCodeAt(0) - 97 + 2;
  if (head >= "A" && head <= "Z") return 90 - head.charCodeAt(0) + 2;
  throw new Error(`invalid order key head: ${head}`);
}

function integerPart(key) {
  const length = headLength(key[0]);
  if (length > key.length) throw new Error(`invalid order key: ${key}`);
  return key.slice(0, length);
}

function validate(key) {
  if (key === undefined) return;
  if (key === null || key === "") throw new Error(`invalid order key: ${key}`);
  const integer = integerPart(key);
  const fraction = key.slice(integer.length);
  if (fraction.endsWith(SMALLEST)) throw new Error(`invalid order key: ${key}`);
  for (const character of key) {
    if (!DIGITS.includes(character)) throw new Error(`invalid order key: ${key}`);
  }
}

function incrementInteger(integer) {
  const head = integer[0];
  const digits = integer.slice(1).split("");
  let carry = true;
  for (let i = digits.length - 1; carry && i >= 0; i -= 1) {
    const next = DIGITS.indexOf(digits[i]) + 1;
    if (next === DIGITS.length) {
      digits[i] = SMALLEST;
    } else {
      digits[i] = DIGITS[next];
      carry = false;
    }
  }
  if (carry) {
    if (head === "z") return `a${LARGEST}`.padEnd(headLength("a") + 1, LARGEST);
    if (head === "Z") return `a${SMALLEST}`;
    const nextHead = String.fromCharCode(head.charCodeAt(0) + 1);
    if (head < "a") return nextHead + SMALLEST.repeat(headLength(nextHead) - 1);
    return nextHead + digits.join("") + SMALLEST;
  }
  return head + digits.join("");
}

function decrementInteger(integer) {
  const head = integer[0];
  const digits = integer.slice(1).split("");
  let borrow = true;
  for (let i = digits.length - 1; borrow && i >= 0; i -= 1) {
    const next = DIGITS.indexOf(digits[i]) - 1;
    if (next === -1) {
      digits[i] = LARGEST;
    } else {
      digits[i] = DIGITS[next];
      borrow = false;
    }
  }
  if (borrow) {
    if (head === "a") return `Z${LARGEST}`;
    if (head === "A") return null;
    const previousHead = String.fromCharCode(head.charCodeAt(0) - 1);
    if (head > "Z") return previousHead + digits.join("").slice(0, -1);
    return previousHead + LARGEST.repeat(headLength(previousHead) - 1);
  }
  return head + digits.join("");
}

function midpoint(lower, upper) {
  if (upper !== null && lower >= upper) {
    throw new Error(`${lower} >= ${upper}`);
  }
  if (lower.endsWith(SMALLEST) || (upper && upper.endsWith(SMALLEST))) {
    throw new Error("trailing zero");
  }
  if (upper) {
    // Skip the common prefix, then recurse on the remainder.
    let shared = 0;
    while ((lower[shared] || SMALLEST) === upper[shared]) shared += 1;
    if (shared > 0) {
      return upper.slice(0, shared) + midpoint(lower.slice(shared), upper.slice(shared));
    }
  }
  const lowerDigit = lower ? DIGITS.indexOf(lower[0]) : 0;
  const upperDigit = upper ? DIGITS.indexOf(upper[0]) : DIGITS.length;
  if (upperDigit - lowerDigit > 1) {
    return DIGITS[Math.round(0.5 * (lowerDigit + upperDigit))];
  }
  if (upper && upper.length > 1) return upper.slice(0, 1);
  return DIGITS[lowerDigit] + midpoint(lower.slice(1), null);
}

/**
 * Return a key strictly between `lower` and `upper`.
 * Pass undefined for either end to append/prepend.
 */
export function keyBetween(lower, upper) {
  validate(lower);
  validate(upper);
  if (lower !== undefined && upper !== undefined && lower >= upper) {
    throw new Error(`${lower} >= ${upper}`);
  }
  if (lower === undefined && upper === undefined) return "a0";

  if (lower === undefined) {
    const upperInteger = integerPart(upper);
    const upperFraction = upper.slice(upperInteger.length);
    if (upperInteger === "A" + SMALLEST.repeat(headLength("A") - 1)) {
      return upperInteger + midpoint("", upperFraction);
    }
    if (upperInteger < upper) return upperInteger;
    const decremented = decrementInteger(upperInteger);
    if (decremented === null) throw new Error("cannot decrement any further");
    return decremented;
  }

  const lowerInteger = integerPart(lower);
  if (upper === undefined) {
    const incremented = incrementInteger(lowerInteger);
    return incremented === null
      ? lowerInteger + midpoint(lower.slice(lowerInteger.length), null)
      : incremented;
  }

  const upperInteger = integerPart(upper);
  if (lowerInteger === upperInteger) {
    return lowerInteger + midpoint(lower.slice(lowerInteger.length), upper.slice(upperInteger.length));
  }
  const incremented = incrementInteger(lowerInteger);
  if (incremented === null) throw new Error("cannot increment any further");
  if (incremented < upper) return incremented;
  return lowerInteger + midpoint(lower.slice(lowerInteger.length), null);
}

/** N keys in ascending order between the two bounds. */
export function keysBetween(lower, upper, count) {
  if (count <= 0) return [];
  if (count === 1) return [keyBetween(lower, upper)];
  const keys = [];
  let cursor = lower;
  for (let i = 0; i < count; i += 1) {
    cursor = keyBetween(cursor, upper);
    keys.push(cursor);
  }
  return keys;
}

/** Ascending comparison usable directly by Array#sort. */
export function compareIndex(a, b) {
  const left = a.index;
  const right = b.index;
  const leftKeyed = typeof left === "string" && left !== "";
  const rightKeyed = typeof right === "string" && right !== "";

  // An element with NO key carries no ordering information, so the array it
  // arrived in is the only order there is — and ensureIndices() is about to
  // turn that order into keys. Treating a missing key as "" and then breaking
  // the tie on id scrambles the whole set: a drawing that arrives without keys
  // (an older Excalidraw export, a hand-written file) came out in a random
  // order, front to back. Array.prototype.sort is stable, so returning 0 here
  // keeps the caller's order intact.
  if (!leftKeyed) return rightKeyed ? 1 : 0;      // unkeyed goes on top
  if (!rightKeyed) return -1;

  // Two elements that genuinely hold the SAME key still need a deterministic
  // answer, and it has to be one two devices reach independently — hence the
  // id, not the array position (Expansion_Plan 2-3).
  if (left === right) return a.id < b.id ? -1 : a.id > b.id ? 1 : 0;
  return left < right ? -1 : 1;
}

/**
 * Give every element a valid index without changing the visible order.
 * Used when importing files that predate fractional indexing, and as a repair
 * step when a file arrives with duplicate or missing keys.
 */
export function ensureIndices(elements) {
  let previous;
  let changed = false;
  for (const element of elements) {
    const valid = typeof element.index === "string"
      && element.index.length > 0
      && (previous === undefined || element.index > previous);
    if (!valid) {
      element.index = keyBetween(previous, undefined);
      changed = true;
    }
    previous = element.index;
  }
  return changed;
}
