/**
 * Coordinate an intercepted API response with the top-level navigation it triggers.
 * The captured value is not observable until the response reached the page and the
 * expected automatic navigation was positively aborted.
 */
export class E2ENavigationCapture<T> {
  #captured: T | undefined;
  #failed: unknown;
  #navigationAborted = false;

  async publishAfterFulfill(
    captured: T,
    fulfill: () => Promise<void>,
  ): Promise<void> {
    await fulfill();
    this.#captured = captured;
  }

  markNavigationAborted(): void {
    this.#navigationAborted = true;
  }

  fail(error: unknown): void {
    if (this.#failed === undefined) {
      this.#failed = error;
    }
  }

  readyValue(): T | undefined {
    if (this.#failed !== undefined) {
      throw this.#failed;
    }
    return this.#navigationAborted ? this.#captured : undefined;
  }

  assertReleasable(): void {
    if (this.#failed !== undefined) {
      throw this.#failed;
    }
    if (this.#captured === undefined || !this.#navigationAborted) {
      throw new Error(
        "Refusing to release navigation capture before response fulfillment and abort.",
      );
    }
  }
}
