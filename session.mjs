export const LEGACY_KEY = 'doi-desk-session-v1';
export const FAILURE_KEY = 'doi-desk-save-failed';
export const DATABASE_NAME = 'doi-desk-sessions';

// Keep the large snapshot out of localStorage. Each write resolves only after
// transaction completion, not merely after the put request succeeds.
export function createIndexedDBBackend(factory = globalThis.indexedDB) {
  function open() {
    return new Promise((resolve, reject) => {
      if (!factory) { reject(new Error('IndexedDB 不可用')); return; }
      let settled = false;
      const request = factory.open(DATABASE_NAME, 1);
      const timer = setTimeout(() => fail(new Error('打开本地存储超时')), 10000);
      function fail(error) {
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        reject(error);
      }
      request.onupgradeneeded = () => {
        if (!request.result.objectStoreNames.contains('session')) request.result.createObjectStore('session');
      };
      request.onblocked = () => fail(new Error('本地存储被其他窗口占用'));
      request.onerror = () => fail(request.error || new Error('无法打开本地存储'));
      request.onsuccess = () => {
        if (settled) { request.result.close(); return; }
        settled = true;
        clearTimeout(timer);
        resolve(request.result);
      };
    });
  }

  async function run(mode, operate) {
    const db = await open();
    try {
      return await new Promise((resolve, reject) => {
        const transaction = db.transaction('session', mode);
        let result = () => undefined;
        transaction.oncomplete = () => resolve(result());
        transaction.onabort = () => reject(transaction.error || new Error('本地存储事务未完成'));
        try { result = operate(transaction.objectStore('session')) || result; }
        catch (error) { transaction.abort(); reject(error); }
      });
    } finally { db.close(); }
  }

  return {
    read: () => run('readonly', store => {
      const snapshot = store.get('snapshot'), pending = store.get('pending');
      return () => ({snapshot: snapshot.result, pending: pending.result});
    }),
    // Commit this small marker separately. A failed snapshot transaction must
    // leave evidence that the previous snapshot is no longer the latest work.
    markPending: () => run('readwrite', store => { store.put(true, 'pending'); }),
    commit: snapshot => run('readwrite', store => {
      store.put(snapshot, 'snapshot');
      store.put(false, 'pending');
    }),
    clear: () => run('readwrite', store => {
      // An explicit empty value also prevents an old v1 backup resurfacing.
      store.put(null, 'snapshot');
      store.put(false, 'pending');
    }),
  };
}

// Serialize writes and clearing so an older async save cannot finish last.
// Injecting the backend lets the queue and failure/recovery policy be tested
// without substituting a fake implementation for IndexedDB in the browser.
export function createSessionStore({backend = createIndexedDBBackend(), legacyStorage = () => globalThis.localStorage} = {}) {
  let tail = Promise.resolve();
  function enqueue(operation) {
    const result = tail.then(operation);
    tail = result.catch(() => {});
    return result;
  }
  function removeLegacy() { legacyStorage()?.removeItem(LEGACY_KEY); }
  function failedPreviously() {
    try { return legacyStorage()?.getItem(FAILURE_KEY) === '1'; } catch { return false; }
  }
  function recordFailure() {
    // A tiny fallback marker also covers failure to commit the IDB pending flag.
    try { legacyStorage()?.setItem(FAILURE_KEY, '1'); } catch {}
  }
  function clearFailure() {
    if (failedPreviously()) legacyStorage().removeItem(FAILURE_KEY);
  }
  return {
    load: () => enqueue(async () => {
      if (failedPreviously()) return {snapshot: null, incomplete: true};
      const saved = await backend.read();
      if (saved.pending) return {snapshot: null, incomplete: true};
      if (saved.snapshot !== undefined) return {snapshot: saved.snapshot, incomplete: false};
      const legacy = JSON.parse(legacyStorage()?.getItem(LEGACY_KEY) || 'null');
      return {snapshot: legacy, incomplete: false, legacy: !!legacy};
    }),
    save: snapshot => enqueue(async () => {
      let marked = false;
      try {
        await backend.markPending();
        marked = true;
        await backend.commit(snapshot);
        clearFailure();
        // The durable v2 snapshot takes precedence even if v1 cleanup is denied.
        try { removeLegacy(); } catch {}
      } catch (error) {
        recordFailure();
        // If even the pending marker failed, try invalidating the old snapshot.
        if (!marked) { try { await backend.clear(); } catch {} }
        throw error;
      }
    }),
    clear: () => enqueue(async () => {
      try {
        await backend.clear();
        removeLegacy();
        clearFailure();
      } catch (error) { recordFailure(); throw error; }
    }),
  };
}
