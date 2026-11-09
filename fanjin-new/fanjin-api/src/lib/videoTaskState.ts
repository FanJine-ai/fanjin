import u from "@/utils";

type VideoTaskState = "已完成" | "生成失败";

function relatedVideoIdMatches(relatedObjects: string | undefined, videoId: number) {
  try {
    const related = JSON.parse(relatedObjects || "{}");
    return Number(related?.videoId) === videoId;
  } catch {
    return false;
  }
}

export async function syncVideoTaskState(videoId: number, state: VideoTaskState, reason = "") {
  const normalizedVideoId = Number(videoId);
  if (!Number.isFinite(normalizedVideoId)) return;

  const candidates = await u
    .db("o_tasks")
    .where("taskClass", "视频生成")
    .andWhere((qb: any) => {
      qb.where("relatedObjects", "like", `%"videoId":${normalizedVideoId}%`).orWhere(
        "relatedObjects",
        "like",
        `%"videoId":"${normalizedVideoId}"%`,
      );
    })
    .select("id", "relatedObjects")
    .orderBy("id", "desc")
    .limit(20);

  const matched = candidates.find((item: any) => relatedVideoIdMatches(item.relatedObjects, normalizedVideoId));
  if (!matched?.id) return;

  await u
    .db("o_tasks")
    .where("id", matched.id)
    .update({
      state,
      reason: state === "生成失败" ? reason : null,
    });
}
