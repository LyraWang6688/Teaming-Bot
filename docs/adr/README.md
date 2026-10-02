# Architecture Decision Records（ADR）

> Teaming-Bot 的架构决策记录。本目录记录「为什么这样设计」，不记录「怎么使用」。

## 什么是 ADR

一条 ADR 记录一个已经做出的、影响系统结构的决策，连同它当时的上下文、候选方案、取舍与后果。

ADR 回答的是「为什么是这样」。它不是教程、API 文档、操作手册、README，也不是完整项目历史。

## 什么时候写 ADR

满足以下任一条件就写：

- **选型**：在多个候选技术路线中做出取舍。
- **结构性约束**：决定影响多个模块的边界、分层或数据归属。
- **难以回退**：改回来的成本明显高于改过去。
- **被反复讨论**：同一个问题再次被提出，需要一个可引用的结论。

以下情况不写：普通功能迭代、Bug 修复、样式或文案调整。

## Status

| Status | 含义 |
| --- | --- |
| `Proposed` | 已提出，尚未定稿或尚未实施 |
| `Accepted` | 已采纳，当前有效 |
| `Superseded` | 已被后续 ADR 取代 |
| `Deprecated` | 仍然存在但不再推荐使用，且暂无替代方案 |

## 规则

- **ADR 不删除历史。** 已接受的内容不重写、不删除；发现写错时新建 ADR 说明修正。
- **新决策推翻旧决策时**：新建一条 ADR，并把旧 ADR 的 Status 标记为 `Superseded by ADR-XXX`，保留原文不动。
- **事实必须可分辨**：每条 ADR 需区分 `Repository Fact`（仓库可独立证明）与 `Human Owner Context`（本人提供、GitHub 无法独立证明）。
- **不编造**：无法确认的事实明确写出「无法确认」，不用推测填补结构。

## 索引

| ADR | 标题 | Status | Date |
| --- | --- | --- | --- |
| [ADR-001](./ADR-001-use-feishu-official-sdk-for-meeting-integration.md) | Use Feishu Official SDK for Meeting Integration | Accepted | 2026-07-20 |
| [ADR-002](./ADR-002-ai-host-integration-architecture.md) | Keep the Always-On Service as Event Source; Integrate AI Hosts as Interaction and Delivery Surface | Proposed | 2026-10-02 |

## 标注类别

`ADR-002` 起新增 `[Host]` 标注类别，用于标记「于本机宿主程序实测所得、附可复现命令、但不进入本仓库」的外部平台事实。理由：宿主能力既不能由本仓库证明，也不属于 Human Owner 的主观背景，混入 `[Repo]` 或 `[Owner]` 会破坏 ADR 的可分辨性。`[Host]` 证据随宿主版本变化可能失效，需在使用处显式提示。
