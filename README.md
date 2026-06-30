# 组队会议动力分析

基于 `Next.js 16 + React 19 + TypeScript` 的会议纪要分析工具，使用豆包 OpenAI-compatible API 生成结构化分析结果，并通过服务器内置的飞书 CLI 完成用户级集成初始化、妙记生成事件监听、妙记文字稿导出和多维表格回写。

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

FEISHU_USER_OAUTH_SCOPE=minutes:minutes.basic:read minutes:minutes.transcript:export offline_access bitable:app
FEISHU_ENABLE_STARTUP_RECOVERY=true
```

## 两条可用入口

- 手动入口：前端上传 `.txt/.docx`，调用 `/api/analyze/tasks` 创建 `web_analysis_tasks` 任务并轮询结果
- 自动入口：飞书 CLI 监听 `minutes.minute.generated_v1` 妙记生成事件

两条入口共享同一套分析服务与报告渲染逻辑。

## 飞书自动化说明

- 用户在 `/feishu-config` 点击按钮，后端调用 `lark-cli config init --new` 为该用户创建或绑定独立 CLI profile。
- 用户授权由后端调用 `lark-cli auth login --scope ... --no-wait --json` 发起，再用 `--device-code --json` 完成轮询。
- 事件监听由后端调用 `lark-cli --profile <profile> event consume minutes.minute.generated_v1 --as user`。
- 服务端从事件体读取 `event.minute_source.source_entity_id` 作为会议 ID 写入 Base，读取 `event.minute_token` 作为导出妙记文字稿入参。
- 飞书 OpenAPI 调用统一通过 `lark-cli --profile <profile> api ... --as user --format json` 执行，不在数据库中保存或使用 Bearer token。
- 默认启用启动恢复：服务重启后会基于 `meeting_pipeline_tasks` 继续恢复到期任务
- 结构化监控日志会输出到应用日志，建议重点关注 `event_listener_ready`、`minute_generated_event_received`、`transcript_export_finished`、`analysis_failed`、`meeting_pipeline_failed`
- `/feishu-config` 是唯一的飞书接入入口，CLI profile、Base 配置和授权状态都保存在数据库

## 相关文档

- `docs/飞书集成设计.md`
- `docs/项目结构说明.md`
- `docs/后台分析逻辑说明.md`
