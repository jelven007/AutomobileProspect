# seed 目录

把真实的 **Demo.xlsx** 放到这里（`web/apps/ingest-service/seed/Demo.xlsx`），然后：

```bash
bash scripts/bootstrap-dev.sh
```

bootstrap 会把它上传到本地 MinIO 的 `leadops-raw/huji/2026/10/01/Demo.xlsx`，
之后就能跑 `pnpm --filter @leadops/ingest-service ingest:run` 做端到端联调。

> 本目录下的 xlsx 文件不要进 git（已在根 `.gitignore` 过滤 `*.xlsx`，若无请手动忽略）。
