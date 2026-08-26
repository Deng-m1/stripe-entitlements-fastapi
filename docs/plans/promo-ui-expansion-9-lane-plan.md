# 9 路并行工单：促销能力 Phase-1 + 前端品牌强化（cursor/stripe-promo-ui-expand-7789）

规划日期：2026-08-26。集成分支：`cursor/stripe-promo-ui-expand-7789`（基于 9620941）。
本文件未提交，仅作父代理派单参考；权威内容以派单 prompt 为准。

## 父代理覆盖决议（2026-08-26，优先于下文 D 路）

基于 `gpt-5.6-sol-xhigh` 只读评审，**本集成分支当前 Phase-1 不实现可开启的 Checkout 促销收款**：

- **禁止**向 Stripe Checkout Session 传入 `allow_promotion_codes`（含默认关闭的 feature flag 接线）。
- **禁止**在未完成「持久化促销授权 + Invoice gross/discount/net 校验 + 固定 catalog credits + 退款/乱序/并发矩阵」前放宽 `has_unsupported_invoice_adjustments`。
- 本分支已落地：UI/文档/测试门禁（`TEST_GATES_PROMO_UI.md`、`test_invoice_policy.py`、gateway 断言 Session 永不含该参数）。
- 下文 D 路「flag + 受限允收原子落地」降级为 **Phase-1b / 显式后续波次**，不得在本分支并行偷偷接线；若要做须单独评审并默认关且测试完备后再合入。
- 原文勘察事实仍有效；仅执行优先级以此决议为准。

## 勘察结论（所有路共享的事实）

1. Checkout Session 创建位于 `src/stripe_entitlements/stripe_gateway.py` `create_checkout_session`（约 522–600 行），当前不传 `allow_promotion_codes`。
2. `src/stripe_entitlements/invoice_policy.py::has_unsupported_invoice_adjustments` 对任何 tax/discount/balance/credit-note 参与（含零值对象）一律判不支持，调用点：
   - `stripe_gateway.py:967`（preview 事实门槛，`discount_amount==0` 才 immediate-eligible，另见 `plan_changes.py:288,302`）；
   - `processor.py:720`（首购/full-period `invoice.paid` 路径 → `invoice_catalog_amount_mismatch` incident，不授予）；
   - `processor.py:1524`（prorated-delta 结算票 → fail closed）。
3. 因此：仅开 `allow_promotion_codes` 而不扩展首票允收 = 客户按折扣付款、权益不授予、只有 incident。Phase-1 必须原子落地「flag + 受限允收 + 文档 + 四类测试」。
4. 首票授予的信用额来自目录（`plans.toml` monthly_credits），与现金无关；折扣只改变现金，不改变权益差额——这与不变量 §14「现金与权益维度分离」一致。
5. 退款收敛按折后 `amount_paid` 作分母；100% off 使分母为 0，Phase-1 拒收。
6. 年票资助 12 个月度 slot 且退款单调递减 slot（`annual.py`），折扣影响该算术——Phase-1 仅月度 Session 开 flag。
7. `allow_promotion_codes=True` 无法在 Stripe 侧限制 coupon duration/形状；账户内任何活跃促销码都可被输入。服务端允收是唯一兜底：不合规形状 → 既有 fail-closed（收了钱、无权益、有 incident）。运营约束 + bootstrap 校验（F 路）+ 文档（G 路）必须同步。
8. 前端为单一 `web/app/globals.css`（800 行，token：`--brand:#2055d6` 等，Inter）；组件测试集中在 `web/components/BillingScreens.test.tsx`（838 行）与 `web/app/seo.test.tsx`。
9. 门禁命令：后端 `uv run ruff format --check . && uv run ruff check . && uv run mypy src && uv run pytest -m "not real_stripe"`；前端 `cd web && npm run lint && npm run typecheck && npm test && npm run build`；最后 `git diff --check`。
10. README/FAQ/SEO/JSON-LD 多处宣称「不含 coupons」；Phase-1 合并后必须一致性刷新（G 路），且不得夸大边界。

## 分支与并行策略

- 每路子代理用 tosea `open_workspace` `mode=worktree`、`baseRef=cursor/stripe-promo-ui-expand-7789`，各自分支 `cursor/promo-<lane>-7789`（全小写）。
- 合并顺序：Wave1 {A,B,C,D,E} → 合 D、B、C → Wave2 {F,H,I} → 合 F、H、I → Wave3 {G}。每次合回集成分支后，未启动的路以最新集成分支为 baseRef。
- 文件独占约定（防冲突热点）：`globals.css`/`page.tsx`/`layout.tsx`=B；`web/components/*.tsx`+`BillingScreens.test.tsx`+`web/lib/types.ts`=C（组件样式一律 CSS Modules 新文件）；`src/*.py`+`INVARIANTS.md`+`PLAN_TRANSITIONS.md`=D；`docs/plans/promotions-phase2-design.md`=E；`app.py`/`catalog.py`/`bootstrap_stripe.py`=F（D 后）；tests 新文件=H；web 测试新文件+`mock-api.ts`+e2e 选择器=I；README/FAQ/SEO 刷新=G（最后）。

## 九路工单摘要

| 路 | 简称 | 模型 | Wave | 依赖 |
| --- | --- | --- | --- | --- |
| A | 现状只读评审 | gpt-5.6-sol-xhigh | 1 | 无 |
| B | 品牌与落地页视觉 | claude-fable-5-thinking-xhigh | 1 | 无 |
| C | Pricing/Account 体验 | claude-fable-5-thinking-xhigh | 1 | 无（token 契约见下） |
| D | 促销 Phase-1 最小安全切片 | claude-fable-5-thinking-xhigh | 1 | 无 |
| E | 促销 Phase-2 设计文档 | claude-fable-5-thinking-xhigh | 1 | 无 |
| F | 促销配置面/目录支撑 | claude-fable-5-thinking-xhigh | 2 | D |
| H | 后端测试补强 | gpt-5.6-sol-xhigh | 2 | D（参考 A 报告） |
| I | 前端回归/E2E 加强 | gpt-5.6-sol-xhigh | 2 | B、C |
| G | 文档与不变量一致性刷新 | claude-fable-5-thinking-xhigh | 3 | D、F、B |

各路完整目标/文件范围/不做清单/验收标准见父代理派单 prompt（与本仓库勘察结论一致）。

## D 路允收形状（规范草案，供 D/H/G 引用）

仅当 `BILLING_CHECKOUT_PROMOTION_CODES=true`（默认 false）：
- 仅 `interval == month` 的 Checkout Session 传 `allow_promotion_codes=True`；年度 Session 永不传。
- `invoice.paid` 首票（`grant_slot=1`、Checkout 授权路径）允收扩展，全部条件同时成立才放行：
  1. 恰一条订阅目录行；`line_amount == 目录月度全额`；`subtotal == 目录月度全额`；`quantity == 1`；币种与目录一致；
  2. 发票级 `total_discount_amounts` 恰一项、与行级 `discount_amounts` 一致，`0 < discount_total < subtotal`；
  3. `total == amount_paid == amount_due == subtotal - discount_total`，`amount_paid > 0`；
  4. 折扣来源 coupon 经允收校验：`percent_off` 型、`duration == "once"`、同币种；无法证实 → 拒绝；
  5. tax/balance/credit-note/pagination/payment-shape 等其余守卫原样保留；
  6. 授予信用额不变（目录 `monthly_credits`），现金折扣不改变权益。
- 任何不满足 → 既有 `invoice_catalog_amount_mismatch`/incident fail-closed 路径，不得静默放行。
- 计划变更（full_period/delta 结算票）、renewal、annual、reconciler 之外来源的折扣形状全部维持拒绝；reconciler 合成 `invoice.paid` 必须走同一允收函数。

## 风险清单

1. 已收款未授予（最高风险）：flag 开而允收未落地/形状不允 → 折扣扣款、零权益、仅 incident。缓解：D 原子落地、默认关、运营允诺文档、incident 可重放。
2. §14 冲击：repeating/forever coupon 会污染 plan-change 结算票与 renewal 票 → preview↔paid 绑定（要求 discount_amount==0）失配 → intent 卡死/incident。Phase-1 只允 duration=once，deeper 方案归 E。
3. Stripe 侧无法约束可输入的促销码形状：兜底=服务端允收 + F 路 bootstrap `--verify-only` 扫描不合规活跃促销码并告警。
4. 年票 12-slot funding 与退款 slot 递减算术未对折扣验证 → 年度 Session 不开 flag。
5. 折后退款收敛/clawback debt/dispute-before-paid 的分母变化 → H 路必测（含真并发）。100% off 拒收。
6. Clover vs Dahlia 两种 Event 快照的 discount 字段形状差异 → D/H 双 fixture 测试；触及 payload parsing → 新增 real_stripe 形状用例（存在≠已运行，发布门禁再跑）。
7. 并行冲突热点：globals.css、types.ts、config.py/app.py、INVARIANTS/PLAN_TRANSITIONS、page.tsx、BillingScreens.test.tsx——按上文件独占表切分 + worktree。
8. 文案真实性：现有多处「无 coupons」声明与 Phase-1 矛盾；G 必须精确改写（monthly Checkout 首票 + allowlist 形状 + 其余 fail-closed），不得夸大，且证据表只记录实际运行过的层。
