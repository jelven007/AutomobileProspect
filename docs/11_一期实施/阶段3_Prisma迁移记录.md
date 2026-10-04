# 阶段 3：BFF 切 Prisma + Postgres 迁移记录

## 目标

把 BFF 的 `customer` 相关 CRUD 从内存 Mock Store 替换成 Prisma + PostgreSQL。核心价值：

- 服务重启不丢数据（根治 nodemon 热重载 + 本地测试清零问题）
- 支撑亿级 Lead 场景的持久化基础
- 读写走分区表 `customer` + 索引，查询不再做 `Array.from(STORE.values())` 全表扫

## 落地动作

### 1. 依赖

- `prisma@5.22.0` + `@prisma/client@5.22.0`
- 一次性补上 `fastify@^4.26.0`（Prisma 装入时拉掉了原来通过 `@nestjs/platform-fastify` 带出的 fastify 类型，补装后 `import type { FastifyReply } from 'fastify'` 恢复可用）

### 2. 关键文件

| 文件 | 作用 |
| --- | --- |
| [prisma/schema.prisma](file:///Users/bytedance/Documents/trae_projects/潜客运营/web/apps/bff/prisma/schema.prisma) | Prisma schema，字段严格对齐 [001_init.sql](file:///Users/bytedance/Documents/trae_projects/潜客运营/web/apps/ingest-service/migrations/001_init.sql) |
| [prisma/prisma.service.ts](file:///Users/bytedance/Documents/trae_projects/潜客运营/web/apps/bff/src/prisma/prisma.service.ts) | PrismaClient 封装 + 当月分区兜底 |
| [prisma/prisma.module.ts](file:///Users/bytedance/Documents/trae_projects/潜客运营/web/apps/bff/src/prisma/prisma.module.ts) | `@Global()` 导出 PrismaService |
| [modules/customer.service.ts](file:///Users/bytedance/Documents/trae_projects/潜客运营/web/apps/bff/src/modules/customer.service.ts) | 批量导入入口 `upsertFromIngest`，被 CustomerImportController 注入 |
| [modules/customer.controller.ts](file:///Users/bytedance/Documents/trae_projects/潜客运营/web/apps/bff/src/modules/customer.controller.ts) | list / facets / detail / create / update / batchDelete / export 全部 Prisma 化 |
| [.env.example](file:///Users/bytedance/Documents/trae_projects/潜客运营/web/apps/bff/.env.example) | `DATABASE_URL=postgresql://leadops:leadops@localhost:5432/leadops?schema=public` |

### 3. 分区表约定

- `customer` 为 `PARTITION BY RANGE (ingest_month)`，Prisma 不原生支持分区
- 对策：
  - schema 层只声明 `@@id([customer_id, ingest_month])`，分区 DDL 不交给 Prisma Migrate 管
  - 部分唯一索引 `uk_customer_huji (huji_no, ingest_month) WHERE is_deleted=FALSE` 保留在 [001_init.sql](file:///Users/bytedance/Documents/trae_projects/潜客运营/web/apps/ingest-service/migrations/001_init.sql)，Prisma schema 不声明以免被 push 回去改坏
  - [PrismaService.onModuleInit](file:///Users/bytedance/Documents/trae_projects/潜客运营/web/apps/bff/src/prisma/prisma.service.ts#L17-L23) 启动时 `CREATE TABLE IF NOT EXISTS customer_pYYYY_MM`，跨年 / 新环境 safety-net

### 4. "空值不覆盖已有" 的 upsert 合并

- 匹配链：`huji_no` → `id_card` → `(name + phone_masked)`
- 命中则组装 `Prisma.CustomerUpdateInput`，仅把真正有值的字段放进去，`version` 用 `increment: 1`
- 未命中则 `prisma.customer.create` 配 ULID + 推导的 `ingest_month`
- 同一个 Demo.xlsx 连续导入两次：第二次 `inserted=0 / updated=3`，`total` 保持 3 ✅

## 验证

```bash
# 1. 清库
curl -X DELETE http://localhost:7001/bff/customer/_all

# 2. 首次导入
curl -X POST http://localhost:7001/bff/customer/import \
  -F "file=@web/apps/ingest-service/seed/Demo.xlsx"
# => inserted_rows=3, updated_rows=0, total_rows=3

# 3. 核对数据：id_card 明文、phone 明文、省市区齐
curl http://localhost:7001/bff/customer?limit=5

# 4. 关键：重启 BFF 后数据仍在
lsof -ti:7001 | xargs kill -9
pnpm --filter @leadops/bff dev
curl http://localhost:7001/bff/customer?limit=5   # 仍返回 3 行 ✅

# 5. 二次导入验证跨批次 upsert
curl -X POST http://localhost:7001/bff/customer/import \
  -F "file=@web/apps/ingest-service/seed/Demo.xlsx"
# => inserted_rows=0, updated_rows=3, 列表 total 仍为 3 ✅

# 6. CRUD / export 冒烟
curl -X POST http://localhost:7001/bff/customer -H "Content-Type: application/json" \
  -d '{"name":"测试","huji_no":"999999","id_card":"110108199001010011"}'
curl -X PUT http://localhost:7001/bff/customer/<id> -d '{"version":1,"occupation":"工程师"}'
curl -X DELETE http://localhost:7001/bff/customer/<id>
curl -o /tmp/exp.zip http://localhost:7001/bff/customer/export
# => Content-Type: application/zip, groups=3, X-Export-Total=3 ✅
```

## 待跟进项

- 3.5 huji_no 唯一冲突从 "先查后插" 改成捕获 Prisma `P2002`（二期优化，当前走先查更直观）
- 3.7 IngestJobController 接 `ingest_job` 真实表（当前仍是内存数组）
- 100 万行性能压测（阶段 5）需要加 Prisma `createMany` + 批次事务重写导入链路，当前单条 upsert 适合 Demo 规模
