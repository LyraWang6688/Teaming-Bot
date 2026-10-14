# AI 宿主接入设计

> 最后更新时间：2026-10-15
> 状态：**设计阶段，尚未实施**。本文描述目标形态与落地路径，不代表当前系统已有行为。
> 决策依据：[ADR-002](./adr/ADR-002-ai-host-integration-architecture.md)、
> [ADR-003](./adr/ADR-003-host-provides-transcript-analysis-separation.md)（取数与分析分离）、
> [ADR-004](./adr/ADR-004-http-analysis-channel-for-automation.md)（自动化通道，见第十六节）
> 关联文档：[飞书集成设计.md](./飞书集成设计.md)、[项目结构说明.md](./项目结构说明.md)、[后台分析逻辑说明.md](./后台分析逻辑说明.md)

---

## 一、文档定位与边界

本文回答「**怎么把现有能力接入豆包工作 / WorkBuddy / Codex，并让会议报告在这些宿主里可用**」，属于设计文档，不是操作手册。

本文**不**改变以下既有约束（`AGENTS.md`「运行边界」）：

- 本地仅编辑代码、执行静态检查与不启动服务的单元测试。
- 不启动 `next dev` / `next start` / 飞书监听 / 任务消费者 / 本地预览服务。
- 生产容器须显式设置 `FEISHU_RUNTIME_ENABLED=true`；不得在本地设置该开关绕过限制。
- 不得让本地进程连接生产数据库消费任务。

> **术语**：本文中的「宿主」指豆包工作、WorkBuddy、Codex 等可安装 MCP / Skill / CLI 组件的 AI 客户端；「常驻服务」指部署在服务器上的本项目的 Next.js 容器。

---

## 二、目标与非目标

### 目标

| # | 目标 | 验收形态 |
|---|------|---------|
| G1 | 用户可在三宿主任一安装一个组件即可使用 | 安装步骤 ≤ 3 步，无需发包、无需审核 |
| G2 | 用户可在宿主里查询会议报告（问答式） | 「上周三那次会的团队氛围怎么样」可被正确回答 |
| G3 | 用户可在宿主里看到会议报告的送达反馈 | 宿主会话中出现报告消息，含标题、结论、报告链接 |
| G4 | 会议结束后报告仍能可靠送达 | 飞书卡片通道保持现状不劣化 |
| G5 | 宿主未运行时报告不丢失 | 宿主恢复后一次性补齐积压 |

### 非目标

- **不**把常驻服务下沉到本地（原因见 ADR-002 Option A）。
- **不**承诺「宿主会话内随时必达」：宿主未开机/未运行时无法在会话内送达，这是物理约束。
- **不**把报告分析迁移到宿主模型（保住 Zone 决策树等确定性后处理）。
- **不**取消飞书卡片通道。
- **不**在阶段 0 验证完成前编写业务代码。

---

## 三、能力拆解：三种被混为一谈的需求

| # | 能力 | 触发方 | 形态 | 依赖宿主在线 | 本设计归属 |
|---|------|--------|------|-------------|-----------|
| **A** | 查询报告（问答式） | 用户主动提问 | 拉取 | 是 | L2 宿主组件 |
| **B** | 配置集成、看任务状态、重跑 | 用户主动要求 | 拉取 | 是 | L2 宿主组件 |
| **C** | 会议结束后自动送达 | **飞书事件** | 推送 | 否（走飞书卡片） | L1 服务端 + L3 飞书卡片 |
| **C'** | 会议结束后送达宿主会话 | 宿主定时器 | **拉取** | **是** | L2 定时拉取 + L1 增量查询 |

**核心结论**：C（飞书卡片）与 C'（宿主会话）是**两条独立通道**，不是一条通道的两个实现。C 由服务端主动推，C' 由宿主定时拉。C 是必达主通道，C' 是体验增强通道。

---

## 四、现状资产盘点

### 4.1 可直接复用

| 资产 | 位置 | 复用方式 |
|------|------|---------|
| 通用交付基础设施（7 态状态机、SKIP LOCKED 领取、租约心跳、退避） | `src/lib/feishu/delivery/deliveryTaskStore.ts` | 宿主通道若需任务语义，直接复用原语 |
| 交付 worker 调度骨架（独立轮询间隔、批量、异常不退出） | `src/lib/feishu/delivery/deliveryWorker.ts` | 新增通道时照此加一条轮询链路 |
| 报告持久化 | `src/lib/db/schema.ts` 的 `meetingRecords` | 提供 `report_public_id` / `report_url` / `analysis_result` / `report_revision` |
| 报告读取仓储 | `src/lib/reports/meetingReportStore.ts` | 宿主 API 的数据来源 |
| 审计日志 | `src/lib/feishu/integration/integrationStore.ts` 的 `writeAuditLog` | 宿主通道的送达审计复用，避免新建回执表 |
| 安全工具 | `src/lib/security/crypto.ts` | `encrypt` / `decrypt` / `hash` / `mask` |
| 飞书卡片通知 | `src/lib/feishu/im/reportNotificationService.ts` | 主通道保持不变 |
| 运行边界断言 | `src/lib/platform/serverRuntime.ts` | 需按下节改造 |
| 统一监控日志 | `src/lib/feishu/common/monitor.ts` | 宿主 API 的结构化日志出口 |

### 4.2 需要改造

| # | 改造项 | 现状 | 目标 | 影响面 |
|---|--------|------|------|--------|
| R1 | 报告 URL 断言语义 | `assertPublicReportUrl()` 是**业务断言**，非公网 HTTPS 直接抛错 | 改为**按通道声明的交付能力**：`assertDeliverableReportUrl(url, channel)`；飞书卡片通道仍要求公网 HTTPS，宿主通道允许本地地址 | `src/lib/platform/serverRuntime.ts`、`delivery/notificationProcessor.ts` |
| R2 | 交付通道枚举 | `DELIVERY_TABLE` 注释明确「只允许这两张表走通用原语」 | 若新增宿主交付任务表，必须同步更新该不变量注释与 `docs/飞书集成设计.md` | `delivery/deliveryTaskStore.ts` |
| R3 | 多租户显式依赖 | 业务函数显式接收 `integrationId` | 宿主 API 层同样必须显式携带用户与集成上下文，禁止 `process.env` 读用户级配置 | 新增代码遵守 `AGENTS.md` 4.1 |
| R4 | 鉴权模型 | 仅浏览器 Supabase session | 新增面向宿主组件的独立凭证体系（见第九章） | `src/app/api/host/v1/*` |

### 4.3 需要新增

- `packages/core`：与宿主、与 Next.js 无关的纯域逻辑（报告摘要构造、游标语义）。
- `packages/cli`：CLI 事实核心。
- `packages/mcp-server`：stdio MCP 薄壳。
- `packages/skill`：`SKILL.md` 说明书。
- `src/app/api/host/v1/*`：面向宿主组件的云端 API。
- `host_delivery_cursors` 表 + 迁移 SQL。

> 仓库当前是单体 Next.js（`package.json` 的 `name` 为 `projects`），**无 pnpm workspace 配置、无 `packages/` 目录**。引入多包形态需先补 `pnpm-workspace.yaml`。

---

## 五、架构总览

```text
┌─ L3 交付端 ───────────────────────────────────────────────────┐
│  a) 飞书机器人卡片   【主通道 · 必达 · 不依赖宿主】  ← 现状不变  │
│  b) 宿主会话 Inbox   【增强通道 · 依赖宿主运行】     ← 新增      │
│  c) 多维表格写回     【现状不变】                              │
└───────────────────────────────────────────────────────────────┘
                            ▲
┌─ L1 常驻服务（服务器容器，保留）────────────────────────────────┐
│  飞书事件(WSClient) → 任务入队 → 妙记导出 → LLM 分析            │
│    → meeting_records 持久化 → 投递编排（Base / 飞书卡片）        │
│  ★ 事件源唯一，不可下沉到宿主                                    │
└───────────────────────────────────────────────────────────────┘
                            ▲ HTTPS + 宿主凭证（独立于浏览器 session）
┌─ L2 宿主组件（用户本机，新增）──────────────────────────────────┐
│  CLI（事实核心）  ←  MCP server（薄壳，stdio）  ←  Skill（说明书） │
│  职责：查询报告 / 展示状态 / 拉取增量 / 回执                       │
│  禁止：直连生产库、消费生产任务、持有用户级 env 配置               │
└───────────────────────────────────────────────────────────────┘
```

### 三条数据流

**流 1（现状，不变）**：飞书事件 → L1 流水线 → 报告落库 → 飞书卡片推给会议所有者。

**流 2（新增，A 类查询）**：用户在宿主提问 → 宿主模型调 MCP 工具 → MCP 调 CLI → CLI 请求云端 API → 返回紧凑摘要 → 宿主渲染。

**流 3（新增，C' 类送达）**：宿主定时器唤醒 → 模型调 `list_pending_reports` → CLI 以游标拉增量 → 宿主渲染为会话消息 → `ack_report` 推进游标 → 云端写审计日志。

---

## 六、宿主组件形态：CLI 为核心，MCP 为薄壳，Skill 为说明书

### 6.1 为什么以 CLI 为核心

| 维度 | 纯 MCP | **CLI 核心 + MCP 薄壳** |
|------|--------|------------------------|
| 豆包工作 Connector 机制适配 | 走 MCP 通道 | **同构**：`connector_runtime` 本身就是「npm 包 + `tool_prefix/bin` 软链 + 原生 artifact」 |
| stdout 纯净性 | 致命陷阱（一行日志即断连） | CLI 天然面向人类输出，无此约束 |
| 返回值体积 | 受宿主 IPC 帧上限约束 | 文件系统天然绕开（`--out ./report.json`） |
| 大报告 | 上下文爆炸 | 落盘后返回路径 |
| 三宿主复用 | 各写一份 | 一份核心，三处薄封装 |
| 结构化调用与权限模型 | 好 | 需 MCP 补足 |

**结论**：MCP 工具的实现即 `spawn(cli, [...])` 的薄壳，不在 MCP 层重复业务逻辑。

### 6.2 Skill 可一份三用

三宿主的 Skill 格式同源（`SKILL.md` + YAML frontmatter `name` / `description`）：

| 宿主 | 安装位置 |
|------|---------|
| 豆包工作 | 技能包（zip，含 `SKILL.md`） |
| WorkBuddy | `~/.codebuddy/skills/<name>/SKILL.md` |
| Codex | AGENTS / skill 约定 |

Skill 正文必须写明：**什么时候该调用、什么时候不要调用、如何把结果讲成人话**。参照豆包工作既有 Skill 的文案约束（对用户说「任务说明」「结果核对」，不说 PRD、命令、JSON、错误码、文件路径或内部诊断信息），本 Skill 采用同一标准。

---

## 七、能力清单与返回契约

### 7.1 CLI 命令

```text
teaming login                      设备授权码流程绑定账号
teaming logout                     吊销并清除本地凭证
teaming whoami                     当前绑定身份与可用集成（脱敏）
teaming doctor                     环境自检（只读）
teaming report list [--limit N]    列出报告
teaming report show <public_id>    紧凑摘要（默认）
            --full --out <path>    完整报告落盘，返回路径
teaming pending [--since <cursor>] 拉取增量（C' 类送达用）
teaming ack <public_id...>         回执并推进游标
```

### 7.2 MCP 工具

| 工具 | 副作用 | `readOnlyHint` | 说明 |
|------|--------|----------------|------|
| `doctor` | 无 | `true` | 环境自检：云连通性、凭证有效性、stdout 纯净性。**生态准入要求至少一个无副作用工具** |
| `whoami` | 无 | `true` | 当前身份与集成列表（脱敏） |
| `list_reports` | 无 | `true` | 分页列报告 |
| `get_report_summary` | 无 | `true` | 紧凑摘要 |
| `get_report` | 本地落盘 | `true`（仅读云端） | 完整报告 → 本地文件 → 返回路径 |
| `list_pending_reports` | 无 | `true` | 游标增量 |
| `ack_report` | 推进游标 | `false` | 需确认 |
| `rerun_analysis`（可选） | 触发重跑 | `false` | 高风险，需显式确认 |

### 7.3 返回契约：传引用不传正文

报告体量决定返回必须分级——`analysis_result` 是完整 `AnalysisResultV2`（含 `dialogueNetwork`、`unfinishedDialogues`、`communication` 逐人数组），外加全文 `transcript`；直接进模型上下文即数万 token，并会撞上宿主的 IPC 帧上限。

| 层级 | 返回内容 | 目标体积 |
|------|---------|---------|
| `list_pending_reports` | `public_id` + 标题 + 时间 + `revision` | 每条约 100 字节 |
| `get_report_summary` | zone 结论 + 五维色标 + 3 条要点 + `report_url` | < 2 KB |
| `get_report --full` | **本地文件路径** + `report_url` | 路径字符串 |

**硬约束**：工具返回值中不得包含完整报告 JSON、转录全文、base64 图片或大量 URL。

### 7.4 错误必须翻译成人话

对齐外部经验文档 §5.6：错误信息要说明「发生了什么、影响了什么、下一步怎么做」，且不得泄露文件路径与凭据。典型映射：

| 内部错误 | 用户可见文案 |
|---------|-------------|
| `HOST_TOKEN_EXPIRED` | 登录已过期。请在本机终端执行 `teaming login` 重新绑定账号后重试。 |
| `HOST_TOKEN_REVOKED` | 该设备的授权已被吊销。请重新执行 `teaming login`。 |
| `INTEGRATION_INACTIVE` | 你的飞书集成已被更新的集成取代，本次未取到数据。请到配置页确认当前生效的集成。 |
| 网络/超时 | 暂时连不上服务（网络或服务未响应）。稍后重试；若持续失败请执行 `teaming doctor`。 |

---

## 八、交付设计

### 8.1 通道优先级

| 通道 | 优先级 | 触发方 | 依赖宿主 | 幂等键 |
|------|-------|--------|---------|--------|
| 飞书机器人卡片 | **P0 必达** | 服务端 | 否 | `meeting_record_id + report_revision + recipient`（现有） |
| 宿主会话 Inbox | P1 增强 | 宿主定时器 | **是** | `public_id + report_revision + installation_id` |
| 多维表格写回 | P0 | 服务端 | 否 | `meeting_record_id + target_key`（现有） |

### 8.2 宿主通道采用「游标增量」，不建「一报告一任务」

**方案对比**：

| | 方案甲：一报告一交付任务 | **方案乙：游标增量（采纳）** |
|---|---|---|
| 状态量 | `报告数 × 安装数`，无界增长 | **一安装一行**，有界 |
| 与现有基础设施关系 | 完全复用 7 态状态机 | 复用审计日志，不复用任务表 |
| 交付保证 | 每份可单独观测 | at-least-once（渲染后回执） |
| 数据复制 | 需快照标题/URL/revision | **零复制**，直接引用 `meeting_records` |
| 宿主离线 | 任务积压 | 游标不动，天然积压 |

**采纳方案乙的理由**：报告是**可重复拉取的资源**，不是一次性凭证。它已由 `meeting_records` 持久化并带不可枚举的 `report_public_id`，宿主随时可按 id 重取。为其再建一套任务状态属于重复建模。

**游标语义**：

```text
游标 = (last_updated_at, last_public_id)   按 (updated_at, public_id) 字典序
查询 = meeting_records WHERE analysis_result IS NOT NULL
                       AND (updated_at, public_id) > 游标
         ORDER BY updated_at, public_id  LIMIT N
```

- 报告被重新分析时 `report_revision` 自增、`updated_at` 前移 → **自动重新出现在增量里**，天然支持「报告已更新」通知，无需额外状态。
- 顺序必须是 **fetch → render → ack**：渲染成功后才推进游标，保证 at-least-once、不丢失；崩溃在 render 与 ack 之间最多导致一次重复渲染，可接受。
- 首次安装默认从「当前时刻」开始，不回放历史；需回放时显式 `teaming pending --since 0`。

### 8.3 新增数据表

```text
host_delivery_cursors
  id                  uuid  pk
  user_id             uuid  not null          所属用户
  host_kind           text  not null          豆包工作 / workbuddy / codex / cli
  installation_id     text  not null          安装实例（多机多宿主隔离）
  integration_id      uuid                    当前绑定集成（显式多租户）
  last_updated_at     timestamptz
  last_public_id      uuid
  last_ack_at         timestamptz
  created_at / updated_at

  unique (user_id, host_kind, installation_id)
```

**多机多宿主隔离**：游标按安装实例区分。若按 user 粒度，用户在本机装第二台宿主后会吞掉另一台的积压。

### 8.4 送达审计

不新建回执表，复用 `feishu_audit_logs`：每次 `ack_report` 写一条 `meeting.delivery.host_ack`，含 `userId` / `integrationId` / `installationId` / `public_id` / `revision` / 结果。

---

## 九、鉴权与凭证设计

宿主的 MCP/CLI 进程**没有浏览器 session**，现有 Supabase session 模型不适用。

### 9.1 设备授权码流程

```text
1. CLI 执行 teaming login
2. CLI 请求 POST /api/host/v1/device/start
   云端返回 device_code + user_code + verification_uri + interval
3. CLI 提示用户在浏览器打开 verification_uri 并输入 user_code
4. 用户确认后，云端把 device_code 标记为已批准
5. CLI 按 interval 轮询 POST /api/host/v1/device/token
   换取长期 host_token（仅返回一次）
6. CLI 将 host_token 存本地（macOS Keychain 优先，退化为 0600 配置文件）
```

### 9.2 凭证规则（对齐 `AGENTS.md` 4.2）

- `host_token` 云端只存 **hash**，可吊销、可轮换、可设置过期。
- 每次请求携带 `Authorization: Bearer <host_token>` 与 `X-Host-Installation-Id`。
- 凭证**只从环境变量或本地配置读取**；不落盘明文（除 Keychain）、不回显、不写日志。
- 日志、错误输出、调试信息中一律不得出现完整 token。
- 前端与 MCP 工具返回值只展示脱敏值。

### 9.3 显式依赖（对齐 `AGENTS.md` 4.1）

宿主 API 的每个业务函数必须显式接收 `userId` / `integrationId` / `installationId`，**禁止**从 `process.env` 读取用户级配置。

---

## 十、三宿主适配

| | 豆包工作 | WorkBuddy | Codex |
|---|---|---|---|
| 装 MCP | 界面「新建自定义连接器」（STDIO / HTTP） | `~/.workbuddy/mcp.json`（支持 JSONC） | `~/.codex/config.toml` 的 `[mcp_servers]` |
| 装 Skill | 技能包 zip（`SKILL.md`） | `~/.codebuddy/skills/<name>/SKILL.md` | AGENTS / skill 约定 |
| 装 CLI | `connector_runtime`（`tool_prefix/bin` 软链 + artifact） | 支持 | 支持 |
| 定时调度 | **无法确认**（关键待验证项） | 有定时任务（Cron） | 原生 `automation.toml` + `rrule` |
| 分发审核 | 自用免审 / 生态上架需准入 | 连接器市场需入驻 | 无 |

### 10.1 安装要点

- **`command` 必须写绝对路径**：GUI 宿主进程不继承 shell 的 `PATH`。
- **改源码后必须重新构建**：宿主指向的是构建产物。
- **改 MCP 配置后需在宿主内重载连接器**（关闭再打开开关，或重启宿主）。
- **宿主可能不提供子进程 stderr**：CLI 必须自己落一份日志文件，否则静默失败时无从判断进程是否启动。
- **豆包工作的分发规则要区分两套**：`connector_runtime` 支持 npm 包前缀**和**原生二进制 artifact（本机实例 `tool_prefix/bin/tmeet`、`artifacts/wecom-cli`）；`npx -y 包名@版本` 的硬要求仅针对 **MCP 生态上架**。自用阶段不必先发包。

---

## 十一、阶段 0 验证清单（**先做这一步，不写业务代码**）

以下 7 项验证的结论直接决定投递方案选型。**在完成前不得进入阶段 1。**

| # | 验证项 | 方法 | 预期证据 | 结论影响 |
|---|--------|------|---------|---------|
| V0-1 | 豆包工作能否连上本地 stdio MCP | 写 10 行最小 MCP server，在「新建自定义连接器」填入 `node` 绝对路径 + 脚本路径 | 宿主内出现工具列表 | 否定则豆包工作只能走 HTTP 连接器 |
| V0-2 | 宿主是否渲染 MCP 服务端通知 | 在 `tools/call` 执行期间发 `notifications/message` 与 `notifications/progress` | 用户界面是否可见 | **若可见 → 存在「真推送」技术缝隙，C' 可升级为推送** |
| V0-3 | 宿主是否支持 `resources/subscribe` + `notifications/resources/updated` | 同上，注册资源订阅后主动推送变更 | 用户界面是否可见、连接是否维持 | 若可用 → 可用资源订阅替代定时轮询 |
| V0-4 | WorkBuddy 定时任务能否驱动 MCP/CLI | 建一条定时任务，让 Agent 调用 `echo` 或 CLI | 会话/任务产物是否可见 | 决定 WorkBuddy 的 C' 实现方式 |
| V0-5 | Codex automation 能否驱动 CLI | 新建 `automation.toml`，`prompt` 指向 CLI 调用 | `memory.md` 或会话产物是否可见 | 决定 Codex 的 C' 实现方式 |
| V0-6 | 豆包工作是否存在定时/自动化入口 | 界面排查 + 包内字符串扫描 | 是否找到 | 决定豆包工作是否具备 C' |
| V0-7 | MCP stdout 纯净性自测 | 抓取 stdout，逐行 `JSON.parse`，断言零污染 | 全部行可解析 | 必须通过，否则连接器「已连接但无工具」 |

> V0-2 与 V0-3 是本设计中最不确定、也最有价值的两项。它们决定 C' 是「退化为轮询」还是「可以真正推送」。**不要跳过。**

---

## 十二、分阶段路线

### 阶段 0：验证（1~2 天，零业务代码）

完成第十一章 7 项验证，产出结论并更新 ADR-002 的 Status 与 `无法确认` 清单。

### 阶段 1：MVP（自用打磨）

1. 补 `pnpm-workspace.yaml`，建 `packages/core` / `cli` / `mcp-server` / `skill`。
2. 服务端：`host_delivery_cursors` 表 + 迁移、`/api/host/v1/*`、设备授权码流程、审计日志。
3. CLI：`login` / `logout` / `whoami` / `doctor` / `report list|show` / `pending` / `ack`。
4. MCP 薄壳：7 个工具，含 `doctor` 与 `readOnlyHint`。
5. Skill：一份 `SKILL.md`。
6. 改造 R1（报告 URL 断言按通道分级）。
7. 三宿主手工安装验证（自用路径，不需审核）。

### 阶段 2：体验

宿主定时任务模板（Codex `automation.toml` 样例、WorkBuddy 定时任务配置说明）；会话内卡片渲染；报告落盘与本地打开；问答式分析的 Skill 细化。

### 阶段 3：分发

发 npm 包（`npx -y` 启动）；豆包工作 MCP 生态准入材料（准入门槛白皮书、接入信息收集表、联调验收、>512×512 圆形图标、凭据申请/交付/轮换/吊销说明、中英文 skill 名称）；WorkBuddy 连接器市场入驻。

---

## 十三、安全与红线

| # | 红线 | 依据 |
|---|------|------|
| S1 | 本地组件**禁止**直连生产数据库、**禁止**消费生产任务队列，一律经云端 HTTPS API | `AGENTS.md` 运行边界 |
| S2 | 宿主凭证只从环境变量/本地配置读，不落盘明文、不返回、不打日志 | `AGENTS.md` 4.2 |
| S3 | 业务函数显式接收 `userId` / `integrationId`，禁止 `process.env` 读用户级配置 | `AGENTS.md` 4.1 |
| S4 | 交付状态必须落库可观测，禁止进程内 `Map` / `Set` 承载状态 | `AGENTS.md` 4.4 |
| S5 | MCP stdio 入口 stdout 只输出协议消息，日志一律 stderr，并自测 | 外部经验文档 §5.2 |
| S6 | 工具返回值紧凑，不传正文只传引用 | 外部经验文档 §5.1 / §5.7 |
| S7 | 错误信息不得泄露文件路径与凭据 | 外部经验文档 §5.6 |
| S8 | 副作用前先落盘状态，结果未知时**不自动重试** | 外部经验文档 §5.3 |
| S9 | 路径参数视为敌意输入：绝对路径 + `realpath` + 分段前缀比较 + 敏感目录黑名单 | 外部经验文档 §5.5 |

### `AGENTS.md` 需新增的章节

阶段 1 开始前，`AGENTS.md` 必须补充「**宿主组件边界**」一节，至少包含：S1–S4 四条红线；`packages/` 各包的职责与禁止事项；宿主 API 的鉴权要求；本地组件日志落盘位置。否则本地会出现一个职责未定义的常驻进程，破坏现有隔离。

---

## 十四、文档同步要求

| 变更 | 必须同步更新 |
|------|-------------|
| 新增/删除/移动文件（含 `packages/`） | `docs/项目结构说明.md` |
| 修改交付通道、新增 `host_delivery_cursors` 表 | `docs/飞书集成设计.md` 第 8 章；`deliveryTaskStore.ts` 的 `DELIVERY_TABLE` 注释 |
| 修改 `serverRuntime.ts` 的 URL 断言 | `docs/飞书集成设计.md`；本文第 4.2 节 R1 |
| 修改运行边界或新增宿主组件边界 | `AGENTS.md` |
| 阶段 0 验证产生结论 | `docs/adr/ADR-002-*.md` 的 Status 与「无法确认」清单 |
| 宿主能力变化（版本升级导致 `[Host]` 证据失效） | `docs/adr/ADR-002-*.md` 的 Evidence 章节 |

---

## 十五、待决事项与未确认清单

### 待 Owner 决策

| # | 事项 | 说明 |
|---|------|------|
| D1 | 分发节奏 | 先自用免审打磨，还是直接冲豆包工作生态准入（必须 npm 包 + 联调验收） |
| D2 | 是否接受宿主通道的物理上限 | 宿主未运行时无法在会话内送达，需据此确定对外表述 |
| D3 | 是否存在多机/多宿主安装场景 | 影响游标粒度；当前设计按安装实例隔离，成本略高 |
| D4 | 报告 URL 断言改造范围 | 是否允许宿主通道使用本地地址（影响自托管场景） |
| D5 | `rerun_analysis` 是否开放 | 触发重跑有成本与一致性风险 |

### 未确认事实

| # | 事项 | 影响 |
|---|------|------|
| U1 | 豆包工作是否具备定时/自动化唤醒能力 | 决定豆包工作能否实现 C' |
| U2 | 宿主是否渲染 MCP 服务端通知并维持订阅 | 决定 C' 是推送还是轮询（V0-2 / V0-3） |
| U3 | 宿主是否存在向会话注入消息的接口 | 若存在，C' 可实现真正推送，需新建 ADR |
| U4 | 宿主版本升级后 `[Host]` 证据是否仍成立 | `[Host]` 标注的固有风险 |

---

## 附：外部经验文档的适用边界

参考文档：`wechat-draft-mcp`《豆包工作 与 WorkBuddy：MCP 接入调研与实战沉淀》。

| 该文档章节 | 对本项目的适用性 |
|-----------|-----------------|
| §1 平台对比、§2 WorkBuddy 配置、§3 豆包工作路径 | **完全适用**，已本机复核一致 |
| §5.1 传引用不传正文、§5.7 返回值紧凑 | **完全适用**，见本文 7.3 |
| §5.2 stdout 纯净性、§5.5 路径沙箱、§5.3 幂等与未知结果 | **完全适用**，见本文第十三章 |
| §6 教训清单、§7 检查清单 | **完全适用**，建议作为实施阶段的验收清单 |
| §3.3 生态准入（npx 硬要求） | **部分适用**：仅针对 MCP 生态上架；Connector 分发还有原生 artifact 路径，见本文 10.1 |
| §3.4 / §5.6 | 适用，已纳入设计与错误文案规范 |
| — | **该文档未覆盖「事件驱动型推送」场景**，即本文的 C / C' 拆解与游标方案，属本项目新增结论 |

---

## 附录一、部署注意：新增路由必须同步 nginx 白名单

**生产环境的 `meeting.bamamei.online` 在 nginx 层有一份按路径的白名单**
（`/etc/nginx/snippets/allowlist-meeting.conf`），原则是"一条不多放"。

```
新增任何 API 路由后，必须在该文件里加一条 location，
否则外部访问会返回 HTTP 000（不是 404、不是 403），
本地/容器内测试却完全正常 —— 极难排查。
```

2026-10-14 实现 `/api/host/v1/reports` 时就踩到了：容器内 `POST` 返回 401（正确），
外部 `POST` 返回 000。最后定位到白名单缺条目。

**排查线索**：`curl -sv` 能看到 TLS 握手完成、但没有任何 HTTP 响应行。

**操作方式**（务必先备份再 reload，配置写错会导致整站不可用）：

```bash
sudo cp -a /etc/nginx/snippets/allowlist-meeting.conf{,.bak}
# 追加 location = <新路由> { include /etc/nginx/snippets/proxy-meeting.conf; }
sudo nginx -t && sudo systemctl reload nginx
```

---

## 十六、自动化通道：`POST /api/host/v1/analyze`（ADR-004）

> 决策依据：[ADR-004](./adr/ADR-004-http-analysis-channel-for-automation.md)
> 状态：**设计阶段，尚未实现**。

### 16.1 为什么需要它

MCP 通道在【普通对话】里工作正常，但在**豆包工作的定时任务环境**里拿不到 MCP 工具
（宿主原文：`Tool not found or is not available`，两次独立运行均如此）。

「自动」依赖宿主调度，而宿主调度恰好跑在拿不到 MCP 工具的环境里 —— 把自动化绑死在
stdio MCP 上等于放弃自动。本接口走**命令行 / 网络**通道，**不经过宿主的工具集**。

**分工一个字没改**（ADR-003）：取数与投递仍由宿主用自带飞书能力完成；
变的只是**分析在哪台机器执行**。

### 16.2 与 MCP 通道的关系

| | MCP（交互式） | HTTP（自动化）★本文 |
|---|---|---|
| 用在 | 普通对话里让 AI 分析一场会 | 定时任务 / 任何拿不到 MCP 工具的宿主 |
| 分析在哪 | 宿主本机（逐字稿不出本机） | 服务器（逐字稿随请求上传） |
| 引擎 | `teaming-mcp` 里的 vendored copy | **同一个** `src/lib/analysis/` |
| 幂等键 | 逐字稿内容哈希 | **同一个**规则 |
| 报告页 | 服务器 | **同一个**页面 |

**两条通道必须给出同一个报告。** 新增能力时要明确：给哪条通道，还是两条都给。

### 16.3 契约

```
POST /api/host/v1/analyze
Authorization: Bearer <host token>
Content-Type: application/json
```

**请求体**

| 字段 | 必填 | 说明 |
|---|---|---|
| `transcript` | ✅ | 妙记导出的**文字转录稿**原文。不接受 AI 摘要 / 会议纪要 / 待办列表 |
| `title` | — | 会议标题，用于报告命名与卡片 |
| `meetingStartedAt` | — | 形如 `2026-10-13 22:13`，可空 |
| `feishuMeetingId` | — | 便于对账与反查，可空 |
| `clientRequestId` | — | 幂等键；不传则用逐字稿内容哈希 |
| `integrationId` | — | **⚠️ 见 16.5：调用方不能指定归属** |

**成功响应 200**

```json
{
  "ok": true,
  "reportPublicId": "078404e4-a2cc-43b4-9957-63526128104e",
  "reportUrl": "https://meeting.bamamei.online/report/v2/078404e4-…",
  "zone": "Apathy",
  "zoneLabel": "可能是冷漠区或舒适区",
  "meetingType": "技术支持/排障",
  "durationLabel": "7分钟 43秒",
  "participantCount": 3,
  "reused": false,
  "elapsedMs": 24183
}
```

`reused: true` 表示命中幂等（同一份逐字稿此前已分析过），**没有重复消耗模型额度**。

**错误响应**

```json
{ "ok": false,
  "error": {
    "type": "transcript",
    "code": "transcript_not_speaker_lines",
    "message": "这不是可用的逐字稿（只认出 2 条「姓名 时间 内容」形式的发言）。团队动力分析需要成员原始发言，不接受 AI 摘要或其他产物。"
  } }
```

| HTTP | `error.type` | 含义 | 宿主该做什么 |
|---|---|---|---|
| 400 | `transcript` | 逐字稿不合格（发言条数不足 / 是摘要） | **如实转告用户**，不要重试、不要编造报告 |
| 401 | `auth` | token 无效或已吊销 | 提示用户重新用接入码配置 |
| 422 | `analysis` | 引擎分析失败 | 可重试一次 |
| 429 | `rate_limit` | 触发限流 | 退避后重试 |
| 500 | `server` | 服务器内部错误 | 可重试 |

**错误必须映射为内部错误码**（对齐 `AGENTS.md` 4.3）：页面 / 宿主只消费 `error.type` + `error.code`，
不消费飞书或模型的原始报错文本。

### 16.4 幂等

- 幂等键 = `clientRequestId`（若传）否则 **逐字稿内容 SHA-256**。
- 命中时直接返回已有 `reportUrl`，`reused: true`，**不调模型**。
- 幂等是**超时兜底**的关键：宿主 HTTP 超时后重试，不会重复烧额度。

### 16.5 归属：由凭证决定，调用方不能指定

沿用 `/api/host/v1/reports` 的既有规则：**归属集成由 host token 反查得到**，
调用方即使传 `integrationId` 也**不生效**。

理由：接入码决定"报告归到谁名下"。若允许调用方指定，任何人都能把报告塞进别人的账下。

### 16.6 同步 or 异步

**本期选同步**：

- 分析约 20~60 秒，宿主把 HTTP 超时设到 **120 秒**即可。
- 即使超时，报告**仍会生成**；幂等保证重试能拿到同一个 `reportUrl`（16.4）。
- 不需要新增任务状态表。

**若实测发现宿主的 HTTP 超时无法调大**，再退回异步形态（返回 `jobId` + 轮询端点）。
届时需要新增状态表，并复用 MCP 侧已有的 job 语义。

### 16.7 部署注意

1. **必须同步 nginx 白名单。** 在 `/etc/nginx/snippets/allowlist-meeting.conf` 增加：

   ```nginx
   location = /api/host/v1/analyze { include /etc/nginx/snippets/proxy-meeting.conf; }
   ```

   漏加的后果今天已踩过：**外部访问返回 HTTP 000**（不是 404），容器内却是 401，很费时间。

2. 改 `.env.production` 后必须 `docker compose up -d --force-recreate meeting-analysis`，
   普通 `up -d --build` **不会**重新注入新变量。

3. 上线前先 `nginx -t` 再 reload。

### 16.8 宿主侧怎么用（定时任务提示词）

```
监控我在飞书会议里产生的妙记，发现新妙记就做团队动力分析，并把报告发给我。

执行步骤：
1) 用你自己的飞书能力查询最近 2 小时我参与或我拥有的妙记，按 token 去重；
   与上次已处理过的 minute_token 比对，只处理新出现的。查询为空就如实说明。

2) 对每个新妙记，用你自己的飞书能力导出【妙记文字转录稿】。
   拿不到就如实说明，不要用 AI 摘要替代。

3) 用 HTTP POST 调用 https://meeting.bamamei.online/api/host/v1/analyze
   （Authorization: Bearer <接入码换来的 host token>），body 传：
     transcript = 上一步的逐字稿原文
     title      = 妙记标题
   超时设 120 秒。返回里拿 reportUrl。

4) 把 reportUrl 以卡片形式发到【我自己的】单聊会话。

约束：查询为空就如实说明；报告不合格（400）就转告用户不要重试；不要编造。
```

### 16.9 未确认事项

| # | 事项 | 怎么确认 |
|---|---|---|
| 1 | 豆包工作的定时任务能否发起 HTTP 请求 | 本接口上线后，用一次真实多人会议实测 |
| 2 | 定时任务的 HTTP 超时上限 | 同上；若过短则改异步形态（16.6） |
| 3 | 定时任务是否能读环境变量 / 保存 token | 若不安全，改为让用户在任务里显式带 token（或改用「一次性票据」） |
| 4 | 逐字稿上传的合规边界 | **需 Owner 决策**：是否在接入文档里显式告知用户 |

