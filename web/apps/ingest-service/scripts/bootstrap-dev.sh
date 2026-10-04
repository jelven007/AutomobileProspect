#!/usr/bin/env bash
# bootstrap-dev.sh —— 一键准备 ingest-service 本地联调环境
# 作用：
#   1. docker compose up postgres + minio
#   2. 等 PG + MinIO 健康
#   3. 跑 migrations/001_init.sql
#   4. 建 MinIO bucket + 上传 ./seed/Demo.xlsx 到 huji/2026/10/01/（如存在）
#   5. 提示下一步命令

set -euo pipefail

HERE="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
cd "$HERE"

GREEN='\033[0;32m'
YELLOW='\033[0;33m'
RED='\033[0;31m'
NC='\033[0m'

info() { echo -e "${GREEN}[bootstrap]${NC} $*"; }
warn() { echo -e "${YELLOW}[bootstrap]${NC} $*"; }
die()  { echo -e "${RED}[bootstrap]${NC} $*"; exit 1; }

command -v docker >/dev/null || die "docker 未安装，请先安装 Docker Desktop"
docker compose version >/dev/null 2>&1 || die "docker compose v2 不可用"

info "拉起 PostgreSQL + MinIO ..."
docker compose up -d postgres minio

info "等待 PostgreSQL 健康 ..."
for i in $(seq 1 30); do
  if docker compose exec -T postgres pg_isready -U leadops -d leadops >/dev/null 2>&1; then
    info "PG ready"
    break
  fi
  sleep 1
  [[ $i -eq 30 ]] && die "PG 启动超时"
done

info "等待 MinIO 健康 ..."
for i in $(seq 1 30); do
  if curl -fsS http://localhost:9000/minio/health/live >/dev/null 2>&1; then
    info "MinIO ready (console: http://localhost:9001  user/pass: minioadmin/minioadmin)"
    break
  fi
  sleep 1
  [[ $i -eq 30 ]] && die "MinIO 启动超时"
done

info "执行 migrations/001_init.sql ..."
docker compose exec -T postgres psql -U leadops -d leadops \
  -v ON_ERROR_STOP=1 < migrations/001_init.sql \
  || die "DDL 执行失败，看上面日志。若是 uk_customer_huji 唯一索引失败，是 PG 分区表的全局唯一约束限制，参考 docs/11_一期实施/开发阶段TODO.md 风险小节"

info "DDL 执行完成"

info "初始化 MinIO bucket + 上传 seed/Demo.xlsx（如存在）"
docker compose --profile setup up --exit-code-from createbuckets createbuckets

if [[ ! -f ./seed/Demo.xlsx ]]; then
  warn "没有发现 ./seed/Demo.xlsx —— 把真实 Demo.xlsx 放到 web/apps/ingest-service/seed/Demo.xlsx 后重跑："
  warn "  bash scripts/bootstrap-dev.sh"
fi

cat <<'TIPS'

======================================================================
 ingest-service 联调环境已就绪
======================================================================
 PG         postgres://leadops:leadops@localhost:5432/leadops
 MinIO API  http://localhost:9000   (AK/SK: minioadmin / minioadmin)
 MinIO UI   http://localhost:9001
 Bucket     leadops-raw             (seed 下 Demo.xlsx 已上传到 huji/2026/10/01/)

 下一步：
   set -a; source .env.example; set +a      # 或 cp .env.example .env 后 source
   pnpm --filter @leadops/ingest-service ingest:run -- \
     --schema configs/ingest-schema.yaml \
     --prefix huji/2026/10/01/

 清理：
   docker compose down            # 保留数据卷
   docker compose down -v         # 连 PG / MinIO 数据一起清
======================================================================
TIPS
