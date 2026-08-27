# Wave1 无密钥预检报告（LOCAL_STRIPE_PRECHECK）

- 日期：2026-08-26（UTC）
- 分支：`cursor/stripe-promo-ui-expand-7789`（基于 commit `220a734`）
- 说明：`docs/plans/LOCAL_STRIPE_REAL_REGRESSION.md` 不存在，故按预检清单执行并记录于本文件。
- 安全声明：本次预检**未进行任何 Stripe 网络调用**，未写入、打印或记录任何密钥值；仅检测前缀与存在性。未触碰 `allow_promotion_codes`。

## 1. 密钥与配置检查

| 检查项 | 结果 |
| --- | --- |
| `.env` 文件 | **缺失** |
| `.env.example` 文件 | 存在（含 19 个变量模板，见下） |
| `STRIPE_SECRET_KEY`（shell 环境变量） | **未设置** |
| `STRIPE_SECRET_KEY` 前缀是否 `sk_test_` | 无法验证（密钥不存在）；仅报告前缀结论，绝不打印密钥全文 |
| `STRIPE_PUBLISHABLE_KEY`（浏览器 E2E 必需，需 `pk_test_` 前缀） | **未设置** |

`.env.example` 变量清单（仅变量名）：`APP_ENV`、`BILLING_TRANSITION_POLICY`、`CHECKOUT_CANCEL_URL`、`CHECKOUT_SUCCESS_URL`、`DATABASE_URL`、`DEMO_BEARER_EMAIL`、`DEMO_BEARER_SUBJECT`、`DEMO_BEARER_TOKEN`、`FRONTEND_ORIGINS`、`LOG_LEVEL`、`LOOKUP_PREFIX`、`PLAN_CATALOG_PATH`、`PORTAL_RETURN_URL`、`PRODUCT_LINE`、`STRIPE_API_VERSION`、`STRIPE_PORTAL_CONFIGURATION_ID`、`STRIPE_SECRET_KEY`、`STRIPE_WEBHOOK_API_VERSION`、`STRIPE_WEBHOOK_SECRET`。

## 2. 工具链可用性

| 工具 | 状态 | 版本/备注 |
| --- | --- | --- |
| docker | 可用 | 29.3.1，守护进程运行中 |
| uv | **缺失** | `command -v uv` 无结果；两个 E2E 脚本均硬性要求 uv，AGENTS.md 全部命令走 `uv run` |
| stripe CLI | 可用 | 1.21.8；`~/.config/stripe/config.toml` 缺失（未登录），但脚本通过 `STRIPE_API_KEY` 环境变量传密钥，登录非硬性要求 |
| node / npm | 可用 | node v22.22.0 |
| cloudflared | 可用 | `endpoint` webhook 传输模式所需 |
| curl / rg / psql / jq | 可用 | — |
| Python venv | 可用 | `.venv` 已存在：Python 3.12.13 + pytest 9.1.1（可绕过 uv 直接调 `.venv/bin/pytest`，但脚本入口仍会因缺 uv 退出） |
| web 前端依赖 | 可用 | `web/node_modules/.bin/next`、`playwright` 均在；Playwright 浏览器缓存含 chromium-1234、chromium_headless_shell-1234、ffmpeg-1011 |
| PostgreSQL 镜像 | 部分可用 | 本地已有 `public.ecr.aws/docker/library/postgres:17-alpine`；脚本默认镜像名为 `postgres:17-alpine`（Docker Hub），如需离线运行须设 `E2E_POSTGRES_IMAGE=public.ecr.aws/docker/library/postgres:17-alpine` |

## 3. real_stripe 用例收集

命令：`.venv/bin/pytest --collect-only -m real_stripe -q`（仅收集，无网络调用）

结果：**收集 9 个用例**（9/733，724 deselected），全部位于 `tests/real/test_stripe_test_mode.py`：

1. `test_real_paid_and_refund_events_converge_in_postgres`
2. `test_real_midcycle_upgrade_is_full_price_and_webhook_authoritative`
3. `test_real_prorated_delta_upgrade_and_refund_preserve_funding_lineage`
4. `test_real_failed_immediate_change_keeps_old_entitlement[full_period_reset-pm_card_authenticationRequired]`
5. `test_real_failed_immediate_change_keeps_old_entitlement[full_period_reset-pm_card_chargeCustomerFail]`
6. `test_real_failed_immediate_change_keeps_old_entitlement[prorated_delta-pm_card_authenticationRequired]`
7. `test_real_failed_immediate_change_keeps_old_entitlement[prorated_delta-pm_card_chargeCustomerFail]`
8. `test_real_annual_origin_change_builds_period_end_schedule`
9. `test_real_test_clock_annual_slots_downtime_and_renewal`

守卫逻辑（`tests/real/test_stripe_test_mode.py`）：无 `STRIPE_SECRET_KEY` 时 `pytest.skip`；前缀非 `sk_test_` 时 `pytest.fail`（拒绝 `sk_live_`，符合 AGENTS.md 安全规则）。

## 4. E2E 脚本入口与必需环境变量

### `scripts/run_test_clock_e2e.sh`

- 入口：`uv run pytest tests/real/test_stripe_test_mode.py::test_real_test_clock_annual_slots_downtime_and_renewal -vv`，并注入 `TEST_CLOCK_RECOVERY_MANIFEST`（secret-free 恢复清单，位于 `/tmp/stripe-entitlements-test-clock.*`）。
- 必需：`STRIPE_SECRET_KEY`（必须 `sk_test_` 前缀，否则 exit 2）；命令 `docker`、`uv`；docker 守护进程运行中（用于一次性 PostgreSQL 容器）。
- 失败/中断时保留 recovery 目录供恢复清理。

### `scripts/run_browser_e2e.sh`

- 入口：启动一次性 PostgreSQL 容器 → `uv run stripe-entitlements migrate` → cloudflared 隧道或 `stripe listen` → uvicorn 后端 → Next.js 前端 → `npm --prefix web run test:e2e:stripe`（Playwright）→ `scripts/e2e_stripe.py verify-database` 数据库断言 → 全量清理（webhook endpoint、Stripe 对象、容器、进程）。
- 必需环境变量：
  - `STRIPE_SECRET_KEY`：必须 `sk_test_` 前缀，否则 exit 2；
  - `STRIPE_PUBLISHABLE_KEY`：必须 `pk_test_` 前缀，否则 exit 2；
  - `E2E_WEBHOOK_TRANSPORT=stripe_cli` 时必须显式提供 `E2E_STRIPE_EVENT_API_VERSION`。
- 可选环境变量（含默认值）：`STRIPE_API_VERSION`（`2026-06-24.dahlia`）、`E2E_WEBHOOK_TRANSPORT`（`endpoint`，可选 `stripe_cli`）、`E2E_TRANSITION_POLICY`（`full_period_reset`，可选 `prorated_delta`）、`E2E_UPGRADE_PAYMENT_METHOD`（`pm_card_authenticationRequired`，白名单另含 `pm_card_visa`）、`E2E_RECORD_VIDEO`（`0`/`1`）、`CLOUDFLARED_BIN`（`cloudflared`）、`E2E_POSTGRES_IMAGE`（`postgres:17-alpine`）、`E2E_OUTPUT_DIR`、`E2E_DECLINE_STABILITY_SECONDS`（`10`）、`E2E_DEMO_PAUSE_MS`（`0`）。
- 必需命令：`docker`、`curl`、`uv`、`npm`；`endpoint` 模式另需 `cloudflared`，`stripe_cli` 模式另需 `stripe` CLI。
- 文档依据：`docs/BROWSER_E2E.md`（变量表与两种传输模式）、`docs/TESTING.md`（real_stripe 门控）、`docs/STRIPE_CLI.md`（sk_test_ 前缀守卫）。

## 5. 阻塞项清单（按影响排序）

1. **无 `.env` 且未设置 `STRIPE_SECRET_KEY`**：real_stripe 9 个用例全部会被 skip；`run_test_clock_e2e.sh` 与 `run_browser_e2e.sh` 均在入口 exit 2。需要提供 `sk_test_` 前缀的测试密钥（严禁 `sk_live_`）。
2. **未设置 `STRIPE_PUBLISHABLE_KEY`（`pk_test_`）**：`run_browser_e2e.sh` 第二道门控直接 exit 2。
3. **`uv` 未安装**：两个 E2E 脚本 `command -v uv` 检查会 exit 2；AGENTS.md 的 lint/typecheck/test 命令全部依赖 `uv run`。（临时替代：`.venv/bin/pytest` 可直接收集/运行，但不改变脚本门控。）
4. 次要：脚本默认 PostgreSQL 镜像名 `postgres:17-alpine` 本地不存在（本地仅有 ECR 镜像别名），离线运行需设 `E2E_POSTGRES_IMAGE=public.ecr.aws/docker/library/postgres:17-alpine`，否则将触发 Docker Hub 拉取。
5. 次要：stripe CLI 未登录（无 `~/.config/stripe/config.toml`）；脚本通过 `STRIPE_API_KEY` 传密钥可运行，`stripe_cli` 传输模式无需交互登录，仅记录备查。

## 6. 结论

基础设施（docker、node/npm、stripe CLI、cloudflared、Playwright、前端依赖、Python venv）基本就绪；**真实回归当前不可执行**，解除条件为：提供 `sk_test_` 测试密钥与 `pk_test_` 可发布密钥（建议经 `.env`，参照 `.env.example`，绝不入库）并安装 `uv`。在此之前不得进行任何真实 Stripe 调用。
