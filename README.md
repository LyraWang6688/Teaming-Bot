# 组队会议动力分析

基于 `Next.js 16 + React 19 + TypeScript` 的会议纪要分析工具，使用豆包 OpenAI-compatible API 生成结构化分析结果，并支持通过飞书 `Webhook + OpenAPI` 自动处理会议事件、回写多维表格和打开报告页。

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

FEISHU_USER_OAUTH_SCOPE=offline_access minutes:minutes.search:read minutes:minutes.transcript:export
FEISHU_ENABLE_STARTUP_RECOVERY=true
```

## 两条可用入口

- 手动入口：前端上传 `.txt/.docx`，调用 `/api/analyze`
- 自动入口：飞书 `Webhook + OpenAPI`，调用 `/api/feishu/webhook`

两条入口共享同一套分析服务与报告渲染逻辑。

## 飞书自动化说明

- 当前正式自动化链路只依赖 `vc.meeting.participant_meeting_ended_v1`
- 服务端收到 Webhook 后，会按“会议结束 -> 获取录制文件 -> 解析 minute_token -> 导出文字稿 -> 豆包分析 -> 回写 Base”执行
- 正式主链路统一使用数据库中保存的集成级 `tenant_access_token / user_access_token`，不再依赖任何全局飞书密钥 env
- 默认启用启动恢复：服务重启后会基于 `meeting_pipeline_tasks` 继续恢复到期任务
- 结构化监控日志会输出到应用日志，建议重点关注 `recording_fetch_finished`、`transcript_export_finished`、`analysis_failed`、`meeting_pipeline_failed`
- `/feishu-config` 是唯一的飞书接入入口，应用配置、Webhook Token、Base 配置和 OAuth 授权都保存在数据库

## 相关文档

- `docs/飞书集成设计.md`
- `docs/项目结构说明.md`
- `docs/后台分析逻辑说明.md`
