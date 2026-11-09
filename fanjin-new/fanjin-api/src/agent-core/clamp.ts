/**
 * 字节安全裁剪。从 toolLoopProcessor 的裁剪逻辑抽出的纯函数。
 * 来源：toolLoopProcessor.ts byteLength() / cleanToolCalls / cleanFinalContent。
 */

const encoder = new TextEncoder();

/**
 * 按 UTF-8 字节上限裁剪字符串，保证不截断多字节字符。
 * 来源：toolLoopProcessor.ts byteLength() 函数的裁剪语义。
 */
export function clampUtf8(input: string, maxBytes: number): string {
  if (maxBytes <= 0) return "";
  const encoded = encoder.encode(input);
  if (encoded.byteLength <= maxBytes) return input;
  // 回退到 <= maxBytes 的合法字符边界，避免插入 U+FFFD
  for (let end = maxBytes; end > 0; end--) {
    try {
      return new TextDecoder("utf-8", { fatal: true }).decode(encoded.slice(0, end));
    } catch {
      // 不完整多字节序列，继续回退
    }
  }
  return "";
}

/**
 * 裁剪任意 JSON 值的序列化字节（用于 tool 结果 output）。
 * 若序列化后超限，整体替换为截断占位对象。
 * 来源：toolLoopProcessor.ts byteLength() 的超限处理。
 */
export function clampJsonBytes(value: unknown, maxBytes: number): unknown {
  const json = JSON.stringify(value);
  const byteLen = encoder.encode(json).byteLength;
  if (byteLen <= maxBytes) return value;
  // 超限时截断字符串表示
  const clamped = clampUtf8(json, maxBytes);
  try {
    return JSON.parse(clamped);
  } catch {
    // 截断后不是合法 JSON，返回截断字符串占位
    return clamped;
  }
}
