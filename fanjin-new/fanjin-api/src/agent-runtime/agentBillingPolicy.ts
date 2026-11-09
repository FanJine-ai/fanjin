/** 1 GU is represented as 1,000,000 billing micros. */
export const AGENT_LLM_RESERVATION_MICROS = 100 * 1_000_000;

/**
 * Selecting an official Skill changes the Agent policy snapshot but is not a
 * separately billable event. Model turns and generation tools keep their own
 * quote/reservation/settlement contracts.
 */
export const AGENT_SKILL_BILLING_POLICY = Object.freeze({
  currency: "GU" as const,
  catalogAccessMicros: 0,
  templateCopyMicros: 0,
  executionMode: "underlying_usage" as const,
  surchargeMicros: 0,
});
