/** One LocalShare failure with a stable machine code and an HTTP status. */
export class LocalShareError extends Error {
  /**
   * @param {string} code stable error code such as `peer/timeout`
   * @param {string} message user-facing message
   * @param {number} [status] HTTP status used when the failure crosses the peer wire
   */
  constructor(code, message, status = 400) {
    super(message)
    this.name = 'LocalShareError'
    this.code = code
    this.status = status
  }
}
