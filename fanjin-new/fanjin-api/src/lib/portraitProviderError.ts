/** Safe public error shape without loading the provider worker or database. */
export class PortraitProviderRuntimeError extends Error {
  readonly code: string;
  readonly status: number;

  constructor(status: number, code: string, message: string) {
    super(message);
    this.name = "PortraitProviderRuntimeError";
    this.status = status;
    this.code = code;
  }
}
