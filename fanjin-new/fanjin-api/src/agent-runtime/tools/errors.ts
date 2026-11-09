export class AgentToolGatewayError extends Error {
  readonly code: string;
  readonly status: number;
  readonly replayed: boolean;

  constructor(
    code: string,
    message: string,
    options: { status?: number; replayed?: boolean } = {},
  ) {
    super(message);
    this.name = "AgentToolGatewayError";
    this.code = code;
    this.status = options.status ?? 500;
    this.replayed = options.replayed === true;
  }
}
