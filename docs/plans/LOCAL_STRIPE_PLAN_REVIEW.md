# 本地 Stripe 真实回归计划复核

复核日期：2026-08-26

## 结论

**阻塞，当前不能批准执行。** `docs/plans/LOCAL_STRIPE_REAL_REGRESSION.md` 仍不存在；本次实际
复核输入是并行代理随后提交的
[`LOCAL_STRIPE_PRECHECK.md`](LOCAL_STRIPE_PRECHECK.md)（commit `1911eb2`）。PRECHECK 是可靠的
无密钥环境盘点和用例收集记录，但不是包含命令顺序、成功判据、分层证据和失败恢复的真实
回归执行计划。

本复核没有运行真实 Stripe 网络，也没有自行读取或打印密钥值。PRECHECK 仅检查存在性与
前缀，并报告 `STRIPE_SECRET_KEY`、`STRIPE_PUBLISHABLE_KEY` 均未设置。

### PRECHECK 覆盖判定

| 必审项 | 判定 | 说明 |
| --- | --- | --- |
| `real_stripe` 九用例 | **已覆盖（仅收集）** | 无网络 `--collect-only` 确认 9 个 node id，含 2 × 2 失败付款矩阵；尚未执行 |
| Test Clock 时光跳跃 | **部分覆盖** | 记录 wrapper、key guard 和 recovery manifest，但未写 `+32d`、约 `+190d`、`period_end + 1h` 及逐阶段断言 |
| browser 双策略 | **部分覆盖** | 列出两个允许值，但未要求两次独立运行及各自成功判据；也未明确 policy 与 transport 是两个维度 |
| 清理 `inventory=0` | **未充分覆盖** | 只概述“全量清理”，没有 run-owned 六类库存、完整分页、unknown-create sweep 与 cleanup-failure 判负矩阵 |
| 分层证据 | **未覆盖** | 没有规定 local、real API polling、browser signed transport、endpoint metadata、manual/live 的独立结论与版本字段 |
| 禁止促销码 | **部分覆盖** | 只声明预检未触碰 `allow_promotion_codes`，没有把省略参数、不得创建/兑换 Coupon/Promotion Code 写成执行不变量 |

此外，PRECHECK 已确认三个实际执行阻塞：缺少 `sk_test_` secret、缺少 `pk_test_`
publishable key、缺少 `uv`。因此即使补齐计划，也必须先以不泄密方式解除这些条件；在此之前
不得尝试网络门禁。

未来计划或扩充后的 PRECHECK 至少必须逐项满足下面的覆盖矩阵。依据是现行
[`docs/TESTING.md`](../TESTING.md)、[`docs/STRIPE_CLI.md`](../STRIPE_CLI.md)、
[`docs/BROWSER_E2E.md`](../BROWSER_E2E.md) 与
[`tests/real/test_stripe_test_mode.py`](../../tests/real/test_stripe_test_mode.py)。

## 必须覆盖的验收矩阵

### 1. `real_stripe` 九用例

计划必须把“九用例”写成可核对的收集矩阵，而不只是写一个 pytest 命令。当前代码是六个
测试函数，其中失败付款测试按两种付款方式和两种变更策略做 2 × 2 参数化，因此合计九个
pytest case：

1. 真实 `invoice.paid` 后投影 300 credits，再做 $9.50 部分退款并收敛到 150；
2. Starter Monthly → Pro Monthly 的 `full_period_reset`，无按比例计费，Paid Event 投影到
   1,000；
3. Starter Monthly → Pro Monthly 的 `prorated_delta`，验证两行升级 Invoice、700-credit
   allocation、全额退款后回到 Starter/300 且保留原 funding lineage；
4. `full_period_reset` × `pm_card_authenticationRequired` 失败更新；
5. `full_period_reset` × `pm_card_chargeCustomerFail` 失败更新；
6. `prorated_delta` × `pm_card_authenticationRequired` 失败更新；
7. `prorated_delta` × `pm_card_chargeCustomerFail` 失败更新；
8. Starter Yearly → Pro Yearly 的 period-end 两阶段 contiguous Schedule，且
   `end_behavior=release`；
9. 年度 Test Clock 的 slot、停机跳跃及续费生命周期。

执行前必须先做 fail-fast key guard：只接受 `sk_test_`，缺失、格式错误或 `sk_live_` 都要在
pytest 和任何网络请求之前失败。不能把缺少密钥导致的 skip 记成通过。结果证据应记录
“collected=9、passed=9、failed=0、skipped=0”，并保留每个 node id；只报告六个函数名会
掩盖四格参数矩阵缺失。

### 2. Test Clock 时光跳跃

计划必须单列 `scripts/run_test_clock_e2e.sh`，不能用普通订阅等待代替时光跳跃。至少要写明：

- 初始年度付款处理为 slot 1；
- frozen time 前进 `+32 days`，等待 clock 进入 `ready` 后授予 slot 2；
- 直接跳到约 `+190 days`，只授予当前计算 slot，不回填错过的每个月；
- 前进到原始 `period_end + 1 hour`，等待真实 paid renewal Invoice/Event；
- 新 funding Invoice 从 slot 1 重新开始，额度为 300，entitlement period 延后且仍 active、
  non-revoked、enforceable；
- 每次 advance 都要有有限超时、`ready` 状态检查和远端 Subscription 快照校验；
- Test Clock 必须最后删除。

Event polling 只证明 Stripe 对象形状和 PostgreSQL 投影，不证明签名 webhook 传输或任意投递
顺序；证据结论必须保留这个边界。

### 3. Browser 双策略

“browser 双策略”必须明确指两次独立、串行且隔离的运行：

- `E2E_TRANSITION_POLICY=full_period_reset`；
- `E2E_TRANSITION_POLICY=prorated_delta`。

两次都要经过 Free/0、同一 Checkout Session 的 decline 稳定屏障、3DS 成功、
Starter/Monthly/300 webhook 投影、UI preview/confirm、升级 SCA、Pro/Monthly/1,000 投影，
并验证恰好三个 identity-bound essential Events、策略对应 allocation、无相关 unresolved
incident 和严格清理。重定向、SCA 完成或页面文案不能代替 `/api/account` 与 PostgreSQL 投影
证据。

计划还要把“策略”与“传输模式”分开：默认 temporary endpoint 是较强发布证据；
`stripe_cli` 只是 Quick Tunnel 不可用时的显式本地诊断/录制备选。CLI 模式不能被描述成
Webhook Endpoint metadata 或 endpoint version-pin 证据。若本次只跑 CLI，必须将 endpoint
层标成未运行，而不是继承 2026-08-02 的历史结果。

### 4. 清理与 `inventory=0`

每个网络场景必须使用唯一 run ID，只清理本次运行拥有并标记的对象。计划必须要求：

- create 成功后立即原子记录对象 ID；未知 create 结果通过 run marker 扫描恢复；
- 所有 list/sweep/inventory 操作完整 auto-pagination；
- 先清理 Subscription/Schedule/Customer，再停用 Price、删除或停用 Product，并最后删除
  Test Clock；browser endpoint 模式还要清理本次 Webhook Endpoint；
- 清理后重新遍历每一页，要求本 run 的 non-canceled Subscriptions、Customers、active
  Prices、active Products、Test Clocks、unfinished Schedules 均为 0；
- 这是 **run-owned inventory=0**，不是要求共享 test account 的全局库存为 0，也不能删除
  无 run marker 的对象；
- cleanup、pagination、inventory 或 zero assertion 任一失败，整个场景必须失败；
- 中断、skip、清理失败或 inventory 不确定时保留 mode-`0700` 恢复目录和 mode-`0600`、
  无秘密的 manifest，并给出人工恢复入口。

### 5. 分层证据

计划和最终报告必须分别记录，不得跨层借证：

1. network-free backend/PostgreSQL 与 frontend 门禁；
2. 九个 real Stripe case：直接 test-mode API/Event polling；
3. 两个 browser policy gate：真实 Checkout/3DS/SCA、签名传输、UI 与 PostgreSQL；
4. endpoint metadata/version-pin 与 Stripe CLI signed-forwarding 两种传输证据；
5. 手工观察和 live production（本轮默认均未运行）。

至少分别记录 outbound request API version、endpoint signed-payload API version、Event API
retrieval view version、stripe-python/PostgreSQL 版本、命令、开始/结束时间、case 计数、清理
结果、跳过项及原因。不能把历史 `0.2.2`、2026-08-18 或 2026-08-02 的通过结果写成本次
通过，也不能把 Event API retrieval view 当成 signed payload version。

原始日志、trace、截图、视频和恢复 manifest 都按私有证据处理；公开摘要不得含 `sk_*`、
`rk_*`、`whsec_*`、client secret、数据库 DSN、hosted recovery URL 或可复用对象 URL。

### 6. 禁止促销码

本回归不是促销码验收。计划必须显式禁止：

- Checkout Session 传 `allow_promotion_codes`；
- 创建或兑换 Coupon/Promotion Code；
- 通过折扣 Invoice 扩大当前允许的 payload 形状；
- 把 [`docs/TESTING.md`](../TESTING.md) 的 “Promo future gates” 描述为已执行。

计划应在网络前的 deterministic gate 验证 Session 参数仍省略
`allow_promotion_codes`，并在结果中记录“未创建、未兑换促销码”。Stripe 账户里即使存在与
本 run 无关的 Coupon/Promotion Code，也不能使用或删除它们。发现意外 discount 时应
fail closed、保留可恢复证据并停止该场景，不能为了完成回归而放宽解析或 entitlement
规则。

## 缺口与风险

1. **P0：执行计划缺失。** 已有 PRECHECK，但目标计划不存在；PRECHECK 没有给出完整命令顺序、
   超时、证据目录、逐阶段成功判据和失败恢复编排。补齐计划或扩充 PRECHECK 后必须重新复核。
2. **P0：当前环境不可执行。** PRECHECK 明确报告两类测试密钥未设置且 `uv` 缺失；直接运行
   wrapper 会在入口退出，直接跑 pytest 则可能因无 secret 全部 skip，不能记成通过。
3. **九用例计数歧义。** 六个函数容易被误报为六个 case，或漏掉 failed-payment 的四格
   参数矩阵；应以 pytest collected node ids 和 9/9 结果为准。
4. **时钟推进假阳性。** 未等待 `ready`、把约 +190 天拆成逐月 advance，或不检查
   “current slot only” 都无法证明停机无回填语义。
5. **browser 双策略与双传输混淆。** 两种 policy 都必须跑；endpoint 与 CLI 是另一维度。
   用 CLI 结果声称 endpoint metadata 已验证属于证据越界。
6. **清理范围错误。** 把 `inventory=0` 理解为共享账户全局为零会误删他人对象；只检查
   已记录 ID 又会漏掉 unknown-create outcome。必须完整分页后按唯一 run marker 归属。
7. **历史结果冒充当前结果。** 文档里的 2026-08-18/2026-08-02 只可作为基线，不可替代
   当前 checkout、test clock 或 payload shape 的实际运行。
8. **API 版本混写。** Dahlia outbound pin、endpoint signed snapshot 与 Clover Event API
   retrieval view 是三个独立字段；合并成一个 `stripe_api_version` 会产生错误结论。
9. **促销能力意外扩张。** browser 测试若为了“覆盖 Checkout”开启促销码，会改变当前产品
   契约，并可能触发“已收款但 discount shape fail-closed、零权益”的高风险路径。
10. **秘密与对象标识泄漏。** `-v` 输出、Stripe CLI 日志、Playwright trace 和恢复文件的
   处理规则若不明确，可能把测试密钥、签名 secret、client secret 或可复用 URL 带入提交。
11. **环境隔离不足。** real suite 与 browser suite 必须使用 disposable PostgreSQL、唯一
    account subject/run ID；并行运行或复用已有 entitlement/Checkout claim 会导致污染和
    错误归因。

## 重新复核准入条件

`docs/plans/LOCAL_STRIPE_REAL_REGRESSION.md` 落盘或 PRECHECK 扩充为完整执行计划后，应至少
包含：上述六类门禁的逐项命令、先决条件、fail-fast guard、串行/隔离策略、有限超时、证据
输出位置、严格清理与恢复流程、成功判据及明确的未覆盖声明。在重新复核通过且三项环境阻塞
解除前，不应启动任何真实 Stripe 网络运行。
