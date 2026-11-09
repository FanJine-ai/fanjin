import type { Knex } from "knex";

import { insertAndReturnId } from "@/lib/dbDialect";

export type ScriptStoryboardDraft = {
  prompt: string;
  videoDesc: string;
  duration: number;
};

function isHeading(value: string): boolean {
  return /^(?:第[\d一二三四五六七八九十百]+[章节幕集]|(?:场景|场次|scene)\s*[\d一二三四五六七八九十]+|【[^】]+】)/i.test(value.trim());
}

function splitLongBlock(value: string): string[] {
  if (value.length <= 180) return [value];
  const sentences = value.split(/(?<=[。！？!?])\s*/).filter(Boolean);
  const groups: string[] = [];
  let current = "";
  for (const sentence of sentences) {
    if (current && `${current}${sentence}`.length > 180) {
      groups.push(current);
      current = sentence;
    } else {
      current += sentence;
    }
  }
  if (current) groups.push(current);
  return groups.length ? groups : [value];
}

export function buildStoryboardDraftsFromScript(
  scriptName: string,
  content: string,
): ScriptStoryboardDraft[] {
  const rawBlocks = content
    .replace(/\r\n?/g, "\n")
    .split(/\n\s*\n+/)
    .map((block) => block.split("\n").map((line) => line.trim()).filter(Boolean).join("\n"))
    .filter(Boolean);
  const blocks: string[] = [];
  let heading = "";
  for (const block of rawBlocks.length ? rawBlocks : [content.trim()]) {
    if (isHeading(block) && !block.includes("\n") && block.length <= 40) {
      heading = block;
      continue;
    }
    const combined = heading ? `${heading}\n${block}` : block;
    heading = "";
    blocks.push(...splitLongBlock(combined));
  }
  if (heading) blocks.push(heading);
  return blocks.slice(0, 24).map((block, index) => {
    const condensed = block.replace(/\s+/g, " ").trim();
    const duration = Math.max(3, Math.min(8, Math.ceil(condensed.length / 28) + 3));
    return {
      prompt: `${scriptName} · 分镜 ${String(index + 1).padStart(2, "0")}：${condensed}`,
      videoDesc: block,
      duration,
    };
  });
}

export async function createStoryboardDraftsForScript(
  transaction: Knex.Transaction,
  input: { projectId: number; scriptId: number; scriptName: string; content: string },
): Promise<number[]> {
  const drafts = buildStoryboardDraftsFromScript(input.scriptName, input.content);
  const storyboardIds: number[] = [];
  for (const [index, draft] of drafts.entries()) {
    const trackId = await insertAndReturnId(transaction, "o_videoTrack", {
      scriptId: input.scriptId,
      projectId: input.projectId,
      duration: draft.duration,
      state: "未生成",
      prompt: draft.videoDesc,
    });
    storyboardIds.push(await insertAndReturnId(transaction, "o_storyboard", {
      prompt: draft.prompt,
      duration: String(draft.duration),
      state: "未生成",
      filePath: null,
      trackId,
      track: `镜头${String(index + 1).padStart(2, "0")}`,
      videoDesc: draft.videoDesc,
      shouldGenerateImage: 1,
      scriptId: input.scriptId,
      projectId: input.projectId,
      createTime: Date.now(),
      index: index + 1,
    }));
  }
  return storyboardIds;
}
