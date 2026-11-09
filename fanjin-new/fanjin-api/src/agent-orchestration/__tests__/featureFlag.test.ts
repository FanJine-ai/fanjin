import { describe, it, expect } from "vitest";
import { isAgentCoreEnabled } from "../featureFlag";

describe("isAgentCoreEnabled", () => {
  it("未设置 → false", () => {
    expect(isAgentCoreEnabled({})).toBe(false);
  });

  it('"1" → true', () => {
    expect(isAgentCoreEnabled({ FANJIN_AGENT_USE_CORE: "1" })).toBe(true);
  });

  it('"0" → false', () => {
    expect(isAgentCoreEnabled({ FANJIN_AGENT_USE_CORE: "0" })).toBe(false);
  });

  it('空字符串 → false', () => {
    expect(isAgentCoreEnabled({ FANJIN_AGENT_USE_CORE: "" })).toBe(false);
  });

  it('其他值 → false', () => {
    expect(isAgentCoreEnabled({ FANJIN_AGENT_USE_CORE: "true" })).toBe(false);
    expect(isAgentCoreEnabled({ FANJIN_AGENT_USE_CORE: "yes" })).toBe(false);
    expect(isAgentCoreEnabled({ FANJIN_AGENT_USE_CORE: "2" })).toBe(false);
  });

  it('带空格的 " 1 " → true（trim 后等于 "1"）', () => {
    expect(isAgentCoreEnabled({ FANJIN_AGENT_USE_CORE: " 1 " })).toBe(true);
  });
});
