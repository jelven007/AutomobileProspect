# 潜客运营 · Web Monorepo

亿级潜客运营系统的前台工程仓库，覆盖营销运营工作台、销售 SDR 工作台、管理后台、经营大屏及 BFF 聚合层。

## 技术栈

- **包管理**：pnpm Monorepo + Turborepo
- **语言**：TypeScript 5
- **框架**：React 18 + Vite 5（Marketing / Sales / Admin） · Next.js 14（Dashboard SSR 大屏） · NestJS + Fastify（BFF）
- **UI**：Ant Design 5 + 自定义 brand theme
- **数据**：TanStack Query + Zustand + ky
- **可视化**：ECharts、G2Plot、React Flow（旅程 DAG）

## 目录结构

```
web/
├── apps/
│   ├── marketing/      # 营销运营工作台（标签/圈选/旅程/实验/归因/效果）
│   ├── sales/          # 销售 SDR 工作台（线索池/跟进 SOP/话术）
│   ├── admin/          # 管理后台（权限/配额/数据治理/租户）
│   ├── dashboard/      # 经营大屏（Next.js SSR，深色主题）
│   └── bff/            # NestJS Fastify BFF 聚合层
├── packages/
│   ├── types/          # 领域 TS 类型（OneId / Segment / Lead ...）
│   ├── api-client/     # 封装 CDP/圈选/SDR 的 HTTP SDK
│   ├── ui/             # 共享 brand 组件（KpiCard / IntentBadge / PageContainer）
│   ├── charts/         # 轻量图表（Funnel / TrendLine）
│   ├── dag/            # 旅程 DAG 数据结构
│   ├── segment-builder/# 圈选表达式工具
│   ├── auth/           # 身份与会话
│   ├── permission/     # 角色权限判定
│   ├── hooks/          # 通用 React Hooks
│   ├── icons/          # 自定义图标
│   ├── tsconfig/       # 共享 tsconfig 预设
│   └── eslint-config/  # 共享 ESLint 预设
├── pnpm-workspace.yaml
├── turbo.json
└── package.json
```

## 快速开始

```bash
# 1. 安装依赖（Node ≥ 20，已配 .nvmrc）
pnpm install

# 2. 启动全部 app（Turborepo 并行）
pnpm dev

# 或启动单个 app
pnpm --filter @leadops/marketing dev   # http://localhost:5173
pnpm --filter @leadops/sales dev       # http://localhost:5174
pnpm --filter @leadops/admin dev       # http://localhost:5175
pnpm --filter @leadops/dashboard dev   # http://localhost:3000
pnpm --filter @leadops/bff dev         # http://localhost:7001/bff
```

## 常用脚本

| 命令 | 说明 |
| --- | --- |
| `pnpm dev` | 并行启动所有 app |
| `pnpm build` | Turbo 构建全部 workspace |
| `pnpm lint` | ESLint 全量检查 |
| `pnpm typecheck` | 全仓 TypeScript 校验 |
| `pnpm format` | Prettier 格式化 |
| `pnpm clean` | 清理各包产物 |

## 工程规范

- 所有共享能力统一走 `@leadops/*` workspace 包，禁止跨 app 相对路径互相引用。
- 领域类型只在 `packages/types` 定义；BFF 与前端共享同一套类型。
- HTTP 请求必须通过 `@leadops/api-client` 发出，便于鉴权注入、链路追踪、Mock 切换。
- 大屏独立使用 Next.js SSR，避免 Vite 应用首屏加载过重。
- 后续补充 OpenAPI → openapi-typescript 自动生成客户端的流水线。

## 对应设计文档

- 需求/系统/技术方案：`../docs/`
- 前端详细方案：[前台Web门户技术方案.md](../docs/04_技术方案/前台Web门户技术方案.md)
- API 规范：[API接口规范.md](../docs/05_接口文档/API接口规范.md)
