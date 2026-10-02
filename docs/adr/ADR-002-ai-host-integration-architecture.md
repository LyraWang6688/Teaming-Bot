# ADR-002: Keep the Always-On Service as Event Source; Integrate AI Hosts as Interaction and Delivery Surface

Status: Proposed
Date: 2026-10-02

> 标注约定：
> **[Repo]** = 可从公开仓库（commit / PR / docs / 当前代码）独立证明；
> **[Owner]** = 由 Human Owner 提供、仓库无法独立证明的决策背景；
> **[Host]** = 于本机宿主程序（豆包工作 / WorkBuddy / Codex）实测所得，附可复现命令，但**不进入本仓库**，因此随宿主版本变化可能失效；
> **无法确认** = 现有证据不足以判定，不做推测填补。
>
> `[Host]` 是本 ADR 新增的标注类别。宿主能力属于外部平台事实，既不能由本仓库证明，也不属于 Human Owner 的主观背景，混入两者会破坏 ADR 的可分辨性。

## Context

当前系统是一条**事件驱动**的常驻链路：飞书妙记生成事件 → 任务入队 → 妙记导出 → LLM 分析 → 报告持久化 → Base 写回 + 飞书机器人卡片通知。事件接收依赖常驻进程持有 `WSClient` 长连接，交付依赖数据库任务表与租约 worker。**[Repo]**（`docs/飞书集成设计.md` 第七、八章；`src/lib/feishu/events/eventListenerManager.ts`；`src/lib/feishu/delivery/deliveryWorker.ts`）

Owner 提出的重构意图是：把项目重构成**依托 AI Agent 宿主**（豆包工作、WorkBuddy、Codex 等）存在，通过在这些宿主里安装一个组件（skill / MCP / CLI），实现「用户会议结束后把会议报告推送给用户，或推送到与豆包工作、WorkBuddy 的聊天里」。**[Owner]**

该意图同时参考了一份外部经验沉淀：`wechat-draft-mcp` 项目的《豆包工作 与 WorkBuddy：MCP 接入调研与实战沉淀》（本机路径 `/Users/wangying/Documents/workplace/wechat-draft-mcp/docs/feishu-doubao-workbuddy-mcp.md`）。**[Owner]** 该文档的实测对象与结论经本机复核后与 `[Host]` 证据一致。

### 决定架构边界的三条事实

**事实一：宿主侧组件是拉取型的，会议结束是推送型事件。**

MCP 工具与 Skill 只有在宿主模型于会话中主动调用时才执行；豆包工作的 MCP 客户端（Rust `rmcp-3.2.0`）虽然实现了 `notifications/message`、`notifications/progress`、`resources/subscribe` + `notifications/resources/updated`、`notifications/tasks` 等服务端通知方法 **[Host]**（`strings -n 8 /Applications/DoubaoWork.app/Contents/Helpers/libmcp_helper.dylib`），但**宿主是否把这些通知渲染为用户可见的聊天消息、是否常驻订阅，无法确认**。

**事实二：第三方无法向宿主会话主动注入消息。**

在豆包工作、WorkBuddy、Codex 三台宿主上均未发现任何「第三方向既有会话写入消息」的公开接口或本地机制。**[Host]** + **无法确认**（三者的公开文档边界未能完整核实，但本机未发现该能力）。

**事实三：飞书事件可以在本地被消费，但进程必须存活。**

本机 `lark-cli` v1.0.97 的 `event list` 包含 `minutes.minute.generated_v1`、`vc.meeting.participant_meeting_ended_v1` 等 EventKey，并提供 event bus daemon（`lark-cli event status`），说明**用户身份的事件消费可以不走公网 webhook，仅靠 WS 长连接在本机完成**。**[Host]** 但 WS 长连接不补发离线期间的事件，因此**宿主未运行时的事件必然丢失**。

### 被混为一谈的三种能力

Owner 的表述中实际包含三种难度差异极大的能力 **[Owner]** + **[Repo]**：

| # | 能力 | 形态 | 可行性 |
|---|---|---|---|
| A | 在宿主里**查询**会议报告（问答式） | MCP / Skill，拉取 | 可行 |
| B | 在宿主里**配置**集成、看任务状态、重跑分析 | MCP / Skill / CLI，拉取 | 可行 |
| C | 会议结束后**自动推送**到宿主聊天 | 需推送，且第三方无注入通道 | **受事实一、二约束** |

`wechat-draft-mcp` 的经验覆盖的是 A 类场景（用户主动要求 → 模型调用工具）。**其结论不能直接外推到 C 类**：那篇文档的第 5、7 章（stdout 纯净性、传引用不传正文、幂等、路径沙箱、返回值紧凑、npx 分发）对 A、B 完全适用，但**没有回答 C**。

### 宿主侧调度能力（C 的唯一可能绕法）

本机实测确认三台宿主中至少两台具备**定时唤醒 Agent** 的能力：

- **Codex**：`~/.codex/automations/<id>/automation.toml` 使用 `kind = "cron"` + `rrule` + `prompt` + `model` + `target`，本机已有 6 条实例（`automation`、`daily-bug-scan-2`、`skill-progression-map`、`update-agents-md`、`update-agents-md-b6a89b134245`、`weekly-pr-summary`）。**[Host]**
- **WorkBuddy**：`app.asar` 中「定时任务」命中 188 次，含「是否启用定时任务（Cron）功能」「定时任务：」，并出现「定时任务的四张表」。**[Host]**
- **豆包工作**：未发现定时任务能力的证据。**无法确认**。

「定时唤醒 → 调工具拉取 → 在会话中产出可见消息」是唯一不依赖「第三方注入会话」的推送路径，且已被 Codex 的既有机制形态证明可行。**[Host]**

## Options Considered

### Option A: 完全去服务端，能力全部下沉到本地宿主组件

本地进程用 `lark-cli event consume`（或自建 `WSClient`）直接消费妙记事件，在用户机器上完成导出、分析、存储与呈现。服务端只保留一个静态报告托管（甚至不留）。

- 优点：架构最简，无服务端运维成本，数据不出本机。
- **[Repo]** 直接冲突项：报告交付依赖 `assertPublicReportUrl()` 强制公网 HTTPS 地址，本地自托管产不出合规报告链接（`src/lib/platform/serverRuntime.ts`）。
- **[Host]** 致命项：事实三——宿主未运行时事件必然丢失。用户合上笔记本的那一刻起，会议报告就永久丢失，且没有任何补偿路径（WS 不补发）。
- **[Repo]** 还违反 `AGENTS.md` 的运行边界：本地不得消费业务任务；且 `meetingPipelineWorker` 的租约与恢复语义在「一台随时休眠的机器」上不成立。
- 结论：**否决**。它把「偶发可用」当成了「常驻可用」。

### Option B: 保留服务端为纯 API，宿主作为唯一交付端

服务端保留事件接收与流水线，但**交付只在宿主会话内发生**——用户在宿主里才能看到报告，飞书卡片通道取消。

- 优点：交付体验集中，减少飞书侧耦合。
- **[Host]** 否决项：受事实一、二约束，宿主交付依赖宿主侧的定时能力。豆包工作的定时能力**无法确认**；即便三台宿主都支持，用户不开机、不运行宿主时仍然收不到，且**没有任何兜底通道**。
- 与 Owner 的取舍相悖：Owner 已明确选择「飞书卡片为主 + 宿主会话为增强」**[Owner]**。
- 结论：**否决**。可用性下限低于现状。

### Option C: 三层架构——常驻服务为事件源，宿主组件为交互面，多通道交付

```text
L3 交付端：飞书卡片（主） / 宿主会话 Inbox（增强） / 多维表格写回（现有）
L1 常驻服务（保留）：飞书事件 → 妙记导出 → LLM 分析 → 报告持久化 → 交付编排
L2 宿主组件（新增）：CLI（事实核心） + MCP server（薄壳） + Skill（说明书）
```

- 常驻服务保留为**唯一事件源**，承接事实三约束下不可本地化的事件接收与恢复语义。**[Repo]**
- 宿主组件承担 A、B 两类能力，并作为 C 的**增强**交付端。**[Owner]**
- C 在宿主侧的实现方式改为「**宿主定时拉取**」：把「推」改造成「可积压的拉」，绕开事实二。**[Host]** + **[Owner]**
- 复用现有交付基础设施：`DELIVERY_TABLE` 已是多表映射，`deliveryTaskStore.ts` 已是通用租约/幂等/退避框架。**[Repo]**
- 结论：**采纳**。

### Option D: 维持现状，只做飞书卡片通道优化

不改架构，继续只在飞书内交付。

- 优点：零风险、零成本。
- 否决理由：不满足 Owner 明确提出的重构意图。**[Owner]**
- 结论：**否决**（但这正是 Option C 的兜底形态：即使 L2 完全不落地，L1 + L3 也必须继续正常工作）。

## Decision

采用 **Option C**。具体决策如下：

1. **常驻服务不移除、不降级为纯静态托管。** 它继续是飞书事件的唯一接收方与流水线执行方；本决策不改变 `AGENTS.md` 已确立的运行边界（本地不启动服务、不消费业务任务、不连生产库）。**[Repo]**
2. **宿主组件定位为「交互面 + 增强交付端」，不是运行时替代品。** 它承担 A（查询）、B（配置与状态）两类能力，并为 C 提供第二交付通道。**[Owner]**
3. **C 类交付通过「宿主侧定时拉取」实现，不追求服务端向宿主推送。** 宿主按 `cron` 唤醒 → 调用只读工具拉取增量 → 在会话中渲染 → 回执。允许退化为「用户下次主动询问时补齐」，即 C 失效时自动降级为 A 而不丢失数据。**[Owner]** + **[Host]**
4. **交付通道以飞书机器人卡片为主通道，宿主会话为增强通道。** 飞书卡片是唯一不依赖宿主开机的必达通道，优先级与可用性要求均高于宿主通道。**[Owner]**
5. **报告分析继续在服务端执行，不下沉到宿主模型。** 服务端承担确定性后处理（Zone 决策树修正、JSON 修复、发言占比重算）。**[Repo]**（`src/services/analysisService.ts`；`docs/后台分析逻辑说明.md`）
6. **组件形态以 CLI 为事实核心，MCP 为薄壳，Skill 为说明书。** 三宿主共用同一份核心。理由见 Why 第 4 条。**[Host]**
7. **宿主组件与云端之间只走 HTTPS API，禁止直连生产数据库。** 凭证独立于浏览器 session 签发。**[Repo]**（`AGENTS.md` 飞书编码原则 4.1 / 4.2 的延伸）
8. **本 ADR 在阶段 0 验证（见 `docs/AI宿主接入设计.md` 第十一章）产生结论前保持 `Proposed`。** 若验证推翻事实一或事实三，应新建 ADR 修正，不改写本文。**[Owner]**

## Why

1. **推送型事件源无法被拉取型组件替代。** 这是本决策的第一性理由。妙记生成是飞书侧主动产生的事件，其接收必须有常驻进程持有长连接或公网 webhook；宿主组件只在会话中被调用时存在，二者在时间轴上的存在性不同。**[Host]** + **[Repo]**
2. **可用性下限必须由不依赖宿主开机的通道兜住。** 用户合上笔记本、退出宿主之后仍然要能收到会议报告——这是当前系统的既有能力，重构不应回退它。飞书卡片由服务端常驻进程发出，与该约束天然对齐。**[Owner]** + **[Repo]**（`src/lib/feishu/im/reportNotificationService.ts`）
3. **「可积压的拉」比「脆弱的推」更符合既有工程约束。** 把 C 实现为宿主轮询后，宿主离线只是积压而非丢失，且天然具备幂等与补发能力，与 `AGENTS.md` 4.4「重试必须基于数据库任务状态、可持久化、可恢复、可观测」一致；反之，任何试图向宿主注入消息的方案都会引入无法观测、无法补发的旁路。**[Repo]**
4. **CLI 为核心可同时满足三宿主的差异化安装机制。** 豆包工作的 `connector_runtime` 本身就是「npm 包 + `tool_prefix/bin` 软链 + 原生二进制 artifact」的 CLI 安装机制（本机实例：`tool_prefix/bin/tmeet` 指向 `@tencentcloud/tmeet`；`artifacts/wecom-cli` 带 sha256 回执），CLI 是与该机制同构的形态；同时 CLI 天然规避了 stdio MCP 的 stdout 纯净性陷阱与返回值体积限制（豆包工作的 `ResponseBodyTooLarge`、tools/call 总超时）。**[Host]**
5. **Skill 说明书可一份三用。** 豆包工作（`rpa-dev/exports/skills/<name>/SKILL.md`）与 WorkBuddy（`resources/plugins/workbuddy-builtin/builtin-plugins/*/skills/*/SKILL.md`）使用同一套 `SKILL.md` + YAML frontmatter（`name` / `description`）格式；Codex 走 AGENTS / skill 约定。**[Host]**
6. **分析不下沉可保住报告质量的确定性。** 服务端在 LLM 原始输出之上执行 Zone 决策树修正、JSON 修复与发言占比重算；把这些搬到宿主模型会引入模型差异导致的结果不可复现。**[Repo]**

### Reusable Principle

> **事件驱动型能力与工具调用型能力对宿主集成的要求不同：前者必须有常驻事件源，后者才可以完全托管给宿主组件。**
>
> 判断一个能力能否「装进宿主就不再需要服务端」，只需问三个问题：
> 1. **触发源是谁？** 若由外部系统主动产生（webhook / 长连接事件），则必须有常驻接收方。
> 2. **触发时刻宿主是否必然在线？** 若否，则必须有不依赖宿主的兜底通道，或具备可补发的积压机制。
> 3. **交付是「资源」还是「凭证」？** 若是可重复拉取的资源，用游标增量即可；若是一次性凭证，才需要独立的交付任务与不可变快照。
>
> 本项目三次回答分别是「飞书」「否」「资源」，因此得到「服务端保留 + 宿主增强 + 游标补发」的结论。

## Consequences

### Positive

- 宿主集成是**纯增量**：L1 + 现有飞书卡片通道保持不动，即使 L2 全部回滚，线上行为不劣化。**[Repo]**
- 交付基础设施可复用而非重写：`deliveryTaskStore.ts` 的 7 态状态机（pending / running / retry_wait / succeeded / blocked / unknown / cancelled）、SKIP LOCKED 领取、租约心跳、30s/1m/2m/5m 退避均已存在。**[Repo]**
- 报告资源无需复制：`meeting_records` 已含 `report_public_id`（随机 UUID）、`report_url`、`analysis_result`、`report_revision`，宿主通道只需引用。**[Repo]**
- 三宿主共用一份 CLI 核心，Skill 一份三用，维护面收敛。**[Host]**

### Trade-offs

- **C 类交付存在物理上限。** 宿主未运行时无法在宿主会话内送达，这是事实三的直接后果，不可通过工程手段消除。产品表述必须诚实，不得承诺「随时推送」。**[Host]**
- **必须新增一层面向宿主的 API 与独立鉴权。** MCP/CLI 进程没有浏览器 session，需要 device code / 长期令牌机制，扩大凭证管理面与攻击面。**[Repo]**（现有鉴权模型见 `src/lib/auth/*` 与 Supabase session）
- **需要处理「多宿主安装」的游标归属。** 同一用户可能在本机、台式机、多台宿主各装一份，若游标按 user 粒度会互相吞掉积压，必须按安装实例区分。**[Owner]** + **无法确认**（Owner 是否真的会多机安装）
- **`DELIVERY_TABLE` 的既有不变量被打破。** 该常量当前注释明确「只允许这两张表走通用原语，表名永远不接受外部动态输入」，新增第三张表是有意变更，必须同步更新该注释与 `docs/飞书集成设计.md`。**[Repo]**
- **宿主能力是外部事实且会漂移。** `[Host]` 证据随宿主版本失效；豆包工作的定时能力至今无法确认，可能导致三宿主能力不对等。**[Host]**
- **报告 URL 的公网约束与本地场景冲突。** `assertPublicReportUrl()` 当前是业务断言（非公网 HTTPS 直接抛错），宿主通道若允许本地地址，需把该约束从「业务断言」降级为「通道能力声明」。**[Repo]**

### Future Constraints

- 新增宿主相关能力时，**禁止**在本地组件中直连生产数据库或消费生产任务队列；一律经云端 HTTPS API。**[Repo]**
- 宿主侧凭证必须显式绑定 `integrationId` / 用户身份，禁止从 `process.env` 读取用户级配置；敏感字段统一走 `encrypt()` / `decrypt()`，不得落盘明文、不得回显、不得打日志。**[Repo]**（`AGENTS.md` 4.1 / 4.2）
- 宿主通路的状态必须落库可观测，**禁止**用进程内 `Map` / `Set` 维护交付状态。**[Repo]**（`AGENTS.md` 4.4）
- MCP stdio 入口必须保证 stdout 只输出协议消息；日志一律走 stderr，且入口需自测 stdout 纯净性。**[Host]**（外部经验文档 §5.2 / §7）
- MCP 工具必须至少包含一个无副作用工具（`doctor`），只读工具标注 `readOnlyHint: true`，返回值必须紧凑并遵循「传引用不传正文」。**[Host]**（外部经验文档 §5.1 / §5.7 / §7；豆包工作 `ResponseBodyTooLarge`）
- 若未来豆包工作确认提供定时任务能力，或三宿主中任一提供了向会话注入消息的正式接口，本 ADR 的 C 类实现方式应重新评估并新建 ADR，**不改写本文**。**[Owner]**

## Evidence

**[Repo]**
1. `docs/飞书集成设计.md` 第一章「方案与边界」、第六章「用户级妙记事件订阅」、第七章「事件订阅与消费门禁」、第八章「多维表格与分析流程」——现有常驻链路与事件驱动形态。
2. `src/lib/feishu/events/eventListenerManager.ts`、`src/lib/feishu/pipeline/meetingPipelineWorker.ts`、`src/lib/feishu/delivery/deliveryWorker.ts`、`src/lib/feishu/im/reportNotificationService.ts`——事件接收、流水线执行与飞书卡片交付。
3. `src/lib/feishu/delivery/deliveryTaskStore.ts` 第 1–45 行——通用交付基础设施、7 态状态机、`DELIVERY_TABLE` 双表不变量。
4. `src/lib/db/schema.ts` 中 `meetingRecords`（`report_public_id` / `report_url` / `analysis_result` / `report_revision`）与 `meetingReportNotificationTasks`（幂等键、接收人快照、租约字段）。
5. `src/lib/platform/serverRuntime.ts`——`assertServerRuntimeEnabled()` 与 `assertPublicReportUrl()` 两条运行边界断言。
6. `.env.production.example`——`FEISHU_RUNTIME_ENABLED=true` 仅部署服务器开启。
7. `AGENTS.md`「运行边界」与「飞书集成编码原则」4.1–4.6。
8. `docs/adr/ADR-001-use-feishu-official-sdk-for-meeting-integration.md`——飞书集成收敛到官方 SDK 的历史决策；本 ADR 不推翻其任何结论。

**[Host]**（本机实测，2026-10-02，macOS；命令可复现，结论随宿主版本可能失效）
9. 豆包工作 MCP 客户端：`/Applications/DoubaoWork.app/Contents/Helpers/libmcp_helper.dylib`（12,761,104 字节）经 `strings` 提取到 `rmcp-3.2.0` 源码路径、协议版本 `2024-11-05 / 2025-03-26 / 2025-06-18 / 2025-11-25 / 2026-07-28`，以及 `notifications/message`、`notifications/progress`、`resources/subscribe`、`notifications/resources/updated`、`notifications/tasks`、`tasks/get|update|cancel`、`elicitation/create`、`sampling/createMessage`、`roots/list` 方法表。
10. 豆包工作 Skill 形态：`~/Library/Application Support/DoubaoWork/rpa-dev/exports/skills/trae-monthly-invoice/SKILL.md`（YAML frontmatter 含 `name` / `description`）与同名 `.zip` 分发件。
11. 豆包工作 Connector 运行时：`~/Library/Application Support/DoubaoWork/Default/connector_runtime/` —— `tool_prefix/bin/tmeet` 软链至 `tool_prefix/lib/node_modules/@tencentcloud/tmeet/scripts/tmeet.js`；`artifacts/wecom-cli` 与 `artifact_receipts/*.json`（`schema_version: 1` + `sha256` + `package_key`）；`packages/pkg-v1-*/install.json`。
12. WorkBuddy Skill/插件形态：`/Applications/WorkBuddy.app/Contents/Resources/app.asar.unpacked/resources/plugins/workbuddy-builtin/builtin-plugins/*/skills/*/SKILL.md`。
13. WorkBuddy 定时任务能力：`app.asar` 中「定时任务」命中 188 次，含「是否启用定时任务（Cron）功能」「定时任务：」「定时任务的四张表」。
14. Codex 定时自动化：`~/.codex/automations/` 下 6 个实例各含 `automation.toml`（`automation`、`daily-bug-scan-2`、`skill-progression-map`、`update-agents-md`、`update-agents-md-b6a89b134245`、`weekly-pr-summary`），字段 `kind = "cron"`、`rrule`、`prompt`、`model`、`reasoning_effort`、`execution_environment`、`target`、`cwds`，且每条带 `memory.md` 记录历史运行结论。
15. Codex stdio MCP：`~/.codex/config.toml` 第 7 行 `[mcp_servers]`，已有 `node_repl`、`computer-use` 实例。
16. 本机飞书事件消费能力：`lark-cli` v1.0.97，`lark-cli event list` 含 `minutes.minute.generated_v1`、`vc.meeting.participant_meeting_ended_v1`、`vc.meeting.participant_meeting_started_v1`；`lark-cli event status` 显示 event bus daemon 机制（本机 bus 未运行）。

**[Owner]**
17. 重构意图：依托 AI Agent 宿主（豆包工作 / WorkBuddy / Codex），通过安装 skill / MCP / CLI 组件，实现会议报告推送至用户或推送至宿主聊天。
18. 交付通道取舍：飞书卡片为主通道，宿主会话为增强通道（2026-10-02 确认）。
19. 参考的外部经验文档：`wechat-draft-mcp`《豆包工作 与 WorkBuddy：MCP 接入调研与实战沉淀》（本机路径 `/Users/wangying/Documents/workplace/wechat-draft-mcp/docs/feishu-doubao-workbuddy-mcp.md`），调研日期 2026-10-02。

**无法确认**
20. 豆包工作是否具备定时任务 / 自动化唤醒能力。
21. 三台宿主是否会将 MCP 服务端通知（`notifications/message`、`resources/updated`、`notifications/tasks`）渲染为用户可见的会话消息，以及是否会为 stdio 连接器维持常驻订阅。
22. 三台宿主是否存在任何「第三方向既有会话注入消息」的正式接口。
23. Owner 是否存在同一用户多机 / 多宿主安装的实际场景（影响游标粒度设计）。

## Related

- `docs/AI宿主接入设计.md`——本决策的落地设计、工具契约、阶段 0 验证清单与分阶段路线。
- `docs/飞书集成设计.md`——现有常驻链路设计，本 ADR 不改动其结论。
- `AGENTS.md`——运行边界与飞书编码原则；宿主组件边界需在实施阶段同步补充。
