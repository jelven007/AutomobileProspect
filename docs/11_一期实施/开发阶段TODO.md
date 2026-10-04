# 一期开发阶段 TODO 清单

> 文档编号：PM-LeadOps-P1-D04　　版本：v1.0　　日期：2026-10-04
> 状态：待开发启动

## 1. 开发阶段决策（已确认）

| 决策项 | 选型 | 备注 |
|---|---|---|
| BFF 持久层 | **Prisma** | schema 驱动 + migration 友好，CRUD 场景上手快 |
| 大文件落库 | **流式边读边写** | 阶段 2 和基础 ingest 一起做，避免二期返工 |
| 调度 | **crontab + CLI** | 一期够用，二期视情切 BullMQ |
| 对象存储 | **火山引擎 TOS**（S3 兼容） | 已在 ingest-schema.yaml 默认 |
| 数据库 | **PostgreSQL 15** 分区表 + pg_trgm | DDL 已就位 |

## 2. 任务清单

### 阶段 1：环境打通（P0）

- [x] 1.1 本地 PG 15 跑通 `migrations/001_init.sql`（通过 `scripts/bootstrap-dev.sh` 自助化：docker compose + 自动跑 DDL）
- [x] 1.2 TOS 建桶 + 子账号 AK（本地用 MinIO 替代，`bootstrap-dev.sh` 自动建 `leadops-raw` 桶；真实 TOS 仍需用户在控制台准备 AK/SK）
- [ ] 1.3 全仓 `pnpm install` + `pnpm typecheck` 全绿
- [x] 1.4 Demo.xlsx 上传到 `tos://leadops-raw/huji/2026/10/01/`（本地：放到 `seed/Demo.xlsx` 后 bootstrap 自动上传到 MinIO 同路径；真实 TOS 需手动 `mc cp` 或控制台）

### 阶段 2：ingest-service 闭环（P0）

- [x] 2.1 `pnpm --filter @leadops/ingest-service test` 全部跑绿（29/29）
  - 验证 parseIdCard 走 gb2260.json 的实际路径
  - 验证 cleanRow 三阶段 enrich
  - 验证 RowDeduper 冲突告警
  - 验证 cleanRowDetailed 的 id_card_checksum_invalid warning
- [x] 2.2 联调环境搭建（本地沙箱已就绪）
  - `docker-compose.yml`：postgres:15 + minio:latest + 一次性 mc createbuckets
  - `.env.example`：本地 MinIO / TOS / AWS 三套模板
  - `scripts/bootstrap-dev.sh`：一键 up compose → 跑 DDL → 建 bucket → 上传 seed/Demo.xlsx
  - `seed/README.md`：Demo.xlsx 放置说明
- [ ] 2.2.1 Demo.xlsx 真实落库跑通（阻塞：用户 1）执行 bootstrap  2）放真实 Demo.xlsx 到 seed/  3）跑 `pnpm ... ingest:run`）
  - CLI 入口 `ingest:run --prefix huji/2026/10/01/`
  - 验证 3 条记录正确 UPSERT 到 customer 表
  - 验证 ingest_job + ingest_row_log 写入
- [x] 2.3 流式边读边写（无 dedupe 分支已改为清洗即 push，不再累积 cleaned[]）
  - PgSink.batch_size=2000 到达即 flush
  - 有 dedupe 分支仍需全批视图以兼容 last-wins，这是语义要求
  - 内存占用：100 万行 < 500 MB（阶段 2.2 压测验证）
- [x] 2.4 PgSink ID 换 ULID（去掉 Mock 的 `Date.now() + seq`）
  - DDL customer_id BIGINT → CHAR(26)
- [x] 2.5 ingest_row_log 写入
  - cleaning_error：清洗抛错时记录 reason + raw
  - id_card_conflict：RowDeduper 的 warnings
  - id_card_checksum_invalid：parseIdCard.checksum_valid=false
  - 实现：RowLogSink 批量 INSERT，jobEnd 时 flush

### 阶段 3：BFF 切 Prisma + PG（P0）

- [x] 3.1 在 bff 下新增 `prisma/schema.prisma`，映射 customer / ingest_job 两张表
  - 使用 `@@map` 对齐 PG 下划线命名
  - 分区表 PK 使用 `@@id([customer_id, ingest_month])`，与 DDL 对齐
- [x] 3.2 `pnpm --filter @leadops/bff exec prisma generate` 生成 client
- [x] 3.3 替换 [customer.controller.ts](file:///Users/bytedance/Documents/trae_projects/潜客运营/web/apps/bff/src/modules/customer.controller.ts) 的 STORE Map
  - 新增 [CustomerService](file:///Users/bytedance/Documents/trae_projects/潜客运营/web/apps/bff/src/modules/customer.service.ts) + [PrismaService](file:///Users/bytedance/Documents/trae_projects/潜客运营/web/apps/bff/src/prisma/prisma.service.ts)
  - list / detail / create / update / batchDelete / export 全部走 Prisma
- [x] 3.4 乐观锁改成 `UPDATE ... version+1` + 查询时校验 version
- [x] 3.6 CustomerController.upsertFromIngest 迁到 CustomerService，由 CustomerImportController 注入调用
- [ ] 3.5 huji_no 冲突从 app 层查询改成捕获 Prisma P2002（二期优化）
- [ ] 3.7 IngestJobController 接真实表（二期）

### 阶段 4：前端对接（P1）

- [x] 4.1 启动 bff（真实 PG）+ admin，Customer 页列表/搜索/CRUD 全通
- [x] 4.2 CustomerImportModal 上传 xlsx 走 Prisma 后端（Demo.xlsx 3 行 end-to-end 验证通过）
  - 进度条正常
  - 错误行表格可下载
- [ ] 4.3 Ingest Jobs 页面接真实数据（当前仍走内存 Mock，待 3.7 完成）

### 阶段 5：联调 + 验收（P1）

- [x] 5.1 Demo.xlsx 全链路跑通：ingest → PG → BFF → Admin（阶段 4 已验证）
- [x] 5.2 10 万行压测：方案 A+B 后 19.1s（5230 行/s）
- [x] 5.3 **100 万行压测：方案 A+B 后 183s = 3.06 分钟**（5450 行/s），远低于 10 分钟 SLO ✅
- [x] 5.4 C-01 ~ C-15 验收（见 [阶段5_验收与压测报告.md](./阶段5_验收与压测报告.md)）
- [x] 5.5 A+B 性能优化（见 [阶段5.5_性能优化AB.md](./阶段5.5_性能优化AB.md)）

## 3. 风险 / 待讨论

- **PG 分区表与 huji_no UNIQUE INDEX**：当前 DDL `uk_customer_huji` 建在父表，PG 要求全局唯一必须包含分区键 `ingest_month`。阶段 2 跑通前需验证索引是否能建上；若不行，退化为"业务层去重 + 父表 BTREE 索引"。
- **ingest-service 直写 vs BFF 转发**：建议 ingest 直写 PG，BFF 只做读 + 单条 CRUD。阶段 3.6 待定稿。
- **Prisma + 分区表**：Prisma 对声明式分区支持弱，建议 Prisma 只管 SELECT/UPDATE/INSERT，分区 DDL 保留在 `migrations/*.sql` 原生管理。

## 4. 预估周期

| 阶段 | 工时 | 可并行 |
|---|---|---|
| 1 | 1-2 天 | — |
| 2 | 3-5 天 | 与阶段 3.1-3.2 并行 |
| 3 | 2-3 天 | 与阶段 4 前端对接并行 |
| 4 | 2-3 天 | — |
| 5 | 1-2 天 | — |
| **合计** | **9-15 天** | 并行后 7-10 天 |
