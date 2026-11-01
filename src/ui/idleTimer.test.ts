import { describe, expect, it, vi } from 'vitest';
import { createIdleTimer } from './idleTimer';

describe('idleTimer', () => {
  it('shows attract after 90s on empty draw screen and hides on poke', () => {
    let view: 'draw' | 'board' | 'done' | 'restore' = 'draw';
    let hasContent = false;
    const onShowAttract = vi.fn();
    const onHideAttract = vi.fn();
    const onResetDone = vi.fn();

    const timer = createIdleTimer({
      getView: () => view,
      hasContent: () => hasContent,
      onShowAttract,
      onHideAttract,
      onResetDone,
      initialTime: 1000,
    });

    timer.check(1000 + 89999);
    expect(onShowAttract).not.toHaveBeenCalled();

    timer.check(1000 + 90001);
    expect(onShowAttract).toHaveBeenCalledTimes(1);

    timer.poke(1000 + 95000);
    expect(onHideAttract).toHaveBeenCalledTimes(1);
  });

  it('never shows attract and never resets when drawing has strokes or active stroke (編集中消さない)', () => {
    let hasContent = true;
    const onShowAttract = vi.fn();
    const onHideAttract = vi.fn();
    const onResetDone = vi.fn();

    const timer = createIdleTimer({
      getView: () => 'draw',
      hasContent: () => hasContent,
      onShowAttract,
      onHideAttract,
      onResetDone,
      initialTime: 0,
    });

    timer.check(200000);
    expect(onShowAttract).not.toHaveBeenCalled();
    expect(onResetDone).not.toHaveBeenCalled();
  });

  it('resets done screen after 120s of inactivity and respects camera/pointer poke', () => {
    let view: 'draw' | 'board' | 'done' | 'restore' = 'done';
    const onShowAttract = vi.fn();
    const onHideAttract = vi.fn();
    const onResetDone = vi.fn();

    const timer = createIdleTimer({
      getView: () => view,
      hasContent: () => true,
      onShowAttract,
      onHideAttract,
      onResetDone,
      initialTime: 0,
    });

    timer.check(110000);
    expect(onResetDone).not.toHaveBeenCalled();

    // Camera or pointer activity at 110s resets idle clock
    timer.poke(110000);
    timer.check(200000);
    expect(onResetDone).not.toHaveBeenCalled();

    timer.check(230001);
    expect(onResetDone).toHaveBeenCalledTimes(1);
  });
});
