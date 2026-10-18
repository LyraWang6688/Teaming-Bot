#!/usr/bin/env bash
#
# 生产部署 —— 一条命令完成「拉代码 → 取提交号 → 重建 → 自证」
#
# ## 为什么要有这个脚本
#
# 过去几次部署事故都不是"代码写错了"，而是"步骤漏了一环"，而且漏了**不报错**，
# 只表现成"改了没生效"，排查成本很高：
#
#   1. **先构建、后拉代码** → 构建出来的是旧代码（2026-10-15 真实发生，
#      容器跑的是前一个提交，日志看起来一切正常）
#   2. **`docker compose up -d` 不会重新注入环境变量** → 必须 `--force-recreate`
#      （2026-10-15 也踩过：容器里 `OPS_ALERT_ENABLED` 是空串）
#   3. **没传 `SOURCE_REVISION`** → 镜像不知道自己是哪次构建产出的，
#      `/api/health` 报 null、镜像 label 是 unknown（issue #9）
#
# 脚本把这些步骤固定下来，并且最后**读 `/api/health` 自证**：
# 报出来的 commit 与本次部署的提交不一致，就以非零退出码失败——不留
# "看起来部署成功了"的模糊状态。
#
# ## 用法（在服务器上）
#
#   cd /home/ubuntu/meeting-analysis
#   ./scripts/deploy.sh
#
# ## 会中断服务
#
# `--force-recreate` 会停掉旧容器再起新的，通常几十秒。挑没有会议正在分析的时间窗。
#
set -euo pipefail

cd "$(dirname "$0")/.."

SERVICE="${SERVICE:-meeting-analysis}"
HEALTH_URL="${HEALTH_URL:-https://meeting.bamamei.online/api/health}"
MAX_WAIT_CHECKS="${MAX_WAIT_CHECKS:-40}"     # 每次 3 秒，默认最多等 2 分钟
MISMATCH_GRACE="${MISMATCH_GRACE:-10}"       # 有响应但不匹配时，再宽限几次（约 30 秒）

log() { printf '%s\n' "$*"; }

# ── 0. 前置检查 ───────────────────────────────────────────────────────────────
if ! command -v docker >/dev/null 2>&1; then
  log "❌ 找不到 docker。这个脚本是在服务器上跑的，不是本机。"
  exit 1
fi
if [ ! -f docker-compose.yml ] && [ ! -f compose.yml ]; then
  log "❌ 当前目录没有 docker-compose.yml，确认在仓库根目录（$(pwd)）"
  exit 1
fi

# ── 1. 先拉代码，再动手构建 ───────────────────────────────────────────────────
log "==> 1/4 拉取代码（必须在构建之前）"
git pull --ff-only

# ── 2. 把本次部署的提交号确定下来 ─────────────────────────────────────────────
log "==> 2/4 记录本次部署的提交"
REV="$(git rev-parse --short HEAD)"
if ! git diff --quiet; then
  REV="${REV}-dirty"
  log "    ⚠️ 工作区有未提交改动，标记为 ${REV}（生产不该这样，请确认）"
fi
export SOURCE_REVISION="$REV"
log "    SOURCE_REVISION=${SOURCE_REVISION}"

# ── 3. 重建镜像 + 强制重建容器 ────────────────────────────────────────────────
log "==> 3/4 重建镜像并强制重建容器（会中断服务几十秒）"
docker compose up -d --build --force-recreate "$SERVICE"

# ── 4. 自证：健康接口报出来的 commit 必须等于本次部署的提交 ───────────────────
log "==> 4/4 等待健康检查，核对 commit"
mismatch_seen=0
for i in $(seq 1 "$MAX_WAIT_CHECKS"); do
  sleep 3
  body="$(curl -fsS --max-time 5 "$HEALTH_URL" 2>/dev/null || true)"
  if [ -z "$body" ]; then
    continue
  fi

  # commit 可能是字符串或 null；null 时取不到值，视为未匹配
  reported="$(printf '%s' "$body" | sed -n 's/.*"commit":"\([^"]*\)".*/\1/p')"

  if [ "$reported" = "$SOURCE_REVISION" ]; then
    log "    ✅ 生产已确认在跑 ${reported}"
    exit 0
  fi

  mismatch_seen=$((mismatch_seen + 1))
  if [ "$mismatch_seen" -ge "$MISMATCH_GRACE" ]; then
    log "    ❌ 容器已响应，但 commit 对不上"
    log "       接口报的：${reported:-<null>}"
    log "       本次部署：${SOURCE_REVISION}"
    log "       完整响应：${body}"
    log "       常见原因：镜像没重建成功、或 SOURCE_REVISION 没进构建参数"
    exit 1
  fi
done

log "    ❌ 等了 $((MAX_WAIT_CHECKS * 3)) 秒，健康检查一直没通过"
log "       排查：docker compose logs --tail 80 ${SERVICE}"
exit 1
