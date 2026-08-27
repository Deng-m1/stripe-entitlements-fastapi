# 本地 Stripe 真实测试 + Test Clock 回归执行计划

适用分支：`cursor/stripe-promo-ui-expand-7789`。制定日期：2026-08-26。
本计划供父代理按 Wave 派生子代理落地执行。所有真实调用仅限 Stripe **test mode**
（`sk_test_`），本轮回归目标是**既有计费正确性**（订阅、授信、续费、Test Clock
时光跳跃、双结算策略），与促销码收款无关。

权威依据（执行前子代理必须通读）：[AGENTS.md](../../AGENTS.md)、
[TESTING.md](../TESTING.md)、[STRIPE_CLI.md](../STRIPE_CLI.md)、
[BROWSER_E2E.md](../BROWSER_E2E.md)、[INVARIANTS.md（尤其 §16）](../INVARIANTS.md)。

## 全局硬约束（每个子代理 prompt 必须原样携带）

1. 只用 test mode：任何网络调用前先做 `case "$STRIPE_SECRET_KEY" in sk_test_*) ;; *) exit 2;; esac`；`sk_live_` 一律拒绝。
2. 永不打印、提交、粘贴 `sk_*` / `rk_*` / `whsec_*`；探测密钥只回显「已设置/未设置/前缀判断结果」。
3. 本分支 Checkout 创建**禁止** `allow_promotion_codes`（不改代码、不加开关；`tests/test_checkout_promo_prohibition.py` 是既有守卫，只许通过不许削弱）。
4. 真实对象必须 run-owned（`run_id` metadata / 幂等键 `real-test:{run_id}:{label}` / `external_ref` / endpoint description），破坏性清理只针对本 run 创建对象；不碰账户内任何其他对象。
5. 不弱化 PostgreSQL 并发测试；不为通过门禁修改被测代码或断言。
6. 分层报告：mocked 套件、真实 API 套件、Test Clock、browser 门禁四层证据分开陈述，禁止把一层说成另一层（`--collect-only` / `--list` 输出不是执行证据；Event 轮询不是签名投递证据；CLI transport 不是 endpoint metadata 证据）。

## 1. 现状盘点

### 1.1 `real_stripe` 真实 API 套件

- 位置：`tests/real/test_stripe_test_mode.py`（`pytestmark = pytest.mark.real_stripe`，marker 注册于 `pyproject.toml`，`--strict-markers`）。
- 用例数：**9**（6 个函数，其中失败路径函数按 2 策略 × 2 失败 PaymentMethod 参数化为 4 例）。2026-08-26 本机实测 `--collect-only`：`9/733 tests collected (724 deselected)`。
  1. `test_real_paid_and_refund_events_converge_in_postgres` — 真实 Product/Price/Customer/Subscription + `invoice.paid` 投影 300 授信 + $9.50 部分退款收敛 150。
  2. `test_real_midcycle_upgrade_is_full_price_and_webhook_authoritative` — 全价无按比例月中升级，paid Event 收敛 Pro/1,000。
  3. `test_real_prorated_delta_upgrade_and_refund_preserve_funding_lineage` — prorated-delta 升级两行 Invoice、700 授信分配、全额退款回退 Starter/300 且不撤源授信。
  4. `test_real_failed_immediate_change_keeps_old_entitlement[<policy>-<pm>]` × 4 — `pm_card_authenticationRequired` / `pm_card_chargeCustomerFail` × 两策略：`pending_update` 存在、旧 SKU 保持、Invoice open、`invoice.payment_failed` 走 durable incident，授信/epoch 不变。
  5. `test_real_annual_origin_change_builds_period_end_schedule` — 年付起点 period-end 两阶段 Schedule（`end_behavior=release`）。
  6. `test_real_test_clock_annual_slots_downtime_and_renewal` — 年付 Test Clock 全生命周期（见 1.2）。
- 关键机制：无 key 时 `pytest.skip`（**skip 呈绿不是证据**，必须先跑 key 守卫）；非 `sk_test_` 直接 `pytest.fail`；对象带 `automated_test/run_id` metadata；清理 + 全分页 sweep + **零库存断言**失败即测试失败。
- 前置：Docker（`tests/conftest.py` session 级自动起一次性 PostgreSQL 17 容器，tmpfs 数据目录，workspace 派生 loopback 端口）、`uv`、出网到 `api.stripe.com`、env 提供 `STRIPE_SECRET_KEY`。出站请求版本 pin `2026-06-24.dahlia`（测试文件内硬编码）。
- 证据边界：直接 test-mode API + Event 轮询 + 本地 processor，**不证明**签名 webhook 投递与投递顺序。

### 1.2 Test Clock 续费门禁

- 入口：`scripts/run_test_clock_e2e.sh`（只跑 `test_real_test_clock_annual_slots_downtime_and_renewal -vv`）。
- 守卫：缺失/畸形/live key 在 pytest 之前退出 2（防止「无密钥 skip 呈绿」）；要求 `docker`、`uv` 存在且 daemon 运行。
- 时光跳跃步骤：创建 clock/Product/年价/Customer → 年付订阅 slot 1 → **+32 天** slot 2 → 直接跳 **≈+190 天** 只补当前 slot（不回填）→ **period_end + 1 小时** 续费 `invoice.paid` 重置 slot 1、300 授信、延长授权期。
- 清理：只删 run-marked 对象，Test Clock 最后删；全分页重列并要求零库存。
- 恢复机制：`/tmp/stripe-entitlements-test-clock.XXXXXX`（0700）内 `recovery.json`（0600、secret-free，逐步原子记录对象 ID）；成功即删，失败/中断保留并打印路径。

### 1.3 browser e2e 双策略门禁

- 入口：`scripts/run_browser_e2e.sh`，每策略跑一次（`E2E_TRANSITION_POLICY=full_period_reset|prorated_delta`）。生命周期：Free 起点 → 拒付卡 `4000000000000002` + 稳定性屏障 → 同 Session 换 3DS 卡 `4000002500003155` 完成挑战 → webhook 投影 Starter/300 → UI preview/confirm 升级（默认 `pm_card_authenticationRequired` 走 Stripe.js SCA）→ 第二次 paid 投影 Pro/1,000 → 数据库校验恰好 3 个 identity-bound essential Events + 无未解决 incident + 策略相应 700 delta 分配或无分配。
- 双 transport：默认 `endpoint`（cloudflared Quick Tunnel + 临时 version-pinned Webhook Endpoint，release 级证据）；备选 `stripe_cli`（本地签名转发，必须显式给 `E2E_STRIPE_EVENT_API_VERSION` 实测值，不证明 endpoint metadata）。
- 前置：Docker + `postgres:17-alpine`（可 `E2E_POSTGRES_IMAGE` 覆盖）、`uv`、Node 22+/npm、Playwright chromium、`cloudflared` 或 Stripe CLI、`sk_test_` + `pk_test_`、账户已 bootstrap 六个 Price + Portal 配置（`uv run python scripts/bootstrap_stripe.py --verify-only`）。
- 端口：PG/后端/前端全部随机 loopback 端口，无固定端口冲突；容器名 `stripe-entitlements-browser-e2e-pg-$$`。
- 清理：过期未完成 Session、只删本 run 的 Customer/Subscription/Webhook Endpoint、`docker rm -f` 容器；失败保留 `/tmp/stripe-entitlements-browser-e2e.*` 内非密日志与 secret-free `cleanup-manifest.json`；listener 日志自动 redact `whsec_`。
- 历史参考时长：endpoint 模式每策略约 1.6–1.7 分钟（不含依赖启动）。

### 1.4 分层关系

本地 mocked 套件（`pytest -m "not real_stripe"`，含 PG 并发与 promo 禁用守卫）是第 0 层基线，证明仓库逻辑；真实 API 套件证明 Stripe 对象形状与投影；Test Clock 证明跨期/续费；browser 证明 Checkout/SCA/签名投递/UI 投影。四层互不替代。

## 2. 环境检查清单

### 2.1 本机 2026-08-26 实测快照（只读探测，未打印任何密钥）

| 项 | 状态 | 处置 |
| --- | --- | --- |
| Docker daemon | 运行中 | 无需动作 |
| PostgreSQL 17 镜像 | 已缓存 `public.ecr.aws/docker/library/postgres:17-alpine` | mocked/real 套件 conftest 自动后缀匹配识别；browser 脚本需显式 `E2E_POSTGRES_IMAGE=public.ecr.aws/docker/library/postgres:17-alpine`（默认 tag 若从 docker.io 拉取失败） |
| `uv` | 0.11.3，位于 `~/.local/bin`（**不在默认 PATH**） | 每个 shell 先 `export PATH="$HOME/.local/bin:$PATH"` |
| `.venv` / `uv.lock` | 存在，Python 3.12.13 | 执行前跑一次 `uv sync --frozen` 确认 |
| Stripe CLI | 1.21.8 已装，**未登录**（无 `~/.config/stripe/config.toml`） | 无需 `stripe login`：脚本以 `STRIPE_API_KEY="$STRIPE_SECRET_KEY"` 注入；**禁止**跑 `stripe config --list`（会回显密钥） |
| cloudflared | 2026.7.3 已装 | endpoint 模式可用性仍取决于出网与 trycloudflare 可达性，Wave 0 预检 |
| Node/npm、`web/node_modules` | 存在 | 无需动作 |
| Playwright chromium | 已缓存（chromium-1234） | 若版本报错：`cd web && npx playwright install chromium` |
| `STRIPE_SECRET_KEY` | **未设置** | **阻塞项**，见 2.2 |
| `STRIPE_PUBLISHABLE_KEY` | **未设置** | **阻塞项**（仅 browser 门禁需要） |
| `.env` | 不存在 | 按 `.env.example` 建 ignored 本地 `.env`（不含真值样板已在仓库） |

### 2.2 密钥与版本核对方法（不写真实密钥）

- 密钥存在性/前缀（只回显判断结果）：

```bash
case "${STRIPE_SECRET_KEY:-}" in
  '') echo 'BLOCKED: STRIPE_SECRET_KEY unset' ;;
  sk_test_*) echo 'ok: test-mode secret key' ;;
  *) echo 'REFUSED: non-test key' ;;
esac
case "${STRIPE_PUBLISHABLE_KEY:-}" in
  '') echo 'BLOCKED: STRIPE_PUBLISHABLE_KEY unset (browser gate only)' ;;
  pk_test_*) echo 'ok: test publishable key' ;;
  *) echo 'REFUSED: non-test publishable key' ;;
esac
```

- 补法：Stripe Dashboard（test mode）→ Developers → API keys，取 `sk_test_` / `pk_test_` 写入 ignored `.env` 或 secret manager 后 `source`；绝不 echo、不进 shell history 明文、不 commit。
- webhook secret：**本轮 real suite 与 Test Clock 不需要 `whsec_`**（它们走 Event 轮询 + 本地 processor，不走签名投递）。browser 门禁的 `whsec_` 由 runner 自动获取（endpoint 模式来自临时 endpoint 创建返回、存 0600 临时文件；stripe_cli 模式从 listener 日志提取并自动 redact），无需人工配置。手动 `stripe listen` 仅用于开发调试，非本轮必需。
- API version pin 三方核对：出站请求 `STRIPE_API_VERSION=2026-06-24.dahlia`（代码与测试硬编码一致）；endpoint 模式 `E2E_STRIPE_EVENT_API_VERSION=2026-06-24.dahlia`；stripe_cli 模式必须现场从 listener 输出读实际 Event 版本再显式传入（历史观测 `2025-12-15.clover`，**不许盲抄**，脚本会校验不一致即退出）。
- CLI 鉴权探活（不打印密钥、只读一条 Event）：`STRIPE_API_KEY="$STRIPE_SECRET_KEY" stripe events list --limit 1 >/dev/null && echo authed`。
- 目录/Portal 就绪：`uv run python scripts/bootstrap_stripe.py --verify-only`（幂等；若账户未 bootstrap 先跑无 `--verify-only` 版本，属 run 前置而非清理对象）。

### 2.3 网络前置

- 全部真实层需要出网 `api.stripe.com:443`。
- endpoint 模式额外需要 trycloudflare.com 出网 + Stripe→Quick Tunnel 回程可达（脚本会先 preflight 公网 `/health`，失败会在建立任何有状态 Checkout 之前退出）。受限网络下先跑 stripe_cli 模式并如实降级报告证据层。

## 3. 回归矩阵

阻塞风险：低 = 无网络或本机已验证；中 = 依赖出网/密钥；高 = 依赖出网 + 回程/多进程编排。

| # | 场景 | 命令（均先 `export PATH="$HOME/.local/bin:$PATH"` 且过 key 守卫） | 期望证据 | Test Clock 跳跃 | 阻塞风险 |
| --- | --- | --- | --- | --- | --- |
| R0a | 无密钥预检：标记收集 | `uv run pytest -m real_stripe --collect-only -q` | `9/733 tests collected`，9 个用例 ID 与 §1.1 一致；仅收集证据 | 否 | 低（已于 2026-08-26 实测通过） |
| R0b | 脚本语法 + fail-closed 拒绝 | `bash -n scripts/run_test_clock_e2e.sh scripts/run_browser_e2e.sh`；随后在**不设 key** 的子 shell 里分别运行两脚本 | 语法 0 错；两脚本均以 exit 2 拒绝并打印要求 `sk_test_` 的提示，未发起网络调用 | 否 | 低 |
| R0c | mocked 本地基线（分层第 0 层） | `uv run pytest -m "not real_stripe"` | 全部通过（当前树参考量级 ~724 例）、9 个 real_stripe deselected、PG 并发用例真实执行未被跳过、`test_checkout_promo_prohibition.py` 通过；**报告为 mocked 层** | 否 | 低（需 Docker） |
| R0d | 目录/Portal 校验 | `uv run python scripts/bootstrap_stripe.py --verify-only` | 六个测试 Price + 专用 Portal 配置与 `plans.toml` 一致；输出不含密钥 | 否 | 中（需 sk_test_ + 出网） |
| R1 | 默认真实 API 套件（9 例全量，含失败路径 4 例与 Test Clock 用例） | `uv run pytest -m real_stripe -v`（后台运行 + 轮询日志，见 §4 Wave 1） | `9 passed`（0 skip——skip 必须报为 not-run）；每用例清理断言与零库存断言通过；日志无 `sk_`/`whsec_`；失败路径 4 例证明旧授信保持 + durable incident | 否（该套件内 clock 用例含跳跃，但证据归 R2 专项复跑） | 中（出网 + Event 轮询 45s 上限/对象） |
| R2 | Test Clock 跨期/续费专项（恢复清单保护） | `scripts/run_test_clock_e2e.sh` | exit 0；+32d slot 2、≈+190d 仅当前 slot 无回填、`period_end+1h` 续费重置 slot 1/300 并延长授权期；恢复目录被自动删除（残留即失败） | **是**（+32d → ≈+190d → period_end+1h 三段跳跃） | 中（clock `advancing→ready` 等待，单例最长） |
| R3 | browser 门禁 `full_period_reset`（endpoint 模式） | `E2E_STRIPE_EVENT_API_VERSION=2026-06-24.dahlia E2E_TRANSITION_POLICY=full_period_reset E2E_POSTGRES_IMAGE=public.ecr.aws/docker/library/postgres:17-alpine scripts/run_browser_e2e.sh` | 末行 `browser Stripe Checkout, full_period_reset upgrade, and signed webhook E2E passed`；decline→3DS→Starter/300→升级→Pro/1,000；恰 3 个 essential Events、无未解决 incident、无 delta 分配；临时目录被删 | 否 | 高（Quick Tunnel 回程） |
| R4 | browser 门禁 `prorated_delta`（endpoint 模式） | 同 R3，`E2E_TRANSITION_POLICY=prorated_delta` | 同上但含恰一条 700-credit delta 分配 | 否 | 高 |
| R5 | browser 兜底 transport（仅当 R3/R4 因隧道失败） | `E2E_WEBHOOK_TRANSPORT=stripe_cli E2E_STRIPE_EVENT_API_VERSION=<listener 实测值> E2E_TRANSITION_POLICY=<policy> scripts/run_browser_e2e.sh` | 同 R3/R4 的浏览器与数据库断言；**如实标注为 CLI transport 证据，不得报 endpoint metadata 证据** | 否 | 中 |

关键失败路径说明：现有脚本已内建覆盖——R1 内 4 例参数化失败升级（认证要求/扣款失败 × 两策略）+ browser 门禁的拒付卡与 3DS 强制路径；无需另造失败注入脚本，禁止为覆盖率临时改脚本。

## 4. 执行顺序（Wave）

模型分配：规划/执行子代理用 **fable**；每波证据复核用 **gpt-5.6-sol-xhigh**（只读）。串行推进，前波失败或被阻塞时后波不得开始（阻塞时按 §6 报 not-run）。

- **Wave 0（只读勘察 / dry-run，fable）**：R0a → R0b → R0c → R0d。无密钥时 R0a–R0c 照跑，R0d 记 `blocked: STRIPE_SECRET_KEY unset`。产出：环境快照 + 分层第 0 层证据。
- **Wave 1（真实 API 套件，fable）**：R1。因 MCP 单命令 300s 上限，须以 `nohup uv run pytest -m real_stripe -v > /tmp/stripe-regression-logs/real-suite.log 2>&1 &` 后台运行（日志目录 0700，仅存 pytest 输出，勿写密钥），轮询 `tail` 直至出现汇总行；总时长可能 15–40 分钟（含 clock 用例与 Event 轮询）。
- **Wave 2（Test Clock 专项，fable）**：R2，同样后台 + 轮询。虽与 R1 的 clock 用例重复一次运行，但专项复跑验证 wrapper 守卫与恢复清单路径，成本可接受。
- **Wave 3（browser 双策略，fable）**：R3 → R4 串行（各自独立随机端口与容器，但避免并发争用 Stripe 账户目录）；隧道失败则 R5 兜底并降级标注。
- **Wave 4（复核，gpt-5.6-sol-xhigh，只读）**：核对四层证据不串层、日志无密钥、inventory=0、每行矩阵状态与原始输出一致；产出最终分层报告。

## 5. 每波子代理 prompt 要点（可直接派单）

通用头部（每单都贴）：

> 仓库 `/root/work/stripe-entitlements-fastapi`，分支 `cursor/stripe-promo-ui-expand-7789`。先读 AGENTS.md 与 docs/plans/LOCAL_STRIPE_REAL_REGRESSION.md §全局硬约束。每个 shell 先 `export PATH="$HOME/.local/bin:$PATH"`。任何网络调用前跑 sk_test_ 守卫；永不打印/提交 sk_/rk_/whsec_；不修改任何被测代码、测试断言或脚本；只清理本 run 创建对象；报告按层标注，未跑/跳过必须写明原因，禁止把 skip、collect、--list 说成执行证据。

- **Wave 0 单**：目标 = 完成 R0a–R0d 并输出环境快照表（§2.1 格式）。要点：R0b 需在 `env -u STRIPE_SECRET_KEY` 子 shell 验证两脚本 exit 2；R0c 完整跑 mocked 套件并给 pytest 汇总行原文；R0d 无 key 时记 blocked 不得伪造；产出物 = 一份带命令原始输出摘录（截密钥）的勘察报告。
- **Wave 1 单**：目标 = R1 九例全过。要点：先 `uv sync --frozen` 与 key 守卫；nohup 后台 + `tail -f` 轮询；若任何用例 fail/error，保留完整日志（先确认无密钥再摘录）、记录失败用例的 `run_id`（日志中 metadata/幂等键可见）并立即按 §6.1 清扫核账；`9 skipped` 视为 not-run 而非通过；报告须含最终汇总行原文与零库存断言结论。
- **Wave 2 单**：目标 = R2 通过且恢复目录自动删除。要点：wrapper 退出码为准；失败/中断时**不要删除** `/tmp/stripe-entitlements-test-clock.*`，先读 `recovery.json`（secret-free）按 §6.2 顺序手工清理并复核零库存，再报告残留处置；须在报告中列出三段时间跳跃各自的断言结果。
- **Wave 3 单**：目标 = R3、R4 各自末行 pass + verify-database 通过。要点：显式传 `E2E_POSTGRES_IMAGE`；每策略独立运行不并发；隧道 60s 内未出 URL 即判 endpoint 模式受阻，转 R5 并从 listener 日志读实际 Event 版本传入（读时用 `rg -o` 只取版本号，勿全量 cat 日志到报告）；失败时保留 `/tmp/stripe-entitlements-browser-e2e.*` 与 `web/test-results/` trace（视为私密证据，不外贴）；报告必须区分 endpoint / stripe_cli 证据层级。
- **Wave 4 单（gpt-5.6-sol-xhigh）**：目标 = 只读复核。要点：逐行核对矩阵状态与原始日志一致；抽查日志中无 `sk_`/`whsec_`/DSN；确认零库存断言与恢复目录/清单最终状态；确认报告未把 mocked 层、Event 轮询层、CLI transport 层、endpoint 层互相冒充；输出最终报告 + 遗留风险清单。复核不执行任何 Stripe 写操作。

## 6. 失败与清理 SOP

### 6.1 real 套件（R1）中断/失败

1. 正常路径：每用例自带 cleanup + 全分页 sweep + 零库存断言，清理失败即用例失败——先看断言输出而非直接手清。
2. 进程级中断（kill/断网）：从日志取该用例 `run_id`；用只读列表（带 `--limit 100` 全分页）按 metadata `run_id=<id>` / `automated_test=true` 盘点 Subscription、Customer、Price、Product、Schedule、Test Clock；仅对匹配对象执行 cancel/delete/deactivate，Test Clock 最后删；再全量重列确认该 `run_id` 零库存。
3. 无法确认归属的对象**一律不动**，记入报告的遗留风险清单。

### 6.2 Test Clock wrapper（R2）中断/失败

1. wrapper 已保留 `/tmp/stripe-entitlements-test-clock.*/recovery.json`（0600、secret-free、含逐对象 ID）。
2. 按清单顺序手清：Subscription（cancel）→ Customer（delete）→ Price/Product（deactivate/delete）→ Schedule（release/cancel 未完成的）→ **Test Clock 最后 delete**（删 clock 会级联删 clock 上对象，仍须逐项核对）。
3. 复核零库存后删除恢复目录；报告中记录「恢复清单路径、处置动作、复核结果」。

### 6.3 browser 门禁（R3–R5）中断/失败

1. 读取保留目录 `/tmp/stripe-entitlements-browser-e2e.*` 的 `cleanup-manifest.json`（secret-free）。
2. 依次执行（均带 `STRIPE_API_VERSION=2026-06-24.dahlia`）：`uv run python scripts/e2e_stripe.py cleanup-account --database-url <manifest 中 DSN 不存在时用当次运行值> --external-ref <manifest 值>`；`delete-webhook --endpoint-id <id>` 或未知创建结果时 `delete-webhook-by-description --description <值> --url <值>`；`docker rm -f stripe-entitlements-browser-e2e-pg-<pid>`；确认未完成 Checkout Session 已过期。
3. trace/video 留在 ignored `web/test-results/`，作为私密证据不外发。

### 6.4 报告纪律（inventory=0 与未跑声明）

- 每个 Wave 报告末尾必须有「run-owned inventory = 0」结论及其依据（零库存断言输出、手清后的重列结果，或「本波未创建真实对象」）。
- 每个矩阵行状态 ∈ {passed, failed（附原始失败摘要）, blocked（缺什么）, not-run（为何未到达）}；skip 记 not-run。
- 疑似日志含密钥：browser listener 日志已自动 redact；其余场景立即停用该日志文件、不摘录，并在报告标注；若确认 `sk_test_` 外泄到持久文件，建议在 Dashboard roll key（此为用户动作，代理只提示）。

## 7. 明确不做

- **不做促销码/优惠券兑换**：不向 Checkout 传 `allow_promotion_codes`，不建 Coupon/Promotion Code 对象，不跑 [PROMOTION_CODES.md](../PROMOTION_CODES.md) Phase 2 门禁；invariant 16 的 fail-closed 行为原样保留。
- **不碰 live mode**：不用 `sk_live_`、不跑 `bootstrap_stripe.py --allow-live`、不建 live endpoint；测试通过不得表述为 live 证据。
- **不削弱 fail-closed**：不为通过而放宽任何拒绝路径、不 mock 真实门禁、不跳过/串行化 PostgreSQL 并发测试。
- **不做全账户清扫**：清理严格限定 run-owned 对象；不动非本 run 的任何 Stripe 对象或他人 webhook endpoint。
- **不改被测代码**：本轮为回归验证，仅允许改 `docs/plans/`（报告/计划）；发现产品缺陷记录并上报，不顺手修。
- **不跨层冒充证据**：mocked ≠ 真实 API ≠ Test Clock ≠ browser；Event 轮询 ≠ 签名投递；CLI transport ≠ endpoint metadata；本轮任何结果 ≠ live 生产证据。

## 附：当前已知阻塞项

| 阻塞项 | 影响范围 | 补救 |
| --- | --- | --- |
| `STRIPE_SECRET_KEY` 未设置 | R0d、R1–R5 全部真实层 | 用户在本机 ignored `.env`/secret manager 注入 `sk_test_`；注入前只能执行 R0a–R0c 预检 |
| `STRIPE_PUBLISHABLE_KEY` 未设置 | R3–R5 | 同上注入 `pk_test_` |
| Quick Tunnel 回程未验证 | R3/R4 endpoint 模式 | 脚本自带 preflight；失败走 R5 stripe_cli 兜底并降级标注 |
| `uv` 不在默认 PATH | 所有波 | 每 shell `export PATH="$HOME/.local/bin:$PATH"` |

无密钥期间可完成的预检 = R0a（收集 9 例）、R0b（语法 + fail-closed 拒绝）、R0c（mocked 基线含 PG 并发与 promo 禁用守卫）。以上三项不构成任何真实网络证据，报告时按 §6.4 标注。
