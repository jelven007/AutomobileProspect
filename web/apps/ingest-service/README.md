# @leadops/ingest-service

一期对象存储 → PG 同步与清洗服务。流式处理 xlsx，亿级可控内存。

## 本地联调（一行启动）

本地沙箱用 **Postgres 15 + MinIO** 替代真实 PG + TOS，一行命令起来：

```bash
cd web/apps/ingest-service

# 1. 一键拉容器 + 跑 DDL + 建 MinIO bucket + 上传 seed/Demo.xlsx
bash scripts/bootstrap-dev.sh

# 2. 加载环境变量
set -a; source .env.example; set +a

# 3. 跑一次 ingest
pnpm --filter @leadops/ingest-service ingest:run -- \
  --schema configs/ingest-schema.yaml \
  --prefix huji/2026/10/01/
```

**准备 Demo.xlsx**：把真实 Demo.xlsx 放到 `seed/Demo.xlsx` 后再跑 bootstrap，脚本会自动上传到 MinIO 的 `leadops-raw/huji/2026/10/01/Demo.xlsx`。xlsx 文件已在根 `.gitignore` 过滤，不会污染提交。

**依赖检查**：bootstrap 需要本机已安装 Docker Desktop 且 `docker compose version` 可用。

单独升级已有数据库时，设置 `PG_URL` 后执行：

```bash
pnpm --filter @leadops/ingest-service db:migrate
```

**本地服务端口**：
- PG `localhost:5432`（leadops / leadops / leadops）
- MinIO API `localhost:9000`、Console `localhost:9001`（minioadmin / minioadmin）

**清理**：

```bash
docker compose down            # 保留数据卷
docker compose down -v         # 连数据一起清
```

## 用法（接真实 TOS / S3）

### 快速接入火山 TOS（prospect-data / cn-shanghai 示例）

```bash
cd web/apps/ingest-service

# 1. 复制模板并填入 IAM 子账号的 AK/SK
cp .env.tos.example .env.tos
vim .env.tos                     # 填 AWS_ACCESS_KEY_ID / AWS_SECRET_ACCESS_KEY

# 2. 加载环境变量
set -a; source .env.tos; set +a

# 3. dry-run：列出前缀下所有 xlsx，不入库
pnpm --filter @leadops/ingest-service ingest:ls -- \
  --schema configs/ingest-schema.yaml \
  --prefix Prospect8kwS/

# 4. 单文件试跑（挑一个最小的 xlsx 完整 key 作为 prefix）
pnpm --filter @leadops/ingest-service ingest:run -- \
  --schema configs/ingest-schema.yaml \
  --prefix Prospect8kwS/<某个文件.xlsx>

# 5. 全量
pnpm --filter @leadops/ingest-service ingest:run -- \
  --schema configs/ingest-schema.yaml \
  --prefix Prospect8kwS/
```

**IAM 子账号权限**（最小集）：`tos:GetObject` + `tos:ListBucket`，Resource 锁到 `prospect-data` 单桶。

### 通用环境变量

```bash
# 1. 环境变量（以火山 TOS 为例）
export INGEST_BUCKET=leadops-raw
export TOS_ENDPOINT=https://tos-s3-cn-beijing.volces.com
export TOS_REGION=cn-beijing
export AWS_ACCESS_KEY_ID=<TOS AccessKey>
export AWS_SECRET_ACCESS_KEY=<TOS SecretKey>
export PG_URL=postgres://user:pass@host:5432/leadops

# 2. 运行一次同步
pnpm --filter @leadops/ingest-service ingest:run -- \
  --schema configs/ingest-schema.yaml \
  --prefix huji/2026/10/01/

# 3. 定时任务
crontab -e
# 0 2 * * * /usr/bin/pnpm --filter @leadops/ingest-service ingest:run ...
```

全部走 S3 兼容协议（AWS SDK v3 `@aws-sdk/client-s3`），通过 `configs/ingest-schema.yaml` 中的 `source.type` 切换：

| type    | 适用场景                   | endpoint 示例                                   | force_path_style |
|---------|----------------------------|-------------------------------------------------|------------------|
| `s3`    | AWS S3 原生                 | 留空（走 AWS 默认）                            | `false`          |
| `tos`   | 火山引擎对象存储（推荐）    | `https://tos-s3-cn-beijing.volces.com`         | `true`           |
| `oss`   | 阿里云 OSS 的 S3 兼容入口   | `https://oss-cn-hangzhou.aliyuncs.com`         | `true`           |
| `minio` | 自建 MinIO                  | `https://minio.internal:9000`                  | `true`           |

### 接入火山引擎 TOS

TOS 原生提供 S3 兼容 API 入口，无需额外 SDK，三步接入：

**Step 1：在 TOS 控制台创建桶**
- 控制台 → 对象存储 TOS → 创建桶
- 记下 **桶名**（如 `leadops-raw`）、**所在区域**（如 `cn-beijing`）
- 记下对应的 S3 兼容 Endpoint：
  - 华北2(北京)：`https://tos-s3-cn-beijing.volces.com`
  - 华东2(上海)：`https://tos-s3-cn-shanghai.volces.com`
  - 华南1(广州)：`https://tos-s3-cn-guangzhou.volces.com`
  - 完整列表参考 [火山引擎 TOS 文档 - 地域和访问域名](https://www.volcengine.com/docs/6349/107356)

**Step 2：创建访问凭证（AccessKey）**
- 控制台 → 访问控制 IAM → 用户 / 子账号 → 新建密钥对
- 建议为同步任务新建子账号，并授予该账号对单个桶的 `tos:GetObject` + `tos:ListBucket` 权限
- 保存 `AccessKeyId` / `SecretAccessKey`

**Step 3：配置环境变量 + yaml**

```bash
export INGEST_BUCKET=leadops-raw
export TOS_ENDPOINT=https://tos-s3-cn-beijing.volces.com
export TOS_REGION=cn-beijing
# AWS SDK 识别的凭证变量，TOS 的 AK/SK 直接复用
export AWS_ACCESS_KEY_ID=AKLT...
export AWS_SECRET_ACCESS_KEY=xxx
```

`configs/ingest-schema.yaml` 默认已配好 TOS 模板：

```yaml
source:
  type: tos
  bucket: ${INGEST_BUCKET}
  prefix: huji/
  endpoint: ${TOS_ENDPOINT}
  region: ${TOS_REGION}
  force_path_style: true
```

**Step 4：验证**

```bash
# 列出前缀下的 xlsx 看能否连通
pnpm --filter @leadops/ingest-service ingest:run -- \
  --schema configs/ingest-schema.yaml --prefix huji/2026/10/01/
```

启动日志里会打印 `source_type=tos, bucket=..., endpoint=..., region=...`，确认连接到 TOS 而不是误走 AWS。

### 切回 AWS S3 或其他兼容对象存储

编辑 `source.type` / `endpoint` / `region` / `force_path_style` 四个字段即可，代码无需改动。

### 常见问题

- **403 SignatureDoesNotMatch**：`region` 没填或填错；TOS 必须显式传 `cn-beijing` 这类区域码。
- **PermanentRedirect / endpoint 不匹配**：桶所在区域与 endpoint 的区域不一致，核对控制台。
- **ListObjectsV2 返回空**：确认 `prefix` 以 `/` 结尾；TOS 的 ACL 需要 `tos:ListBucket` 而非 `tos:ListObjects`。
- **访问性能慢**：桶如果和运行同步服务的 ECS 不在同一 region，建议开启 TOS 的内网 endpoint（如 `https://tos-s3-cn-beijing.ivolces.com`），同 VPC 内走内网不走公网。

## 行政区划码持续更新

身份证地址派生使用三层数据：

1. 现行区划：`china-division`
2. 1980–2020 历史快照：`@cndiv/source-history`
3. 项目兜底：`configs/gb2260.json`

每月 GitHub Actions 会检查并创建数据源升级 PR。也可手动执行：

```bash
pnpm --filter @leadops/ingest-service region:update
pnpm --filter @leadops/ingest-service region:audit -- /absolute/path/to/file.xlsx
```

`region:audit` 只输出未命中的行政区划代码及计数，不输出身份证、姓名或手机号。升级码表后必须运行测试和真实文件覆盖率审计。

## 清洗规则

- 优先按首行中文表头动态识别列，未识别到任何字段时才回落到 `configs/ingest-schema.yaml` 的固定列号。
- 编码编号去除 `2016户籍统计` 前缀，仅保留数字；允许为空。
- 身份证为必填且是唯一合并依据；同一身份证只保留一条，编码编号不参与唯一性判断。
- 身份证明文入库前派生 `province` / `city` / `district` / `birth_date` / `gender`。
- 身份证和手机号按当前一期决策明文存储；生产环境应另行配置字段级加密和访问审计。
- 超过数据库字段容量的值按行记为 `value_too_long:<field>:<limit>`，不会回滚整批。

详见 [数据同步与清洗规则](../../../docs/11_一期实施/数据同步与清洗规则.md)。
