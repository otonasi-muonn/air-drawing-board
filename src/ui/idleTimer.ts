export type ViewName = 'draw' | 'board' | 'done' | 'restore';

export const ATTRACT_IDLE_MS = 90_000;
export const DONE_RESET_IDLE_MS = 120_000;

export interface IdleTimerOptions {
  getView: () => ViewName;
  hasContent: () => boolean;
  onShowAttract: () => void;
  onHideAttract: () => void;
  onResetDone: () => void;
  initialTime?: number;
}

export interface IdleTimer {
  poke(now?: number): void;
  check(now?: number): void;
  readonly lastPoke: number;
}

/**
 * アトラクト表示（空画面90秒無操作）および完了画面自動リセット（120秒無操作）を管理する。
 * 編集中（ストロークあり、または描画中）はアトラクト表示も消去も行わない。
 */
export function createIdleTimer(options: IdleTimerOptions): IdleTimer {
  let lastPoke = options.initialTime ?? Date.now();

  function poke(now: number = Date.now()): void {
    lastPoke = now;
    options.onHideAttract();
  }

  function check(now: number = Date.now()): void {
    const idle = now - lastPoke;
    const view = options.getView();

    if (view === 'draw' && !options.hasContent() && idle >= ATTRACT_IDLE_MS) {
      options.onShowAttract();
    } else if (view === 'done' && idle >= DONE_RESET_IDLE_MS) {
      lastPoke = now;
      options.onResetDone();
    }
  }

  return {
    poke,
    check,
    get lastPoke() {
      return lastPoke;
    },
  };
}
