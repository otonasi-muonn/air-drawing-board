import type { Work } from '../domain/drawing';

export const WORKS_STORAGE_KEY = 'airboard.works.v1';

export interface StorageLike {
  getItem(key: string): string | null;
  setItem(key: string, value: string): void;
}

export interface WorkStore {
  loadWorks(): Work[];
  saveWorks(works: readonly Work[]): void;
  addWork(data: string, now?: number): Work;
  toggleApproval(id: string): Work | undefined;
  deleteWork(id: string): void;
  exportJson(): string;
}

function isValidWorkRecord(item: unknown): item is Work {
  if (!item || typeof item !== 'object') return false;
  const candidate = item as Record<string, unknown>;
  return typeof candidate.id === 'string' && typeof candidate.data === 'string';
}

/**
 * localStorage ベースの WorkStore 実装（現行 JSON 形式と完全互換）。
 */
export function createLocalStorageWorkStore(
  // localStorageのgetter自体がSecurityErrorになる環境でも描画を起動できる。
  storage: StorageLike = {
    getItem(key) { return globalThis.localStorage.getItem(key); },
    setItem(key, value) { globalThis.localStorage.setItem(key, value); },
  },
  key: string = WORKS_STORAGE_KEY
): WorkStore {
  function loadWorks(): Work[] {
    try {
      const raw = storage.getItem(key);
      if (!raw) return [];
      const parsed: unknown = JSON.parse(raw);
      if (!Array.isArray(parsed)) return [];
      const works: Work[] = [];
      for (const item of parsed) {
        if (isValidWorkRecord(item)) {
          works.push({
            id: item.id,
            ts: typeof item.ts === 'number' ? item.ts : 0,
            data: item.data,
            approved: Boolean(item.approved),
          });
        }
      }
      return works;
    } catch {
      return [];
    }
  }

  function saveWorks(works: readonly Work[]): void {
    storage.setItem(key, JSON.stringify(works));
  }

  function addWork(data: string, now: number = Date.now()): Work {
    const works = loadWorks();
    const baseId = now.toString(36);
    let id = baseId;
    let suffix = 1;
    while (works.some(w => w.id === id)) {
      id = `${baseId}_${suffix++}`;
    }
    const work: Work = {
      id,
      ts: now,
      data,
      approved: false,
    };
    works.push(work);
    saveWorks(works);
    return work;
  }

  function toggleApproval(id: string): Work | undefined {
    const all = loadWorks();
    const target = all.find(w => w.id === id);
    if (!target) return undefined;
    target.approved = !target.approved;
    saveWorks(all);
    return { ...target };
  }

  function deleteWork(id: string): void {
    const remaining = loadWorks().filter(w => w.id !== id);
    saveWorks(remaining);
  }

  function exportJson(): string {
    return JSON.stringify(loadWorks(), null, 2);
  }

  return {
    loadWorks,
    saveWorks,
    addWork,
    toggleApproval,
    deleteWork,
    exportJson,
  };
}
