/**
 * Agent Core 专属错误基类。
 */

/** Core 层错误基类，带 machine-readable code。 */
export class AgentCoreError extends Error {
  readonly code: string;
  constructor(code: string, message: string) {
    super(message);
    this.name = "AgentCoreError";
    this.code = code;
  }
}
