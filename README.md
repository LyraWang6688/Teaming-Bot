# 组队会议动力分析

基于 `Next.js 16 + React 19 + TypeScript` 的会议纪要分析工具，使用豆包 OpenAI-compatible API 生成结构化分析结果，并通过飞书官方 Node SDK 完成用户级集成初始化、OAuth 授权、妙记生成事件监听、妙记文字稿导出和多维表格回写。

## 本地开发

```bash
pnpm install
pnpm dev
```

默认本地地址：

- `http://localhost:5000`

## 质量检查

```bash
pnpm ts-check
pnpm lint
```

## 生产部署

项目采用 Docker Compose 部署，宿主机通过 `127.0.0.1:3011` 映射到容器内 `3000` 端口，再由 Nginx 对外暴露 `80/443`。

```bash
sudo docker compose up -d --build
```

前端上传入口使用异步任务：先调用 `/api/analyze/tasks` 创建任务，再轮询 `/api/analyze/tasks/:taskId` 获取结果。保留的同步 `/api/analyze` 兼容接口仍可能等待大模型分析结果，生产 Nginx 建议允许较长代理等待时间：

```nginx
client_max_body_size 12m;
proxy_connect_timeout 300s;
proxy_send_timeout 300s;
proxy_read_timeout 300s;
```

## 生产环境变量

```env
NODE_ENV=production
PROJECT_PUBLIC_URL=https://meeting.bamamei.online
DATABASE_URL=
NEXT_PUBLIC_SUPABASE_URL=
NEXT_PUBLIC_SUPABASE_ANON_KEY=
SUPABASE_SERVICE_ROLE_KEY=
APP_ENCRYPTION_KEY=

ANALYSIS_PROVIDER=doubao
DOUBAO_API_KEY=
DOUBAO_BASE_URL=https://ark.cn-beijing.volces.com/api/v3
DOUBAO_MODEL=doubao-seed-1-8-251228

FEISHU_ENABLE_STARTUP_RECOVERY=true
```

## 两条可用入口

- 手动入口：前端上传 `.txt/.docx`，调用 `/api/analyze/tasks` 创建 `web_analysis_tasks` 任务并轮询结果
- 自动入口：飞书 SDK 长连接监听 `minutes.minute.generated_v1` 妙记生成事件

两条入口共享同一套分析服务与报告渲染逻辑。

## 飞书自动化说明

- 用户在 `/feishu-config` 点击按钮，后端通过 SDK `registerApp` 发起扫码确认并一键创建应用；App ID 与 App Secret 随即加密落库。
- 后端自动配置并发布 OAuth 回调、Refresh Token 开关和长连接订阅方式；用户点击授权后在飞书完成确认，再自动回到配置页。
- OAuth 回调取得真实 `access_token`、`refresh_token` 与过期时间，统一加密落库；TokenService 负责提前刷新和重授权状态判断，容器重建不再依赖 Keychain。
- 初始化严格依次完成“创建应用 → 用户授权 → 选择组织 → 目标 Base 可访问 → SDK 长连接 ready”；只有第五步成功才将集成标记为初始化完成并触发烟花。
- 事件监听由 SDK `WSClient` 建立，消费进程启动前会重新读取数据库并校验前四步，未走完整流程的集成不会进入消费范围。
- 服务端从事件体读取 `event.minute_source.source_entity_id` 作为会议 ID 写入 Base，读取 `event.minute_token` 作为导出妙记文字稿入参。
- 妙记和 Base OpenAPI 由官方 SDK 使用数据库中的用户 Token 调用；应用密钥与 OAuth Token 均只在服务端解密，不回显到前端或日志。
- 默认启用启动恢复：服务重启后会基于 `meeting_pipeline_tasks` 继续恢复到期任务
- 结构化监控日志会输出到应用日志，建议重点关注 `event_listener_ready`、`minute_generated_event_received`、`transcript_export_finished`、`analysis_failed`、`meeting_pipeline_failed`
- `/feishu-config` 是唯一的飞书接入入口，应用、OAuth、Base、检查和初始化状态均以数据库为唯一事实来源

## 相关文档

- `docs/飞书集成设计.md`
- `docs/项目结构说明.md`
- `docs/后台分析逻辑说明.md`
