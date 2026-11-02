/** Counts decoded frames the engine holds: must be 0 after every run and after every cancel (plan §3.2, 04 §4.2). */
export class FrameLedger {
  private held = 0;

  get open(): number {
    return this.held;
  }

  /** Registers one held frame; the returned function releases it (idempotent). */
  acquire(): () => void {
    this.held++;
    let released = false;
    return () => {
      if (released) return;
      released = true;
      this.held--;
    };
  }
}
