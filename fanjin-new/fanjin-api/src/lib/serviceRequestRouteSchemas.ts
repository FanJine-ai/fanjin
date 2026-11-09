import { z } from "zod";

const nonEmpty = z.string().trim().min(1);
const positiveMicros = z.number().int().positive().max(Number.MAX_SAFE_INTEGER);
const revision = z.number().int().nonnegative().max(Number.MAX_SAFE_INTEGER);

export const serviceRequestSubmitSchema = z
  .object({
    payload: z.discriminatedUnion("type", [
      z
        .object({
          type: z.literal("invoice"),
          invoiceAmountMicros: positiveMicros,
          invoiceCurrency: z.literal("CNY"),
          invoiceProfileHash: nonEmpty,
        })
        .strict(),
      z
        .object({
          type: z.literal("offline_payment"),
          paidAmountMicros: positiveMicros,
          paidCurrency: z.literal("CNY"),
          paymentEvidenceId: nonEmpty,
        })
        .strict(),
      z
        .object({
          type: z.literal("credit_limit"),
          requestedCreditLimitMicros: positiveMicros,
          currency: z.literal("GU"),
          reason: nonEmpty,
        })
        .strict(),
    ]),
    submissionEvidenceId: nonEmpty,
    idempotencyKey: nonEmpty,
    subjectName: z.string().nullable().optional(),
    taxId: z.string().nullable().optional(),
    contactName: z.string().nullable().optional(),
    contactEmail: z.string().email().nullable().optional(),
    contactPhone: z.string().nullable().optional(),
    note: z.string().nullable().optional(),
  })
  .strict();

export const serviceRequestReviewSchema = z
  .object({
    targetDecision: z.enum(["approved", "rejected", "cancelled"]),
    reason: z.string().trim().min(1).nullable(),
    reviewEvidenceId: nonEmpty,
    expectedRevision: revision,
    idempotencyKey: nonEmpty,
  })
  .strict()
  .superRefine((value, context) => {
    if (value.targetDecision === "approved" && value.reason !== null) {
      context.addIssue({
        code: "custom",
        path: ["reason"],
        message: "approved review 的 reason 必须为 null",
      });
    }
    if (value.targetDecision !== "approved" && value.reason === null) {
      context.addIssue({
        code: "custom",
        path: ["reason"],
        message: "rejected/cancelled review 必须提供 reason",
      });
    }
  });

export const serviceRequestIssueSchema = z
  .object({
    expectedRevision: revision,
    idempotencyKey: nonEmpty,
  })
  .strict();

export const serviceRequestRecoverSchema = z
  .object({
    expectedRevision: revision,
    idempotencyKey: nonEmpty,
    recoveryEvidenceId: nonEmpty,
  })
  .strict();
