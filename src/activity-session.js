const DEFAULT_IDLE_MS = 5 * 60 * 1000;
const DEFAULT_CHECKPOINT_MS = 30 * 1000;

function pad(value) { return String(Math.abs(value)).padStart(2, '0'); }
export function localDate(value = new Date()) {
  const date = value instanceof Date ? value : new Date(value);
  if (Number.isNaN(date.getTime())) throw new Error('Invalid session date');
  return `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())}`;
}
export function localIso(value = new Date()) {
  const date = value instanceof Date ? value : new Date(value);
  if (Number.isNaN(date.getTime())) throw new Error('Invalid session timestamp');
  const offset = -date.getTimezoneOffset();
  const sign = offset >= 0 ? '+' : '-';
  return `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())}T${pad(date.getHours())}:${pad(date.getMinutes())}:${pad(date.getSeconds())}.${String(date.getMilliseconds()).padStart(3, '0')}${sign}${pad(Math.floor(Math.abs(offset) / 60))}:${pad(Math.abs(offset) % 60)}`;
}
function nextMidnight(ms) {
  const d = new Date(ms);
  return new Date(d.getFullYear(), d.getMonth(), d.getDate() + 1).getTime();
}
function makeId() {
  return globalThis.crypto?.randomUUID?.() || `session-${Date.now()}-${Math.random().toString(36).slice(2)}`;
}
function safeParse(value, fallback) { try { return JSON.parse(value); } catch { return fallback; } }
function readStorage(key, fallback) { try { return safeParse(localStorage.getItem(key) || '', fallback); } catch { return fallback; } }
function writeStorage(key, value) { try { localStorage.setItem(key, JSON.stringify(value)); } catch { /* best effort */ } }
function removeStorage(key) { try { localStorage.removeItem(key); } catch { /* best effort */ } }

export function sessionRecords(session, kind) {
  const start = Number(session?.startedAt);
  const end = Math.max(start, Number(session?.endedAt));
  if (!session?.id || !session?.itemId || !Number.isFinite(start) || !Number.isFinite(end) || end <= start) return [];
  const wall = Math.max(1, end - start);
  const totalActive = Math.max(0, Number(session.activeSeconds) || 0);
  const rows = [];
  let cursor = start;
  do {
    const segmentEnd = Math.min(end, nextMidnight(cursor));
    const date = localDate(new Date(cursor));
    const share = (segmentEnd - cursor) / wall;
    rows.push({
      id: `${session.id}:${date}`,
      kind,
      at: localIso(new Date(cursor)),
      updatedAt: localIso(new Date(segmentEnd)),
      deleted: false,
      title: String(session.title || 'Untitled'),
      data: {
        itemId: String(session.itemId),
        itemType: String(session.itemType || 'item'),
        startedAt: localIso(new Date(cursor)),
        endedAt: localIso(new Date(segmentEnd)),
        activeSeconds: Math.max(0, Math.round(totalActive * share)),
        contentIncluded: session.contentIncluded !== false,
        historyAccuracy: 'exact',
      },
    });
    cursor = segmentEnd;
  } while (cursor < end);
  return rows.filter((row) => row.data.activeSeconds > 0);
}

export function createSessionLedger(storageKey) {
  const read = () => {
    const rows = readStorage(storageKey, []);
    return Array.isArray(rows) ? rows : [];
  };
  const validate = (rows) => {
    if (!Array.isArray(rows)) throw new Error('Invalid session ledger');
    return rows.map((row) => {
      if (!row || typeof row.id !== 'string' || !row.id || !['reading-session', 'usage-session'].includes(row.kind)) throw new Error('Invalid session record');
      if (!row.data?.itemId || !Number.isFinite(Number(row.data.activeSeconds)) || Number(row.data.activeSeconds) < 0) throw new Error('Invalid session data');
      if (!Number.isFinite(Date.parse(row.at)) || !Number.isFinite(Date.parse(row.updatedAt))) throw new Error('Invalid session timestamp');
      return structuredClone(row);
    });
  };
  const replace = (rows, { merge = false } = {}) => {
    const incoming = validate(rows);
    const map = new Map((merge ? read() : []).map((row) => [row.id, row]));
    incoming.forEach((row) => {
      const current = map.get(row.id);
      if (!current || Date.parse(current.updatedAt) <= Date.parse(row.updatedAt)) map.set(row.id, row);
    });
    const cutoff = Date.now() - 90 * 86400000;
    const kept = [...map.values()].filter((row) => Date.parse(row.updatedAt) >= cutoff);
    writeStorage(storageKey, kept);
    return kept;
  };
  return { read, validate, replace };
}

export function createSessionTracker({
  kind, itemType, storageKey, onRecord = () => {}, idleMs = DEFAULT_IDLE_MS,
  checkpointMs = DEFAULT_CHECKPOINT_MS, now = () => Date.now(),
  isVisible = () => typeof document === 'undefined' || document.visibilityState === 'visible',
} = {}) {
  const ledger = createSessionLedger(storageKey);
  const activeKey = `${storageKey}.active`;
  let state = null;
  let timer = null;
  let currentItem = null;

  const saveCheckpoint = () => {
    if (!state) return;
    state.checkpointAt = now();
    writeStorage(activeKey, state);
  };
  const accrue = (target) => {
    if (!state) return;
    const cap = state.lastSignalAt + idleMs;
    const until = Math.min(target, cap);
    if (until > state.lastTickAt) state.activeSeconds += (until - state.lastTickAt) / 1000;
    state.lastTickAt = Math.max(state.lastTickAt, until);
  };
  const publish = (finished) => {
    const rows = sessionRecords(finished, kind);
    if (rows.length) {
      ledger.replace(rows, { merge: true });
      rows.forEach((row) => Promise.resolve(onRecord(row)).catch(() => {}));
    }
    return rows;
  };
  const stop = (at = now()) => {
    if (!state) return [];
    accrue(at);
    const finished = { ...state, endedAt: Math.min(at, state.lastSignalAt + idleMs) };
    state = null;
    removeStorage(activeKey);
    if (timer) clearInterval(timer);
    timer = null;
    return publish(finished);
  };
  const clearItem = (at = now()) => {
    if (state) stop(at);
    currentItem = null;
  };
  const heartbeat = () => {
    if (!state) return;
    const at = now();
    if (!isVisible()) { stop(at); return; }
    if (at >= state.lastSignalAt + idleMs) { stop(state.lastSignalAt + idleMs); return; }
    accrue(at);
    saveCheckpoint();
  };
  const start = (item, at = now()) => {
    if (!item?.id || !isVisible()) return false;
    if (state) stop(at);
    currentItem = { id: String(item.id), title: String(item.title || 'Untitled'), itemType: String(item.itemType || itemType || 'item'), contentIncluded: item.contentIncluded !== false };
    state = {
      id: makeId(), itemId: currentItem.id, title: currentItem.title, itemType: currentItem.itemType,
      contentIncluded: currentItem.contentIncluded, startedAt: at, lastTickAt: at,
      lastSignalAt: at, checkpointAt: at, activeSeconds: 0,
    };
    saveCheckpoint();
    timer = setInterval(heartbeat, checkpointMs);
    return true;
  };
  const signal = (at = now()) => {
    if (!state) return currentItem ? start(currentItem, at) : false;
    if (at >= state.lastSignalAt + idleMs) {
      const item = { ...currentItem };
      stop(state.lastSignalAt + idleMs);
      return start(item, at);
    }
    accrue(at);
    state.lastSignalAt = at;
    saveCheckpoint();
    return true;
  };
  const recover = () => {
    const saved = readStorage(activeKey, null);
    if (!saved?.id || !saved?.itemId) { removeStorage(activeKey); return []; }
    const end = Number(saved.checkpointAt);
    removeStorage(activeKey);
    if (!Number.isFinite(end) || end <= Number(saved.startedAt)) return [];
    return publish({ ...saved, endedAt: end });
  };
  recover();
  return { start, signal, stop, clearItem, heartbeat, exportSessions: ledger.read, validateSessions: ledger.validate, replaceSessions: ledger.replace, active: () => Boolean(state) };
}

