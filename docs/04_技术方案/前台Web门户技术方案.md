# 前台 Web 门户技术方案

> 文档编号：TS-LeadOps-Web-001　　版本：v1.0　　日期：2026-10-04　　负责人：张路

本文档是 [技术选型与实现](./技术选型与实现.md) 的子方案，专门描述前台 Web 门户的技术设计。

## 1. 门户定位

潜客运营系统有 **4 个 Web 门户**，面向不同角色、不同使用频率、不同终端：

| 门户 | 面向角色 | 终端 | 关键能力 |
|---|---|---|---|
| 运营工作台 | 市场运营、投放、内容 | PC（1440+） | 圈选、旅程、实验、素材、创意 |
| 销售工作台 | SDR、销售顾问 | PC + 移动 H5 | 今日线索、客户 360、外呼跟进 |
| 经营大屏 | 管理层、店长 | 大屏 1920/4K | 实时指标、下钻、告警 |
| 平台管理后台 | 平台管理员、数据/算法团队 | PC | 数据源、标签、模型、权限、审计 |

四个门户共用底层组件库与账号体系，独立部署与发布。

## 2. 整体技术栈

### 2.1 核心技术
- **语言**：TypeScript 5.x（严格模式）
- **框架**：React 18（Server Components 暂不启用，稳定度优先）
- **路由**：React Router 6 / Next.js App Router（经营大屏采用 Next.js SSR）
- **UI 组件库**：Ant Design 5 + Ant Design Pro Components
- **状态管理**：Zustand（本地）+ TanStack Query（服务端态）
- **样式**：Tailwind CSS + CSS Modules + Antd Token（主题化）
- **图表**：ECharts 5 + G2Plot（AntV）
- **可视化编辑**：
  - 圈选条件构造器：自研 + react-querybuilder 二次封装
  - 旅程 DAG：React Flow（节点自定义）
  - 大屏：DataV / AntV + 自研组件
- **表单**：React Hook Form + Zod（schema 校验）
- **国际化**：i18next（一期中文；二期多语言）
- **构建**：Vite 5（开发快）+ Rsbuild（生产；Rspack 底层）
- **Mono-repo**：pnpm + Turborepo
- **测试**：Vitest + Testing Library + Playwright（E2E）
- **代码规范**：ESLint + Prettier + Stylelint + Husky + lint-staged
- **类型契约**：OpenAPI → openapi-typescript 自动生成 Client

### 2.2 工程脚手架
基于 Ant Design Pro + 自研增强：
- Mock 数据：MSW（Mock Service Worker）
- API Client 自动生成（根据后端 OpenAPI）
- 权限路由：按菜单/按钮/按字段 三级
- 微前端：Qiankun（为后续多子系统集成留口子）

## 3. 架构分层

```
┌─────────────────────────────────────────────┐
│ 用户层  浏览器（Chrome/Edge/Safari 最近两版） │
├─────────────────────────────────────────────┤
│ 边缘层  CDN · 静态资源 · ALB · WAF           │
├─────────────────────────────────────────────┤
│ 应用层  运营 · 销售 · 大屏 · 管理（SPA/SSR） │
├─────────────────────────────────────────────┤
│ BFF 层  Node.js (NestJS) · 聚合 · 鉴权透传   │
├─────────────────────────────────────────────┤
│ 后端    REST / gRPC-Web · OpenAPI 契约        │
└─────────────────────────────────────────────┘
```

### 3.1 为什么要 BFF
- 聚合多后端接口（画像 + 分数 + 行为），一次返回；
- 字段裁剪与前端定制（减少数据量，PII 自动脱敏）；
- 鉴权透传、Session、CSRF、缓存；
- 为移动 H5 和 PC 提供差异化响应。

**技术**：NestJS + Fastify；共享 TS 类型；可部署在 K8s；
**权衡**：BFF 不做业务逻辑，不做 DB 直连，不做长事务。

### 3.2 Mono-repo 目录
```
leadops-web/
├─ apps/
│  ├─ marketing/           ← 运营工作台 (Vite SPA)
│  ├─ sales/               ← 销售工作台 (Vite SPA + H5)
│  ├─ dashboard/           ← 经营大屏 (Next.js SSR)
│  ├─ admin/               ← 管理后台 (Vite SPA)
│  └─ bff/                 ← NestJS BFF
├─ packages/
│  ├─ ui/                  ← 共享组件库
│  ├─ icons/
│  ├─ hooks/
│  ├─ api-client/          ← OpenAPI 自动生成
│  ├─ types/               ← 共享类型
│  ├─ auth/                ← 鉴权 SDK
│  ├─ permission/          ← 权限 HOC/Hooks
│  ├─ charts/              ← 图表封装
│  ├─ dag/                 ← 旅程 DAG 组件
│  └─ segment-builder/     ← 圈选条件构造器
├─ tooling/                ← eslint/tsconfig/vite 共享配置
└─ turbo.json
```

## 4. 核心页面技术设计

### 4.1 运营工作台 · 人群圈选

**页面组成**：
- 左侧标签树（虚拟滚动，万级标签秒开）
- 中间条件构造器（嵌套 AND/OR/NOT、时间窗、事件次数）
- 右侧预估面板（人数、人数分布、与历史人群重叠度）
- 底部：保存、复用、导出、关联旅程

**技术要点**：
- `segment-builder` 封装为独立包，表达式 AST 存 JSON：
  ```ts
  type Expr =
    | { op: 'AND' | 'OR'; children: Expr[] }
    | { op: 'NOT'; child: Expr }
    | { tag_id: number; op: 'eq' | 'in' | 'gt' | 'lt'; value: unknown; time_window?: string };
  ```
- 预估防抖 500ms；loading 态 skeleton；
- 大量结果列表用 TanStack Virtual（react-virtual）；
- 导出走 Server-Sent Events 推送进度；
- 本地保存草稿（IndexedDB，Dexie）。

### 4.2 运营工作台 · 旅程编排

**基于 React Flow**：
- 节点类型：Entry、Send、Wait、Condition、A/B、Webhook、Dispatch、End；
- 节点自定义渲染 + 右侧抽屉属性编辑；
- 画布功能：缩放、小地图、对齐、撤销重做（zundo）；
- 校验：出入度、死循环、未完成节点；
- 发布：Dry Run → Shadow → 灰度 5% → 全量；
- 节点实时数据：接 Webhook 增量推送，节点上显示进入/完成/转化。

### 4.3 销售工作台

**双端**：
- PC：主用，侧栏客户列表 + 右侧 360 详情；
- H5：外出走访用，适配 iPhone/Android；
- 共享业务逻辑包 `packages/sales-core`。

**客户 360 页**：
- 卡片式信息组织：
  - 基础信息（PII 脱敏，一键解密走审批）
  - 意向分 + Top 3 原因（SHAP 可视化：bar）
  - 推荐车型（卡片 + 快速话术）
  - 行为流水（时间线 Virtualized）
  - 触达历史（短信/企微/外呼）
  - 跟进记录（表单 + 时间线）
- 操作：一键外呼（CTI 回调）、添加跟进、推送内容。

### 4.4 经营大屏

**技术**：
- Next.js SSR（首屏快，SEO 无关但利于性能）；
- WebSocket 推送 + 轮询兜底（10s）；
- 分辨率适配：1920×1080、2560×1440、3840×2160；
- 字体缩放：`clamp()` + CSS Variables；
- 组件：计数器动效（react-countup）、折线/柱状/漏斗/地图（禁用真实地图，用矩阵/柱状表达区域）；
- 异常告警区自动滚动，支持点击跳转。

### 4.5 平台管理后台

**模块**：
- 数据源、Schema、DQC、任务监控
- 标签管理（含审批流）
- 模型管理（版本、灰度）
- 权限、角色、数据域
- 审计日志（高性能表格：react-virtualized-tree）
- 通道、模板、退订

**技术要点**：
- 复杂表单（嵌套、动态字段）用 React Hook Form + Zod；
- 大表格（10 万行）虚拟化；
- 审批流用 x6（AntV）或内置 Stepper。

## 5. 鉴权与权限

### 5.1 登录
- 企业内网：对接 SSO（OAuth2 / OIDC / SAML）；
- 外部：账号密码 + 二次验证（短信/TOTP）；
- Token：Access Token（JWT，15min）+ Refresh Token（HttpOnly Cookie，7d）；
- CSRF：双提交 Cookie；
- XSS：严格 CSP + DOMPurify。

### 5.2 权限
三级权限：
1. **菜单级**：路由守卫 + 配置化菜单（`permissions` 字段）；
2. **按钮/操作级**：`<AuthWrap code="segment:export">`；
3. **字段级**：BFF 响应时按用户权限脱敏/删除字段。

### 5.3 数据域
- 销售只看辖区客户，由 BFF 根据 `data_scope` 过滤。
- 前端只做展示，不信任前端过滤结果。

## 6. 性能方案

### 6.1 加载性能
- 代码分割：路由级 + 组件级 `React.lazy`；
- Tree Shaking + Antd 按需加载；
- CDN 加速静态资源 + Brotli；
- 关键路径预加载：路由预取（Hover prefetch）；
- 图片 WebP / AVIF，LazyLoad；
- 字体子集化（中文按需）；
- 目标：
  - LCP ≤ 2.5s（P75）
  - INP ≤ 200ms
  - CLS ≤ 0.1

### 6.2 运行时性能
- 大列表虚拟滚动（TanStack Virtual）；
- 高频更新用 `useMemo` + `useDeferredValue`；
- 图表渲染用 Canvas（非 SVG）处理 ≥ 1000 点；
- Web Worker 处理表达式解析、重计算；
- IndexedDB 存草稿、离线查询（Dexie）。

### 6.3 监控
- 性能埋点：Web Vitals + 自研 RUM；
- 错误监控：Sentry（含 Source Map）；
- 用户行为埋点：按事件 schema 上报 Kafka → 分析。

## 7. 可访问性与国际化

- WCAG 2.1 AA；
- 键盘可达（Tab、Enter、Esc、方向键）；
- 对比度 ≥ 4.5；
- 色盲友好（不只用颜色传递信息，附加图标/文字）；
- i18next 文件化词条，按需加载；
- 日期/数字格式按 locale。

## 8. 主题与设计系统

- **设计 Token**：颜色、字号、间距、圆角、阴影统一；
- **主题切换**：Antd Dynamic Theme + CSS Variables；
- **暗色模式**：预留（M3 开启）；
- **品牌**：主色品牌绿 `#16a34a`，辅助蓝 `#1677ff`；
- **组件库**：
  - 原子组件来自 Antd；
  - 业务组件在 `packages/ui`（KpiCard、FunnelChart、ProfileCard、TagChip 等）。

## 9. 工程规范

### 9.1 代码规范
- ESLint（airbnb + 自定义规则）；
- Prettier 统一格式；
- 类型严格：`noImplicitAny`、`strictNullChecks`；
- Commit：Conventional Commits；
- 分支：trunk-based；
- PR：模板化（变更说明、截图、测试点、风险）。

### 9.2 质量门禁
- 单测覆盖率 ≥ 70%（核心包 ≥ 85%）；
- 构建产物体积预算（每个 chunk ≤ 300KB gzip）；
- Lighthouse CI（主要页面）；
- E2E 核心路径（圈选、旅程、大屏加载）；
- 可访问性 axe-core。

### 9.3 文档
- 组件库 Storybook；
- 页面交互 Figma 对齐；
- 更新日志 Changesets。

## 10. API 契约与数据流

### 10.1 契约
- 后端提供 OpenAPI 3.0 YAML；
- CI 中用 `openapi-typescript` 自动生成 TS 类型 + API Client；
- 契约变更需通过 CI 检查，Breaking Change 升版本。

### 10.2 数据获取
- 列表/详情：TanStack Query（stale-while-revalidate、重试、乐观更新）；
- 实时推送：WebSocket（SignalR 风格的订阅）；
- 大文件：分片下载 + 断点续传。

### 10.3 错误处理
- 全局拦截：401 跳登录；403 提示 + 申请权限；5xx 兜底页；
- 业务错误：按 `code` 展示具体文案；
- 弱网：自动重试（指数退避）+ Offline Banner。

## 11. 安全

- CSP 严格策略：禁 inline script，白名单 CDN；
- SRI（Subresource Integrity）；
- XSS 防御：DOMPurify 处理富文本；
- CSRF：Token + SameSite Cookie；
- 点击劫持：X-Frame-Options / frame-ancestors；
- 敏感操作二次确认（导出 PII、删除标签）；
- 水印：PII 页面叠加当前用户 ID + 时间水印；
- 审计：敏感操作前端埋点 + 后端日志。

## 12. 部署与发布

### 12.1 构建
- Vite / Rsbuild 产物 → OSS/CDN；
- 文件名带 hash，index.html 不缓存，chunk 永久缓存；
- Nginx/BFF 做 history 回退与 gzip/br。

### 12.2 发布流程
- GitLab CI → 构建 → 产物归档 → OSS 上传 → CDN 刷新；
- 多环境：Dev/QA/Staging/Prod；
- 灰度：按用户 ID 分片，或路径级 A/B；
- 回滚：版本目录保留，秒级切回。

### 12.3 配置
- 运行时配置通过 `/config.json` 注入（避免重新构建）；
- 不同环境注入不同 BFF 地址、埋点 Key。

## 13. 浏览器兼容

- Chrome / Edge 最近 2 版；
- Safari 最近 2 版；
- 不支持 IE。
- 不足时降级为"请升级浏览器"引导页。

## 14. 第 1 期（MVP）前端排期

| 周次 | 工作项 |
|---|---|
| W1 | 脚手架、Mono-repo、CI/CD、Mock、Storybook |
| W2 | 账号登录、权限、路由、Shell 布局 |
| W3 | 标签树、圈选条件构造器 v1 |
| W4 | 圈选预估/保存/导出；BFF 聚合 |
| W5 | 旅程画布 v1（Send + Wait + Dispatch）；基础素材库 |
| W6 | 销售工作台：线索池、客户 360、跟进 |
| W7 | 简单经营看板（4 核心指标 + 漏斗） |
| W7 | 权限页面、审计查询 |
| W8 | 性能压测、E2E、修 Bug、灰度上线 |

## 15. 第 2/3 期增量

- 第 2 期：
  - 旅程画布完整节点（条件、A/B、Webhook）；
  - 实验平台 UI；
  - 画像前端升级（搜索、血缘图）；
  - 大屏完整版（实时推送）。
- 第 3 期：
  - 投放中心、Lookalike、归因可视化；
  - SDR 智能派单看板；
  - 多租户/多品牌切换；
  - 多语言。

## 16. 风险

- Antd 升级断层：锁大版本 + 升级计划；
- React Flow 大图性能：节点 > 200 需自定义渲染；
- 大屏在 4K 终端的字体/图层：预留 Zoom 层；
- PII 泄漏：严格 BFF 字段过滤 + 水印 + 审计；
- 组件库跨门户复用冲突：Storybook 可视化约束。
