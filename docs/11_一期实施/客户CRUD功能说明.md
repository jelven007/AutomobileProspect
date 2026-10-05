# 客户 CRUD 功能说明（一期）

> **现行规则（2026-10-05）**：参见 [多证件导入与定向补录](多证件导入与定向补录.md)。客户按「证件类型 + 证件号码」唯一匹配，列表、表单与批量导出均包含证件类型；编码编号仅为展示字段。以下为历史设计记录，其中编码唯一、仅 18 位身份证、自动脱敏等描述已被现行规则取代。

> 文档编号：PM-LeadOps-P1-C01　　版本：v1.3　　日期：2026-10-04

## 1. 入口

- Admin 应用：`/customer`
- Marketing 应用：复用（只读 + 导出）

## 2. 页面

### 2.1 列表页 `/customer`

| 元素 | 说明 |
|---|---|
| 搜索栏 | 姓名、地址关键字、省份、城市、区县、性别、证件类型；采用紧凑小尺寸控件 |
| 操作栏 | 新增客户、批量导入、批量导出、批量删除、清空全部、刷新、展开/收起内容 |
| 表格列 | 编码编号、姓名、证件类型、证件号码、出生日期、性别、手机号、省份、城市、区县、地址、职业、学历、婚姻、统计时间、入库批次、操作 |
| 分页 | 每页 50/100/200；显示总页数，支持首页、上一页、下一页、尾页及输入页码跳转 |
| 伸缩 | 侧栏可收起；内容区随窗口与侧栏宽度自适应；表格列宽可拖动或键盘微调，长文本可展开/收起 |
| 批量 | 批量选择 → 批量删除 / 导出 |

批量导出生成 ZIP：居民身份证按省份和城市分别生成 `省份-城市-条数.xlsx`；当前筛选范围内的所有非居民身份证合并生成一个 `非居民身份证-条数.xlsx`。每个 Excel 均包含证件类型列。

### 2.2 详情页 `/customer/:id`

字段分组：
- 基础信息：编码编号、姓名、性别、出生日期、身份证（脱敏）
- 地理信息：省份、城市、区县、地址
- 社会属性：职业、学历、婚姻
- 联系信息：脱敏手机
- 入库信息：统计时间、来源文件、来源行、入库批次、版本

> **字段来源说明**：
> - `province` / `city` 优先取 Excel 原列，缺失时**由身份证前 2 / 前 4 位自动推导**
> - `birth_date` / `gender` 同样优先 Excel 原列，缺失时由身份证推导
> - `district` 一期仅预留字段，可通过详情页人工维护，二期补全 GB2260 后自动填充
> - `occupation` / `education` / `marital_status` 为**人工维护位**（身份证推不出），用于后续画像补齐

### 2.3 新增 / 编辑

- 单条表单，含校验：
  - `huji_no` 纯数字；新增时若与库中已存在的编码号重复，后端返回 **409 version_conflict**
  - `id_card` 18 位（结尾可为 X/x）；入库前服务端自动脱敏
  - `address` 多行文本，长度 ≤ 256
- 编辑时提交 `version` 做乐观锁，冲突返回 409

### 2.4 批量导入

- 入口：客户管理页「批量导入」按钮，打开 Modal
- 上传：拖拽 / 点击，单文件 ≤ 200 MB（更大体量请走 ingest-service 对接对象存储）
- 清洗：**服务端复用 `@leadops/ingest-service`**，走同一套 pipeline
  - 丢弃第 1（所属户籍站）/3（居住地址）/倒数两列
  - 第 4 列（编码编号）去除 "2016户籍统计" 前缀，仅保留纯数字
  - 第 7 列（身份证）在服务端脱敏为 `前6+********+后4`
  - 其余字段按 `configs/ingest-schema.yaml` 配置
- **去重**（本次新增）：
  - 文件内 Map 去重（`huji_no`，`keep=last`）
  - 跨批次 PG `ON CONFLICT (huji_no) DO UPDATE` 幂等覆盖
  - 编码号不同但身份证相同 → 冲突告警（不阻断导入）
- 响应：`CustomerImportReport`：
  - `total_rows / success_rows / duplicate_rows / written_rows / skipped_rows`
  - `conflict_warnings: [{ huji_no, against, reason }]`
  - `errors: [{ row, reason }]`
- UI：上传进度条 + 完成后结果页；异常行、身份证冲突明细分别用两张小表展示，支持"再传一个"

### 2.5 同步任务页 `/ingest-jobs`

- 任务列表、状态、进度、重跑按钮、异常行下载
- 新增列：`duplicate_rows`、`written_rows`、`warnings`

### 2.6 导出任务页 `/export-jobs`

- 客户页点击「批量导出」只创建后台任务，随后进入导出任务页，不阻塞列表操作。
- 导出任务按创建时间倒序展示排队、处理、完成和失败状态；运行中每 2 秒自动刷新。
- 进度约每处理 1 万行更新，同时记录已处理行数/总行数、已完成文件数/计划文件数；服务重启后任务按创建顺序串行恢复。
- 完成后的 ZIP 可在任务页下载，失败任务可按原筛选条件重试，过期文件不再提供下载按钮。

## 3. REST API（挂到 BFF `/bff/customer`）

| Method | Path | 说明 |
|---|---|---|
| GET | `/bff/customer` | 列表，支持 `q / address / province / city / district / gender / id_type / page / limit`；旧客户端仍可使用 `cursor` |
| GET | `/bff/customer/:id` | 详情 |
| POST | `/bff/customer` | 新增（`huji_no` 冲突返回 409） |
| PUT | `/bff/customer/:id` | 编辑（必带 `version`） |
| DELETE | `/bff/customer/:id` | 软删除 |
| POST | `/bff/customer/import` | 批量导入 xlsx（multipart） |
| GET | `/bff/customer/export` | 导出异步任务 |
| GET | `/bff/ingest-jobs` | 同步任务列表 |
| POST | `/bff/ingest-jobs/:jobId/retry` | 重跑 |

### 3.1 列表请求

```http
GET /bff/customer?q=谭&address=车家湾&id_type=resident_id&page=3&limit=50
```

响应：
```json
{
  "code": 0,
  "message": "ok",
  "request_id": "r_123",
  "data": {
    "items": [
      {
        "customer_id": "182313",
        "huji_no": "9161337",
        "name": "谭陆友",
        "gender": "M",
        "birth_date": "1988-09-01",
        "id_card": "510***********1234",
        "phone_masked": "135****5678",
        "address": "车家湾社区……",
        "province": "四川省",
        "city": "内江市",
        "district": null,
        "occupation": null,
        "education": null,
        "marital_status": null,
        "stat_time": "2016-02-26T16:51:34Z",
        "ingest_batch": "01JAD...ULID",
        "version": 1
      }
    ],
    "next_cursor": "182413",
    "has_more": true,
    "total": 7433143,
    "page": 3,
    "total_pages": 148663
  }
}
```

### 3.2 批量导入响应

```json
{
  "code": 0,
  "data": {
    "job_id": "01JAD...ULID",
    "file_name": "Demo.xlsx",
    "total_rows": 10234,
    "success_rows": 10200,
    "skipped_rows": 34,
    "duplicate_rows": 128,
    "written_rows": 10072,
    "conflict_warnings": [
      { "huji_no": "9161337", "against": "9161200", "reason": "id_card_conflict" }
    ],
    "errors": [
      { "row": 42, "reason": "invalid_id_card_format" }
    ],
    "elapsed_ms": 7345
  }
}
```

### 3.3 错误码

| code | message | 场景 |
|---|---|---|
| 0 | ok | 成功 |
| 40001 | invalid_param | 参数校验失败 |
| 40401 | not_found | 不存在 |
| 40901 | version_conflict | 乐观锁冲突 / **新增时编码号已存在** |
| 50001 | server_error | 未知错误 |

## 4. 权限

| 角色 | 可做 |
|---|---|
| admin | 全部 |
| operator | 列表 / 详情 / 新增 / 编辑 / 导入 |
| viewer | 列表 / 详情 / 导出 |

## 5. 交互细节

- 页面查询使用一致性事务同时获取总条数和数据；末页会从倒序结果的近端读取，避免尾页扫描全部记录。
- 兼容接口仍支持游标顺序翻页；指定页码需要计算位置，743 万条无筛选数据跳到中间页实测约 10.56 秒，首页、相邻页和尾页明显更快。
- 搜索姓名、地址用 **PG trgm** 索引；编码编号走等值索引
- 删除是**软删除**（`is_deleted = TRUE`），30 天后硬删
- 新增 / 编辑在提交前对 `huji_no` 做纯数字校验，前后端一致
- **身份证字段**：前端 Form 对 18 位做正则预校验；明文仅在"新增"场景一次性进入清洗管道，入库后一律脱敏

## 6. 验收用例

| ID | 用例 | 期望 |
|---|---|---|
| C-01 | 列表默认按入库时间倒序 | ✅ |
| C-02 | 搜索姓名「谭」匹配所有姓谭的 | ✅ |
| C-03 | 搜索编码编号 `9161337` 精确命中 | ✅ |
| C-04 | 搜索地址关键字 "车家湾" 命中并走 trgm 索引 | ✅ |
| C-05 | 编辑 `version` 冲突返回 409 并提示 | ✅ |
| C-06 | 新增时编码号已存在返回 409 并提示 | ✅ |
| C-07 | 删除后再搜索看不到；详情直链返回 404 | ✅ |
| C-08 | 批量导入 1 万行完成提示：total/success/duplicate/written/skipped 均准确 | ✅ |
| C-09 | 同文件再传一次：`duplicate_rows ≈ written_rows`，表体不膨胀 | ✅ |
| C-10 | 两行同身份证不同编码号 → 均入库 + 冲突告警可见 | ✅ |
| C-11 | 身份证字段在列表与详情中严格脱敏（前 6 + 8\* + 后 4） | ✅ |
| C-12 | 身份证前 2 位 "51" → 省份 "四川省"；前 4 位 "5101" → 城市 "成都市"；7–14 位→出生日期；第 17 位奇/偶→性别 | ✅ |
| C-13 | Excel 原列 `gender=男` 时，身份证推导的 F 不会覆盖 M | ✅ |
| C-14 | 身份证校验位异常时仍落库，并在 `ingest_row_log` 留 `id_card_checksum_invalid` | ✅ |
| C-15 | 1000 万数据翻 100 页 P95 ≤ 500ms | ✅ |
