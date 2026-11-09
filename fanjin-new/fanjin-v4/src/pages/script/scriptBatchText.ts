export type ScriptSplitMode = "auto" | "paragraphs" | "whole";
export type ImportedScript = { scriptName: string; scriptData: string };

export function looksLikeScriptJson(text: string): boolean {
  // Bracketed stage directions such as [旁白] are ordinary screenplay text.
  return /^[\[{]\s*(?:[\[\]{}"]|null\b|true\b|false\b|[-\d])/.test(text.trim());
}

function fromBlock(block: string, index: number): ImportedScript {
  const normalized = block.trim();
  const newline = normalized.indexOf("\n");
  const title = (newline < 0 ? normalized : normalized.slice(0, newline)).replace(/^#{1,6}\s+/, "").trim();
  return {
    scriptName: title.slice(0, 120) || `脚本 ${index + 1}`,
    // Keep every paragraph, including the scene heading, available to extraction.
    scriptData: normalized,
  };
}

function isSceneHeading(line: string): boolean {
  const title = line.replace(/^#{1,6}\s+/, "").trim();
  if (title.length > 120) return false;
  return /^(?:第[零〇一二三四五六七八九十百千万两\d]+[场幕集章]|(?:场景|场次|Scene)\s*[零〇一二三四五六七八九十百千万两\d]+)(?:[\s：:、.．\-]|$)/i.test(title)
    || /^\d{1,5}[、.．)）]\s*\S.*(?:内|外|INT\.?|EXT\.?)\s*[/／·\-—]\s*(?:日|夜|昼|晨|昏|傍晚|白天|晚上|DAY|NIGHT)\s*$/i.test(title);
}

export function parseBatchScriptText(text: string, mode: ScriptSplitMode = "auto", jsonFile = false): ImportedScript[] {
  const raw = text.replace(/\r\n?/g, "\n").trim();
  if (!raw) return [];
  if (raw.length > 2_000_000) throw new Error("剧本正文不能超过 200 万字符");
  if (jsonFile || looksLikeScriptJson(raw)) {
    let parsed: unknown;
    try { parsed = JSON.parse(raw); } catch { throw new Error("JSON 格式不正确，请检查后再导入"); }
    if (!Array.isArray(parsed)) throw new Error("JSON 需要是剧本数组，每项包含 title 和 content（或 scriptName 和 scriptData）");
    return parsed.map((item: unknown, index) => {
      if (!item || typeof item !== "object" || Array.isArray(item)) throw new Error(`JSON 第 ${index + 1} 项不是有效剧本`);
      const record = item as Record<string, unknown>;
      const body = record.scriptData ?? record.content ?? record.text;
      const title = record.scriptName ?? record.title ?? record.name ?? `脚本 ${index + 1}`;
      if (typeof body !== "string" || !body.trim() || typeof title !== "string" || !title.trim()) {
        throw new Error(`JSON 第 ${index + 1} 项需要有效的标题和正文，正文不能为空`);
      }
      return { scriptName: title.trim(), scriptData: body.trim() };
    });
  }
  if (mode === "whole") return [fromBlock(raw, 0)];
  if (mode === "paragraphs") return raw.split(/\n\s*\n/).filter((block) => block.trim()).map(fromBlock);
  const blocks: string[] = [];
  let current: string[] = [];
  for (const line of raw.split("\n")) {
    if (isSceneHeading(line) && current.some((part) => part.trim())) {
      blocks.push(current.join("\n"));
      current = [];
    }
    current.push(line);
  }
  if (current.some((part) => part.trim())) blocks.push(current.join("\n"));
  return blocks.map(fromBlock);
}
