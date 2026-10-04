# API 接口规范

> 文档编号：API-LeadOps-001　　版本：v1.0　　日期：2026-10-04　　负责人：张路

## 1. 通用约定

- 协议：HTTPS（外部）、gRPC（内部）。
- 风格：RESTful + JSON；GET 读、POST/PUT/DELETE 写。
- BaseURL：`https://api.leadops.internal/v1`
- 鉴权：外部 `Authorization: Bearer <JWT>`；内部 mTLS + 服务 Token。
- 公共请求头：
  ```
  Authorization: Bearer <token>
  X-Request-Id: <uuid>
  X-App-Id: <caller>
  Content-Type: application/json
  ```
- 公共响应：
  ```json
  { "code": 0, "message": "ok", "request_id": "...", "data": {} }
  ```

## 2. 错误码

| code | 含义 | HTTP |
|---|---|---|
| 0 | 成功 | 200 |
| 40001 | 参数错误 | 400 |
| 40100 | 未鉴权/Token 失效 | 401 |
| 40300 | 无权限 | 403 |
| 40400 | 资源不存在 | 404 |
| 40900 | 冲突 | 409 |
| 42900 | 限流 | 429 |
| 50000 | 服务内部错误 | 500 |
| 50300 | 下游依赖异常 | 503 |

- 分页：`page`（1 起）+ `page_size`（默认 20，最大 200）。
- 幂等：写操作必带 `X-Request-Id`。
- 限流：默认 200 QPS/app_id，可申请提额。
- 版本：路径带 `v1`、`v2`，向后兼容 ≥ 6 个月。

## 3. OneID

- `POST /oneid/query`
  ```json
  { "id_type": "phone_md5", "id_value": "a1b2...", "with_relations": true }
  ```
  Resp：`{ "oneid": "O_1000...", "relations": [...] }`

- `POST /oneid/merge`
  ```json
  { "primary_oneid": "O_1", "to_merge": ["O_2"], "reason": "manual", "operator": "u_zhanglu" }
  ```

- `POST /oneid/split` `{ "task_id": "merge_..." }`

## 4. 画像

- `GET /profile/{oneid}?fields=basic,tags,behavior,score&behavior_days=30`
- `POST /profile/batch` `{"oneids": [...], "fields": "basic,score"}` 单次 ≤ 500
- `GET /tags` / `POST /tags` / `PUT /tags/{id}` / `DELETE /tags/{id}`

## 5. 圈选

- `POST /segment/estimate`
  ```json
  {
    "expression": {
      "op": "AND",
      "conditions": [
        {"tag_id": 1001, "op": "eq", "value": "L5"},
        {"tag_id": 1200, "op": "in", "value": ["一线"]}
      ]
    }
  }
  ```
- `POST /segment` 创建人群包。
- `GET /segment/{id}` 查询状态。
- `GET /segment` 分页列表。
- `DELETE /segment/{id}` 下线。

## 6. 模型打分 / 推荐 / Lookalike

- `POST /score/intent` `{ "oneid": "O_...", "model_version": "intent_v2.3" }`
- `POST /score/intent/batch` 单次 ≤ 1000；超量走 `/score/intent/batch_async`。
- `GET /recommend/vehicles?oneid=O_...&top_n=5`
- `POST /lookalike/expand`
  ```json
  { "seed_segment_id": "seg_...", "expand_size": 1000000, "similarity_threshold": 0.75 }
  ```

## 7. 旅程

- `POST /journey` 创建旅程（DAG）。
- `POST /journey/{id}/publish|pause|resume|stop`。
- `GET /journey/{id}/stats` 执行统计。

旅程 DAG 示例节点：`send | wait | condition | ab_split | webhook | sdr_dispatch`。

## 8. 触达

- `POST /message/send`
  ```json
  {
    "oneid": "O_...", "channel": "sms", "template_id": "tpl_...",
    "params": {"name":"张先生"}, "biz_tag": {"journey_id":"jny_..."},
    "frequency_control": true
  }
  ```
- `POST /message/batch_send`
- `POST /optout` / `GET /optout/{oneid}` / `DELETE /optout/{oneid}`
- `POST /callback/message` 下游供应商回执

## 9. SDR 派单

- `GET /sdr/leads?sales_id=...&limit=20`
- `POST /sdr/leads/{lead_id}/followup`
  ```json
  { "status": "contacted|arrived|no_response|invalid|deal", "note": "...", "next_contact_at": "..." }
  ```
- `POST /sdr/leads/{lead_id}/return` `{ "reason": "wrong_number" }`

## 10. 实验平台

- `POST /experiment` 创建实验。
- `GET /experiment/assign?oneid=...&experiment_id=...` 分流查询。
- `GET /experiment/{id}/result` 查看结果（样本、均值、CI、p 值）。

## 11. BI 与归因

- `GET /metrics/dashboard?date_range=...&region=...&model=...`
- `GET /metrics/funnel?segment_id=...` 或 `journey_id=...`
- `POST /attribution/mta`
  ```json
  { "date_range": {"start":"2026-09-01","end":"2026-09-30"},
    "conversion_event": "deal", "model": "shapley|time_decay|linear" }
  ```

## 12. 数据接入与 DQC

- `POST /ingest/source` 注册数据源。
- `POST /dqc/rule` 配置数据质量规则。
- `GET /ingest/source/{id}/status` 查询状态。

## 13. IAM 与审计

- `/iam/user`、`/iam/role`、`/iam/grant`、`/iam/revoke`。
- `GET /audit/log?user_id=&action=&resource=&date_range=`。

## 14. Webhook

- `POST /webhook/subscribe`
  ```json
  { "event":"high_intent_detected","callback_url":"...","secret":"...","filter":{"region":["SH"]} }
  ```
- 回调签名：`X-Signature: HMAC-SHA256(secret, body)`

事件：`high_intent_detected | lead_arrived | deal_closed | model_drift | journey_completed`

## 15. SDK

- 官方 SDK：Java / Python / Go，封装鉴权、重试、幂等。
- Python 示例：
  ```python
  from leadops import Client
  cli = Client(app_id="mkt_app_001", secret="***")
  seg = cli.segment.estimate({"op":"AND","conditions":[{"tag_id":1001,"op":"eq","value":"L5"}]})
  print(seg["estimated_count"])
  ```

## 16. OpenAPI

- OpenAPI 3.0 YAML 发布在 `https://api.leadops.internal/docs`。
- 支持 Swagger UI 在线调试、Postman Collection 导出。
- 变更需走 API Review；Breaking Change 必须升版本并双版本并行 6 个月。
