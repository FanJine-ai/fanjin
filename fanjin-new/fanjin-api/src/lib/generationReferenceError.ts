/**
 * Lightweight generation-reference failure shared by request validation and
 * provider adapters. Keep this module free of database and storage imports so
 * read-only release tooling can import adapter contracts without starting the
 * application database singleton.
 */
export class GenerationReferenceError extends Error {
  status: number;
  code: string;

  constructor(status: number, code: string, message: string) {
    super(message);
    this.name = "GenerationReferenceError";
    this.status = status;
    this.code = code;
  }
}
