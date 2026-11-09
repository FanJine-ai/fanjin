export class PortraitAdmissionWorkflowError extends Error {
  readonly code: string;
  readonly status: number;

  constructor(status: number, code: string, message: string) {
    super(message);
    this.name = "PortraitAdmissionWorkflowError";
    this.status = status;
    this.code = code;
  }
}
