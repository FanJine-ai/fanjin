/** Editorial titles only. Original media, prompts and parameters live in ark-source.json. */
export const arkWork = {
  title: "别小看TA",
  source: "火山方舟 Gallery",
  sourceUrl: "https://console.volcengine.com/ark/region:cn-beijing/gallery/works?workId=work-20260828032530-b9qzh&episodeNo=1&galleryEntrySource=work_card",
  author: "导演：蓝天 · AIGC 导演：程宽 · 技术指导：鲁琦",
};
export const windWork = {
  title: "追风",
  source: "火山方舟 Gallery",
  sourceUrl: "https://console.volcengine.com/ark/region:cn-beijing/gallery/works?workId=work-20260908165104-6x77h&episodeNo=1&galleryEntrySource=work_card",
  author: "出品：火山引擎 · 导演：张卫东 · AIGC 导演：潘登、郑泽坤、张卫东",
};

type ArkGuide = { number: number; title: string; timecode: string; description: string };

export const arkTemplates: ArkGuide[] = [
  {"number": 1, "title": "城市巨物 · 世界观开场", "timecode": "00:04–00:07", "description": "用纪录片式的观察机位与远近尺度差，建立巨虫入侵城市的奇观。"},
  {"number": 2, "title": "街头潜行 · 反差喜剧", "timecode": "00:19–00:25", "description": "把巨大角色的专注与小角色的谨慎放进同一画面，形成安静的喜剧张力。"},
  {"number": 3, "title": "空中缠斗 · 极速逃脱", "timecode": "00:32–00:47", "description": "犀鸟带着水獭穿梭玻璃塔楼，借灵活转弯甩开追来的巨型甲虫。"},
  {"number": 4, "title": "荒野交谈 · 角色表演", "timecode": "01:02–01:10", "description": "保持动物自然姿态，通过对话、角色反应和真实毛发表现电影叙事。"},
  {"number": 5, "title": "厨房追逐 · 三次喜剧升级", "timecode": "01:12–01:23", "description": "同一追逐目标反复被打断，每次都更接近成功，以动作完成笑点。"},
  {"number": 6, "title": "风格穿越 · 完整环绕", "timecode": "01:27–01:33", "description": "把一次扑跃作为稳定动作，围绕角色完整旋转，在连续运动中切换艺术媒介。"},
  {"number": 7, "title": "水下险境 · 危险建立", "timecode": "01:36–01:40", "description": "以真实水体、焦散和水下运动表现水獭与种子的追逐。"},
  {"number": 8, "title": "破窗逃脱 · 高能追逐", "timecode": "01:40–01:57", "description": "首秒破窗爆发，以强手持、子弹时间和快速甩镜衔接荒诞喜剧式追逐。"},
  {"number": 9, "title": "高空冲刺 · 巨物尺度", "timecode": "02:08–02:18", "description": "把飞船、巨虫和巨花分成三层，用空气透视与垂直距离表现渺小和勇气。"},
  {"number": 10, "title": "花蕊庆典 · 群像收束", "timecode": "02:50–03:02", "description": "用飞行平台、种子群与暖光烟花，把角色的关系变化变成一场欢乐的结尾。"},
];

export const windTemplates: ArkGuide[] = [
  {"number": 1, "title": "橱窗观赛 · 梦想起点", "timecode": "00:00–00:13", "description": "用足球的运动方向连接街头与球场，让少年的憧憬进入画面。"},
  {"number": 2, "title": "街头与赛场 · 动作匹配", "timecode": "00:13–00:25", "description": "结合少年、球员、酒吧与街道，以动作连接街头和比赛现场。"},
  {"number": 3, "title": "街头带球 · 人群加入", "timecode": "00:31–00:41", "description": "让经过的人逐渐加入追球队伍，通过场景层次表现足球带来的感染力。"},
  {"number": 4, "title": "跌倒与起身 · 情绪转折", "timecode": "00:41–00:56", "description": "以球员失衡和少年跌倒的动作衔接，表现挫折时刻与情绪变化。"},
  {"number": 5, "title": "多地控球 · 运动蒙太奇", "timecode": "00:56–01:05", "description": "把同一颗足球带入不同空间，以连续的带球与争抢动作组织运动蒙太奇。"},
  {"number": 6, "title": "泥地起身 · 奋力射门", "timecode": "01:05–01:17", "description": "少年从泥泞地面撑起身体，低机位跟随助跑与踢球，表现继续向前的意志。"},
  {"number": 7, "title": "穿过电视 · 视频角色替换", "timecode": "01:24–01:42", "description": "在已有跨空间长镜头上替换人物，保留原运镜、构图、节奏与光影。"},
];
