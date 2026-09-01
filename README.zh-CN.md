# 适用于 TypeScript 与 FastAPI 的 Stripe 订阅、权益和积分包

[English](README.md) | **简体中文**

[![CI](https://github.com/ToseaAI/stripe-entitlements/actions/workflows/ci.yml/badge.svg)](https://github.com/ToseaAI/stripe-entitlements/actions/workflows/ci.yml)
[![License](https://img.shields.io/badge/license-Apache--2.0-blue.svg)](LICENSE)
[![Python](https://img.shields.io/badge/python-3.12%2B-3776AB.svg)](pyproject.toml)
[![Node](https://img.shields.io/badge/node-22%2B-339933.svg)](typescript/package.json)

一个开源的 Stripe 计费、SaaS 权益和积分账本起步项目，同时提供两种原生后端：
TypeScript/Node/Next.js 与 Python/FastAPI。两者都使用 PostgreSQL，并遵循同一套经过
评审的记账契约。项目包含月付/年付订阅、精确小数积分、一次性积分包、两种可选升级
策略、Hosted Checkout、退款、争议、SCA 恢复、Test Clock 续费，以及能应对重复、
延迟、并发和乱序事件的 webhook 权威记账流程。

> 本项目是独立的社区项目，不是 Stripe 官方产品。它是一份参考实现，不是适用于所有
> SaaS 的通用计费框架，也不构成财务、税务、会计或法律建议。

> **当前发布状态：** `main` 包含 `0.4.0` 候选版本，但 `v0.4.0` tag 和
> `@tosea/stripe-entitlements@0.4.0` 尚未发布。在正式发布这些渠道之前，请使用经过
> 评审并固定提交哈希的源码、Git/path 依赖、vendored 副本或本地构建的 tarball；
> 不要把旧 tag 或旧包当作等价代码。本项目仍是 pre-1.0 的新参考实现，目前没有已
> 记录的第三方生产使用者；自动化测试和 Stripe 测试模式证据不等于第三方生产验证。

<a id="start-here"></a>

## 从这里开始

先按宿主应用选择路径，链接中的指南才是完整的配置和验证步骤：

| 目标 | 从这里开始 |
| --- | --- |
| 使用原生 Next.js/TypeScript 计费 | [TypeScript 源码、Git vendor 或 tarball](typescript/README.md#requirements) |
| 接入 Python/FastAPI 服务 | [快速开始](#quick-start)，再阅读[接入指南](docs/ADOPTION.md#compose-the-fastapi-application) |
| 部署真实 Stripe 测试模式环境 | [首次真实部署](docs/DEPLOYMENT.md) |
| 分享不连接 Stripe/数据库的 UI 链接 | [无凭据公开模拟](docs/AI_BUILDERS.md#publish-a-ui-only-simulation) |

两种后端都不依赖 registry 已发布版本。[固定 Git 提交与最小 vendoring 指南](docs/ADOPTION.md#consume-a-pinned-git-source-or-vendored-copy)
列出了 Python/TypeScript 源码、SQL、套餐目录、构建和升级边界。TypeScript 源码方式
仍然要用 npm 或兼容的 JavaScript 包管理器安装第三方依赖并构建 `dist/`；它只是
不从公共 registry 下载当前尚未发布的本项目 npm 包。

不要根据仓库曾经的名称或根目录 Python manifest 判断项目技术栈。两个后端目录都
包含完整的服务端计费代码，参考 Web 同时包含真正的 Node Route Handlers 与页面：

```text
src/stripe_entitlements/   Python/FastAPI 后端
typescript/src/            独立的 TypeScript/Node 后端
typescript/src/next/       Next.js App Router 适配层
web/app/                   SSR UI、API、webhook、健康检查、metadata、robots 与 sitemap
```

<a id="contents"></a>

## 目录

- [已实现与未实现的范围](#implemented-scope)
- [选择 Python 或 TypeScript](#choose-runtime)
- [编码前选择订阅流程](#choose-subscription-flow)
- [套餐目录与年付优惠](#plan-catalog)
- [一次性积分包](#credit-packs)
- [两种套餐变更模板](#plan-transitions)
- [正确性与分布式部署](#correctness-model)
- [可选 Vercel 部署](#vercel-deployment)
- [v0、Lovable 与公开模拟](#ai-builders)
- [快速开始](#quick-start)
- [接入现有应用](#adoption)
- [演示录制](#demo-recording)
- [测试证据边界](#verification)
- [SQL 与生产切换](#migrations)
- [仓库结构](#repository-map)
- [常见问题](#faq)

<a id="why-this-project"></a>

## 为什么需要这份 Stripe 计费参考实现

很多 Stripe 示例到创建 Checkout 或验证 webhook 签名就结束了。真实 SaaS 计费还要
经受重复与乱序事件、并发 worker、未知远端结果、年付积分重置、升级支付失败、退款，
以及早于权益投影到达的浏览器返回。本仓库把这些状态变化显式化，并用 PostgreSQL
约束和真实 Stripe 测试模式关口验证它们。

它适合需要可评审参考、而不只是一段 Checkout 粘贴代码的 FastAPI Stripe 集成、
TypeScript/Next.js 计费后端、订阅积分系统或 SaaS 套餐页。

<a id="choose-runtime"></a>

## 选择 Python 或 TypeScript

仓库包含两个相互独立的服务端实现。TypeScript 不会把请求转发给 Python，Python
也不会调用 Node：

| 运行时 | 适用场景 | 入口 |
| --- | --- | --- |
| Python 3.12+ / FastAPI | 现有 Python API、sidecar、容器或 Vercel Services 拆分部署 | `stripe_entitlements`、`create_app`、`install_billing`、Python CLI |
| Node 22+ / TypeScript | Next.js App Router、独立 Node 计费服务或其他 Fetch 兼容宿主 | `@tosea/stripe-entitlements`、Node CLI、Fetch handler、Next Route Handler |

两种实现共享规范化的 [`plans.toml`](plans.toml)、PostgreSQL
[`001_v3_baseline.sql`](migrations/001_v3_baseline.sql) 与追加式
[`002_stripe_request_snapshots.sql`](migrations/002_stripe_request_snapshots.sql)、
定点积分协议、状态转移矩阵、webhook 契约和文档化不变量。两个语言都会运行相同的
golden policy vectors；Python/TypeScript 混合 PostgreSQL 测试还证明，同一个幂等键
无法重复扣费或超额消费。

正常部署只选择一个后端运行时。不要把任意包版本混成可互换的副本：所有 API、
webhook 和 worker 进程必须使用兼容的 migration 级别、一致的套餐目录、Stripe
模式/版本契约、产品线和变更策略。详见 [TypeScript 指南](typescript/README.md)。

<a id="choose-subscription-flow"></a>

## 编码前先选择订阅流程

先一次性回答这些问题：付费主体是个人还是团队、哪个运行时负责后端、有哪些套餐与
权益、使用哪一种升级策略、是否需要年付、积分包、Portal 和调度器；同时确认真实
身份提供方、PostgreSQL 17 或 18 数据库、稳定的测试域名，以及目标究竟是 UI 模拟、
Stripe 测试环境还是获批的生产环境。

实现中的生命周期不是靠一个笼统的 “subscription changed” 回调直接开通权限：

| 操作 | 已实现机制 |
| --- | --- |
| 首次订阅 | Stripe Hosted Checkout；只有签名验证通过的 `invoice.paid` 完成投影后才开通权益 |
| 升级 | 应用内 preview/confirm；选择 `full_period_reset` 或 `prorated_delta` |
| 降级、源自年付的变更或不支持的周期切换 | 使用 Subscription Schedule 在当前周期结束时生效 |
| 取消 | 使用专门的 Portal 配置，在周期结束时取消 |
| 续费 | 由已支付 Invoice 投影；年付套餐按月释放积分 |
| 一次性积分 | Hosted Checkout 加上精确的 `payment_intent.succeeded` 投影 |

Portal 中禁用价格变更，避免绕开项目选定的升级策略。Stripe 管理支付对象与托管页面；
本项目管理 PostgreSQL 中的权益投影；宿主应用仍须管理已验证登录/团队成员关系、业务
实体和服务端权限执行。[首次部署指南](docs/DEPLOYMENT.md)包含完整职责表、Agent 应先
询问的问题、域名/webhook 两阶段配置、环境边界和故障诊断。

<a id="implemented-scope"></a>

## 已实现与未实现的范围

项目完整实现了两个边界明确的套餐变更模板：

- `full_period_reset`：立即按目标套餐全价开启一个新周期，不做按比例计费；
- `prorated_delta`：保留当前月付周期，支付按比例计算的差价，并增加套餐目录中定义的
  权益差额。

对内置的三个档位和月/年两种周期，两套完整的 6 × 6 矩阵由一个环境变量选择，并按
每个 intent 持久化。共同范围包括：

- 一个订阅 item、一种货币（USD）；
- 任意非空且 key 稳定的套餐集合，每个套餐都有月付和年付；内置 Starter、Pro、Ultra；
- 零个或多个使用银行卡支付的一次性 USD 积分包，具有独立有效期和来源可追踪退款；
  内置三个积分包；
- 精确到 `0.000001` 的产品积分，以整数 atoms 存储而不是浮点数；
- 年付 Invoice 最多为 12 个按月积分批次提供资金，而不是购买时一次发完；
- 首次订阅 Checkout，以及需要认证的套餐、账户、Checkout、Portal、preview、confirm API；
- FastAPI 的独立 `create_app()` 与可组合的 `BillingKernel` / `install_billing`；
- 独立的 TypeScript `BillingKernel`、Fetch facade、Node server/CLI 与 Next.js App Router 集成；
- 严格的个人/团队 JWT 身份 starter，含只可查看套餐的团队 viewer；
- 进程内 `EntitlementService` 与可选的、受 owner 授权保护的内部 workload API；
- 服务端控制的套餐变更、Stripe Invoice preview 与 Subscription Schedule；
- 用于定价、账户状态、支付恢复和 webhook 成功轮询的 Next.js 参考 UI；
- Next.js、FastAPI 和受保护定时任务共域名的 Vercel Services 部署，不依赖 Railway；
- PostgreSQL 事件/业务幂等、行锁、持久套餐变更 intent、跨 Invoice 资金归属、
  退款/争议收敛和 fail-closed incident；
- 可运行的 Job + billing outbox + dispatch outbox + fencing 示例；
- webhook 丢失后根据精确 Session、PaymentIntent 和 Charge 身份进行积分包对账。

项目**没有**实现多币种、席位/数量、试用、优惠券、税费计算、计量计费、任意混合
Invoice item、收入确认、会计或托管身份提供方。宿主应用必须提供已验证认证和产品侧
权限执行。详见[架构](docs/ARCHITECTURE.md)、[不变量](docs/INVARIANTS.md)、
[精确小数积分](docs/CREDIT_PRECISION.md)和[接入指南](docs/ADOPTION.md)。

<a id="plan-catalog"></a>

## 套餐目录与年付优惠

价格来自 [plans.toml](plans.toml)。档位身份和升降方向由稳定的套餐 key 与明确的 rank
决定，绝不通过价格比较决定。

修改规范化文件后，用宿主已经选择的运行时生成公开价格快照；任何一种路径都不要求
安装另一种运行时：

```bash
# Python/FastAPI 源码流程，在仓库根目录运行
uv run python scripts/sync_reference_catalog.py
uv run python scripts/sync_reference_catalog.py --check

# 原生 TypeScript/v0 源码流程
cd typescript
npm run sync:catalog
npm run sync:catalog -- --check
```

两个命令都会校验 `plans.toml`，并确定性地产生相同的
`web/reference-catalog.json`；`--check` 只检查漂移，不写文件。

| 套餐 | 月付 | 年付总价 | 年付折算月价 | 年度节省 | 每月积分 |
| --- | ---: | ---: | ---: | ---: | ---: |
| Starter | $19 | $137 | $11.42/月 | $91 | 300 |
| Pro | $49 | $353 | $29.42/月 | $235 | 1,000 |
| Ultra | $149 | $1,073 | $89.42/月 | $715 | 4,000 |

年付节省额按 12 次月付与明确的年付总价比较。套餐目录允许年付总价低于、等于或高于
月付总和，因为定价是产品决策。只有同币种且年付确实更便宜时，UI 才显示节省金额；
年付相同或更贵时不宣称优惠。该展示计算永远不决定档位方向或变更时机。年付订阅的
积分仍按月发放。

内置年付价约比 12 次月付低 40%。这是明确的年价设计，不是 Stripe Coupon 或
Promotion Code。优惠券、试用和限时活动不在当前实现范围内；Checkout Session 始终
不设置 `allow_promotion_codes`，所以托管 Checkout 不会显示优惠码输入框。未来支持
优惠码前必须满足的关口记录在[优惠码与优惠券](docs/PROMOTION_CODES.md)。

| 权益 | Starter | Pro | Ultra |
| --- | ---: | ---: | ---: |
| PDF → PPT / 图片 → PPT | 是 | 是 | 是 |
| 批量转换 | 否 | 是 | 是 |
| API 访问 | 否 | 是 | 是 |
| 优先队列 | 否 | 否 | 是 |
| 最大文件大小 | 30 MB | 100 MB | 250 MB |
| 单任务最大页数 | 100 | 500 | 2,000 |
| 并发任务 | 1 | 5 | 20 |
| API key 数量 | 0 | 5 | 25 |

API 会返回结构化权益，但产品代码仍要实际执行限制；展示权益不等于执行权益。

内置档位是累积式的，但解析器不会强迫采用者使用这种产品设计。套餐可以没有 feature
或数值 limit，更高 rank 也可以用一项权益交换另一项。只有 rank 定义升级/降级方向。
在 `prorated_delta` 下，如果更高 rank 的月付变更没有正积分差额，会安全地安排在
周期结束时，而不会尝试差价结算。

`monthly_credits` 是从套餐顶层值合成的保留权益名，不能同时出现在 `features` 或
`limits`。其他 feature 与数值 limit 共用一个全局命名空间：同一个 key 不能在某个
套餐里是 feature、在另一个套餐里又是 limit，从而保证下游值类型稳定。

<a id="credit-packs"></a>

## 一次性积分包

积分包只增加可消费的产品积分，不增加套餐 feature、不提高 limit，也不改变订阅档位。

| 积分包 | 价格 | 积分 | 默认有效期 |
| --- | ---: | ---: | ---: |
| Boost 100 | $15 | 100 | 365 天 |
| Boost 500 | $59 | 500 | 365 天 |
| Boost 2,000 | $199 | 2,000 | 365 天 |

积分包通过 Stripe Hosted Checkout 的 `mode=payment` 购买，参考契约明确只允许银行卡，
避免 Dashboard 自动支付方式静默增加未经测试的结算通道。只有通过签名验证且身份精确
匹配的 `payment_intent.succeeded` 才创建资金 lot；浏览器返回和
`checkout.session.completed` 都不会发积分。

产品扣款使用 FEFO 分配到确切的订阅或积分包来源。部分现金退款、争议、过期、产品
退款，以及从未来资金中偿还债务都保留可追踪性，并能在任意事件顺序下收敛。详见
[积分包与多来源资金](docs/CREDIT_PACKS.md)。宿主产品代码只使用 Checkout/router/
`EntitlementService` facade，不需要直接查询或协调内部四张积分包记账表。

<a id="plan-transitions"></a>

## 安全的套餐变更：全价新周期或按比例差价

缩写由套餐与周期组合：`SM` 表示 Starter Monthly，`SY` 表示 Starter Yearly，依此类推。

API 启动前设置 `BILLING_TRANSITION_POLICY=full_period_reset` 或
`prorated_delta`。健康检查、套餐、账户、preview 和 confirm 响应都会暴露当前模式，
每个 intent 也会持久化该模式。

读表方法：从左侧找到用户**当前套餐**，再沿着这一行找到顶部的**目标套餐**。
`—` 表示无需变更；**立即**表示现在发起付款，只有对应 Invoice 支付成功后权益才切换；
**周期末**表示现在保持原套餐并安排变更，到期后的权益仍以 paid Invoice 为准。

### 模板 A：立即开启目标套餐的全价新周期（`full_period_reset`）

适合“升级后立刻开始一个全新周期”的产品。用户现在支付目标套餐全价，旧套餐未使用的
时间不抵扣。

| 当前套餐 ↓ / 目标套餐 → | Starter<br>月付 (SM) | Starter<br>年付 (SY) | Pro<br>月付 (PM) | Pro<br>年付 (PY) | Ultra<br>月付 (UM) | Ultra<br>年付 (UY) |
| --- | --- | --- | --- | --- | --- | --- |
| **Starter 月付 (SM)** | — | **立即**<br>目标全价 | **立即**<br>目标全价 | **立即**<br>目标全价 | **立即**<br>目标全价 | **立即**<br>目标全价 |
| **Starter 年付 (SY)** | **周期末** | — | **周期末** | **周期末** | **周期末** | **周期末** |
| **Pro 月付 (PM)** | **周期末** | **周期末** | — | **立即**<br>目标全价 | **立即**<br>目标全价 | **立即**<br>目标全价 |
| **Pro 年付 (PY)** | **周期末** | **周期末** | **周期末** | — | **周期末** | **周期末** |
| **Ultra 月付 (UM)** | **周期末** | **周期末** | **周期末** | **周期末** | — | **立即**<br>目标全价 |
| **Ultra 年付 (UY)** | **周期末** | **周期末** | **周期末** | **周期末** | **周期末** | — |

月付套餐可以立即升到任意周期的更高档位，也可以在同档位从月付转年付；降级与所有
年付来源变更在周期结束时生效。立即执行会使用 `billing_cycle_anchor=now` 与
`proration_behavior=none`，目标 Invoice 支付后重置月度积分池。

### 模板 B：立即支付剩余周期差价（`prorated_delta`）

适合最常见的“月付套餐中途升级”。Stripe 先抵扣旧套餐未使用的时间，再按相同剩余时间
计算目标套餐费用，因此用户现在只支付净差价。

| 当前套餐 ↓ / 目标套餐 → | Starter<br>月付 (SM) | Starter<br>年付 (SY) | Pro<br>月付 (PM) | Pro<br>年付 (PY) | Ultra<br>月付 (UM) | Ultra<br>年付 (UY) |
| --- | --- | --- | --- | --- | --- | --- |
| **Starter 月付 (SM)** | — | **周期末** | **立即**<br>按比例差价 | **周期末** | **立即**<br>按比例差价 | **周期末** |
| **Starter 年付 (SY)** | **周期末** | — | **周期末** | **周期末** | **周期末** | **周期末** |
| **Pro 月付 (PM)** | **周期末** | **周期末** | — | **周期末** | **立即**<br>按比例差价 | **周期末** |
| **Pro 年付 (PY)** | **周期末** | **周期末** | **周期末** | — | **周期末** | **周期末** |
| **Ultra 月付 (UM)** | **周期末** | **周期末** | **周期末** | **周期末** | — | **周期末** |
| **Ultra 年付 (UY)** | **周期末** | **周期末** | **周期末** | **周期末** | **周期末** | — |

只有保持月付、目标为更高档位且积分差额为正时才立即结算。例如 Starter Monthly →
Pro Monthly 时，由 Stripe 收取剩余周期的净差价，并增加固定的
`1,000 - 300 = 700` 积分，同时保留当前周期和未使用余额。月/年转换、降级和所有
年付来源变更仍在周期结束时生效。

差价 webhook 会读取 Invoice 的全部分页 line，要求同一比例下有一个来源负向 proration
和一个目标正向 proration，并保存跨 Invoice 的资金分配。税费、折扣、Customer balance、
credit note、未知/缺失 line 或不一致周期都会 fail closed。部分退款会按比例收回差额；
关闭叶子升级会退回仍有资金支持的来源状态，关闭来源/中间 lineage 会撤销强制权益并
等待修复。

以上两张表是内置套餐面向用户的完整 6 × 6 决策矩阵。精确的 Invoice 接受规则、
自定义套餐注意事项、退款语义和失败行为见[套餐变更策略](docs/PLAN_TRANSITIONS.md)。

<a id="correctness-model"></a>

## 正确性模型

- **至少一次投递、PostgreSQL 效果上等价一次。** 项目不宣称不可能实现的端到端
  exactly-once 投递。
- 在解析 JSON 前对原始请求体做 Stripe 签名验证。Stripe Event ID 防止重复投递；
  `(stripe_invoice_id, grant_slot)` 独立防止另一事件或 worker 重复发放同一业务积分。
- 资金归属使用精确的 Customer/Subscription、Checkout claim/session，以及从服务端
  拉取并匹配 Price → Product 的套餐身份，不把可变 metadata 当作唯一授权证据。
- 账户行锁串行化余额、发放、退款、取消与套餐变更投影。
- `(event.created, event_rank)` 防止旧或更弱的订阅事件覆盖新状态。
- 即使退款/争议先于 paid grant 到达，也会先持久化事实并最终收敛。
- 积分包订单、资金 lot、扣费分配和 clawback debt 保留精确资金来源。
- 差价分配在退款与争议间保留 source/target Invoice lineage。
- 当前 epoch 的追回超过可用余额时，`billing_clawback_debts` 会保留缺口，并在未来
  同 epoch 产品退款或差价发放变为可用余额之前优先抵扣。
- Checkout 和套餐变更使用持久化、调用方可重放的请求身份与 Stripe 幂等键。
- confirm 会原子地把 preview 移到 `applying`，并在 Stripe 变更前记录
  `remote_started_at`。23 小时内的未知结果只能用相同派生 Stripe key 重试；更久的
  歧义必须停止并等待人工证据。
- paid/payment-failed 事件必须匹配 intent 的 compare-and-set settlement Invoice ID；
  Subscription ID 本身不能把旧失败关联到新 intent。POST 成功响应永远不会直接开通权益。
- 任何返回 2xx 的 fail-closed 决策都必须产生持久状态或 `billing_incidents` 记录。

PostgreSQL 是协调者和可写事实来源。多个 API/worker 进程可以安全共享同一 primary，
但 PostgreSQL 本身仍是有状态依赖；若没有 HA、备份和恢复演练，它仍是单点。详见
[分布式部署](docs/DISTRIBUTED.md)。

<a id="vercel-deployment"></a>

## 使用任一后端部署到 Vercel

仓库中的 [`vercel.json`](vercel.json)把 `web/` 与 Python 计费核心作为两个 Vercel
Services 部署到同一个 URL：浏览器 `/api/*`、Stripe `/webhooks/*` 与 `/health` 由
FastAPI 处理，其余路径由 Next.js 处理。前端使用明确的 `same-origin` sentinel，因此
不需要 Railway URL、跨域 allowlist 或第二个公开部署。

Vercel Cron 调用有界的每小时年付发放和每五分钟对账路由。它们要求 `CRON_SECRET`，
只返回聚合计数，并依赖与多 worker 相同的 PostgreSQL 锁、唯一约束和 lease。部署前
仍要显式执行 schema migration 与 Stripe 套餐 bootstrap。

此方案仍需要托管 PostgreSQL、Stripe 账户/webhook endpoint 和产品真实身份系统。
同源路由不会弱化认证：FastAPI 默认拒绝所有请求，只有完整显式配置后才能启用严格的
个人 JWT/JWKS starter。Preview 部署必须使用隔离的 Stripe 测试资源与数据库，并保持
`noindex`。完整环境矩阵和验证清单见 [Vercel 指南](docs/VERCEL.md)。

纯 TypeScript 部署使用 [`vercel.typescript.json`](vercel.typescript.json)，一个
Next.js service 即可。原生 Route Handlers 负责 `/api/*`、`/webhooks/stripe` 和
`/health`，定时任务也调用 TypeScript services。它不需要 Python、Railway 或常驻的
独立 Node 服务，但仍需要 PostgreSQL、Stripe、真实认证、migration、备份和调度器。

<a id="ai-builders"></a>

## 与 v0、Lovable 和 AI App Builder 配合

只有 Stripe 测试账户也可以搭建真实、受权限控制的测试站：Checkout、Portal、测试卡、
SCA、签名 webhook、退款和 Test Clock 都走 Stripe 真实测试网络，但不会产生真实资金。
项目也提供明确 `noindex` 的公开 `simulation` 模式，用于不能连接 Stripe 或数据库的
纯 UI 分享链接。

v0 可以直接编辑本仓库的 Next.js 视觉层，同时保留原生 TypeScript Route Handlers。
Lovable 可以负责 Vite UI，但真实计费必须通过经过认证集成的独立 Node/FastAPI 服务。
仓库 UI 的 Supabase transport 不是可发布的浏览器包；指南提供一个无依赖、可复制的
[`vite-billing-client.ts`](examples/browser_adapters/vite-billing-client.ts)。无论哪种方式，
secret key、webhook 验签、PostgreSQL 与权益投影都必须留在服务端。详见
[AI Builder 与测试站指南](docs/AI_BUILDERS.md)。

<a id="api-auth"></a>

## API 与认证边界

需要认证的计费路由：

| 方法 | 路由 | 用途 |
| --- | --- | --- |
| GET | `/api/catalog` | 有序价格与结构化权益 |
| GET | `/api/account` | webhook 投影后的套餐、积分、执行与 pending 状态 |
| POST | `/api/checkout` | 首次付费订阅；要求 `Idempotency-Key` |
| POST | `/api/credit-packs/checkout` | 一次性积分包 Checkout；要求 `Idempotency-Key` |
| POST | `/api/billing/portal` | 安全的 Portal Session；要求 `Idempotency-Key` |
| POST | `/api/billing/change/preview` | 持久化 preview；要求 `Idempotency-Key` |
| POST | `/api/billing/change/confirm` | 确认不透明的 `preview_id` |

TypeScript 宿主可以用 `BillingFetchHandlerOptions.onError` 把原始服务端异常发送到结构化
日志或错误追踪系统，同时向客户端返回净化后的响应。该 callback 必须只在服务端使用，
不得把异常原文写入浏览器可见状态。

两个实现都以 `AuthAccountAdapter` 作为身份集成边界。生产默认是
`RejectAllAuthAdapter`，不会信任浏览器提交的 account ID。`DemoBearerAuthAdapter`
只有在 `APP_ENV=development`、使用 Stripe 测试 key、并且显式配置 demo token 时才启用。
部署前必须替换成经过验证的 session/OIDC/JWT；demo token 不是生产认证。

可选 `auth` extra 提供严格的非对称 JWT/JWKS verifier 与个人/团队 adapter。团队
adapter 会校验已签名 tenant selector 的实时成员关系；viewer 只能读 catalog，账户/
恢复状态和所有 mutation 要求 `billing_admin`。服务端产品权益执行与浏览器计费分开，
可选内部 router 默认拒绝所有 workload 认证和 owner 授权，operation scope 本身不能
允许服务任意选择租户。详见[接入指南](docs/ADOPTION.md)与
[可运行认证 starter](examples/auth_starters/README.md)。

<a id="stripe-versions"></a>

## Stripe API 版本是两份独立契约

- `STRIPE_API_VERSION` 控制主动发出的 SDK 请求；当前代码目标为
  `2026-06-24.dahlia`。
- 每个 webhook Event 都有自己的快照 `api_version`，由 Stripe endpoint/账户契约决定。
  `STRIPE_WEBHOOK_API_VERSION` 必须等于实际 Event 值，是必填启动配置；它不会回退到
  `STRIPE_API_VERSION`。

请求版本不会重写 webhook payload。在四个精确绑定 `f757fcc` 的浏览器关口中，固定到
Dahlia 的隔离测试 endpoint 投递了签名的 `2026-06-24.dahlia` payload，而独立 Event
API 查询显示 `2025-12-15.clover`。不匹配会记录 `webhook_contract_mismatch` 并 fail
closed。项目不会从其中一份版本推断另一份。详见[测试](docs/TESTING.md)、
[Stripe CLI](docs/STRIPE_CLI.md)和[webhook 验证](docs/WEBHOOK_VERIFICATION.md)。

<a id="quick-start"></a>

## 快速开始

完整源码仓库测试要求：Python 3.12+、`uv`、Docker、Node.js 22+、npm、Stripe CLI
和一个 Stripe 测试模式账户。应用流量只需选择一个后端运行时；PostgreSQL、Stripe
套餐、Portal、webhook、身份和调度要求相同。Vercel 只是可选部署适配器；任一后端也
可以运行在 VM、容器平台、Kubernetes 或其他能访问 PostgreSQL 并接收签名 webhook
的 PaaS。Docker 与 Stripe CLI 是默认本地/测试流程所需，不是线上容器依赖。

源码方式应把 `main` 换成经过评审的完整 commit SHA：

```bash
git clone https://github.com/ToseaAI/stripe-entitlements.git
cd stripe-entitlements
git checkout main
```

`stripe-entitlements migrate` 初始化本应用 schema，**不会**把 PostgreSQL 17 升级到
PostgreSQL 18。全新的 Neon PostgreSQL 18 只需初始化应用 schema。现有 v0.3 数据库
的 001 → 002 流程见[运维指南](docs/OPERATIONS.md)。

Python/FastAPI 源码流程：

```bash
cp .env.example .env
chmod 600 .env
# 在 .env 中选择 full_period_reset 或 prorated_delta。
docker compose up -d postgres
uv sync --frozen
uv run --env-file .env stripe-entitlements migrate
```

### 各进程需要的环境配置

| 进程或功能 | 必需配置 |
| --- | --- |
| 只执行 schema migration | `DATABASE_URL`；pool 上下限可选 |
| API/webhook/worker | `DATABASE_URL`、`STRIPE_SECRET_KEY`、`STRIPE_WEBHOOK_SECRET`、实际的 `STRIPE_WEBHOOK_API_VERSION` |
| 受保护的浏览器计费 | 宿主提供的 `AuthAccountAdapter`，或完整兼容的 JWT/JWKS starter；否则受保护路由有意返回 401 |
| Customer Portal | `STRIPE_PORTAL_CONFIGURATION_ID`；缺少它不影响其余服务启动 |
| 参考 UI 套餐变更/SCA | 同一测试账户的 `NEXT_PUBLIC_STRIPE_PUBLISHABLE_KEY`；首次 Hosted Checkout 和 Portal 跳转不需要它 |
| 年付发放与对账 | 调度器；只有内置 Vercel Cron 路由要求 `CRON_SECRET` |
| 生产跳转/CORS | 部署专属的 Checkout、Portal、`FRONTEND_ORIGINS` HTTPS 值 |
| SEO 公开收录 | 规范的 `NEXT_PUBLIC_SITE_URL` 加显式 `NEXT_PUBLIC_ALLOW_INDEXING=true`；preview 应禁用 |

`STRIPE_API_VERSION`、套餐/产品 ID、变更策略、pool 设置和本地 URL 有默认值。生产环境
必须评审它们，但它们不是仅启动参考实现就额外要求的密钥。migration 只读取数据库
连接与 pool 配置，生产上应为 schema-init Job 注入最小数据库密钥，而不是完整 Stripe
凭据。

bootstrap 前，在忽略的 `.env` 中替换测试 secret key、本地 demo 值、product line、
lookup prefix、套餐路径与变更策略。Portal ID 和 webhook secret 只有执行后续步骤才能
获得真实测试值。Hosted Checkout 与 Portal 不需要 publishable key；参考 UI 的 Stripe.js
套餐变更/SCA 需要。后端 secret、Stripe CLI 登录和浏览器 publishable key 必须属于同一
Stripe 测试账户。

```bash
uv run --env-file .env python scripts/bootstrap_stripe.py
uv run --env-file .env python scripts/bootstrap_stripe.py --verify-only
```

把 bootstrap 输出的真实 Portal configuration ID 写入被忽略的 `.env`。然后在另一个
终端启动签名转发：

```bash
stripe login
stripe listen \
  --events checkout.session.completed,checkout.session.expired,invoice.paid,invoice.payment_failed,customer.subscription.updated,customer.subscription.deleted,charge.refunded,charge.dispute.created,payment_intent.succeeded \
  --forward-to http://127.0.0.1:8000/webhooks/stripe
```

把临时 signing secret 写入被忽略的 `.env` 后再启动 API。`STRIPE_WEBHOOK_API_VERSION`
必须来自 listener 或 endpoint 实际签名 payload，不能从 `STRIPE_API_VERSION` 复制。
未知时按[本地发现流程](docs/ADOPTION.md#discover-a-local-stripe-cli-payload-version)
诊断一次，再更新 `.env` 并重启。

运行只读 preflight：

```bash
uv run --env-file .env stripe-entitlements doctor
uv run --env-file .env stripe-entitlements doctor --profile portal
uv run --env-file .env stripe-entitlements doctor --profile portal --stripe-network
```

`doctor` 默认不访问 Stripe，只检查本地包、套餐、配置、PostgreSQL schema 与 migration
checksum，也不会输出密钥或 DSN。`--stripe-network` 必须显式开启，并增加只读的 Stripe
Account/套餐/Portal 校验；它仍不能证明生产认证、调度器、endpoint metadata 或签名投递。

```bash
uv run --env-file .env \
  uvicorn stripe_entitlements.app:create_app --factory --port 8000
```

原生 TypeScript/Node 源码流程：

```bash
cd typescript
npm ci
npm run build
cp .env.example .env
chmod 600 .env
# 设置 BILLING_TRANSITION_POLICY。
set -a
. ./.env
set +a
npx --no-install stripe-entitlements migrate
npx --no-install stripe-entitlements doctor
npx --no-install stripe-entitlements serve
```

源码 checkout 必须显式 build，因为生成的 `dist/` CLI 不提交到 Git；本地打包的 `.tgz`
已经包含它们。Node server 在 8000 端口暴露相同路由。纯 Next.js 后端可以使用内置
Route Handlers 与 `vercel.typescript.json`，完全不启动 FastAPI。完整说明见
[TypeScript 指南](typescript/README.md)。外部 Next.js 应使用固定 submodule、本地
`file:` 依赖或本地构建 `.tgz`，不要安装目前不存在的 npm registry 版本。

参考前端：

```bash
cd web
npm ci
cp .env.example .env.local
chmod 600 .env.local
npm run dev
```

默认配置使用显式 mock 数据，不连接后端。HTTP 模式需要按
[接入指南](docs/ADOPTION.md#connect-or-replace-the-nextjs-frontend)配置并提供匹配 auth
adapter。UI 不会把 Checkout return、confirm 成功或 SCA 完成当作权益证据；它会轮询
`/api/account`，直到 webhook 投影与目标一致。默认 allowlist 下请使用
`http://localhost:3000`，不是不同 Origin 的 `http://127.0.0.1:3000`。

`stripe trigger invoice.paid` 生成的事件没有匹配本仓库账户，因此预期会产生一个持久
unknown-account incident；它只能验证传输/签名，不是权益生命周期测试。

<a id="adoption"></a>

## 接入现有应用

写认证 adapter 前先确定付费主体。个人计费通常把不可变宿主 user ID 映射到
`external_ref`；团队计费映射经过验证的 organization/tenant ID。email 与浏览器提交的
account ID 永远不是所有权依据。

两个后端都提供 auth protocol、account resolver、计费 HTTP API 与原子积分操作，还提供
个人/团队 JWT starters、`BillingKernel` / `BillingServices`、原生 `APIRouter` installer、
`EntitlementService` 和可选内部 workload router。宿主仍负责 issuer/session、tenant
成员数据、workload → owner 授权、产品 limit 执行，以及协调 Job 与积分扣除/退款的持久
工作流。`CreditService` 与宿主 Job insert 不是同一事务，生产任务准入必须使用幂等
outbox/saga；完整可运行实现见 [`examples/job_outbox/`](examples/job_outbox/README.md)。

独立 FastAPI 使用 `create_app(..., auth_adapter=...)`。现有 FastAPI 根应用构建
`BillingKernel`，再在 startup 前调用 `install_billing(app, kernel, prefix="/stripe")`。
installer 会组合现有 lifespan、复用且不接管宿主 pool、把带 prefix 的路由加入 OpenAPI，
并只对计费路由应用 CORS/Origin 与响应加固，不改变无关路由或全局日志。

Node/Next.js 使用带宿主 `AuthAccountAdapter` 的 `createBillingRuntime({ auth })`，或配置
严格个人 JWT/JWKS 环境 starter 后把 Route Handlers 委托给
`environmentNextBillingRouteHandler`。团队部署注入带实时 membership repository 的
`TeamJwtAuthAdapter`。一个 `Database` 只能绑定一个 kernel，避免一个 lifecycle 错误
关闭另一个 kernel 的 pool。

积分支持六位精度且不使用二进制浮点。Python 传给 `CreditService` 的整数仍表示完整积分；
小数使用十进制字符串或 `Decimal`。HTTP 响应同时返回规范十进制字符串、atom 字符串与
`scale=1000000`，JavaScript 不会用有损 `number` 作为账本事实。完整接入、认证、产品
检查、调度器和宿主契约测试见[接入指南](docs/ADOPTION.md)。

<a id="demo-recording"></a>

## 演示录制与宣传视频

无需 Stripe 即可录制确定性的公开站点/价格/账户演示：

```bash
PROMO_STEP_PAUSE_MS=1400 scripts/run_promo_ui.sh
```

真实浏览器 runner 还能录制 Stripe **测试模式**中的拒付、Checkout 3DS、签名 webhook
投影、套餐 preview、升级 SCA 和最终账户状态：

```bash
E2E_TRANSITION_POLICY=prorated_delta \
E2E_RECORD_VIDEO=1 \
E2E_DEMO_PAUSE_MS=1200 \
scripts/run_browser_e2e.sh
```

默认 transport 创建临时、版本固定的 Webhook Endpoint，是 release evidence 模式。
`E2E_WEBHOOK_TRANSPORT=stripe_cli` 适合 Quick Tunnel 不可用时的本地诊断和录制，但不能
证明 endpoint metadata 或 endpoint 专属版本固定。

```bash
scripts/build_promo_video.sh
scripts/review_promo_video.sh
```

视频构建器会遮盖支付字段，产物写到被忽略的 `web/test-results/promo-final/`。原始浏览器
产物保持忽略与私密；review 会逐帧解码并检查音画同步、黑屏、codec、响度、敏感 OCR
词与场景字幕。详见[演示视频指南](docs/DEMO_VIDEO.md)。

<a id="verification"></a>

## 验证与证据边界

证据按执行层区分。曾经运行过测试或保留旧结果，不能证明当前工作树仍通过 Stripe 网络。

计费核心与 Stripe 网络一致性关口绑定到干净提交
`f757fcce4aeb1194b3db04f87579e8f5ef169058`；其 tree 与之后 squash 合并的 `89646e5`
完全一致。GitHub Actions [run 33283480383](https://github.com/ToseaAI/stripe-entitlements/actions/runs/33283480383)
通过 Backend、TypeScript core、Container 与 Web：

- Python 通过 Ruff、Mypy、版本检查、依赖审计和 1,257 个无网络测试，另有 10 个
  `real_stripe` 用例被默认排除；
- TypeScript 通过格式、lint、类型、build、两种 npm audit 与 50 个文件中的 816 个测试；
- 干净 Web archive/install 通过 lint、类型、生产 build、两种 npm audit 与 208 个测试；
- Python 与 TypeScript 各自通过全部 10 个 Stripe **测试模式**真实对象用例；
- 两个运行时分别对两种变更策略完成四条生产 build 浏览器链路，使用临时签名 endpoint，
  最终均为 Pro/1,020，并完成数据库/endpoint/对象清理；
- Wheel/sdist/npm artifact、全新与 v0.3 → v0.4 migration，以及 UID/GID 10001、
  read-only root 容器关口通过。

这些临时 endpoint 投递的是签名 `2026-06-24.dahlia` payload，独立 Event API 视图则是
`2025-12-15.clover`。它们是测试模式证据，**不宣称验证了生产 webhook payload**。
后续代码变化必须重跑受影响关口，不能继承旧提交结果。

默认 CI：

```bash
uv sync --frozen
uv run python scripts/check_release_versions.py
uv run ruff format --check .
uv run ruff check .
uv run mypy src
uv run pytest -m "not real_stripe"
uv audit

cd typescript
npm ci
npm audit --omit=dev
npm audit
npm run check

cd ../web
npm ci
npm audit --omit=dev
npm audit
npm run lint
npm run typecheck
npm test
npx playwright install --with-deps chromium
npm run test:e2e:simulation
npm run build
```

默认 backend suite 使用一次性 PostgreSQL 17 容器，覆盖事务、锁、约束、重复/乱序事件、
退款、年度 worker 并发、Checkout、套餐 intent lease、API 响应与 fail-closed。PostgreSQL
18 另做新 schema、幂等重放、readiness 与重点事务兼容测试。两者都受支持，但证据层级
分开报告，不假装完整矩阵运行了两遍。

可选 `real_stripe` suite 会拒绝 live key。当前十个测试覆盖隔离的真实测试模式
Product/Price/Customer/Subscription、月付 Invoice 发 300 积分、$9.50 半额退款收敛到
150、一次性积分包与退款 lineage、两种月付升级策略、年付来源延后变更、失败支付与 SCA、
Test Clock 跨年续费、幂等对象创建/清理和 Event + PostgreSQL 投影。两个运行时在
`f757fcc` 上全部通过；直接 Event polling 不等于签名 endpoint 投递。

浏览器 runner 会创建临时测试 endpoint，执行拒付 → 3DS → 签名 webhook → 浏览器升级
→ 第二次 paid 投影，并应分别对两种策略运行。年度时间跳跃使用
`scripts/run_test_clock_e2e.sh`；浏览器/transport 使用 `scripts/run_browser_e2e.sh`。
跳过或只跑一半都不能作为证据。完整边界见[测试指南](docs/TESTING.md)。

<a id="migrations"></a>

## SQL migration 与生产切换

`stripe-entitlements migrate` 按顺序应用完整 migration bundle。全新 0.4.0 数据库应用
`001_v3_baseline.sql` 与 `002_stripe_request_snapshots.sql`；现有 v0.3 只应用原子追加的
002。baseline 创建十四张正确性表、最终约束、部分唯一保护、协调索引、不可变 Invoice
归属和带因果时间的 incident；002 为订阅 Checkout claim、积分包订单与套餐 intent
增加有版本的 JSON 请求快照，不为旧行编造事实。

这里的 **migration 是应用 schema 初始化/演进**，与 PostgreSQL 17 → 18 服务器升级无关。
新的 PostgreSQL 17 和 18 都从 001、002 开始；只有已经存在旧版本应用 schema 的数据库
才需要版本间切换。

migration 只加载 `DATABASE_URL` 和可选 `DATABASE_POOL_*`。这允许最小权限 schema-init
Job 不持有 Stripe key 或 webhook secret；API/worker 仍需要各自完整运行配置。

这是刻意的 pre-1.0 lineage reset：v0.3 不能升级由公开 v0.2.x tag 初始化的数据库；
应重建旧开发、demo 和 staging 数据库。不要编辑 `schema_migrations` 绕过双向 fail-closed
保护。发布 baseline 后其 checksum 不可变，未来 schema 必须追加 002 及后续文件。

002 DDL 是追加式的，但 v0.3 remote mutation writer 不理解 frozen snapshot，因此不能
混合运行。先停止订阅 Checkout、积分包 Checkout 和套餐变更创建，应用 002，再把所有
writer 替换为 v0.4 后恢复流量。v0.4 已接收请求后，不要在存在 in-flight claim/order/
intent 时把 writer 回滚到 v0.3；应停写并完成对账，或继续向前修复。

生产切换应单独、明确执行：

1. 准备 HA PostgreSQL 并应用 migration；
2. 接入真实认证；默认 fail closed 是有意设计；
3. 用 `--allow-live` bootstrap 并验证 live Product、Price 与 Portal；
4. 创建只订阅支持事件集合的 live webhook endpoint；
5. 从该 endpoint 的真实 Event 快照设置 `STRIPE_WEBHOOK_API_VERSION`，不要与
   `STRIPE_API_VERSION` 混淆；
6. 配置允许的 Checkout/Portal URL 与前端 Origin；
7. 运行后端/前端 CI、测试模式对象形状测试、备份恢复演练、webhook smoke 与支付恢复；
8. 部署年度发放/对账调度器，并对未解决 incident 与 webhook 5xx 告警。

使用[发布检查单](.github/RELEASE_CHECKLIST.md)与[运维指南](docs/OPERATIONS.md)。

<a id="repository-map"></a>

## 仓库结构

- `src/stripe_entitlements/`：独立/可组合 FastAPI、计费与权益 service、processor、gateway、
  worker、认证和套餐变更 coordinator；
- `typescript/`：独立 Node/Next 实现和尚未发布的 npm 源码、Fetch/Route Handler adapter、
  CLI、unit/PostgreSQL/跨运行时/真实 Stripe 测试与接入指南；
- `examples/auth_starters/`：可运行的个人/团队 JWT 入口和团队 membership schema；
- `examples/job_outbox/`：可运行的 Job、billing outbox、queue outbox、retry 和 fencing；
- `migrations/`：按序 PostgreSQL schema；
- `plans.toml`：稳定套餐身份、价格与权益；
- `scripts/bootstrap_stripe.py`：套餐与安全 Portal bootstrap/验证；
- `scripts/run_test_clock_e2e.sh`：真实年度续费/时间跳跃关口；
- `scripts/run_browser_e2e.sh`：真实浏览器与签名 webhook 关口；
- `tests/`：纯逻辑、PostgreSQL 竞态/API 和可选 Stripe 测试模式用例；
- `web/`：Next.js 参考 UI 与 API adapter；
- `docs/`：接入、不变量、架构、测试、运维、SEO 与发布资料；
- `.github/`：CI、贡献模板与发布 metadata。

<a id="faq"></a>

## 常见问题

### 这是 Stripe 官方产品吗？

不是。这是边界明确的独立社区参考实现。Stripe 是支付处理方，PostgreSQL 保存本地权益
与积分投影。

### 支持月付和年付吗？

支持。内置 Starter、Pro、Ultra 都有月付与年付。年付 Invoice 最多为 12 个按月积分
slot 提供资金，可选真实 Stripe suite 包含 Test Clock 跨年续费关口。宿主也可以使用
任意非空、key 稳定的套餐集合。

### 覆盖升级、降级和支付失败吗？

在两套有文档的六状态策略范围内覆盖。可以选择全价开启新周期，或保持月周期、只支付
按比例差价。两者都以已支付 Invoice line 为权威；年付来源变更和降级等待周期结束。
需要认证或银行卡失败时，旧的已付权益会保留，直到目标 Invoice 真正支付。

### 按比例升级如何计算积分？

现金与产品权益分开计算。Stripe 计算剩余周期的来源抵扣和目标收费；匹配的 paid Invoice
验证后，应用固定增加 `target.monthly_credits - source.monthly_credits`。剩余时间变短
只改变应付金额，不改变档位权益差额。

### 支持优惠券、试用、税费或多币种吗？

不支持。这些功能会引入额外 Invoice 形状与策略决策，因此被明确列为非目标，而不是在
没有实现和竞态测试时对外宣传。带折扣 Invoice 会 fail closed，Checkout 始终不启用
`allow_promotion_codes`。未来要求见[优惠码与优惠券](docs/PROMOTION_CODES.md)。

### 可以扣除小数积分吗？

可以。一个积分严格等于一百万个整数 atom，最小支持 `0.000001`。套餐小数使用带引号
十进制字符串，HTTP 使用十进制与 atom 字符串，PostgreSQL 只存整数 atom；权威边界会
拒绝 Python、PostgreSQL、TOML 和 JavaScript 浮点值。

### 支持一次性积分包吗？

支持固定价格、银行卡支付的 USD 积分包，包括 Hosted Checkout、精确资金 lot、FEFO
消费、独立过期、部分/全额现金退款、争议、产品操作退款、跨 epoch debt 与 webhook
丢失对账。积分包不增加订阅 feature 或 limit。增加其他支付方式前必须明确实现并测试
对应结算/退款策略，不能只在 Dashboard 打开开关。

### 多个 API 和 worker 实例可以共享吗？

可以，前提是共享同一个 PostgreSQL primary 和完全一致的配置。正确性依赖数据库锁、
约束、lease 与幂等，而不是进程内存。PostgreSQL 仍需 HA、备份与恢复演练。

### 全栈 SSR Next.js 还需要数据库吗？

真实 Stripe 计费需要。Next.js App Router 不需要单独 FastAPI、Railway 或常驻 Node
服务，因为服务端 Route Handlers 就是后端；但仍需要可写 PostgreSQL 17 或 18 primary。
Stripe 处理资金，PostgreSQL 保存 webhook 幂等、订阅/权益投影、积分 lot、套餐 intent、
年度发放、对账和 incident。只有明确的浏览器本地 `simulation` demo 不需要数据库，
它不是真实 Stripe 集成。

### 可以接入现有 FastAPI 吗？

可以。`BillingKernel` 管理已验证依赖图，`install_billing` 添加可带 prefix 的原生 router
并组合宿主 lifespan。公共计费 middleware 只作用于其路由，宿主已连接的数据库 pool
仍由宿主管理；只有计费作为独立根服务时才使用 `create_app`。

公开站点 metadata、canonical、社交预览、结构化数据与收录检查见
[SEO runbook](docs/SEO.md)。

<a id="non-goals"></a>

## 非目标

- 在 Stripe Checkout、托管 Invoice 或 Stripe.js 以外处理银行卡数据；
- 替代 Stripe Billing、身份提供方、会计软件或通用用量计量平台；
- 保证任意 Dashboard 配置、webhook 投递延迟，或文档中单 item 契约以外的 Invoice 形状；
- 根据浏览器跳转或可变 Subscription read 直接开通权限。

## 许可证

Apache-2.0，见 [LICENSE](LICENSE)。
