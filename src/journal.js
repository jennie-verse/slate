import { localDate, localIso, mergeBoardActivity } from "./journal-record.js";
import { webappDataConfig } from "./deployment.js";

const ENABLED_KEY = "slate.journalEnabled.v1";
const ACTIVITY_KEY = "slate.journalActivity.v1";
const TOKEN_KEY = "sync.token.v1";
const CONTEXT_KEY = "slate.syncContextId";
const CONTEXT_LABEL_KEY = "slate.syncContextLabel";
let clientPromise = null;
let lastState = { status: "not reported", pendingCount: 0, errorCode: "" };

function readItem(key) { try { return localStorage.getItem(key) || ""; } catch { return ""; } }
function writeItem(key, value) { try { localStorage.setItem(key, value); return true; } catch { return false; } }
function parse(value, fallback) { try { return JSON.parse(value); } catch { return fallback; } }
function safeCode(error, fallback) { return typeof error?.code === "string" && /^[A-Z0-9_-]{1,64}$/.test(error.code) ? error.code : fallback; }

function activityMap() {
  const value = parse(readItem(ACTIVITY_KEY), {});
  return value && typeof value === "object" && !Array.isArray(value) ? value : {};
}

function saveActivityMap(value) {
  const cutoff = new Date();
  cutoff.setDate(cutoff.getDate() - 45);
  const cutoffDate = localDate(cutoff);
  writeItem(ACTIVITY_KEY, JSON.stringify(Object.fromEntries(Object.entries(value).filter(([key]) => key.slice(0, 10) >= cutoffDate))));
}

async function sharedV1() { return import("../../shared/v1/sync.js"); }

export function isJournalEnabled() { return readItem(ENABLED_KEY) === "1"; }
export function getJournalState() { return { enabled: isJournalEnabled(), ...lastState }; }
export function hasToken() { return Boolean(readItem(TOKEN_KEY)); }
export function tokenHint() { const token = readItem(TOKEN_KEY); return token ? `Saved · ends ${token.slice(-4)}` : "No token saved"; }
export function contextLabel() { return readItem(CONTEXT_LABEL_KEY); }
export function saveToken(token) { const value = String(token || "").trim(); return value ? writeItem(TOKEN_KEY, value) : false; }

/**
 * Forget the saved credential.
 *
 * The key is shared by every app served from this origin, so this clears it for
 * all of them — that is the point: one token, one place to remove it. Without
 * this there was no way at all to take a private-repo credential back off the
 * device short of clearing site data.
 */
export function removeToken() {
  let removed = false;
  try { localStorage.removeItem(TOKEN_KEY); removed = true; } catch { removed = false; }
  clientPromise = null;
  return removed;
}

async function ensureContext(preferredName) {
  let context = readItem(CONTEXT_KEY);
  if (!context) {
    const shared = await sharedV1();
    context = await shared.ensureContextId("slate", () => String(preferredName || "").trim());
  }
  if (preferredName) writeItem(CONTEXT_LABEL_KEY, String(preferredName).trim());
  return context;
}

async function getClient() {
  if (clientPromise) {
    const existing = await clientPromise;
    if (existing) return existing;
    clientPromise = null;
  }
  clientPromise = (async () => {
    const context = readItem(CONTEXT_KEY);
    if (!context) return null;
    const module = await import("../../shared/v2/journal.js");
    return module.createJournalClient({
      app: "slate", context, namespace: "slate-journal", isEnabled: isJournalEnabled,
      resolveConfig: async () => {
        const token = readItem(TOKEN_KEY);
        if (!token) throw Object.assign(new Error("Journal authentication unavailable"), { code: "AUTH" });
        return webappDataConfig(token);
      },
      onState: state => { lastState = { ...lastState, status: state.status, pendingCount: state.pendingCount, errorCode: state.errorCode || "", lastSuccessfulWriteAt: state.lastSuccessfulWriteAt }; },
    });
  })().catch(() => null);
  return clientPromise;
}

export async function toggleJournal(enabled, preferredName = "") {
  if (enabled) {
    if (!hasToken()) return { ok: false, reason: "token" };
    try { await ensureContext(preferredName); } catch { return { ok: false, reason: "context" }; }
  }
  writeItem(ENABLED_KEY, enabled ? "1" : "0");
  clientPromise = null;
  lastState = { ...lastState, status: enabled ? "ready" : "disabled", errorCode: "" };
  await reportStatus({ enabledAt: enabled ? localIso() : undefined });
  return { ok: true };
}

export async function reportStatus(extra = {}) {
  const client = await getClient();
  if (!client) return false;
  try { await client.reportStatus({ journalEnabled: isJournalEnabled(), ...extra }); return true; }
  catch (error) { lastState = { ...lastState, status: "error", errorCode: safeCode(error, "STATUS_FAILED") }; return false; }
}

export async function recordActivity(board, action, { at = new Date(), importedHistory = false } = {}) {
  if (!board?.id || !isJournalEnabled()) return false;
  const date = localDate(at);
  const key = `${date}:${board.id}`;
  const saved = activityMap();
  const record = mergeBoardActivity(saved[key], board, action, at, { importedHistory });
  saved[key] = record;
  saveActivityMap(saved);
  const client = await getClient();
  if (!client) { lastState = { ...lastState, status: "error", errorCode: "MODULE_UNAVAILABLE" }; return false; }
  try { await client.enqueue(record, { date }); return true; }
  catch (error) { lastState = { ...lastState, status: "error", errorCode: safeCode(error, "QUEUE_FAILED") }; return false; }
}

export async function backfillJournal(boards, { from, to }) {
  const client = await getClient();
  if (!client) return { written: 0, error: new Error("Journal unavailable"), records: 0, dates: 0 };
  const projected = [];
  for (const board of boards) {
    if (!board?.id || board.deletedAt) continue;
    const created = localDate(board.createdAt);
    const updated = localDate(board.updatedAt);
    if (created >= from && created <= to) projected.push(mergeBoardActivity(null, board, "created", board.createdAt, { importedHistory: true }));
    if (updated !== created && updated >= from && updated <= to) projected.push(mergeBoardActivity(null, board, "edited", board.updatedAt, { importedHistory: true }));
  }
  const dates = new Set(projected.map(record => localDate(record.at)));
  await reportStatus({ backfill: { status: "running", from, to, processedDates: 0, totalDates: dates.size, updatedAt: localIso() } });
  for (const record of projected) await client.enqueue(record, { date: localDate(record.at) });
  const result = await client.flush();
  await reportStatus({ backfill: { status: result.error ? "partial" : "complete", from, to, processedDates: result.error ? 0 : dates.size, totalDates: dates.size, updatedAt: localIso() } });
  return { ...result, records: projected.length, dates: dates.size };
}

export async function refreshJournalState() {
  const client = await getClient();
  if (client) { try { lastState.pendingCount = await client.pendingCount(); } catch { /* status only */ } }
  return getJournalState();
}
