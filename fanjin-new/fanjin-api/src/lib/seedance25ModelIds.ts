/** Exact provider model identities. This module has no database or runtime imports. */
export const DOMESTIC_SEEDANCE_25_MODEL_ID = "doubao-seedance-2-5-260628" as const;
export const BYTEPLUS_SEEDANCE_25_MODEL_ID = "dreamina-seedance-2-5-260628" as const;

export type Seedance25ModelId =
  | typeof DOMESTIC_SEEDANCE_25_MODEL_ID
  | typeof BYTEPLUS_SEEDANCE_25_MODEL_ID;

export function isSeedance25ModelId(value: unknown): value is Seedance25ModelId {
  return value === DOMESTIC_SEEDANCE_25_MODEL_ID
    || value === BYTEPLUS_SEEDANCE_25_MODEL_ID;
}
