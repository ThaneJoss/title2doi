import test from 'node:test';
import assert from 'node:assert/strict';
import {createSessionStore, LEGACY_KEY, FAILURE_KEY} from '../session.mjs';

function fixture({legacy = null} = {}) {
  let persisted = {}, failCommit = false, failCleanup = false;
  const values = new Map(legacy ? [[LEGACY_KEY, JSON.stringify(legacy)]] : []);
  const events = [];
  const backend = {
    read: async () => structuredClone(persisted),
    markPending: async () => { events.push('pending'); persisted.pending = true; },
    commit: async snapshot => {
      events.push('commit');
      if (failCommit) throw new Error('QuotaExceededError');
      persisted = {snapshot: structuredClone(snapshot), pending: false};
    },
    clear: async () => { events.push('clear'); persisted = {snapshot: null, pending: false}; },
  };
  const storage = {
    getItem: key => values.get(key) ?? null,
    setItem: (key, value) => { values.set(key, value); },
    removeItem: key => { if (failCleanup) throw new Error('Storage denied'); values.delete(key); },
  };
  return {
    backend, storage, events, values,
    store: () => createSessionStore({backend, legacyStorage: () => storage}),
    failCommit: value => { failCommit = value; },
    failCleanup: value => { failCleanup = value; },
  };
}
const snapshot = label => ({version: 2, sourceName: label, items: [{raw: {type: 'book', title: label}, confirmed: false}]});

test('large snapshots never use localStorage, and retain data after reload', async () => {
  const f = fixture(), session = snapshot('large.json');
  session.items[0].raw.abstract = 'x'.repeat(6 * 1024 * 1024);
  const store = f.store();
  await store.save(session);
  const loaded = await f.store().load();
  assert.deepEqual(loaded.snapshot, session);
  assert.equal(f.values.size, 0);
});

test('a failed replacement is marked incomplete instead of restoring the previous batch', async () => {
  const f = fixture(), store = f.store();
  await store.save(snapshot('old.json'));
  f.failCommit(true);
  await assert.rejects(store.save(snapshot('new.json')), /QuotaExceededError/);
  assert.deepEqual(await f.store().load(), {snapshot: null, incomplete: true});
  f.failCommit(false);
  await store.save(snapshot('new.json'));
  assert.equal((await f.store().load()).snapshot.sourceName, 'new.json');
});

test('legacy progress is retained until a durable replacement succeeds', async () => {
  const legacy = {...snapshot('legacy.json'), version: 1};
  const f = fixture({legacy}), store = f.store();
  assert.deepEqual(await store.load(), {snapshot: legacy, incomplete: false, legacy: true});
  f.failCommit(true);
  await assert.rejects(store.save({...legacy, version: 2}), /QuotaExceededError/);
  assert.ok(f.values.has(LEGACY_KEY));
  f.failCommit(false);
  await store.save({...legacy, version: 2});
  assert.equal(f.values.has(LEGACY_KEY), false);
  assert.equal((await f.store().load()).snapshot.version, 2);
});

test('cleared sessions cannot resurrect a stale legacy snapshot', async () => {
  const f = fixture({legacy: {...snapshot('stale.json'), version: 1}});
  f.failCleanup(true);
  await assert.rejects(f.store().clear(), /Storage denied/);
  assert.ok(f.values.has(LEGACY_KEY));
  assert.deepEqual(await f.store().load(), {snapshot: null, incomplete: true});
});

test('saves and clearing remain ordered when a write is delayed', async () => {
  const f = fixture(), commit = f.backend.commit;
  let release, entered;
  const blocked = new Promise(resolve => { release = resolve; });
  const started = new Promise(resolve => { entered = resolve; });
  let calls = 0;
  f.backend.commit = async value => {
    if (++calls === 1) { entered(); await blocked; }
    await commit(value);
  };
  const store = f.store(), first = store.save(snapshot('first.json'));
  await started;
  const second = store.save(snapshot('second.json')), cleared = store.clear();
  assert.deepEqual(f.events, ['pending']);
  release();
  await Promise.all([first, second, cleared]);
  assert.deepEqual(f.events, ['pending', 'commit', 'pending', 'commit', 'clear']);
  assert.equal((await store.load()).snapshot, null);
});

test('legacy cleanup failure never hides the committed snapshot', async () => {
  const f = fixture({legacy: snapshot('old.json')});
  f.failCleanup(true);
  await f.store().save(snapshot('new.json'));
  assert.equal((await f.store().load()).snapshot.sourceName, 'new.json');
});

test('failure of the pending transaction leaves a small fallback marker', async () => {
  const f = fixture(), store = f.store();
  await store.save(snapshot('old.json'));
  f.backend.markPending = async () => { throw new Error('IDB unavailable'); };
  f.backend.clear = async () => { throw new Error('IDB unavailable'); };
  await assert.rejects(store.save(snapshot('new.json')), /IDB unavailable/);
  assert.equal(f.values.get(FAILURE_KEY), '1');
  assert.deepEqual(await f.store().load(), {snapshot: null, incomplete: true});
});

test('IndexedDB still saves when localStorage is entirely unavailable', async () => {
  const f = fixture();
  const store = createSessionStore({backend: f.backend, legacyStorage: () => { throw new Error('Storage denied'); }});
  await store.save(snapshot('saved.json'));
  assert.equal((await store.load()).snapshot.sourceName, 'saved.json');
});
