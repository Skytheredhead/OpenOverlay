/** Socket.IO retries transport loss, but explicitly stops after a server disconnect. */
export class RealtimeRetry {
  private timer: ReturnType<typeof setTimeout> | undefined;
  private attempts = 0;
  private stopped = false;

  constructor(private readonly connect: () => unknown) {}

  disconnected(reason: string): void {
    if (reason !== "io server disconnect" || this.stopped || this.timer !== undefined) return;
    const delay = Math.min(30_000, 1000 * 2 ** Math.min(this.attempts++, 5));
    this.timer = setTimeout(() => {
      this.timer = undefined;
      if (!this.stopped) this.connect();
    }, delay);
  }

  // A transport handshake alone is not proof the subscription recovered.
  receivedState(): void {
    this.attempts = 0;
    clearTimeout(this.timer);
    this.timer = undefined;
  }

  stop(): void {
    this.stopped = true;
    clearTimeout(this.timer);
    this.timer = undefined;
  }
}
