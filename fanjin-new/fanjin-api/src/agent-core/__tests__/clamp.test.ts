import { describe, it, expect } from "vitest";
import { clampUtf8, clampJsonBytes } from "../clamp";

describe("clampUtf8", () => {
  it("ASCII 短串不截断", () => {
    expect(clampUtf8("hello", 100)).toBe("hello");
  });

  it("恰好等于上限不截断", () => {
    const s = "abc"; // 3 bytes
    expect(clampUtf8(s, 3)).toBe("abc");
  });

  it("超限截断 ASCII", () => {
    expect(clampUtf8("hello world", 5)).toBe("hello");
  });

  it("多字节字符边界不被切断", () => {
    // 中文"你好"每个字符 3 bytes，共 6 bytes
    expect(clampUtf8("你好世界", 4)).toBe("你"); // 截到第一个完整字符
    expect(clampUtf8("你好世界", 6)).toBe("你好"); // 恰好两个字符
    expect(clampUtf8("你好世界", 7)).toBe("你好"); // 不够第三个字符
    expect(clampUtf8("你好世界", 9)).toBe("你好世"); // 三个字符
  });

  it("空串", () => {
    expect(clampUtf8("", 100)).toBe("");
  });

  it("maxBytes 为 0 返回空串", () => {
    expect(clampUtf8("hello", 0)).toBe("");
  });

  it("emoji 多字节不切断", () => {
    // 🎉 是 4 bytes
    expect(clampUtf8("🎉🎊", 4)).toBe("🎉");
    expect(clampUtf8("🎉🎊", 5)).toBe("🎉"); // 不够第二个 emoji
    expect(clampUtf8("🎉🎊", 8)).toBe("🎉🎊");
  });

  it("混合 ASCII + 多字节", () => {
    expect(clampUtf8("a你好b", 4)).toBe("a你"); // a(1) + 你(3) = 4
    expect(clampUtf8("a你好b", 5)).toBe("a你"); // a(1) + 你(3) = 4, 不够 好(3)
  });
});

describe("clampJsonBytes", () => {
  it("不超限返回原值", () => {
    expect(clampJsonBytes({ a: 1 }, 1000)).toEqual({ a: 1 });
  });

  it("超限截断", () => {
    const big = { data: "x".repeat(1000) };
    const result = clampJsonBytes(big, 50);
    // 截断后可能不是合法 JSON，返回截断字符串
    if (typeof result === "string") {
      expect(result.length).toBeLessThan(JSON.stringify(big).length);
    } else {
      // 如果截断后仍是 JSON，也接受
      expect(JSON.stringify(result).length).toBeLessThanOrEqual(50 + 10); // 允许少量误差
    }
  });

  it("空对象不截断", () => {
    expect(clampJsonBytes({}, 10)).toEqual({});
  });

  it("null 值不截断", () => {
    expect(clampJsonBytes(null, 10)).toBeNull();
  });
});
