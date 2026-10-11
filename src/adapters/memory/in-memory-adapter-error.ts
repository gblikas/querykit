/**
 * Error thrown when an expression cannot be applied to plain objects.
 */
export class InMemoryAdapterError extends Error {
  /**
   * @param message What blocked in-memory filtering
   */
  constructor(message: string) {
    super(message);
    this.name = 'InMemoryAdapterError';
  }
}
