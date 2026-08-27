# Wave 0 勘察结果（R0a–R0d）

- 执行日期：2026-08-26；分支：`cursor/stripe-promo-ui-expand-7789`；HEAD：`ccad9c5d9d701d986e9d54313c20ed15dc04c8bd`。
- 计划依据：[LOCAL_STRIPE_REAL_REGRESSION.md](LOCAL_STRIPE_REAL_REGRESSION.md) §3 回归矩阵 Wave 0 行（R0a–R0d）。
- **证据层级声明（§6.4 纪律）**：本报告全部内容属于 mocked/预检层（分层第 0 层）。本波**未发起任何 Stripe 网络调用、未创建任何真实对象**；下文没有任何一行构成真实 API、Test Clock 或 browser 层证据。`--collect-only` 输出仅为收集证据，不是执行证据。

## 结果总览

| # | 场景 | 状态 | 一行结论 |
| --- | --- | --- | --- |
| R0a | real_stripe 标记收集 | **passed** | `9/733 tests collected (724 deselected) in 0.44s`，9 个用例 ID 与计划 §1.1 完全一致 |
| R0b | 脚本语法 + fail-closed | **passed** | `bash -n` 0 错；无 key 时两脚本均 exit 2 并提示需要 `sk_test_`，未发起网络调用 |
| R0c | mocked 本地基线 | **passed** | 聚焦 `22 passed in 2.08s`；全量 `724 passed, 9 deselected in 31.09s`，0 skip，PG 并发用例真实执行 |
| R0d | 目录/Portal 校验 | **blocked** | `STRIPE_SECRET_KEY` 未设置，未执行、未伪造 |

## 环境快照（2026-08-26 实测，只读探测，未打印任何密钥）

| 项 | 状态 |
| --- | --- |
| `STRIPE_SECRET_KEY` | **未设置**（`BLOCKED: STRIPE_SECRET_KEY unset`）——阻塞 R0d、R1–R5 |
| `STRIPE_PUBLISHABLE_KEY` | **未设置**（`BLOCKED: STRIPE_PUBLISHABLE_KEY unset`）——阻塞 R3–R5 |
| Docker daemon | 运行中（`docker info` 成功） |
| `uv` | 0.11.3，位于 `~/.local/bin`（每 shell 需 `export PATH="$HOME/.local/bin:$PATH"`） |
| `.venv` | 存在，Python 3.12.13，本波直接以 `.venv/bin/pytest` 调用 |

## R0a：real_stripe 标记收集（仅收集证据，非执行）

命令：

```bash
export PATH="$HOME/.local/bin:$PATH"
.venv/bin/pytest --collect-only -m real_stripe -q
```

输出末行原文：`9/733 tests collected (724 deselected) in 0.44s`，exit 0。

9 个用例 ID（均位于 `tests/real/test_stripe_test_mode.py`）：

1. `test_real_paid_and_refund_events_converge_in_postgres`
2. `test_real_midcycle_upgrade_is_full_price_and_webhook_authoritative`
3. `test_real_prorated_delta_upgrade_and_refund_preserve_funding_lineage`
4. `test_real_failed_immediate_change_keeps_old_entitlement[full_period_reset-pm_card_authenticationRequired]`
5. `test_real_failed_immediate_change_keeps_old_entitlement[full_period_reset-pm_card_chargeCustomerFail]`
6. `test_real_failed_immediate_change_keeps_old_entitlement[prorated_delta-pm_card_authenticationRequired]`
7. `test_real_failed_immediate_change_keeps_old_entitlement[prorated_delta-pm_card_chargeCustomerFail]`
8. `test_real_annual_origin_change_builds_period_end_schedule`
9. `test_real_test_clock_annual_slots_downtime_and_renewal`

与计划 §1.1 清单逐条一致（3 个基础用例 + 4 个参数化失败路径 + 年付 Schedule + Test Clock）。

## R0b：脚本语法 + fail-closed 拒绝（期望的失败关闭行为）

语法检查：`bash -n scripts/run_test_clock_e2e.sh scripts/run_browser_e2e.sh` → 0 错误。

无密钥运行（`env -u STRIPE_SECRET_KEY`，browser 额外 `-u STRIPE_PUBLISHABLE_KEY`）：

| 脚本 | 退出码 | 拒绝提示原文 |
| --- | --- | --- |
| `scripts/run_test_clock_e2e.sh` | **2** | `Test Clock E2E requires STRIPE_SECRET_KEY=sk_test_...` |
| `scripts/run_browser_e2e.sh` | **2** | `browser E2E requires STRIPE_SECRET_KEY=sk_test_...` |

两脚本均在 pytest / 任何网络调用之前退出，符合「无密钥不得 skip 呈绿」的 fail-closed 设计。这是**期望行为**，计为 R0b passed，而非真实层执行证据。

## R0c：mocked 本地基线（分层第 0 层）

聚焦运行：

```bash
.venv/bin/pytest tests/test_checkout_promo_prohibition.py tests/test_invoice_policy.py -q
```

输出末行原文：`22 passed in 2.08s`，exit 0。其中 `test_checkout_promo_prohibition.py` 收集 10 例全过——本分支 Checkout 创建禁止 `allow_promotion_codes` 的既有守卫保持通过，未被削弱。

全量运行（nohup 后台 + 轮询，日志 `/tmp/stripe-regression-logs/wave0-mocked-full.log`，目录 0700）：

```bash
.venv/bin/pytest -m "not real_stripe" -q --tb=no
```

汇总行原文：`724 passed, 9 deselected in 31.09s`。

- **0 failed / 0 error / 0 skipped**（日志中 `skipped|failed|error` 匹配计数为 0）——PG 并发用例真实执行、未被跳过（conftest 起一次性 Docker PostgreSQL 17 容器）。
- 9 deselected 即 R0a 收集的 9 个 real_stripe 用例，按标记正确排除。
- 日志密钥扫描：`sk_|whsec_|rk_` 匹配计数为 0。

**本层仅证明仓库逻辑（mocked 层），不构成任何真实 Stripe 证据。**

## R0d：目录/Portal 校验 — blocked

状态：**blocked: STRIPE_SECRET_KEY unset**。`uv run python scripts/bootstrap_stripe.py --verify-only` 未执行（需要 `sk_test_` + 出网），未伪造任何输出。

## 阻塞项与下一步

| 阻塞项 | 影响 | 补救 |
| --- | --- | --- |
| `STRIPE_SECRET_KEY`（需 `sk_test_`）未设置 | R0d、R1（real 套件 9 例）、R2（Test Clock）、R3–R5（browser） | 用户在 ignored `.env`/secret manager 注入后重启 Wave 1；注入前真实层一律 not-run |
| `STRIPE_PUBLISHABLE_KEY`（需 `pk_test_`）未设置 | R3–R5 | 同上 |

Wave 1–3 在密钥注入前**不得开始**（计划 §4 串行门禁）。

## run-owned inventory = 0 结论（§6.4）

本波未创建任何真实 Stripe 对象：R0a 仅本地收集，R0b 两脚本均在网络调用前 exit 2，R0c 全程 mocked（仅本地 Docker PostgreSQL 容器，由 conftest 自动创建并回收）。因此 run-owned inventory = 0，依据为「本波未创建真实对象」。

## 安全声明

- 全程未打印、未提交任何 `sk_*` / `rk_*` / `whsec_*` 值；密钥探测只回显「已设置/未设置」判断。
- 未修改任何被测代码、测试断言或脚本；本文件为本波唯一新增产物。
- 未向 Checkout 传 `allow_promotion_codes`，promo 禁用守卫按原样通过。
