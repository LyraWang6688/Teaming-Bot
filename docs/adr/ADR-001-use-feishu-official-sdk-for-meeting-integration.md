# ADR-001: Use Feishu Official SDK for Meeting Integration

Status: Accepted
Date: 2026-07-20

> 标注约定：**[Repo]** = 可从公开仓库（commit / PR / docs / 当前代码）独立证明；**[Owner]** = 由 Human Owner 提供、GitHub 无法独立证明的决策背景。无法从仓库确认的内容一律显式标注「无法确认」，不做推测填补。

## Context

Teaming-Bot 的主链路整体建立在飞书之上：用户在飞书开会并生成妙记后，系统需要导出文字转录稿、完成会议动力分析、把结果回写到多维表格，并把报告推送给会议创建者。这条链路要求集成同时具备四类能力：应用创建与自动配置、用户级 OAuth 授权、会议与妙记事件监听、OpenAPI 数据读写。**[Repo]**（`README.md`、`docs/飞书集成设计.md`）

真正决定选型边界的是两条业务约束 **[Owner]**：

1. **数据权限与数据类型不匹配**：业务需要的是**文字转录稿**，而更早的自动化方案取得的是会议智能纪要。文字转录稿属于**个人资产**，需要用户本人独立授权，不能由平台侧凭证代取。
2. **异步与响应时间约束**：事件触发与数据获取需要跨系统串联，存在响应时间约束，必须异步处理，不能依赖同步长等待。

在这两条约束下，飞书集成路线经历了四次切换。正确的技术演化链是 **[Owner]**：

```text
Feishu Workflow / 工作配方  →  Direct Open API  →  飞书 CLI  →  Feishu Official SDK
```

**[Repo]** 链条的后三段在仓库中留有对应证据；最终于 `e4aab30`（2026-07-20）收敛到官方 SDK。

> **[Repo] 边界说明**：仓库初始导入时，自建 Open API 客户端与 CLI 封装模块同时存在，仓库无法据此判定两者的先后顺序；先后顺序依据 Human Owner 的决策记录。

## Options Considered

### Option A: Feishu Workflow / 工作配方

- **[Owner]** 这是最初尝试的方案。它需要通过 HTTP 串联两个系统，存在响应时间约束，需要异步处理。
- **[Owner]** 更关键的问题不是响应时间，而是**数据权限与数据类型不匹配**：工作配方取得的是会议智能纪要，而业务需要文字转录稿；文字转录稿属于个人资产，需要独立授权。该约束直接否定了这条路线。
- **无法确认**：公开仓库中检索不到「工作配方」相关的实现、文档或提交记录（全历史提交信息检索 `配方` 无匹配）。仓库最早的提交 `9021bb7`（2026-06-17 `chore: initial project import`）已经是一个自建 Webhook 管线。因此工作配方的评估发生在仓库之外、或早于初始导入，仓库无法独立证明其细节与结论。

### Option B: Feishu CLI

- **[Owner]** 转向 CLI 的原因：当时飞书 CLI 较流行，且很适合 Agent 调用。
- **[Repo]** `65f5f91`（2026-06-29）用 `lark-cli` 替换 Webhook 承担事件监听，事件消费形态是 `lark-cli event consume` 的 NDJSON 子进程流；`5c89258`（2026-06-30）进一步用 CLI 替代 OpenClaw 承担集成配置。
- **[Repo]** CLI 期面向集成用户的 OpenAPI 调用通过 `execFile('lark-cli', ['api', ...])` 子进程完成，带 60 秒超时与 10MB buffer；缺少 CLI profile 时直接抛错（`e4aab30^:src/lib/feishu/integration/integrationOpenApi.ts`）。
- **[Repo]** 凭据保存在容器文件系统的 CLI profile 目录（`LARKSUITE_CLI_CONFIG_DIR=/app/.lark-cli`），并用进程内 `configuredProfiles` Set 缓存 profile 状态（`e4aab30^:src/lib/feishu/integration/cliProfileManager.ts`）。
- **[Repo]** 该路线持续产生部署成本修补：Dockerfile 安装 `curl`、`npm install -g @larksuite/cli`、切换国内镜像源、为 CLI 配置目录创建并授权（`f46a8f7`、`39e335c`，以及 `e4aab30` 删除的 Dockerfile 4 行）。
- **[Owner]** 实践后的结论：CLI 更适合作为 Agent / 开发工具的调用入口，**不适合作为产品级长期集成层**，尤其无法很好承担 Token 的全生命周期治理。
- **[Repo]** 该路线最终被完全移除：`e4aab30` 从 Dockerfile 删除 CLI 安装与 profile 目录配置，`af9a4b8`（2026-07-22）删除遗留 CLI Base 流程。当前代码中已无 `lark-cli` / `@larksuite/cli` / `LARKSUITE_CLI` 残留。

### Option C: Direct Open API

- **[Owner]** 这是飞书 CLI 之前被**明确考虑并采用的正式技术路线**，不是偶然出现的历史实现。当时的判断是：如果要搭建一个长期运行的产品，底层应该基于飞书 Open API，而不是依赖临时工具层。
- **[Repo]** 该路线在仓库中留有完整的自建实现：初始导入（`9021bb7`，2026-06-17）已包含 `src/lib/feishu/openapi.ts` —— 直接 `fetch` `https://open.feishu.cn/open-apis`，自行实现 `tenant_access_token` 的获取、进程内缓存与到期续期；`e175837`（2026-06-18）补充最小 OAuth token 流程（`oauth/start`、`oauth/callback`）。
- **[Repo]** 手写令牌交换随后延续到 `65f5f91:src/lib/auth/feishuOAuth.ts`：直接 `fetch` `/open-apis/auth/v3/app_access_token/internal` 与 `/open-apis/authen/v1/access_token`，手工串联 `app_access_token` → `user_access_token`（该文件由 `1c2ef16` 删除）。
- **[Owner]** 该路线后来被放下、转向飞书 CLI（转向原因见 Option B）。
- **[Owner]** 被放弃的是**自建实现层**，不是「基于 Open API」这个方向本身 —— 这一点在最终的 SDK 方案里被保留下来。

### Option D: Feishu Official SDK

- **[Repo]** `@larksuiteoapi/node-sdk` 在迁移前已是项目依赖（`^1.0.0`），但只覆盖局部能力；`e4aab30`（2026-07-20，PR #1，2026-07-22 合并）把应用注册、OAuth、应用配置、事件监听与 OpenAPI 调用**整体**迁到 SDK，并把版本锁定为 `1.71.0`。
- **[Repo]** 迁移后确立的 SDK 使用面：`registerApp`（`appRegistrationStore.ts`）、`WSClient` + `EventDispatcher`（`eventListenerManager.ts`）、`withUserAccessToken` + `client.request`（`integrationOpenApi.ts`）、应用机器人消息（`reportNotificationService.ts`）。
- **[Owner]** 随后了解到官方 SDK。最终判断：SDK 底层仍然基于 Open API，但对认证、Token、事件监听、接口调用等做了更成熟的工程封装，更适合作为产品的长期集成方案。
- **[Repo]** 现状印证了这一点：即使调用 SDK 未封装的端点，代码仍通过 SDK 的 `client.request` 携带原生 `/open-apis/...` 路径完成，而不是回到自建 HTTP 与令牌层（`src/lib/feishu/integration/integrationOpenApi.ts`）。

## Decision

飞书集成统一使用官方 `@larksuiteoapi/node-sdk`（锁定 `1.71.0`）作为唯一通道；不再使用工作配方、飞书 CLI，也不自建 HTTP 与令牌层直连 Open API。SDK 同时承担应用创建与配置、用户 OAuth、令牌刷新、事件长连接、OpenAPI 调用与应用机器人消息。**[Repo]**（`package.json`、`docs/飞书集成设计.md` 第一章、`src/lib/feishu/integration/sdkClient.ts`）

## Why

1. **一个依赖收敛多个外部工具的职责。** 迁移前，应用创建、OAuth、事件监听与 OpenAPI 调用分散在 CLI 子进程、自写 HTTP 与局部 SDK 之间；迁移后由同一个依赖覆盖，减少了「每次换路线都要联动改鉴权、事件接收方式与部署形态」的返工面。**[Repo]** + **[Owner]**
2. **Token 生命周期可治理。** CLI 路线把凭据放在容器文件系统的 profile 目录，并用进程内 Set 缓存状态；SDK 路线由 `TokenService` 从数据库读取并加密保存用户令牌，容器重建不再依赖文件系统或 Keychain。**[Repo]**（`tokenService.ts`，对比 `e4aab30^:src/lib/feishu/integration/cliProfileManager.ts`）
3. **运行形态简化。** 事件消费从子进程 NDJSON 流改为进程内 `WSClient`；容器不再需要安装 CLI 二进制、准备配置目录权限与镜像源。**[Repo]**（`e4aab30` Dockerfile 删除 4 行；`eventListenerManager.ts`）
4. **该方案的权限模型与业务约束一致。** 「文字转录稿属于个人资产、需用户本人独立授权」这一约束要求集成具备标准 OAuth 用户令牌与用户级事件订阅能力，而不是平台侧凭证代取；SDK 路线以用户令牌驱动妙记导出与 Base 读写，与该约束对齐。**[Owner]**（约束来源）+ **[Repo]**（实现形态：`docs/飞书集成设计.md` 第二、四章）

### Reusable Principle

> **适合 Agent / 开发工具调用的工具，不一定适合作为产品的长期集成层。**

产品级第三方集成在选型时应优先评估五件事：

1. **认证方式** —— 是否支持产品所需的身份模型（如用户级 OAuth，而非仅平台凭证）。
2. **Token 全生命周期治理** —— 获取、刷新、失效判定、重授权，且可持久化、可恢复、可观测。
3. **事件机制** —— 长连接 / Webhook 的稳定性、门禁与断线恢复能力。
4. **维护成本** —— 部署形态、版本升级、错误语义与可观测性。
5. **官方支持边界** —— 官方是否长期维护，能力覆盖是否完整。

**[Owner]** 这条原则来自本项目四次路线切换的实际教训，特别是「CLI 很适合 Agent 调用、却不是产品级集成层」这一结论。

## Consequences

### Positive

- 飞书能力收敛到单一依赖，替换或升级只有一处入口。**[Repo]**
- 用户令牌加密落库，事件消费与后台任务都以数据库为唯一事实来源，容器重建不丢状态。**[Repo]**
- 事件监听在应用进程内，不再承担子进程生命周期与 NDJSON 流解析负担。**[Repo]**
- 「一键创建应用并自动配置」成为可能（`registerApp` + 配置发布），业务用户不需要进入开放平台逐项配置。**[Repo]**（`docs/飞书集成设计.md` 第三章）

### Trade-offs

- **版本锁定。** `package.json` 精确锁定 `1.71.0` 而非 `^` 范围，SDK 升级需要单独回归。**[Repo]**
- **仍需直面 Open API 细节。** SDK 未封装的端点仍要手写 `/open-apis/...` 路径与查询参数，SDK 只承担鉴权与传输。**[Repo]**
- **SDK 错误对象需要统一脱敏。** 嵌套错误可能携带 Authorization 头进入日志，必须经统一包装后才能输出。**[Repo]**（`38e1e90`；`src/lib/feishu/common/sdkLogger.ts`）
- **初始化权限面扩大。** 自动配置并发布应用自身需要 `application:application:self_manage`、`application:application:patch` 等应用身份权限。**[Repo]**（`docs/飞书集成设计.md` 第三章）

### Future Constraints

- 新增飞书能力默认走 SDK；确需直连 Open API 时，应通过 SDK 的 `client.request` 承载，不新增自建 HTTP 与令牌层。**[Repo]**（`AGENTS.md` 飞书编码原则）
- 敏感字段（App Secret、access/refresh token 等）必须走统一 `encrypt()` / `decrypt()`，且只在服务端解密。**[Repo]**
- 业务函数必须显式接收 `integrationId` / `integrationConfig`，禁止从 `process.env` 读取用户级配置。**[Repo]**
- SDK 升级前需回归 `registerApp`、`WSClient` 事件消费、令牌刷新与 OpenAPI 调用四条路径。
- **[Owner]** 后续计划把飞书事件监听与推送能力插件化 / Skill 化，并把会议分析能力沉淀为 Skill；该方向可能再次改变集成的封装边界，届时应新建 ADR 而非改写本条。

## Evidence

1. **Commit `e4aab30`**（2026-07-20）`Migrate Feishu integration to SDK` — 迁移主体：删除 `cliProfileManager.ts`、`cliProcessStore.ts`、`authDeviceCodeStore.ts`，新增 `sdkClient.ts`、`tokenService.ts`，Dockerfile 移除 CLI 安装与 profile 目录配置，SDK 依赖由 `^1.0.0` 锁定为 `1.71.0`。
2. **PR #1** `Migrate Feishu integration to SDK`（分支 `codex/feishu-sdk-poc`，merged 2026-07-22）— 变更范围与验证记录：迁移创建应用 / OAuth / Token 刷新 / 事件订阅 / 长连接，删除 CLI 运行时依赖与遗留 Base 初始化接口，并记录线上已验证初始化、事件监听与会议分析主流程。
3. **早期 Direct Open API 与 CLI 路线的实现证据** — `9021bb7:src/lib/feishu/openapi.ts`、`e175837`（自建 Open API 客户端与最小 OAuth token 流程）；`65f5f91:src/lib/auth/feishuOAuth.ts`（手写令牌交换，由 `1c2ef16` 删除）；`65f5f91` / `5c89258` / `f46a8f7` / `39e335c` 与 `e4aab30^:src/lib/feishu/integration/integrationOpenApi.ts`、`e4aab30^:src/lib/feishu/integration/cliProfileManager.ts`（CLI 子进程调用、profile 目录、进程内缓存、Docker 补丁）。
4. **`docs/飞书集成设计.md`** — 第一章「方案与边界」、第二章「六段顺序状态机」、第三章「应用创建与自动配置」。
5. **当前实现** — `src/lib/feishu/integration/sdkClient.ts`、`src/lib/feishu/integration/tokenService.ts`、`src/lib/feishu/events/eventListenerManager.ts`、`src/lib/feishu/integration/integrationOpenApi.ts`、`src/lib/feishu/im/reportNotificationService.ts`。

补充证据：工作配方路线在公开仓库中无对应实现或提交记录，仅依据 Human Owner 的决策记录。
