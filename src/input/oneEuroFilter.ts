/** 参照実装と同じ One Euro Filter。時刻は秒。 */
export class OneEuroFilter {
  private previous: number | null = null;
  private velocity = 0;
  private time = 0;

  constructor(private readonly minCutoff = 1.2, private readonly beta = 0.02) {}

  filter(value: number, time: number): number {
    if (this.previous === null) {
      this.previous = value;
      this.time = time;
      return value;
    }
    const dt = Math.max(1e-3, time - this.time);
    this.time = time;
    const derivative = (value - this.previous) / dt;
    const derivativeAlpha = 1 / (1 + 1 / (2 * Math.PI * dt));
    this.velocity = derivativeAlpha * derivative + (1 - derivativeAlpha) * this.velocity;
    const cutoff = this.minCutoff + this.beta * Math.abs(this.velocity);
    const alpha = 1 / (1 + 1 / (2 * Math.PI * cutoff * dt));
    this.previous = alpha * value + (1 - alpha) * this.previous;
    return this.previous;
  }

  reset(): void {
    this.previous = null;
    this.velocity = 0;
    this.time = 0;
  }
}
