# Toonflow 来源与替换范围

2026-11-03：用户表示已与 ToonFlow 官方确认，过去版本依然适用 MIT。本项目据此记录旧导入版本的 MIT 适用性，保留 HBAI-Ltd 及贡献者署名、来源和历史许可文件；这不是我们独立取得邮件或书面授权的声明。旧版许可差异不再作为必须重写或等待再次确认的阻断。

核对日期：2026-11-02；执行者：Codex-开源准备。当前 API 基线 `0e9bab50c`，另含本轮独立依赖补丁；初始导入 `704790fbb`（Toonflow 1.1.7）。未操作生产，也未删除或改写业务实现。

## 当前方向

用户最新接受保留 Toonflow 来源及适用许可。优先核对实际采用版本、将许可明确的上游代码纳入来源清单；以下重写顺序是对残余不明确部分的备选，不是必须整体重写 198 个文件的决定。保留 Agent、快速创作、画布等现有功能，本轮未改变模式入口。见 [来源声明](../../third_party/toonflow/README.md)。

## 判断

建议保留繁境现有平台架构，逐步替换实际沿用的旧实现，不整仓升级上游。新版采用 Bun 1.4.3、workspace 与 Vue Web；繁境是 Node/React、PostgreSQL/Redis、多租户与独立 Worker。两者需接口和数据迁移设计，不能直接覆盖。

仅以同路径和 blob 比较，旧 206 个 API 源文件中，198 个路径仍存在（61 个完全相同、137 个修改过）；当前 API 共 1,259 文件。198 个占约 15.7% 是路径统计，不是版权或代码原创度结论。静态构建仍纳入其中 195 个（含 59 个完全相同的文件）。373 个不在旧同路径集合中的模块直接引用这些文件；此数不代表所有业务运行时都执行它们。

关键依赖：数据库封装 `utils/db.ts` 被 242 个新模块直接引用；响应封装 `lib/responseFormat.ts` 为 227 个；工具聚合 `utils.ts` 为 41 个；旧 middleware 为 38 个。接口小而调用广，适合先保留契约替换实现，不能直接删除。

## 分组与顺序

| 来源组 | 文件 | 原样 | 进入构建 | 建议 |
| --- | ---: | ---: | ---: | --- |
| `agents` | 2 | 0 | 2 | 隔离核对；迁移记录与线上兼容语义保持不变 |
| `app.ts` | 1 | 0 | 1 | 隔离核对；迁移记录与线上兼容语义保持不变 |
| `core.ts` | 1 | 0 | 1 | 隔离核对；迁移记录与线上兼容语义保持不变 |
| `env.ts` | 1 | 0 | 1 | 隔离核对；迁移记录与线上兼容语义保持不变 |
| `err.ts` | 1 | 0 | 1 | 隔离核对；迁移记录与线上兼容语义保持不变 |
| `lib` | 4 | 1 | 4 | 先写输入/输出及授权行为契约，再独立替换公共实现 |
| `logger.ts` | 1 | 1 | 0 | 隔离核对；迁移记录与线上兼容语义保持不变 |
| `middleware` | 1 | 0 | 1 | 先写输入/输出及授权行为契约，再独立替换公共实现 |
| `routes/agents` | 2 | 2 | 2 | 核对 Web/MCP 调用、数据读写后按功能组替换或停用 |
| `routes/artStyle` | 4 | 1 | 4 | 核对 Web/MCP 调用、数据读写后按功能组替换或停用 |
| `routes/assets` | 15 | 1 | 15 | 核对 Web/MCP 调用、数据读写后按功能组替换或停用 |
| `routes/assetsGenerate` | 5 | 1 | 5 | 核对 Web/MCP 调用、数据读写后按功能组替换或停用 |
| `routes/common` | 1 | 1 | 1 | 核对 Web/MCP 调用、数据读写后按功能组替换或停用 |
| `routes/cornerScape` | 4 | 2 | 4 | 核对 Web/MCP 调用、数据读写后按功能组替换或停用 |
| `routes/general` | 3 | 0 | 3 | 核对 Web/MCP 调用、数据读写后按功能组替换或停用 |
| `routes/login` | 1 | 0 | 1 | 核对 Web/MCP 调用、数据读写后按功能组替换或停用 |
| `routes/modelSelect` | 2 | 2 | 2 | 核对 Web/MCP 调用、数据读写后按功能组替换或停用 |
| `routes/novel` | 12 | 2 | 12 | 核对 Web/MCP 调用、数据读写后按功能组替换或停用 |
| `routes/other` | 2 | 1 | 2 | 核对 Web/MCP 调用、数据读写后按功能组替换或停用 |
| `routes/production` | 37 | 10 | 37 | 核对 Web/MCP 调用、数据读写后按功能组替换或停用 |
| `routes/project` | 14 | 3 | 14 | 核对 Web/MCP 调用、数据读写后按功能组替换或停用 |
| `routes/script` | 9 | 1 | 9 | 核对 Web/MCP 调用、数据读写后按功能组替换或停用 |
| `routes/scriptAgent` | 3 | 0 | 3 | 核对 Web/MCP 调用、数据读写后按功能组替换或停用 |
| `routes/setting` | 46 | 25 | 46 | 核对 Web/MCP 调用、数据读写后按功能组替换或停用 |
| `routes/task` | 4 | 0 | 4 | 核对 Web/MCP 调用、数据读写后按功能组替换或停用 |
| `socket` | 4 | 2 | 3 | 隔离核对；迁移记录与线上兼容语义保持不变 |
| `utils` | 17 | 5 | 16 | 先写输入/输出及授权行为契约，再独立替换公共实现 |
| `utils.ts` | 1 | 0 | 1 | 先写输入/输出及授权行为契约，再独立替换公共实现 |

## 替换验收

1. 以现有公开接口、Web/MCP 行为和数据库契约建立合成测试，不拿原实现逐行改写或改名当作独立实现证明。
2. 优先重建响应、路径、日志和工具入口；保持调用契约，以定向回归覆盖调用方。
3. 小说/剧本/分镜、旧供应商配置、素材生成等按功能组核对实际调用。无调用证据不能直接声称废弃；确认保留的功能另写实现，确认停用的功能再清理路由和调用入口。
4. 数据库初始化、存储与旧 Socket 流程单独评估。不得改写已部署迁移历史；新实现需验证已有数据、授权、计费、重试与 Worker 恢复。
5. 再核查改名/新增派生文件、提示词、模板、静态数据和素材；本清单只覆盖旧 API src 同路径，不能凭列表归零宣称许可问题已消除。来源/许可评审与工程测试分开。

## 许可证据

本地初始包元数据标示 Toonflow 1.1.7、作者 HBAI-Ltd。初始 LICENSE 含 Apache-2.0 与补充条款；2020fd41b 删除附加条款的事实不证明取得再许可权。原文已保全于 [third_party](../../third_party/toonflow/LICENSE)。

当前上游 commit `ecd5325c7f9b38721491382ee6952fa2318b4693` 的 [LICENSE](https://github.com/HBAI-Ltd/Toonflow-app/blob/ecd5325c7f9b38721491382ee6952fa2318b4693/LICENSE) 为 MIT；[README](https://github.com/HBAI-Ltd/Toonflow-app/blob/ecd5325c7f9b38721491382ee6952fa2318b4693/README.md#8--开源许可) 仍明示 v1.0.8～v1.1.8 按原 Apache-2.0 与附加协议。用户于 2026-11-03 与官方确认过去版本依然 MIT，本项目据此整理许可；历史文字作为来源证据留存，不再要求重写或再次确认。目标公开仓库尚未确定；本轮未发布或代签协议。

## 文件清单

“修改过”只表示 blob 不同，不表示已独立重写。“在构建”来自当前 API esbuild 静态输入；不证明运行频率或某接口对外使用。

| 当前路径 | 与导入版本比较 | 进入构建 | 新模块直接引用数 |
| --- | --- | --- | ---: |
| `agents/scriptAgent/index.ts` | 修改过 | 是 | 0 |
| `agents/scriptAgent/tools.ts` | 修改过 | 是 | 0 |
| `app.ts` | 修改过 | 是 | 0 |
| `core.ts` | 修改过 | 是 | 0 |
| `env.ts` | 修改过 | 是 | 0 |
| `err.ts` | 修改过 | 是 | 0 |
| `lib/fixDB.ts` | 修改过 | 是 | 1 |
| `lib/initDB.ts` | 修改过 | 是 | 1 |
| `lib/responseFormat.ts` | 原样 | 是 | 227 |
| `lib/vendor.json` | 修改过 | 是 | 1 |
| `logger.ts` | 原样 | 否 | 0 |
| `middleware/middleware.ts` | 修改过 | 是 | 38 |
| `routes/agents/clearMemory.ts` | 原样 | 是 | 0 |
| `routes/agents/getMemory.ts` | 原样 | 是 | 0 |
| `routes/artStyle/addArtStyle.ts` | 修改过 | 是 | 0 |
| `routes/artStyle/editArtStyle.ts` | 修改过 | 是 | 0 |
| `routes/artStyle/extractStylePrompt.ts` | 修改过 | 是 | 0 |
| `routes/artStyle/getArtStyle.ts` | 原样 | 是 | 0 |
| `routes/assets/addAssets.ts` | 修改过 | 是 | 1 |
| `routes/assets/addAudioAssets.ts` | 修改过 | 是 | 0 |
| `routes/assets/batchDelete.ts` | 修改过 | 是 | 0 |
| `routes/assets/batchGenerationData.ts` | 修改过 | 是 | 0 |
| `routes/assets/delAssets.ts` | 修改过 | 是 | 1 |
| `routes/assets/delImage.ts` | 修改过 | 是 | 0 |
| `routes/assets/getAssetsApi.ts` | 修改过 | 是 | 0 |
| `routes/assets/getImage.ts` | 修改过 | 是 | 1 |
| `routes/assets/getMaterialData.ts` | 修改过 | 是 | 0 |
| `routes/assets/pollingImageAssets.ts` | 修改过 | 是 | 0 |
| `routes/assets/pollingPromptAssets.ts` | 原样 | 是 | 0 |
| `routes/assets/saveAssets.ts` | 修改过 | 是 | 0 |
| `routes/assets/updateAssets.ts` | 修改过 | 是 | 1 |
| `routes/assets/updateAudioAssets.ts` | 修改过 | 是 | 0 |
| `routes/assets/uploadClip.ts` | 修改过 | 是 | 0 |
| `routes/assetsGenerate/batchGenerateImageAssets.ts` | 修改过 | 是 | 0 |
| `routes/assetsGenerate/batchPolishAssetsPrompt.ts` | 修改过 | 是 | 0 |
| `routes/assetsGenerate/cancelGenerate.ts` | 原样 | 是 | 0 |
| `routes/assetsGenerate/generateAssets.ts` | 修改过 | 是 | 0 |
| `routes/assetsGenerate/polishAssetsPrompt.ts` | 修改过 | 是 | 0 |
| `routes/common/getBigImage.ts` | 原样 | 是 | 0 |
| `routes/cornerScape/batchBindAudio.ts` | 修改过 | 是 | 0 |
| `routes/cornerScape/getAllAssets.ts` | 修改过 | 是 | 0 |
| `routes/cornerScape/pollingAudio.ts` | 原样 | 是 | 0 |
| `routes/cornerScape/updateAssetsAudio.ts` | 原样 | 是 | 0 |
| `routes/general/generalStatistics.ts` | 修改过 | 是 | 0 |
| `routes/general/getSingleProject.ts` | 修改过 | 是 | 0 |
| `routes/general/updateProject.ts` | 修改过 | 是 | 0 |
| `routes/login/login.ts` | 修改过 | 是 | 0 |
| `routes/modelSelect/getModelDetail.ts` | 原样 | 是 | 0 |
| `routes/modelSelect/getModelList.ts` | 原样 | 是 | 0 |
| `routes/novel/addNovel.ts` | 修改过 | 是 | 1 |
| `routes/novel/batchDeleteNovel.ts` | 修改过 | 是 | 1 |
| `routes/novel/delNovel.ts` | 修改过 | 是 | 0 |
| `routes/novel/event/batchDeleteEvent.ts` | 修改过 | 是 | 1 |
| `routes/novel/event/deletEvent.ts` | 修改过 | 是 | 0 |
| `routes/novel/event/generateEvents.ts` | 修改过 | 是 | 1 |
| `routes/novel/event/getEvent.ts` | 修改过 | 是 | 1 |
| `routes/novel/getNovel.ts` | 修改过 | 是 | 1 |
| `routes/novel/getNovelData.ts` | 原样 | 是 | 1 |
| `routes/novel/getNovelEventState.ts` | 修改过 | 是 | 1 |
| `routes/novel/getNovelIndex.ts` | 原样 | 是 | 1 |
| `routes/novel/updateNovel.ts` | 修改过 | 是 | 1 |
| `routes/other/deleteAllData.ts` | 修改过 | 是 | 0 |
| `routes/other/getVersion.ts` | 原样 | 是 | 1 |
| `routes/production/assets/batchGenerateAssetsImage.ts` | 修改过 | 是 | 0 |
| `routes/production/assets/deleteAssetsDireve.ts` | 修改过 | 是 | 0 |
| `routes/production/assets/pollingImage.ts` | 原样 | 是 | 0 |
| `routes/production/assets/updateAssetsUrl.ts` | 修改过 | 是 | 0 |
| `routes/production/editImage/generateFlowImage.ts` | 修改过 | 是 | 0 |
| `routes/production/editImage/getImageDefaultModle.ts` | 原样 | 是 | 0 |
| `routes/production/editImage/getImageFlow.ts` | 原样 | 是 | 0 |
| `routes/production/editImage/saveImageFlow.ts` | 修改过 | 是 | 0 |
| `routes/production/editImage/updateImageFlow.ts` | 原样 | 是 | 0 |
| `routes/production/editImage/uploadImage.ts` | 修改过 | 是 | 0 |
| `routes/production/getStoryboardData.ts` | 修改过 | 是 | 1 |
| `routes/production/storyboard/addStoryboard.ts` | 修改过 | 是 | 1 |
| `routes/production/storyboard/batchAddStoryboardInfo.ts` | 修改过 | 是 | 0 |
| `routes/production/storyboard/batchDelete.ts` | 修改过 | 是 | 1 |
| `routes/production/storyboard/batchGenerateImage.ts` | 修改过 | 是 | 1 |
| `routes/production/storyboard/downPreviewImage.ts` | 修改过 | 是 | 0 |
| `routes/production/storyboard/editStoryboardInfo.ts` | 修改过 | 是 | 1 |
| `routes/production/storyboard/getStoryboardData.ts` | 原样 | 是 | 0 |
| `routes/production/storyboard/pollingImage.ts` | 原样 | 是 | 0 |
| `routes/production/storyboard/previewImage.ts` | 修改过 | 是 | 0 |
| `routes/production/storyboard/removeFrame.ts` | 修改过 | 是 | 0 |
| `routes/production/storyboard/updateStoryboardUrl.ts` | 原样 | 是 | 0 |
| `routes/production/workbench/addTrack.ts` | 修改过 | 是 | 0 |
| `routes/production/workbench/batchGeneratePrompt.ts` | 修改过 | 是 | 0 |
| `routes/production/workbench/batchGenerateVideo.ts` | 修改过 | 是 | 1 |
| `routes/production/workbench/checkVideoStateList.ts` | 修改过 | 是 | 0 |
| `routes/production/workbench/delVideo.ts` | 修改过 | 是 | 1 |
| `routes/production/workbench/deleteTrack.ts` | 修改过 | 是 | 0 |
| `routes/production/workbench/generateVideo.ts` | 修改过 | 是 | 0 |
| `routes/production/workbench/generateVideoPrompt.ts` | 修改过 | 是 | 0 |
| `routes/production/workbench/getAudioBindAssetsList.ts` | 修改过 | 是 | 0 |
| `routes/production/workbench/getFileUrl.ts` | 原样 | 是 | 0 |
| `routes/production/workbench/getGenerateData.ts` | 修改过 | 是 | 1 |
| `routes/production/workbench/getVideoList.ts` | 修改过 | 是 | 0 |
| `routes/production/workbench/selectVideo.ts` | 修改过 | 是 | 1 |
| `routes/production/workbench/updateVideoDuration.ts` | 原样 | 是 | 1 |
| `routes/production/workbench/updateVideoPrompt.ts` | 原样 | 是 | 1 |
| `routes/project/addDirectorManual.ts` | 修改过 | 是 | 0 |
| `routes/project/addProject.ts` | 修改过 | 是 | 0 |
| `routes/project/addVisualManual.ts` | 修改过 | 是 | 0 |
| `routes/project/delProject.ts` | 修改过 | 是 | 1 |
| `routes/project/deleteDirectorManual.ts` | 修改过 | 是 | 0 |
| `routes/project/deleteVisualManual.ts` | 修改过 | 是 | 0 |
| `routes/project/editDirectorlManual.ts` | 修改过 | 是 | 0 |
| `routes/project/editProject.ts` | 修改过 | 是 | 1 |
| `routes/project/editVisualManual.ts` | 修改过 | 是 | 0 |
| `routes/project/getModelDetails.ts` | 原样 | 是 | 0 |
| `routes/project/getProject.ts` | 修改过 | 是 | 0 |
| `routes/project/getVisualManual.ts` | 修改过 | 是 | 0 |
| `routes/project/queryDirectorManual.ts` | 原样 | 是 | 0 |
| `routes/project/visualManual.ts` | 原样 | 是 | 0 |
| `routes/script/addScript.ts` | 修改过 | 是 | 1 |
| `routes/script/batchAddScript.ts` | 修改过 | 是 | 1 |
| `routes/script/delScript.ts` | 修改过 | 是 | 1 |
| `routes/script/exportScript.ts` | 原样 | 是 | 0 |
| `routes/script/extractAssets.ts` | 修改过 | 是 | 1 |
| `routes/script/getAiRegex.ts` | 修改过 | 是 | 0 |
| `routes/script/getScrptApi.ts` | 修改过 | 是 | 1 |
| `routes/script/pollScriptAssets.ts` | 修改过 | 是 | 0 |
| `routes/script/updateScript.ts` | 修改过 | 是 | 1 |
| `routes/scriptAgent/getPlanData.ts` | 修改过 | 是 | 0 |
| `routes/scriptAgent/setPlanData.ts` | 修改过 | 是 | 0 |
| `routes/scriptAgent/updateData.ts` | 修改过 | 是 | 0 |
| `routes/setting/about/checkUpdate.ts` | 修改过 | 是 | 0 |
| `routes/setting/about/downloadApp.ts` | 原样 | 是 | 0 |
| `routes/setting/agentDeploy/agentSetKey.ts` | 修改过 | 是 | 0 |
| `routes/setting/agentDeploy/deployAgentModel.ts` | 修改过 | 是 | 0 |
| `routes/setting/agentDeploy/getAgentDeploy.ts` | 修改过 | 是 | 0 |
| `routes/setting/agentDeploy/getAgentUseMode.ts` | 原样 | 是 | 0 |
| `routes/setting/agentDeploy/updateUseMode.ts` | 原样 | 是 | 0 |
| `routes/setting/dbConfig/clearData.ts` | 修改过 | 是 | 0 |
| `routes/setting/dbConfig/clearTable.ts` | 修改过 | 是 | 0 |
| `routes/setting/dbConfig/dbInfo.ts` | 修改过 | 是 | 0 |
| `routes/setting/dbConfig/exportData.ts` | 修改过 | 是 | 0 |
| `routes/setting/dbConfig/importData.ts` | 修改过 | 是 | 0 |
| `routes/setting/dev/getSwitchAiDevTool.ts` | 原样 | 是 | 0 |
| `routes/setting/dev/updateSwitchAiDevTool.ts` | 原样 | 是 | 0 |
| `routes/setting/fileManagement/openFolder.ts` | 修改过 | 是 | 0 |
| `routes/setting/getTextModel.ts` | 原样 | 是 | 0 |
| `routes/setting/loginConfig/getUser.ts` | 修改过 | 是 | 0 |
| `routes/setting/loginConfig/updateUserPwd.ts` | 修改过 | 是 | 0 |
| `routes/setting/memoryConfig/delAllMemory.ts` | 原样 | 是 | 0 |
| `routes/setting/memoryConfig/getMemory.ts` | 原样 | 是 | 0 |
| `routes/setting/memoryConfig/sureMemory.ts` | 原样 | 是 | 0 |
| `routes/setting/modelMap/bindingPrompt.ts` | 原样 | 是 | 0 |
| `routes/setting/modelMap/deletePrompt.ts` | 原样 | 是 | 0 |
| `routes/setting/modelMap/getImageAndVideoModel.ts` | 修改过 | 是 | 0 |
| `routes/setting/modelMap/getPromptList.ts` | 修改过 | 是 | 0 |
| `routes/setting/modelMap/savePrompt.ts` | 原样 | 是 | 0 |
| `routes/setting/modelMap/updatePrompt.ts` | 原样 | 是 | 0 |
| `routes/setting/promptManage/getPrompt.ts` | 修改过 | 是 | 1 |
| `routes/setting/promptManage/updatePrompt.ts` | 修改过 | 是 | 1 |
| `routes/setting/skillManagement/getSkillContent.ts` | 原样 | 是 | 0 |
| `routes/setting/skillManagement/getSkillList.ts` | 修改过 | 是 | 0 |
| `routes/setting/skillManagement/saveSkillContent.ts` | 原样 | 是 | 0 |
| `routes/setting/vendorConfig/addVendor.ts` | 修改过 | 是 | 0 |
| `routes/setting/vendorConfig/addVendorModel.ts` | 原样 | 是 | 0 |
| `routes/setting/vendorConfig/delVendorModel.ts` | 原样 | 是 | 0 |
| `routes/setting/vendorConfig/deleteVendor.ts` | 原样 | 是 | 0 |
| `routes/setting/vendorConfig/enableVendor.ts` | 原样 | 是 | 0 |
| `routes/setting/vendorConfig/getCodeByLink.ts` | 原样 | 是 | 0 |
| `routes/setting/vendorConfig/getVendorList.ts` | 修改过 | 是 | 0 |
| `routes/setting/vendorConfig/modelTest.ts` | 原样 | 是 | 0 |
| `routes/setting/vendorConfig/modelTest/imageTest.ts` | 修改过 | 是 | 0 |
| `routes/setting/vendorConfig/modelTest/textTest.ts` | 原样 | 是 | 0 |
| `routes/setting/vendorConfig/modelTest/videoTest.ts` | 原样 | 是 | 0 |
| `routes/setting/vendorConfig/upVendorModel.ts` | 原样 | 是 | 0 |
| `routes/setting/vendorConfig/updateCode.ts` | 原样 | 是 | 0 |
| `routes/setting/vendorConfig/updateVendorInputs.ts` | 修改过 | 是 | 0 |
| `routes/task/getProject.ts` | 修改过 | 是 | 0 |
| `routes/task/getTaskApi.ts` | 修改过 | 是 | 0 |
| `routes/task/getTaskCategories.ts` | 修改过 | 是 | 0 |
| `routes/task/taskDetails.ts` | 修改过 | 是 | 0 |
| `socket/chatMessagesData.d.ts` | 原样 | 否 | 0 |
| `socket/index.ts` | 修改过 | 是 | 0 |
| `socket/resTool.ts` | 原样 | 是 | 0 |
| `socket/routes/scriptAgent.ts` | 修改过 | 是 | 0 |
| `utils.ts` | 修改过 | 是 | 41 |
| `utils/agent/embedding.ts` | 修改过 | 是 | 0 |
| `utils/agent/memory.ts` | 修改过 | 是 | 0 |
| `utils/agent/skillsTools.ts` | 修改过 | 否 | 0 |
| `utils/ai.ts` | 修改过 | 是 | 0 |
| `utils/db.ts` | 修改过 | 是 | 242 |
| `utils/error.ts` | 原样 | 是 | 0 |
| `utils/getArtPrompt.ts` | 原样 | 是 | 0 |
| `utils/getConfig.ts` | 修改过 | 是 | 0 |
| `utils/getPath.ts` | 修改过 | 是 | 8 |
| `utils/getPrompts.ts` | 原样 | 是 | 0 |
| `utils/oss.ts` | 修改过 | 是 | 6 |
| `utils/replaceUrl.ts` | 修改过 | 是 | 0 |
| `utils/stripThink.ts` | 原样 | 是 | 1 |
| `utils/taskRecord.ts` | 修改过 | 是 | 0 |
| `utils/vendor.ts` | 原样 | 是 | 0 |
| `utils/vm.ts` | 修改过 | 是 | 0 |
| `utils/writeVersion.ts` | 修改过 | 是 | 0 |
