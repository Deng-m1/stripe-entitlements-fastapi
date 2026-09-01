# Stripe 订阅、权益与积分包：可直接接入 TypeScript 或 FastAPI

[English](README.md) | **简体中文**

[![CI](https://github.com/ToseaAI/stripe-entitlements/actions/workflows/ci.yml/badge.svg)](https://github.com/ToseaAI/stripe-entitlements/actions/workflows/ci.yml)
[![License](https://img.shields.io/badge/license-Apache--2.0-blue.svg)](LICENSE)
[![Python](https://img.shields.io/badge/python-3.12%2B-3776AB.svg)](pyproject.toml)
[![Node](https://img.shields.io/badge/node-22%2B-339933.svg)](typescript/package.json)

这是一个面向 SaaS 产品的开源 Stripe 计费起步项目。它不只创建 Checkout，还把付款结果
安全地转换成你的业务权益：套餐、功能开关、使用上限、订阅积分和一次性积分包。

你可以直接选择原生 **TypeScript/Node/Next.js** 或 **Python/FastAPI** 后端。两套实现
都使用 PostgreSQL，并提供相同的套餐规则、月付/年付生命周期、升级/降级策略和
webhook 记账边界。正常部署只需要选择其中一种后端。

> **发布状态：** `main` 是 `0.4.0` 候选版本，但 `v0.4.0` tag 和
> `@tosea/stripe-entitlements@0.4.0` npm 包尚未发布。目前请使用完整仓库源码、
> Git/vendor 依赖或本地构建的 tarball，不要直接安装尚不存在的 npm 版本。

> 本项目是独立社区参考实现，不是 Stripe 官方产品。它仍处于 pre-1.0 阶段，目前没有
> 已记录的第三方生产使用者；测试模式验证不等于你的生产环境验证。

<a id="start-here"></a>

## 从这里开始

| 你的项目 | 推荐入口 |
| --- | --- |
| Next.js、Node 或其他 TypeScript SSR 应用 | [TypeScript/Next.js 接入指南](typescript/README.md#requirements) |
| 已有 Python 或 FastAPI 服务 | [快速开始](#quick-start)与[现有应用接入](docs/ADOPTION.md#compose-the-fastapi-application) |
| 想部署一个可真实付款的 Stripe 测试站 | [首次部署指南](docs/DEPLOYMENT.md) |
| 只想给 v0、Lovable 或客户看 UI | [无 Stripe/数据库的公开模拟](docs/AI_BUILDERS.md#publish-a-ui-only-simulation) |

四个目录分别承担清晰的职责，不要因为根目录的 Python 配置而把它误认为 Python-only
项目：

```text
src/stripe_entitlements/   Python/FastAPI 计费后端
typescript/src/            独立 TypeScript/Node 计费后端
typescript/src/next/       Next.js App Router 适配层
web/app/                   Next.js SSR 参考页面与服务端路由
```

## 目录

- [为什么能快速接入](#quick-adoption)
- [选择 TypeScript 还是 Python](#choose-runtime)
- [订阅与权益如何流转](#choose-subscription-flow)
- [已经包含什么](#implemented-scope)
- [套餐、年付与权益](#plan-catalog)
- [一次性积分包](#credit-packs)
- [两套完整的 6 × 6 套餐变更矩阵](#plan-transitions)
- [五步接入](#quick-start)
- [连接你的用户和业务实体](#adoption)
- [为什么能应对重复、乱序和并发](#correctness-model)
- [Vercel 与其他部署方式](#vercel-deployment)
- [v0、Lovable 与 AI Builder](#ai-builders)
- [验证证据与诚实边界](#verification)
- [数据库初始化与升级](#migrations)
- [进一步阅读](#repository-map)
- [常见问题](#faq)

<a id="quick-adoption"></a>

## 为什么能快速接入

普通 Stripe 示例往往在“创建 Checkout”或“验证 webhook 签名”处结束。这个项目已经把
付款之后最容易出错的业务流程做成了可以复用的服务边界：

| 你只需决定或实现 | 项目已经提供 |
| --- | --- |
| 谁付费：个人用户还是团队 | 个人/团队认证 starter 与账户适配接口 |
| 卖什么：套餐、权益、积分和价格 | 单一 `plans.toml` 套餐目录及校验 |
| 选哪种升级体验 | 两套完整 6 × 6 月付/年付策略 |
| 你的页面如何调用计费 | Checkout、Portal、套餐变更、账户与额度 facade |
| 产品任务如何消耗额度 | 原子 check/charge/refund 服务与 Job + outbox 示例 |
| 部署到哪里 | Next.js、FastAPI、Vercel、容器或普通 PaaS 接入方式 |

它容易移植的关键不是“文件少”，而是边界已经分开：Stripe 管理支付页面和资金对象，
本项目管理 PostgreSQL 中的权益与积分，宿主应用继续管理登录、团队成员和自己的业务
实体。你不需要把参考页面原样搬走，也不需要同时运行 Python 与 Node。

<a id="choose-runtime"></a>

## 选择 TypeScript 还是 Python

| 选择 | 更适合 | 你会使用 |
| --- | --- | --- |
| TypeScript/Node/Next.js | Next.js App Router、Vercel、Node API、全栈 SSR 产品 | 独立 Node 核心、Fetch handler、Next.js Route Handlers 与 Node CLI |
| Python/FastAPI | AI/数据服务、已有 FastAPI API、sidecar 或容器后端 | 独立 FastAPI 应用、可组合 router、Python service 与 CLI |

两套后端共享相同的套餐目录、SQL migration、积分精度和业务决策。部署时选择一种即可；
所有 API、webhook 和 worker 应保持同一套餐目录、数据库版本和变更策略。

详细用法见 [TypeScript 指南](typescript/README.md)和
[FastAPI/现有应用接入指南](docs/ADOPTION.md)。

<a id="business-flow"></a>
<a id="choose-subscription-flow"></a>

## 订阅与权益如何流转

浏览器跳回成功页不代表付款成功。项目只在经过签名验证、身份匹配的 Stripe webhook
完成数据库投影后开放权益。

| 用户动作 | Stripe 负责 | 本项目负责 |
| --- | --- | --- |
| 首次订阅 | Hosted Checkout 与收款 | paid Invoice 到达后开通套餐与积分 |
| 升级 | 计算并收取全价或差价 | 预览、确认、失败恢复与权益切换 |
| 降级或不支持的周期切换 | Subscription Schedule | 保持原权益，到周期末再切换 |
| 取消 | Customer Portal | 到期前保留已付权益，到期后降级 |
| 月付/年付续费 | Invoice 与支付状态 | 按已支付周期发放积分；年付按月释放 |
| 购买积分包 | 一次性 Hosted Checkout | 创建独立积分来源并处理退款、争议与过期 |

Portal 中应禁用套餐价格变更，避免绕过应用选定的升级策略。首次配置 Stripe 产品、
Portal、域名和 webhook 的职责清单见[首次部署指南](docs/DEPLOYMENT.md)。

<a id="limitations"></a>
<a id="implemented-scope"></a>

## 已经包含什么

当前范围适合常见的个人或团队 SaaS：

- 月付和年付订阅，内置 Starter、Pro、Ultra，可替换为自己的套餐；
- 两种升级方式：全价开启新周期，或月付套餐按剩余时间支付差价；
- 周期末降级、取消、支付失败/SCA 恢复、退款和争议收敛；
- 精确到 `0.000001` 的积分，以及可独立购买、过期和退款的积分包；
- Hosted Checkout、Customer Portal、账户/权益查询和服务端额度校验；
- 个人/团队认证 starter、产品 Job + outbox + fencing 示例；
- PostgreSQL 下的幂等、并发协调和多实例部署。

为了避免给采用者错误承诺，当前明确**不支持**多币种、席位计费、试用、优惠券、
自动税费、通用计量计费、任意混合 Invoice item、收入确认和托管身份系统。产品代码
仍需真正执行返回的 feature 与 limit；“页面展示某项权益”本身不是权限控制。

这些边界及后续扩展要求见[接入指南](docs/ADOPTION.md)、
[套餐变更策略](docs/PLAN_TRANSITIONS.md)和[优惠码设计边界](docs/PROMOTION_CODES.md)。

<a id="plan-catalog"></a>

## 套餐、年付与权益

价格和权益来自 [`plans.toml`](plans.toml)。套餐用稳定 key 和 rank 判断升降级，不根据
价格高低猜测档位。下面是可直接替换的示例目录：

| 套餐 | 月付 | 年付总价 | 年付折算月价 | 每月积分 |
| --- | ---: | ---: | ---: | ---: |
| Starter | $19 | $137 | $11.42/月 | 300 |
| Pro | $49 | $353 | $29.42/月 | 1,000 |
| Ultra | $149 | $1,073 | $89.42/月 | 4,000 |

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

只有年付总价确实低于 12 次月付时，参考 UI 才显示节省金额。年付价格是套餐设计，不是
Stripe 优惠券；即使一次收取年费，订阅积分仍按月释放，避免提前透支全年权益。

<a id="credit-packs"></a>

## 一次性积分包

积分包适合用户临时补量，不改变订阅档位、功能开关或使用上限。

| 积分包 | 价格 | 积分 | 默认有效期 |
| --- | ---: | ---: | ---: |
| Boost 100 | $15 | 100 | 365 天 |
| Boost 500 | $59 | 500 | 365 天 |
| Boost 2,000 | $199 | 2,000 | 365 天 |

积分包使用 `mode=payment` 的 Hosted Checkout。系统会记录每批积分的资金来源，消费时
优先使用最早到期的额度，并让部分退款、全额退款、争议、过期和产品退款最终落到正确
余额。业务代码通过公开 service 使用它，不需要直接协调内部账本表。详见
[积分包说明](docs/CREDIT_PACKS.md)。

<a id="plan-transitions"></a>

## 两套完整的 6 × 6 套餐变更矩阵

这是用户最需要先决定的产品规则。`SM` 表示 Starter 月付，`SY` 表示 Starter 年付，
Pro 和 Ultra 以此类推。

读表方法：从左侧找到**当前套餐**，再沿这一行找到顶部的**目标套餐**。

- **立即**：现在发起支付；只有付款完成后才切换权益。
- **周期末**：当前周期保持不变，到期后再切换。
- **—**：套餐没有变化。

### 模板 A：全价开启一个新周期（`full_period_reset`）

适合“升级后立即开始全新周期”的产品。用户支付目标套餐全价，旧周期未使用的时间
不抵扣。

| 当前套餐 ↓ / 目标套餐 → | Starter<br>月付 (SM) | Starter<br>年付 (SY) | Pro<br>月付 (PM) | Pro<br>年付 (PY) | Ultra<br>月付 (UM) | Ultra<br>年付 (UY) |
| --- | --- | --- | --- | --- | --- | --- |
| **Starter 月付 (SM)** | — | **立即**<br>目标全价 | **立即**<br>目标全价 | **立即**<br>目标全价 | **立即**<br>目标全价 | **立即**<br>目标全价 |
| **Starter 年付 (SY)** | **周期末** | — | **周期末** | **周期末** | **周期末** | **周期末** |
| **Pro 月付 (PM)** | **周期末** | **周期末** | — | **立即**<br>目标全价 | **立即**<br>目标全价 | **立即**<br>目标全价 |
| **Pro 年付 (PY)** | **周期末** | **周期末** | **周期末** | — | **周期末** | **周期末** |
| **Ultra 月付 (UM)** | **周期末** | **周期末** | **周期末** | **周期末** | — | **立即**<br>目标全价 |
| **Ultra 年付 (UY)** | **周期末** | **周期末** | **周期末** | **周期末** | **周期末** | — |

月付套餐可以立即升到更高档位，也可以在同档位从月付转为年付；降级与所有年付来源
变更都在周期末生效。立即升级付款成功后，目标套餐开启一个新的权益周期。

### 模板 B：只支付剩余周期差价（`prorated_delta`）

适合常见的“月付套餐中途升级”。Stripe 抵扣旧套餐未使用时间，再收取目标套餐相同
剩余时间的费用，因此用户现在只支付净差价。

| 当前套餐 ↓ / 目标套餐 → | Starter<br>月付 (SM) | Starter<br>年付 (SY) | Pro<br>月付 (PM) | Pro<br>年付 (PY) | Ultra<br>月付 (UM) | Ultra<br>年付 (UY) |
| --- | --- | --- | --- | --- | --- | --- |
| **Starter 月付 (SM)** | — | **周期末** | **立即**<br>按比例差价 | **周期末** | **立即**<br>按比例差价 | **周期末** |
| **Starter 年付 (SY)** | **周期末** | — | **周期末** | **周期末** | **周期末** | **周期末** |
| **Pro 月付 (PM)** | **周期末** | **周期末** | — | **周期末** | **立即**<br>按比例差价 | **周期末** |
| **Pro 年付 (PY)** | **周期末** | **周期末** | **周期末** | — | **周期末** | **周期末** |
| **Ultra 月付 (UM)** | **周期末** | **周期末** | **周期末** | **周期末** | — | **周期末** |
| **Ultra 年付 (UY)** | **周期末** | **周期末** | **周期末** | **周期末** | **周期末** | — |

只有“月付 → 更高档月付”立即结算。例如 Starter 月付升级 Pro 月付时，Stripe 收取
剩余周期净差价，产品增加 `1,000 - 300 = 700` 积分，并保留当前周期与已有余额。
降级、月/年切换和所有年付来源变更仍在周期末生效。

设置 `BILLING_TRANSITION_POLICY=full_period_reset` 或 `prorated_delta` 即可选择模板。
自定义套餐、退款规则和无法安全结算时的处理见
[完整套餐变更契约](docs/PLAN_TRANSITIONS.md)。

<a id="quick-start"></a>

## 五步接入

### 1. 先回答五个产品问题

确定付费主体（个人或团队）、后端运行时、套餐与权益、升级模板，以及是否需要年付、
积分包和 Portal。Agent 或开发者不应在这些问题未确定时替你猜业务规则。

### 2. 引入源码并选择一种后端

当前 npm 包尚未发布。请克隆完整仓库，再按宿主技术栈选择一种实现：

```bash
git clone https://github.com/ToseaAI/stripe-entitlements.git
cd stripe-entitlements
```

- TypeScript/Next.js：按 [TypeScript 源码指南](typescript/README.md#requirements)构建，
  或以 Git vendor、本地 `file:` 依赖、tarball 接入。
- Python/FastAPI：按[接入指南](docs/ADOPTION.md#compose-the-fastapi-application)使用独立
  应用或把 router 安装到现有服务。

### 3. 配置套餐与 PostgreSQL

编辑 `plans.toml`，为测试和生产使用彼此隔离的数据库，然后执行项目 migration。
支持 PostgreSQL 17 或 18；这里的 migration 是初始化/升级应用表，不是升级数据库
服务器版本。

### 4. 配置 Stripe 测试模式

使用测试 secret key 创建 Product/Price 与安全的 Portal 配置。部署出稳定域名后，
再创建指向该域名的 webhook endpoint，并把它自己的 signing secret 放入部署平台的
服务端环境变量。

`STRIPE_API_VERSION` 控制主动 API 请求；`STRIPE_WEBHOOK_API_VERSION` 必须匹配该
endpoint 实际签名 Event 的版本，二者不能互相猜测。需要的事件、Stripe CLI 本地转发
和两阶段部署步骤见 [Stripe CLI 指南](docs/STRIPE_CLI.md)与
[首次部署指南](docs/DEPLOYMENT.md)。

### 5. 连接认证、执行权益并验证

把你已验证的用户 ID 或团队 ID 映射为计费账户；产品 API 在服务端调用权益与额度
service，而不是相信浏览器传来的套餐或余额。先运行 `doctor`，再按
[测试指南](docs/TESTING.md)验证 Checkout、Portal、webhook、失败恢复和套餐变更。

<a id="adoption"></a>

## 连接你的用户和业务实体

| 宿主应用继续负责 | 本项目可以直接承担 |
| --- | --- |
| 登录、session、OIDC/JWT issuer | 验证后身份到计费账户的 adapter |
| 用户、organization、项目和任务表 | Stripe customer、订阅、权益和积分投影 |
| 团队成员与角色真相 | 个人/团队 starter 和计费管理员边界 |
| 产品 feature/limit 的实际执行 | `EntitlementService` 与原子 check/charge/refund |
| 任务创建与队列投递 | 可运行的 Job + outbox + fencing 示例 |

个人产品应映射不可变的宿主 user ID；团队产品应映射经过验证的 tenant/organization ID。
不要用 email，也不要信任浏览器提交的 account ID 作为所有权依据。

如果你的 SaaS 有“生成报告、转换文件、调用 AI”等任务，推荐流程是：验证身份 →
检查权益与上限 → 以业务幂等键扣额度 → 持久化任务 → 失败时退款。跨服务任务使用
[Job/outbox 示例](examples/job_outbox/README.md)，认证起点见
[个人与团队 Auth Starter](examples/auth_starters/README.md)。

<a id="correctness-model"></a>

## 为什么能应对重复、乱序和并发

| 真实问题 | 项目采用的业务保护 |
| --- | --- |
| Stripe 重复投递同一事件 | 事件幂等与业务效果唯一约束 |
| 两个事件都可能发放同一权益 | Invoice/批次级唯一身份，防止重复发放 |
| webhook 乱序或退款先到 | 持久化事实并按因果顺序最终收敛 |
| 多个 API/worker 同时改余额 | PostgreSQL 行锁、约束和 lease 协调 |
| Checkout 成功页先于 webhook 到达 | 页面轮询账户投影，不直接开通权益 |
| 升级支付失败或需要 SCA | 保留旧的已付权益，等待目标 Invoice 真正支付 |
| 处理结果不确定 | 保存可重试请求身份；无法证明时 fail closed 并记录 incident |

因此可以运行多个 API 和 worker 实例，但它们必须共享同一个 PostgreSQL primary 和一致
配置。PostgreSQL 仍需要 HA、备份和恢复演练。实现细节见[不变量](docs/INVARIANTS.md)、
[架构](docs/ARCHITECTURE.md)和[分布式部署](docs/DISTRIBUTED.md)。

<a id="vercel-deployment"></a>

## Vercel 与其他部署方式

纯 TypeScript 方案可以让 Next.js App Router 同时提供页面、API、webhook、健康检查和
定时路由，不需要 FastAPI、Railway 或常驻的独立 Node 服务。

Python 方案也可以让 Next.js 页面与 FastAPI 计费服务共享一个 Vercel 域名。两种方案
都仍需要 PostgreSQL、Stripe endpoint、真实身份系统、migration、备份和年度发放/
对账调度器。Vercel 只是可选适配器；VM、容器、Kubernetes 和其他能接收 HTTPS webhook
的平台同样可用。详见 [Vercel 部署指南](docs/VERCEL.md)。

<a id="ai-builders"></a>

## v0、Lovable 与 AI Builder

只有 Stripe 测试账户也能发布一个可实际走 Hosted Checkout、Portal、测试卡、SCA 和
签名 webhook 的测试站，不会产生真实资金。

- **v0 / Next.js**：可直接编辑参考 UI，并接入原生 TypeScript Route Handlers。
- **Lovable / Vite**：可生成前端，但真实计费仍通过受认证的 Node 或 FastAPI 服务。
- **只展示 UI**：使用明确 `noindex` 的 simulation 模式；它不连接 Stripe 或数据库，
  也不能证明真实订阅已经生效。

Secret key、webhook 验签、数据库和权益判断必须留在服务端。可复制提示词、前端适配器
与测试/生产边界见 [AI Builder 指南](docs/AI_BUILDERS.md)。

<a id="evidence"></a>
<a id="verification"></a>

## 验证证据与诚实边界

仓库的 CI 持续检查 Python/FastAPI、TypeScript/Node、Next.js Web、容器、SQL migration
和跨运行时策略一致性。数据库测试覆盖重复事件、不同事件产生同一业务效果、乱序、
事务回滚、退款/争议和真实并发。

可选的 Stripe **测试模式**与真实浏览器流程覆盖 Hosted Checkout、拒付、3DS/SCA、
签名 webhook、两种升级策略、积分包、Portal、退款和 Test Clock 年度续费。采用者可按
[测试指南](docs/TESTING.md)运行 `scripts/run_browser_e2e.sh`，并在自己的测试 endpoint
上复验。

这些证据说明参考实现的已声明路径被系统性验证过，但不代表任意套餐、Dashboard 配置、
认证系统或部署平台都天然正确；也**不宣称验证了生产 webhook payload**。上线前仍需
使用自己的生产 endpoint、真实签名事件、身份边界、备份恢复和告警完成验收。测试层级
和可复现命令集中在[测试文档](docs/TESTING.md)与
[webhook 验证指南](docs/WEBHOOK_VERIFICATION.md)。

<a id="migrations"></a>

## 数据库初始化与升级

`stripe-entitlements migrate` 初始化并按顺序升级本项目 schema。全新数据库从基线开始；
已有旧版 schema 只应用后续 migration。它不会把 PostgreSQL 17 升级为 PostgreSQL 18，
两种服务器版本都可以承载新数据库。

生产迁移应独立于 Web 启动执行，并使用最小数据库权限。不要手改 migration 历史或让
不兼容的新旧 writer 混跑。升级顺序、回滚边界和生产检查单见
[运维指南](docs/OPERATIONS.md)与[发布检查单](.github/RELEASE_CHECKLIST.md)。

<a id="repository-map"></a>

## 进一步阅读

| 主题 | 文档 |
| --- | --- |
| 第一次部署与 Agent 应询问的问题 | [部署指南](docs/DEPLOYMENT.md) |
| 接入现有应用、认证、业务实体与源码 vendor | [接入指南](docs/ADOPTION.md) |
| TypeScript、Node 与 Next.js | [TypeScript 指南](typescript/README.md) |
| 两种 6 × 6 策略与退款语义 | [套餐变更策略](docs/PLAN_TRANSITIONS.md) |
| 积分包和多来源余额 | [积分包](docs/CREDIT_PACKS.md) |
| 测试、浏览器 E2E 与 Stripe CLI | [测试](docs/TESTING.md) · [Stripe CLI](docs/STRIPE_CLI.md) |
| 部署、运维和分布式边界 | [Vercel](docs/VERCEL.md) · [运维](docs/OPERATIONS.md) · [分布式](docs/DISTRIBUTED.md) |
| SEO 与公开收录 | [SEO 指南](docs/SEO.md) |

<a id="faq"></a>

## 常见问题

### 这是一个 Stripe 前端模板吗？

不只是。参考 Web 提供页面，但真正可复用的是服务端计费、权益与积分流程。Hosted
Checkout 和 Portal 页面由 Stripe 托管；你的应用负责发起安全 session 并消费 webhook
投影后的结果。

### 全栈 Next.js 还需要数据库吗？

真实计费需要。Next.js Route Handlers 可以充当后端，所以不必再部署 FastAPI；但
PostgreSQL 仍保存事件幂等、订阅/权益投影、积分来源、套餐变更和对账状态。只有 UI
simulation 不需要数据库。

### 用户取消或升级失败会立刻失去权益吗？

不会。周期末取消在已付周期结束前保留权益；升级付款失败或等待 SCA 时，也保留旧的
已付套餐，直到新的 Invoice 真正支付。

### 可以接入自己的用户、团队和产品表吗？

可以。通过身份 adapter 把不可变 user/tenant ID 映射到计费账户；业务实体无需搬进本
项目。产品服务只在服务端调用权益检查与额度操作。

### 支持小数积分吗？

支持，最小 `0.000001` 积分。数据库使用整数 atom，API 使用十进制字符串，避免
JavaScript 浮点误差。详见[积分精度](docs/CREDIT_PRECISION.md)。

### 支持优惠券、试用、税费和多币种吗？

当前不支持。这些会改变 Invoice 形状和结算策略，所以项目选择明确拒绝，而不是在没有
竞态测试时默认放行。

## 许可证

Apache-2.0，见 [LICENSE](LICENSE)。
