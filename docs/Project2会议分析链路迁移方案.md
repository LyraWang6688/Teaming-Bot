# Project 2 会议分析链路迁移方案

> 适用范围：当前 `Project` 项目
> 目标模板来源：`/Users/wangying/Documents/Codex/projects 2`
> 当前状态：方案评估与实施准备

---

## 1. 背景与目标

当前 `Project` 已经具备完整的平台外壳能力：

- 网页上传文本并创建异步分析任务
- 飞书妙记事件驱动的自动分析
- 多维表格回写与报告链接读取

本次任务**不调整这些外壳链路**，只聚焦“拿到文字稿之后”的两件事：

1. 如何进行会议分析
2. 如何渲染最终报告

本次迁移的唯一标准源是 `Project 2`。目标不是“参考其思路”，而是：

- **让当前项目的会议分析输出结构与 Project 2 完全一致**
- **让当前项目的最终报告模板与 Project 2 完全一致**

换句话说，本次迁移本质上是一次**分析内核与报告模板整体替换**。

---

## 2. 本次迁移的边界

### 2.1 在范围内

- 会议分析提示词与 JSON Schema
- 文本到结构化分析结果的后端处理逻辑
- Zone 判定、后处理、兜底规则
- `AnalysisResult` 类型结构
- 报告模板与报告展示组件
- 报告图表与报告内容区块

### 2.2 不在范围内

- 飞书自动化外壳
- 飞书事件监听
- 飞书任务 worker / pipeline 调度
- 妙记 transcript 获取逻辑
- Base 写回壳层
- 前端上传入口
- 前端上传异步任务壳层

### 2.3 需要保持不变的对外入口

以下调用关系保持不变：

- 网页上传链路最终仍调用 `analyzeMeetingText(meetingText)`
- 飞书自动分析链路最终仍调用 `analyzeMeetingText(meetingText)`
- 报告页仍通过当前 `/report` 路由读取 JSON 并渲染

也就是说，**外壳不动，内核替换**。

---

## 3. 标准源文件与承接文件

### 3.1 Project 2 中的标准源文件

| 模块 | Project 2 文件 |
|------|----------------|
| 分析主流程 | `src/app/api/analyze/route.ts` |
| 系统提示词 | `src/constants/teamingRules.ts` |
| Zone 与后处理规则 | `src/constants/zoneConfig.ts` |
| 分析输出类型 | `src/types/index.ts` |
| 报告模板 | `src/components/AnalysisDashboard.tsx` |
| 网络图组件 | `src/components/charts/NetworkGraph.tsx` |

### 3.2 当前项目中的承接位置

| 模块 | 当前项目文件 |
|------|--------------|
| 统一分析入口 | `src/services/analysisService.ts` |
| 系统提示词 | `src/constants/teamingRules.ts` |
| Zone 与后处理规则 | `src/constants/zoneConfig.ts` |
| 分析输出类型 | `src/types/index.ts` |
| 报告模板 | `src/components/AnalysisDashboard.tsx` |
| 图表组件目录 | `src/components/charts/` |

### 3.3 迁移原则

- **以 Project 2 为标准答案**
- 当前项目不保留“旧版分析结构优先”的思路
- 当前项目只保留平台级接入壳
- 不把 `Project 2` 的整条 API 路由直接搬入当前项目
- 只把其中真正属于“分析内核”的逻辑迁入 `analysisService.ts`

---

## 4. 当前差异摘要

## 4.1 类型结构差异

当前项目的 `AnalysisResult` 仍然偏轻，主要包含：

- `summary`
- `behaviors`
- `teamState`
- `leaderAdvice`
- `communication`

而 `Project 2` 最新版还额外包含：

- `keyAssumptions`
- `unfinishedDialogues`
- `unseenDisagreements`
- `dialogueNetwork`

这意味着当前项目的报告结构和 JSON 结构都还没有与 `Project 2` 对齐。

## 4.2 报告模板差异

当前项目的 [AnalysisDashboard](file:///Users/wangying/Documents/Codex/projects/src/components/AnalysisDashboard.tsx) 主要展示：

- 团队状态定位
- 行为雷达
- 四个行为卡片
- 领导建议

而 `Project 2` 最新版报告模板是更完整的结构，包含：

- 标准化报告头部说明
- 第一部分：团队整体状态如何
- 第二部分：对话网络与互动结构
- 第三部分：未完形的对话
- 第四部分：尚未看见的非共识 / 假设
- 给领导者的建议

当前项目中也尚未发现这些新版板块对应的消费逻辑和图表组件。

## 4.3 分析后处理差异

`Project 2` 的后处理更接近最新模板，包含：

- 更完整的 JSON 修复逻辑
- `low_sample` / `unbalanced` 影响判断的完整规则
- 低样本强制 `Difficult to Judge`
- Zone 被修正后重写 `teamState.analysis`
- `dialogueNetwork`、`unfinishedDialogues`、`unseenDisagreements` 等板块的兜底

当前项目虽然已有相当一部分能力，但输出目标仍是旧版轻量报告结构，因此不能视作“完全一致”。

---

## 5. 目标态定义

完成迁移后，当前项目需要达到以下目标态：

### 5.1 分析结果目标态

- `analyzeMeetingText()` 返回的 JSON 结构与 `Project 2` 最新版保持一致
- 字段命名、层级、可选字段策略与 `Project 2` 一致
- 低样本、灰度判断、Zone 重判、兜底策略与 `Project 2` 一致

### 5.2 报告模板目标态

- 当前项目的 [AnalysisDashboard](file:///Users/wangying/Documents/Codex/projects/src/components/AnalysisDashboard.tsx) 视觉结构与内容区块顺序与 `Project 2` 一致
- 当前项目的图表组件与 `Project 2` 保持一致
- 报告页 `/report` 和网页上传结果页都复用同一套新版模板

### 5.3 外壳目标态

- 飞书链路无需感知模板升级，只继续传入 `meetingText`
- 上传链路无需感知模板升级，只继续传入 `meetingText`
- Base 写回仍然写入 `JSON数据`，但内容将升级为新版结构

---

## 6. 文件级迁移清单

## 6.1 第一阶段：类型对齐

需要修改：

- `src/types/index.ts`

迁移目标：

- 对齐 `Project 2` 的 `AnalysisResult`
- 新增以下类型：
  - `DialogueNetwork`
  - `NetworkNode`
  - `NetworkEdge`
  - `UnfinishedDialogue`
  - `UnseenDisagreement`
  - `KeyAssumption`
- 保持当前项目页面和报告页仍可消费统一类型

注意事项：

- 这一步是后续迁移的基础，应最先完成
- 如果类型不先统一，后续 `analysisService` 与 `AnalysisDashboard` 会持续返工

## 6.2 第二阶段：规则与提示词对齐

需要修改：

- `src/constants/teamingRules.ts`
- `src/constants/zoneConfig.ts`

迁移目标：

- 以 `Project 2` 最新提示词为准整体替换或逐段对齐
- 以 `Project 2` 最新 Zone 判定与兜底规则为准
- 确保当前项目的分析规则语义与 `Project 2` 一致

注意事项：

- 不做“本地旧规则优先”的折中
- `Project 2` 是标准源，当前项目只做路径和导出方式适配

## 6.3 第三阶段：分析服务重构

需要修改：

- `src/services/analysisService.ts`

迁移目标：

- 将 `Project 2` 中真正属于分析内核的逻辑迁入
- 保留当前导出签名：
  - `analyzeMeetingText(meetingText: string): Promise<AnalysisResult>`
- 内部实现改为对齐 `Project 2`

需要迁入的内容包括：

- 完整 JSON Schema
- LLM 用户 prompt 结构
- JSON 解析与修复
- 样本不足逻辑
- Zone 重判逻辑
- `analysis` 重写逻辑
- 网络结构 / 未完形 / 非共识 / 假设板块兜底

注意事项：

- 不能把 `Project 2` 的 API 路由直接照搬成当前项目 API
- 需要抽取其中纯分析逻辑，落到服务层

## 6.4 第四阶段：报告模板整体迁入

需要修改：

- `src/components/AnalysisDashboard.tsx`

可能需要新增：

- `src/components/charts/NetworkGraph.tsx`

可能需要调整：

- `src/utils/*`
- `src/components/charts/*`

迁移目标：

- 让当前项目报告模板与 `Project 2` 最新版保持一致
- 当前项目保留自己的导出能力与隐藏姓名能力，但模板区块、结构与数据消费以 `Project 2` 为准

注意事项：

- 当前项目现有 `BehaviorRadar`、`TeamStateChart` 不一定需要删除，但报告模板应以 `Project 2` 最终结构为准
- 若 `Project 2` 模板不再使用现有雷达图或现有布局，应允许替换而不是兼容堆叠

---

## 7. 历史数据兼容策略

这是本次迁移必须提前确认的风险点。

当前项目历史上已经存在：

- Base 中旧结构的 `JSON数据`
- 网页上传异步任务可能生成过旧结构结果

而迁移后新的 `AnalysisResult` 会升级为 `Project 2` 结构。

### 建议策略

优先建议采用以下策略：

1. **新分析结果直接写新版结构**
2. **旧报告数据不做自动数据库迁移**
3. **Dashboard 对旧字段做最低限度兼容兜底**
4. 如需完全一致展示，历史记录建议触发重新分析

### 原因

- 当前项目报告入口是“读 JSON 并渲染”，旧数据结构与新模板并不天然兼容
- 如果强行兼容所有历史版本，前端会堆积大量临时分支逻辑，影响模板一致性

### 建议结论

- **新模板对新数据完全一致**
- **旧记录仅做有限兼容，必要时提示重新生成分析**

---

## 8. 实施顺序

建议按以下顺序实施，避免反复返工：

1. `src/types/index.ts`
2. `src/constants/teamingRules.ts`
3. `src/constants/zoneConfig.ts`
4. `src/services/analysisService.ts`
5. `src/components/AnalysisDashboard.tsx`
6. `src/components/charts/*` 补齐新版图表组件
7. 最后做兼容检查与回归测试

---

## 9. 验收标准

迁移完成后，至少满足以下验收条件：

### 9.1 分析结果一致性

- 对同一份文字稿：
  - 当前项目输出的结构字段与 `Project 2` 一致
  - 区域判定与关键板块语义一致

### 9.2 报告模板一致性

- 当前项目最终报告区块顺序与 `Project 2` 一致
- 主要图表与说明区块与 `Project 2` 一致
- 报告文案结构与视觉节奏与 `Project 2` 一致

### 9.3 外壳稳定性

- 飞书自动分析链路无需改调用方式即可继续运行
- 网页上传链路无需改入口方式即可继续运行
- `/report` 页面仍能通过 `recordId/integrationId/orgTargetId` 读取报告

### 9.4 工程约束

- 类型检查通过
- 报告页可正常渲染
- 不引入新的飞书初始化或任务链路改动

---

## 10. 本次实施建议

本次迁移不建议“一步到位直接覆盖所有文件”。

推荐做法是：

- **先完成类型与分析内核迁移**
- **再完成报告模板整体替换**
- **最后处理旧 JSON 的最低限度兼容**

如果按这个方案推进，当前项目可以在保留外层稳定性的前提下，把 `Project 2` 最新分析模板完整承接进来。
