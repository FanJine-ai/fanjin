export class AuthError extends Error {
  status: number;
  code?: string;
  retryAfterSeconds?: number;
  data?: Record<string, unknown>;

  constructor(
    message: string,
    status = 400,
    options: { code?: string; retryAfterSeconds?: number; data?: Record<string, unknown> } = {},
  ) {
    super(message);
    this.status = status;
    this.code = options.code;
    this.retryAfterSeconds = options.retryAfterSeconds;
    this.data = options.data;
  }
}
