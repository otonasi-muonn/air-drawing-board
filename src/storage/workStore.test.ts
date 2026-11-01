import { describe, expect, it } from 'vitest';
import {
  WORKS_STORAGE_KEY,
  createLocalStorageWorkStore,
} from './workStore';

function createMemoryStorage(initial: Record<string, string> = {}) {
  const map = new Map<string, string>(Object.entries(initial));
  return {
    map,
    getItem(key: string) {
      return map.has(key) ? map.get(key)! : null;
    },
    setItem(key: string, val: string) {
      map.set(key, val);
    },
  };
}

describe('workStore', () => {
  it('keeps initialization available when the localStorage getter is denied and propagates write failure', () => {
    const original = Object.getOwnPropertyDescriptor(globalThis, 'localStorage');
    Object.defineProperty(globalThis, 'localStorage', {
      configurable: true,
      get() { throw new DOMException('storage denied', 'SecurityError'); },
    });
    try {
      const store = createLocalStorageWorkStore();
      expect(store.loadWorks()).toEqual([]);
      expect(() => store.addWork('drawing')).toThrow('storage denied');
    } finally {
      if (original) Object.defineProperty(globalThis, 'localStorage', original);
      else Reflect.deleteProperty(globalThis, 'localStorage');
    }
  });
  it('stores works under airboard.works.v1 with approved:false by default and keeps v1 JSON compatibility', () => {
    const storage = createMemoryStorage();
    const store = createLocalStorageWorkStore(storage);

    expect(store.loadWorks()).toEqual([]);

    const created = store.addWork('eJxjZGJkYGBMqQAAAWcA4g', 1730470000000);
    expect(created).toEqual({
      id: (1730470000000).toString(36),
      ts: 1730470000000,
      data: 'eJxjZGJkYGBMqQAAAWcA4g',
      approved: false,
    });

    const raw = storage.getItem(WORKS_STORAGE_KEY);
    expect(raw).toBeTruthy();
    expect(JSON.parse(raw!)).toEqual([created]);
  });

  it('toggles approval, deletes works, and exports formatted backup JSON', () => {
    const existing = [
      { id: 'w1', ts: 1000, data: 'd1', approved: false },
      { id: 'w2', ts: 2000, data: 'd2', approved: true },
    ];
    const storage = createMemoryStorage({
      [WORKS_STORAGE_KEY]: JSON.stringify(existing),
    });
    const store = createLocalStorageWorkStore(storage);

    const toggled = store.toggleApproval('w1');
    expect(toggled?.approved).toBe(true);
    expect(store.loadWorks()[0].approved).toBe(true);

    store.deleteWork('w2');
    expect(store.loadWorks()).toEqual([
      { id: 'w1', ts: 1000, data: 'd1', approved: true },
    ]);

    expect(JSON.parse(store.exportJson())).toEqual([
      { id: 'w1', ts: 1000, data: 'd1', approved: true },
    ]);
  });

  it('returns empty array on corrupted JSON and propagates quota errors on write', () => {
    const storage = createMemoryStorage({
      [WORKS_STORAGE_KEY]: '{invalid-json',
    });
    const store = createLocalStorageWorkStore(storage);
    expect(store.loadWorks()).toEqual([]);

    const quotaStorage = {
      getItem: () => '[]',
      setItem: () => {
        throw new Error('QuotaExceededError');
      },
    };
    const failingStore = createLocalStorageWorkStore(quotaStorage);
    expect(() => failingStore.addWork('abc')).toThrow('QuotaExceededError');
  });
});
