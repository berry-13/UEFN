/**
 * Session clock. All test timeouts and event timestamps are measured on the
 * adapter's clock, so a simulated session can run faster than real time
 * without changing test semantics.
 */
export interface Clock {
  /** Milliseconds since the clock was created. */
  now(): number;
  sleep(ms: number): Promise<void>;
  /** Converts a session-clock duration into wall-clock milliseconds. */
  toWallMs(ms: number): number;
  /**
   * Optional: freezes session time (the debugger, docs/debugging.md). Only
   * clocks that own the session's notion of time can do this; a real
   * Fortnite session keeps running, so RealClock does not implement it.
   */
  pause?(): void;
  resume?(): void;
}

export class RealClock implements Clock {
  private readonly origin = performance.now();
  now(): number {
    return performance.now() - this.origin;
  }
  sleep(ms: number): Promise<void> {
    return new Promise((resolve) => setTimeout(resolve, Math.max(0, ms)));
  }
  toWallMs(ms: number): number {
    return ms;
  }
}

/**
 * Runs `scale` session milliseconds per wall-clock millisecond. Pausable:
 * while paused, `now()` stands still and `sleep()` does not complete, which
 * freezes the simulator (its tick loop sleeps on this clock).
 */
export class ScaledClock implements Clock {
  private readonly origin = performance.now();
  private pausedAt?: number;
  private pausedWallMs = 0;
  private resumeWaiters: (() => void)[] = [];
  constructor(private readonly scale: number) {
    if (!(scale > 0)) throw new Error("clock scale must be positive");
  }
  now(): number {
    return ((this.pausedAt ?? performance.now()) - this.origin - this.pausedWallMs) * this.scale;
  }
  async sleep(ms: number): Promise<void> {
    const target = this.now() + Math.max(0, ms);
    await wallSleep(Math.max(0, ms / this.scale));
    // Only loops when a pause intervened; 1 wall ms of slack absorbs timer jitter.
    while (this.pausedAt !== undefined || target - this.now() > this.scale) {
      if (this.pausedAt !== undefined) await new Promise<void>((resolve) => this.resumeWaiters.push(resolve));
      else await wallSleep((target - this.now()) / this.scale);
    }
  }
  pause(): void {
    this.pausedAt ??= performance.now();
  }
  resume(): void {
    if (this.pausedAt === undefined) return;
    this.pausedWallMs += performance.now() - this.pausedAt;
    this.pausedAt = undefined;
    for (const resolve of this.resumeWaiters.splice(0)) resolve();
  }
  toWallMs(ms: number): number {
    return ms / this.scale;
  }
}

function wallSleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}
