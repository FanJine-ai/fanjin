const SPREADSHEET_FORMULA_PREFIX_RE = /^[\u0000-\u0020\u007f-\u009f]*[=+\-@]/u;

/** Keep attacker-controlled CSV strings from being evaluated as spreadsheet formulas. */
export function secureCsvCell(value: unknown): string {
  const raw = value === null || value === undefined ? "" : String(value);
  const text = typeof value === "string" && SPREADSHEET_FORMULA_PREFIX_RE.test(raw)
    ? `'${raw}`
    : raw;
  return /[",\n\r]/.test(text) ? `"${text.replace(/"/g, '""')}"` : text;
}
