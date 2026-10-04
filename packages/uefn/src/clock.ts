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

/** Runs `scale` session milliseconds per wall-clock millisecond. */
export class ScaledClock implements Clock {
  private readonly origin = performance.now();
  constructor(private readonly scale: number) {
    if (!(scale > 0)) throw new Error("clock scale must be positive");
  }
  now(): number {
    return (performance.now() - this.origin) * this.scale;
  }
  sleep(ms: number): Promise<void> {
    return new Promise((resolve) => setTimeout(resolve, Math.max(0, ms / this.scale)));
  }
  toWallMs(ms: number): number {
    return ms / this.scale;
  }
}
