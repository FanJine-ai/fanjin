export type ProductSheetMode = "standard" | "appearance" | "structure";
export type CharacterThreeViewMode = "face" | "full";
export type MultiAngleNineGridMode = "person" | "product" | "scene";

export interface CanvasPromptSourceNode {
  title?: string;
  prompt?: string;
  fileName?: string;
  mediaNaturalWidth?: number;
  mediaNaturalHeight?: number;
  width: number;
  height: number;
}

const PRODUCT_SHEET_APPEARANCE_KEYWORDS = [
  "唇釉",
  "口红",
  "彩妆",
  "美妆",
  "香水",
  "护肤",
  "精华",
  "面霜",
  "粉底",
  "刷头",
  "珠光",
  "质地",
  "logo",
  "瓶盖",
  "饰品",
  "潮玩",
  "手办",
  "耳机",
  "香氛",
  "喷头",
  "lip",
  "cosmetic",
  "perfume",
  "beauty",
];
const PRODUCT_SHEET_STRUCTURE_KEYWORDS = [
  "罐",
  "易拉罐",
  "饮料",
  "包装",
  "盒",
  "瓶装",
  "容器",
  "拉环",
  "封口",
  "卷边",
  "接口",
  "螺纹",
  "标签",
  "条码",
  "配料",
  "容量",
  "barcode",
  "package",
  "packaging",
  "can",
  "bottle",
  "pull tab",
  "lid",
];

function countKeywordHits(text: string, keywords: string[]) {
  return keywords.reduce((total, keyword) => (text.includes(keyword) ? total + 1 : total), 0);
}

export function detectProductSheetMode(context: string, node: CanvasPromptSourceNode): ProductSheetMode {
  const normalized = context.toLowerCase();
  let appearanceScore = countKeywordHits(normalized, PRODUCT_SHEET_APPEARANCE_KEYWORDS);
  let structureScore = countKeywordHits(normalized, PRODUCT_SHEET_STRUCTURE_KEYWORDS);

  if ((node.mediaNaturalHeight || node.height) > (node.mediaNaturalWidth || node.width) * 1.2) {
    structureScore += 1;
  }
  if ((node.mediaNaturalWidth || node.width) >= (node.mediaNaturalHeight || node.height) * 0.95) {
    appearanceScore += 1;
  }

  if (structureScore >= appearanceScore + 1) return "structure";
  if (appearanceScore >= structureScore + 1) return "appearance";
  return "standard";
}

function buildProductSheetAdaptiveHint(context: string) {
  const hints: string[] = [];
  if (context.includes("刷头") || context.includes("applicator")) hints.push("重点展示刷头、刷杆、刷口与蘸取结构");
  if (context.includes("瓶口") || context.includes("螺纹") || context.includes("封口")) hints.push("重点展示瓶口、螺纹、封装与密封关系");
  if (context.includes("拉环") || context.includes("卷边") || context.includes("易拉罐")) hints.push("重点展示拉环、卷边、顶盖与底部受力结构");
  if (context.includes("logo") || context.includes("商标") || context.includes("印刷")) hints.push("重点展示品牌印刷区域、标识位置与印刷质感");
  if (context.includes("珠光") || context.includes("粉体") || context.includes("质地")) hints.push("重点展示材质纹理、珠光颗粒与表面高光变化");
  if (!hints.length) hints.push("重点展示产品多视图、局部放大、材质表现与核心卖点说明");
  return hints.join("；");
}

export function buildCinematicLightingPrompt(sourceNode: CanvasPromptSourceNode, extraContext: string) {
  const normalized = extraContext.toLowerCase();
  const isProduct = countKeywordHits(normalized, PRODUCT_SHEET_APPEARANCE_KEYWORDS) + countKeywordHits(normalized, PRODUCT_SHEET_STRUCTURE_KEYWORDS) > 0;
  const sourceTitleHint = sourceNode.title?.trim() ? `参考标题：${sourceNode.title.trim()}` : "";
  const referenceHint = extraContext.trim() ? `参考补充信息：${extraContext.trim()}` : "";
  const subjectInstruction = isProduct
    ? "如果参考图是产品：严格保留同一产品造型、比例、颜色、材质、Logo/标签大致位置和关键装饰，将它转化为单品电影级商业摄影主视觉。"
    : "如果参考图是人物/角色/多视图设定板：严格保留同一人物身份、服装、发型、姿态关系和多视图数量，将原有设定板转化为电影级影棚光影版本。";

  return [
    "基于参考图做电影级光影校正，输出一张 16:9 横向成片；这是对原图的光影、背景、质感和电影摄影氛围增强，不是重新设计主体。",
    subjectInstruction,
    "必须保持参考图的主体数量、核心构图、主要轮廓、相对位置和识别特征，不要换产品、换人物、换服装、换包装、换发型或改变多视图顺序。",
    "把白底、平光或普通展示图升级为电影棚拍：暖灰/深灰渐变背景，真实地面接触阴影，柔和烟雾或空气感，背景有轻微暗角和层次。",
    "光影风格：左上或侧后方强主光形成体积光束，低位暖色补光，边缘轮廓光勾勒主体，局部高光更锐利，阴影更深但保留暗部细节。",
    "材质校正：皮肤保留真实纹理与毛孔，布料保留纤维和旧化痕迹，金属要有镜面高光与黑白反射条，透明材质要有折射、透亮边缘和底部高光。",
    "画面要有电影摄影的动态范围、微对比、景深层次、真实环境反射和高级商业修图质感；整体不脏、不糊、不油腻。",
    "如果是产品图：主体居中或略偏中，产品完整可见，保留包装文字/Logo区域的视觉位置，可以不逐字复刻；加入斜向光束、台面反射、长投影和精致高光。",
    "如果是人物多视图/角色三视图：保留左侧半身近景与右侧全身视图的布局逻辑，给每个人物统一电影级布光、接触阴影和暖灰背景，不要变成单人大海报。",
    "最终效果参考高端影视定妆照、商业产品广告片剧照、电影级影棚棚拍；禁止白底平铺、纯产品证件照、设定图说明文字、参数表、边框UI、额外道具、无关场景。",
    sourceTitleHint,
    referenceHint,
  ]
    .filter(Boolean)
    .join("\n");
}
export function buildProductSheetPrompt(
  sourceNode: CanvasPromptSourceNode,
  mode: ProductSheetMode,
  extraContext: string,
) {
  const modeInstruction =
    mode === "appearance"
      ? [
          "版式偏外观卖点型，但信息密度必须接近专业产品设定板：左侧整体视图，中间结构拆解，右侧细节放大，下方材质与工艺说明。",
          "必须展示正面含盖状态、侧面视图、打开盖子或使用态，并补充至少 4 个细节放大框。",
        ]
      : mode === "structure"
        ? [
            "版式偏结构工艺型，必须像工程说明板：左侧多视图，中间爆炸图，右侧结构放大，下方材料/工艺/功能总结。",
            "必须展示主体、盖体/顶盖/拉环/瓶口/接口/底部等拆解关系，并用编号圆点和引线标注。",
          ]
        : [
            "版式走标准产品设定图，但不能简化成展示卡片：必须包含 6 到 8 个编号区块，信息密度高，像商业产品说明板。",
          ];
  const adaptiveHint = buildProductSheetAdaptiveHint(extraContext.toLowerCase());
  const referenceHint = extraContext.trim() ? `参考补充信息：${extraContext.trim()}` : "";
  const sourceTitleHint = sourceNode.title?.trim() ? `参考产品标题：${sourceNode.title.trim()}` : "";

  return [
    "基于参考图中的同一产品，生成一张 16:9 单张横向、信息量很高的产品设定图说明板，目标接近专业品牌产品设定图，不是单个产品海报，也不是简单拼贴卡片。",
    "必须保持产品核心造型、比例、主色、材质趋势、结构关系和主要卖点与参考图一致；允许补全合理侧视、开启态、拆解态和局部细节，但不得改成其他产品。",
    "画面采用白色或浅灰专业说明板背景，细灰色分割线，圆角信息框，编号圆点，引线标注，分区标题清楚，整体干净、密集、可信。",
    "必须使用中文栏目标题和编号，可使用少量中文说明文字；文字以短句标签为主，避免大段乱码，包装小字/条码/Logo 允许概念近似，不追求 OCR 逐字复刻。",
    "强制版式区块：1 整体视图，包含正面、侧面、打开/使用状态；2 结构拆解图，展示可拆部件和连接关系；3 细节放大图，至少 6 个局部框；4 材质与工艺说明；5 图案与标签细节；6 工艺/功能与特点总结；7 参数/规格底栏。",
    "画面必须至少有 12 个可见信息单元：3 个整体视图、1 个主拆解图、6 个细节放大框、1 组材质样本、1 条参数底栏；每个单元必须有边框或分割线，不能留空。",
    "整体视图区要像图册：正面含盖状态、侧面视图、打开盖子/刷头/使用态并列；结构拆解区要像爆炸图：部件纵向分离并用虚线引线连接；细节区要像放大镜：每张特写都带编号圆点和短说明。",
    "细节放大区必须包含材质纹理极近景、金属/透明/塑料/纸质等材料样本、Logo或标签区域、接口/盖体/瓶口/拉环/刷头/底部结构中的关键部位。",
    "主体展示区必须包含至少一个较大的完整产品主视图，中间结构拆解区必须有编号 1-5 的引线说明，右侧细节区必须有 1-6 的放大框。",
    ...modeInstruction,
    `自适应重点：${adaptiveHint}。`,
    "最终输出必须是一张完整横向设定板，信息丰富程度要明显高于普通商品展示图。",
    "禁止：单一大图、纯广告海报、无分区排版、无编号说明、无细节框、无结构拆解、跑题场景背景、无意义密集乱码。",
    sourceTitleHint,
    referenceHint,
  ]
    .filter(Boolean)
    .join("\n");
}

export function buildSceneSheetPrompt(sourceNode: CanvasPromptSourceNode, extraContext: string) {
  const normalized = extraContext.toLowerCase();
  const isProductWorld = countKeywordHits(normalized, PRODUCT_SHEET_APPEARANCE_KEYWORDS) + countKeywordHits(normalized, PRODUCT_SHEET_STRUCTURE_KEYWORDS) > 0;
  const isCharacterWorld = countKeywordHits(normalized, MULTI_ANGLE_PERSON_KEYWORDS) > 0;
  const sourceTitleHint = sourceNode.title?.trim() ? `参考标题：${sourceNode.title.trim()}` : "";
  const referenceHint = extraContext.trim() ? `参考补充信息：${extraContext.trim()}` : "";
  const worldHint = isProductWorld
    ? "从参考产品提炼品牌形态、主色、材质和符号，扩展成一个沉浸式商业空间或概念场景；产品可以成为空间中心装置、门头、陈列台或巨型地标。"
    : isCharacterWorld
      ? "从参考角色/海报提炼时代、地点、情绪、道具和叙事关系，扩展成同一世界观下的场景设定板；不要只画人物，要重点建立环境。"
      : "从参考图提炼环境、氛围、材质、构图和叙事核心，扩展成同一世界观下的完整场景设定板。";

  return [
    "基于参考图生成一张 16:9 单张横向、高信息密度的场景设定图/世界观设定板，目标接近专业影视/游戏美术场景设定图，而不是单张场景海报。",
    worldHint,
    "必须保持参考图的核心视觉资产、主色体系、时代气质、材质语言和情绪氛围；可以合理扩展空间结构、道具系统、视角参考和氛围版本。",
    "版式必须包含多块编号区域，使用清晰分割线、标题条、编号角标、中文短标签、引线说明和材料色板。整体可以是白色设定板、粉色品牌设定板、复古纸张设定板或深色科幻设定板，风格需贴合参考图。",
    "强制区块：1 概念说明与草图，包含一段短概念文案和手绘草图/线稿；2 主视觉大图，占据最大区域；3 多视角参考，包含入口/俯视/近景或远景；4 核心结构设计，展示空间剖面、装置结构或建筑节点；5 场景物件设计，展示道具、家具、载具、标牌或核心陈设；6 色彩与材质参考，包含色板和材质样本；7 细节与装饰特写；8 氛围设定，包含日常/夜晚/阴雨/活动等模式对比。",
    "至少绘制 10 个清晰子画面：1 张超大主视觉、1 张草图、3 张视角参考、2 张结构/物件设计图、1 组色彩材质色板、2 张氛围变化；每块都要有标题条或编号角标。",
    "如果参考是产品图：场景要围绕产品的品牌体验、快闪店、展厅、主题空间、工业设施或沉浸式装置展开，产品形态/颜色/材质要转译为空间语言。",
    "如果参考是人物或海报：场景要围绕人物生活环境、时代背景、关键地点、自然元素、道具和叙事氛围展开，避免变成人物设定图。",
    "每个区块都要有清楚的图像内容，不要空白框；主视觉要有电影级空间深度，细节区要有可执行的设计信息。",
    "允许中文栏目标题和短说明；避免大段乱码和无意义文字，文字以设定板标签和编号为主。",
    "禁止：只生成单张大场景、无区块、无编号、无色板材质、无结构/道具说明、跑题人物肖像或产品海报。",
    sourceTitleHint,
    referenceHint,
  ]
    .filter(Boolean)
    .join("\n");
}

export function buildCharacterSheetPrompt(sourceNode: CanvasPromptSourceNode, extraContext: string) {
  const sourceTitleHint = sourceNode.title?.trim() ? `参考角色标题：${sourceNode.title.trim()}` : "";
  const referenceHint = extraContext.trim() ? `参考补充信息：${extraContext.trim()}` : "";

  return [
    "基于参考图中的同一人物/角色，生成一张 16:9 单张横向、高信息密度的角色设定图板，目标接近专业影视角色设定图，不是三视图小图，也不是单张海报。",
    "必须保留同一角色身份、年龄感、性别、脸型五官、发型、肤色、服装主形、道具、时代气质、配色和情绪；不得换人，不得换成更漂亮或更现代的无关角色。",
    "版式必须是专业角色设定板：复古纸张/中性灰/电影美术板风格均可，但要有清晰分割线、标题条、编号或栏目标题、中文短标签和材质色板。",
    "强制区块：1 主角色全身大图，展示角色气质和关键道具；2 全身转面图，正面、三分之二、侧面、背面至少 4 个站姿；3 头部研究，正面、侧面、背面或表情近景；4 服装与配饰拆解，衣服、裤子、鞋、发型、武器/工具/随身物件单独陈列；5 材质参考，布料、皮肤、头发、木头/金属/泥污等纹理样本；6 色彩板，至少 6 个色块；7 氛围头像或剧情瞬间；8 角色备注，包含姓名/年龄/身份/性格/背景短句。",
    "至少绘制 14 个可见人物/物件单元：1 个大幅全身、4 个转面站姿、4 个头部研究、3 个服装/道具拆解、6 个材质或色彩样本；版式必须像图9那样分栏、分块、带标题条。",
    "如果参考图来自电影海报或场景图，要从中提取人物本身，不要保留海报文字和夸张版式；可以保留时代环境作为主角色大图的背景氛围，但其余设定区保持清晰。",
    "角色全身必须头脚完整，比例稳定；转面图要服装一致、发型一致、身高一致；头部研究必须五官一致，不能变成不同人。",
    "服装与道具拆解区要像实物陈列：衣物、鞋履、工具、武器、饰品分开展示，并有简短标签。材质区要展示近景纹理，而不是简单色块。",
    "允许中文栏目标题和少量设定文字；文字以短标签为主，避免大段乱码。",
    "禁止：单人海报、单纯三视图、只有脸部、无材质板、无服装拆解、无色彩板、换脸、多人混入、肢体残缺、文字乱码占满画面。",
    sourceTitleHint,
    referenceHint,
  ]
    .filter(Boolean)
    .join("\n");
}

const MULTI_ANGLE_PERSON_KEYWORDS = [
  "人物",
  "角色",
  "人像",
  "脸部",
  "面部",
  "女孩",
  "男孩",
  "男人",
  "女人",
  "服装",
  "动作",
  "海报",
  "电影",
  "战场",
  "叙事",
  "portrait",
  "character",
  "person",
  "face",
  "costume",
  "poster",
];
const MULTI_ANGLE_PRODUCT_KEYWORDS = [
  "产品",
  "包装",
  "唇釉",
  "口红",
  "彩妆",
  "美妆",
  "香水",
  "瓶",
  "罐",
  "易拉罐",
  "饮料",
  "logo",
  "标签",
  "材质",
  "白底",
  "商品",
  "product",
  "lip",
  "cosmetic",
  "perfume",
  "bottle",
  "can",
  "packaging",
];
const MULTI_ANGLE_SCENE_KEYWORDS = ["场景", "空间", "环境", "室内", "建筑", "店铺", "scene", "space", "interior"];

export function detectMultiAngleNineGridMode(context: string, node: CanvasPromptSourceNode): MultiAngleNineGridMode {
  const normalized = context.toLowerCase();
  let productScore = countKeywordHits(normalized, MULTI_ANGLE_PRODUCT_KEYWORDS);
  let personScore = countKeywordHits(normalized, MULTI_ANGLE_PERSON_KEYWORDS);
  let sceneScore = countKeywordHits(normalized, MULTI_ANGLE_SCENE_KEYWORDS);
  const naturalWidth = node.mediaNaturalWidth || node.width;
  const naturalHeight = node.mediaNaturalHeight || node.height;

  if (naturalWidth > naturalHeight * 1.35 && productScore > 0) productScore += 1;
  if (naturalHeight > naturalWidth * 1.25 && personScore > 0) personScore += 1;
  if (/海报|poster|角色|character|人物|人像|face|portrait/.test(normalized)) personScore += 2;
  if (/白底|产品图|商品|包装|logo|标签|product|packaging/.test(normalized)) productScore += 2;
  if (/场景|空间|室内|建筑|scene|interior/.test(normalized)) sceneScore += 2;

  if (productScore >= personScore && productScore >= sceneScore && productScore > 0) return "product";
  if (personScore >= productScore && personScore >= sceneScore && personScore > 0) return "person";
  return sceneScore > 0 ? "scene" : "person";
}

function buildMultiAngleShotPlanPrompt(sourceNode: CanvasPromptSourceNode, mode: MultiAngleNineGridMode, extraContext: string) {
  const subject = mode === "product" ? "同一产品" : mode === "scene" ? "同一场景" : "同一人物/角色";
  return [
    `请基于参考图，为${subject}设计一套 3x3 多机位九宫格拍摄脚本。`,
    "只输出 9 条镜头描述，每条控制在 18 个汉字以内，强调机位、景别、角度、焦段或构图变化。",
    "不要写解释，不要写标题，不要要求改变主体身份、产品造型或场景核心元素。",
    sourceNode.title?.trim() ? `参考标题：${sourceNode.title.trim()}` : "",
    extraContext.trim() ? `参考信息：${extraContext.trim()}` : "",
  ]
    .filter(Boolean)
    .join("\n");
}

export function buildMultiAngleNineGridPrompt(
  sourceNode: CanvasPromptSourceNode,
  mode: MultiAngleNineGridMode,
  extraContext: string,
  shotPlan = "",
) {
  const sourceTitleHint = sourceNode.title?.trim() ? `参考标题：${sourceNode.title.trim()}` : "";
  const referenceHint = extraContext.trim() ? `参考补充信息：${extraContext.trim()}` : "";
  const planHint = shotPlan.trim() ? `可参考的九镜头脚本：
${shotPlan.trim()}` : "";
  const modeInstruction =
    mode === "product"
      ? [
          "产品摄影多机位模板，九格依次覆盖：1 大留白远景产品照；2 标准正面产品照；3 更近的主视觉产品照；4 侧面或三分之二视角；5 顶视图；6 Logo或标签区域近景；7 材质纹理极近景；8 顶部、盖体、瓶口或结构视角；9 低角度或倾斜产品英雄镜头。",
          "九格必须保留同一个产品造型、主色、材质、透明/金属/包装细节和关键装饰，只改变机位、焦段、构图和景别。",
          "整体像专业产品摄影分镜，不要做成产品设定图、说明板、参数表、海报或文字说明图。",
        ]
      : mode === "scene"
        ? [
            "通用场景多机位模板，九格依次覆盖：1 环境远景；2 主视觉中景；3 入口或边缘视角；4 侧面视角；5 俯拍；6 关键局部细节；7 低角度；8 材质或光影近景；9 氛围光线变化镜头。",
            "九格必须来自同一空间或同一环境设定，建筑结构、色彩、光线和核心元素连续一致。",
          ]
        : [
            "人物叙事电影多机位模板，九格依次覆盖：1 远景环境交代；2 中景人物姿态；3 半身侧面；4 肩部近景；5 面部特写；6 极近眼部或表情细节；7 高角度俯拍；8 低角度英雄镜头；9 侧逆光氛围镜头。",
            "九格必须保留同一个人物身份、年龄、脸型、发型、服装、道具、环境基调与情绪，只改变机位、焦段、景别、角度和构图。",
            "整体像电影摄影多机位分镜，不要做成角色设定图、三视图、海报排版或文字说明图。",
          ];

  return [
    "基于参考图生成一张 16:9 完整的 3x3 多机位九宫格合成图，必须是单张图片，不要生成九张散图。",
    "画面必须严格为三行三列，每格大小一致，使用干净白色或浅色分隔线/留白边距，九格边界清楚。",
    "所有格子必须围绕同一主体、同一身份、同一产品或同一场景，核心特征不能漂移，不能换人、换产品或换场景。",
    "九个镜头之间保持统一摄影风格、统一色彩倾向、统一光线逻辑、统一材质质感和连续的视觉世界。",
    "禁止添加标题、编号、字幕、Logo、水印、UI 元素、说明文字或参数表；如果参考图有水印，不要放大或强调水印。",
    ...modeInstruction,
    planHint,
    sourceTitleHint,
    referenceHint,
  ]
    .filter(Boolean)
    .join("\n");
}

export function buildStoryboard25GridPrompt(
  sourceNode: CanvasPromptSourceNode,
  mode: MultiAngleNineGridMode,
  extraContext: string,
) {
  const normalized = [sourceNode.title, sourceNode.prompt, sourceNode.fileName, extraContext]
    .filter(Boolean)
    .join("\n")
    .toLowerCase();
  const sourceTitleHint = sourceNode.title?.trim() ? `参考标题：${sourceNode.title.trim()}` : "";
  const referenceHint = extraContext.trim() ? `参考补充信息：${extraContext.trim()}` : "";
  const productScore = countKeywordHits(normalized, [
    ...MULTI_ANGLE_PRODUCT_KEYWORDS,
    "虚拟唇釉",
    "唇彩",
    "美妆产品",
    "化妆品",
    "瓶身",
    "盖子",
    "刷头",
    "膏体",
    "gloss",
    "makeup",
  ]);
  const materialScore = countKeywordHits(normalized, [
    "刺绣",
    "织物",
    "纹理",
    "金线",
    "布料",
    "服饰",
    "绣线",
    "绳结",
    "珠宝",
    "宝石",
    "龙纹",
    "云纹",
    "embroider",
    "fabric",
    "texture",
    "macro",
    "gold",
  ]);
  const sceneScore = countKeywordHits(normalized, [
    ...MULTI_ANGLE_SCENE_KEYWORDS,
    "沙漠",
    "荒漠",
    "山谷",
    "天空",
    "洞穴",
    "遗迹",
    "城市",
    "旅人",
    "desert",
    "landscape",
    "cave",
    "kingdom",
    "traveler",
  ]);
  const isProduct = mode === "product" || productScore >= Math.max(materialScore, sceneScore, 1);
  const isScene = !isProduct && (mode === "scene" || sceneScore >= Math.max(materialScore, 1));
  const isMaterial = !isProduct && !isScene && materialScore > 0;

  const modeInstruction = isProduct
    ? [
        "产品商业分镜方向：把参考图中的同一产品扩展成 25 个商业摄影镜头，保持同一产品造型、颜色、材质、Logo/标签、透明或金属结构和关键装饰完全一致。",
        "25格建议顺序：1 完整产品英雄图；2 倾斜产品图；3 顶部/盖子/装饰特写；4 Logo或瓶身局部；5 膏体/材质微距；6 横放产品；7 开盖瞬间；8 刷头/ applicator 蘸取；9 双支或交叉陈列；10 金属/瓶口结构微距；11 小比例留白产品；12 丝绸或柔软背景；13 水花/液体互动；14 发光装饰特写；15 Logo极近景；16 多支放射陈列；17 斜向英雄图；18 滴落质感微距；19 花瓣/道具场景；20 彩虹折射或光斑；21 运动模糊；22 瓶底/玻璃微距；23 反射台面；24 闪光散景氛围；25 最终居中产品定妆照。",
        "整体应像高端产品广告分镜板，干净高调白色或浅粉背景，柔和棚拍光，画面明亮通透；每格镜头不同，不要重复同一张产品图。",
      ]
    : isScene
      ? [
          "场景叙事分镜方向：把参考图的场景世界扩展成一段连贯电影故事，保持原图地貌、天气、色调、建筑/自然元素和光线方向一致。",
          "25格建议顺序：1 世界观远景；2 角色或行动进入场景；3 人物近景/情绪；4 脚步或地面细节；5 目的地/山体/建筑；6 穿越地形；7 休息或观察；8 入口/洞口/门；9 内部探索；10 墙面符号或线索；11 新空间大景；12 触碰/研究线索；13 符号极近景；14 能量/机关启动；15 核心道具悬浮；16 表情反应；17 能量空间爆发；18 光束或转折大景；19 回到外部环境；20 主角持有道具；21 风暴/魔法高潮；22 新世界或绿洲；23 关键物体特写；24 王国/城市远景；25 终点或结局大场面。",
          "整体应像一张电影分镜板，景别从远景、中景、特写到宏大远景推进，故事连续但每格构图不同。",
        ]
      : isMaterial
        ? [
            "材质工艺分镜方向：把参考图中的同一材质、服饰、工艺或纹理扩展成 25 个连续微距/工艺镜头，保持金属线、布料、纹样、颜色和质感一致。",
            "25格建议顺序：1 主纹理微距；2 针线工作；3 手指持线；4 刺绣浮雕细节；5 纹样/装饰特写；6 宝石或镶嵌；7 螺旋纹；8 云纹/龙纹；9 边缘缝线；10 针尖细节；11 重复纹样；12 金线束；13 花纹与宝石；14 金粉/火花；15 结扣；16 绳索与纹样；17 眼睛或核心纹饰；18 云纹铺陈；19 流苏；20 鳞片/边纹；21 更宽的服饰图案；22 低角度细节；23 雕塑般的宏观纹理；24 局部服装/物件；25 完整服饰或物件收束。",
            "整体应是电影级暗调微距摄影，高对比、浅景深、金色高光、蓝/红/紫辅助色，保持工艺质感统一。",
          ]
        : [
            "人物或通用叙事分镜方向：基于参考主体生成 25 个连贯电影镜头，保持同一人物/主体身份、服装、场景基调和情绪线索一致。",
            "25格建议顺序：远景交代、行动进入、中景姿态、手部/脚步细节、面部近景、侧面、背影、环境互动、关键道具、情绪反应、光影转折、特写推进、高潮动作、结果镜头、最终定格等，镜头语言必须丰富且连续。",
            "整体应像电影广告分镜板，而不是设定图、参数表或同图重复拼贴。",
          ];

  return [
    "基于参考图生成一张 16:9 横向单张图片：25宫格连贯分镜。",
    "严格五行五列 5x5，共 25 个等尺寸画格；必须是一张完整合成图，不要生成 25 张散图。",
    "每个画格左上角必须用清晰中文白字标注：分镜1、分镜2、分镜3……一直到分镜25；编号必须完整、顺序正确、不能漏号、不能重复。",
    "画格之间使用细白线或干净浅色线分隔，形成清楚的分镜板结构；外边缘整齐，不要歪斜，不要出现多余大边框。",
    "非常重要：不要把参考图裁切成 25 块；必须围绕参考图主体重新生成 25 个不同镜头，每格都是新的构图、新景别、新机位或新细节。",
    "所有画格必须保持同一个主体、同一产品/人物/场景世界、同一材质特征、统一色彩和统一摄影风格，不能跑题、换主体、换品牌、换服装或换世界观。",
    "画面要像专业广告/电影分镜 contact sheet，镜头之间有连续性和推进感，同时每格内容明显不同。",
    "禁止出现英文标题、说明文字、参数表、UI 面板、网页截图、聊天气泡、额外 Logo 或新增水印；如果参考图有水印，不要放大或强调。",
    ...modeInstruction,
    sourceTitleHint,
    referenceHint,
  ]
    .filter(Boolean)
    .join("\n");
}

export function buildCharacterThreeViewPrompt(
  sourceNode: CanvasPromptSourceNode,
  mode: CharacterThreeViewMode,
  extraContext: string,
) {
  const sourceTitleHint = sourceNode.title?.trim() ? `参考角色标题：${sourceNode.title.trim()}` : "";
  const referenceHint = extraContext.trim() ? `参考补充信息：${extraContext.trim()}` : "";

  if (mode === "face") {
    return [
      "基于参考图中的同一角色，生成一张 16:9 横向角色脸部三视图参考照，效果参考专业影视定妆照，而不是海报、说明板或分栏模板。",
      "画面必须只有 3 个胸部以上半身近景人物，像三位角色参考照自然并排站在同一个影棚空间里；从左到右依次为：正面直视胸像、标准90度侧面胸像、45度四分之三胸像。",
      "三个人像必须处在同一个连续的灰色影棚背景里，背景自然贯通；绝对禁止任何竖向白条、竖线、分割线、分栏边界、拼接缝、面板缝、卡片边缘、相框边框或栏目式排版。",
      "每个人像都从头顶到胸口/上胸区域，肩颈和服装领口完整可见；不要全身，不要只截脸，不要出现第四个人像。",
      "三个人像要比画面示例略小一号，不能挤满画布；每个人像只占各自横向区域约70%-78%的宽度，头顶、左右肩膀和画面边缘之间都要保留可见灰色背景空隙。",
      "三个人像构图尺度接近，头部大小一致，眼睛高度基本对齐；三者之间必须有明显的连续灰色背景间隔，至少保留一个肩宽的空气感，头发、肩膀、脸部轮廓不能互相贴住、重叠或压边。",
      "人物之间的背景不能出现任何直线边界、色块断层或分割线；空隙必须是自然连续的影棚背景，而不是白条或竖栏。",
      "只允许保留同一角色身份，不得更换人物，不得改变年龄、性别、种族、发型、肤色、五官比例与面部骨骼关系。",
      "统一使用中性灰或暖灰影棚背景，电影级柔和侧光与轮廓光，真实皮肤质感，保留毛孔、细小纹理与自然阴影，禁止过度磨皮。",
      "如果参考图中人物有编发、伤痕、污渍、妆容、饰品、服装领口等关键识别特征，需要在三个角度中保持一致。",
      "整体要像一张完整连续摄影成片，而不是三张照片拼接；不要三栏布局、不要分区、不要标题、编号、字幕、Logo、水印、UI 元素或参数表。",
      sourceTitleHint,
      referenceHint,
    ]
      .filter(Boolean)
      .join("\n");
  }

  return [
    "基于参考图中的同一角色，生成一张 2:1 横向角色三视图参考照，效果参考专业影视角色定妆照，而不是电影海报、说明板或三栏模板。",
    "画面必须明确包含 4 个角色呈现：最左侧 1 个大幅胸部以上半身近景，右侧 3 个较小的全身视图。禁止只生成 3 个全身视图。",
    "四个角色呈现从左到右依次为：大幅正面胸像/半身近景、正面全身、标准90度侧面全身、背面全身。顺序不能改变。",
    "最左侧大幅半身近景约占总宽度的35%-40%，重点展示脸部、发型、领口和上半身识别特征；右侧三个全身人物均分剩余空间。",
    "右侧三个全身视图必须完整显示头到脚，脚不能被裁切，脚底在同一水平线上，站姿自然稳定，人物比例和服装尺度一致。",
    "构图必须像参考样张一样保留上下安全留白：四个角色头顶上方都要有明显白色空白，右侧三个全身人物的脚底下方也必须保留明显白色空白，不能顶到上边缘或贴到底边。",
    "四个角色必须处在同一个连续的纯白色影棚背景里，背景必须是无渐变、无色块、无灰墙感的统一纯白摄影棚白底，接近 #FFFFFF；不要灰色渐变、暗角、阴影色块、竖向白条、分割线、边框、卡片、面板缝、栏目线或拼贴相框。",
    "必须严格保留同一角色身份、脸型、五官、发型、服装、配色、材质、时代气质与人物设定，不得换人或把服装改成其他款式。",
    "四个呈现的布光、阴影方向、色温、皮肤质感、布料纹理和发型结构要统一；只允许人物脚下有极淡自然接触阴影，背景其他区域必须保持纯白且不能出现分隔条、灰色竖带或棚拍渐变。",
    "如果参考图里的角色带有污渍、旧化、伤痕、特殊发辫、民族或年代服饰特征，必须在大半身和三个全身视图中都保留下来。",
    "最终是一张完整连续的摄影参考图，不要标题文字、参数表、编号标签、说明文字、额外道具、无关背景、多余角色、重复肢体或残缺四肢。",
    sourceTitleHint,
    referenceHint,
  ]
    .filter(Boolean)
    .join("\n");
}
