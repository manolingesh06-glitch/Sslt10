// In-process replacement for the Firestore document your app used to read
// and write (splAuction/state). Everything here reimplements exactly the
// slice of Firestore behaviour index.html actually relies on:
//
//   - .set(fields, {merge:true}) does a DEEP merge on nested map fields
//     (this is load-bearing — see the big comment above saveLive() in
//     index.html; the app depends on this to avoid wiping out concurrent
//     writes from other devices).
//   - Dotted keys like "auctionState.5" address a nested field directly.
//   - FieldValue.delete() removes exactly the addressed field.
//   - FieldValue.serverTimestamp() is resolved server-side, not client-side
//     (so every device's clock-sync reads the same authoritative value).
//   - runTransaction()'s guarantee — a transaction always sees the latest
//     state and no other write can land in the middle of it — is what
//     stops two owners' simultaneous bids/passes from corrupting each
//     other. Firestore gets this via optimistic retry; here it's simpler
//     and just as correct: Node is single-threaded, so a FIFO queue that
//     lets exactly one transaction touch the doc at a time is sufficient
//     and needs no retries at all.
//
// State is persisted to SQLite (the same admin.db your accounts/auctions
// already live in) after every write, so a server restart mid-auction
// doesn't lose the live bidding state.

const db = require('./db');

function loadDoc() {
  const row = db.get(`SELECT data FROM live_state WHERE id = 1`);
  try {
    return row ? JSON.parse(row.data) : {};
  } catch (e) {
    console.error('live_state was corrupt, starting fresh', e);
    return {};
  }
}

function persistDoc(doc) {
  db.run(`UPDATE live_state SET data = ? WHERE id = 1`, [JSON.stringify(doc)]);
}

let doc = loadDoc();

function isPlainObject(v) {
  return typeof v === 'object' && v !== null && !Array.isArray(v);
}
function isDeleteSentinel(v) {
  return isPlainObject(v) && v.__op === 'delete';
}
function isServerTimestampSentinel(v) {
  return isPlainObject(v) && v.__op === 'serverTimestamp';
}

function setOrMergeLeaf(target, key, value, now) {
  if (isDeleteSentinel(value)) {
    delete target[key];
    return;
  }
  if (isServerTimestampSentinel(value)) {
    target[key] = { __ts: now };
    return;
  }
  if (isPlainObject(value)) {
    if (!isPlainObject(target[key])) target[key] = {};
    mergeInto(target[key], value, now);
    return;
  }
  // Arrays and primitives are atomic in Firestore's merge semantics too —
  // a new array value fully replaces the old one, it's never merged
  // element-by-element.
  target[key] = value;
}

function mergeInto(target, source, now) {
  now = now || Date.now();
  for (const rawKey of Object.keys(source)) {
    const value = source[rawKey];
    if (rawKey.includes('.')) {
      const parts = rawKey.split('.');
      let cursor = target;
      for (let i = 0; i < parts.length - 1; i++) {
        const p = parts[i];
        if (!isPlainObject(cursor[p])) cursor[p] = {};
        cursor = cursor[p];
      }
      setOrMergeLeaf(cursor, parts[parts.length - 1], value, now);
    } else {
      setOrMergeLeaf(target, rawKey, value, now);
    }
  }
}

// Builds a copy of an update payload with sentinels resolved to concrete
// values (serverTimestamp -> the same `now` used to write the doc; delete
// stays a delete marker) so it's safe to broadcast to every client as a
// small PATCH instead of re-sending the entire (potentially huge) doc.
function resolveSentinelsDeep(source, now) {
  if (isDeleteSentinel(source)) return source;
  if (isServerTimestampSentinel(source)) return { __ts: now };
  if (isPlainObject(source)) {
    const out = {};
    for (const k of Object.keys(source)) out[k] = resolveSentinelsDeep(source[k], now);
    return out;
  }
  return source; // primitives and arrays are copied by reference, that's fine
}

function getDoc() {
  return doc;
}

function applySet(updates) {
  const now = Date.now();
  mergeInto(doc, updates || {}, now);
  persistDoc(doc);
  const patch = resolveSentinelsDeep(updates || {}, now);
  return { doc, patch };
}

// ---------------- Transaction queue ----------------
// Only one live document exists, so a single global lock is all that's
// needed. Requests queue up FIFO and each gets the doc exactly as it stood
// the instant its turn started — nobody can read stale data and clobber a
// write that landed in between, which is the entire point of Firestore
// transactions in the original code.

let lockHolder = null; // socket.id currently holding the lock, or null
let currentTxId = null;
let lockTimer = null;
const queue = [];
const TX_TIMEOUT_MS = 8000; // safety net if a client goes silent mid-transaction

function grantLock(socketId, resolve) {
  lockHolder = socketId;
  currentTxId = Math.random().toString(36).slice(2) + Date.now().toString(36);
  clearTimeout(lockTimer);
  lockTimer = setTimeout(() => {
    if (lockHolder === socketId) releaseLock();
  }, TX_TIMEOUT_MS);
  resolve({ txId: currentTxId, doc: getDoc() });
}

function beginTransaction(socketId) {
  return new Promise((resolve) => {
    if (lockHolder === null) grantLock(socketId, resolve);
    else queue.push(() => grantLock(socketId, resolve));
  });
}

function releaseLock() {
  clearTimeout(lockTimer);
  lockHolder = null;
  currentTxId = null;
  const next = queue.shift();
  if (next) next();
}

function commitTransaction(socketId, txId, updates) {
  if (lockHolder !== socketId || txId !== currentTxId) {
    throw new Error('Transaction expired — please try again.');
  }
  const result = applySet(updates || {});
  releaseLock();
  return result;
}

function abortTransaction(socketId, txId) {
  if (lockHolder === socketId && txId === currentTxId) releaseLock();
}

function releaseIfHeldBy(socketId) {
  if (lockHolder === socketId) releaseLock();
}

module.exports = {
  getDoc,
  applySet,
  beginTransaction,
  commitTransaction,
  abortTransaction,
  releaseIfHeldBy,
};
