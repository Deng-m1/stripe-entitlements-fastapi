# Wave 5 终审

审查分支：`cursor/stripe-promo-ui-expand-7789`

审查基线：`origin/main`（`96209417fade1d57b7a42f5cc507ec1aea69fb21`）

审查提交：`b2b286ec584ac6f1a97c74b0964d08853338892e`

## 结论

**通过，无阻断项。** 当前分支没有向 Checkout Session 传入
`allow_promotion_codes`，也没有可由 `Settings`、环境变量、网关构造参数或方法参数开启的
促销码旗标。禁止门禁与折扣 Invoice fail-closed 门禁通过。Landing、Pricing 和 Account
页面的公开文案与实际能力一致，没有宣称支持 coupons 或 promotion codes。

## 通过项

- 已刷新远端引用并检查 `git log origin/main..HEAD`：分支包含 14 个提交，`HEAD` 与
  `origin/cursor/stripe-promo-ui-expand-7789` 一致。
- `git diff origin/main...HEAD --stat`：31 个文件，2,777 行新增、203 行删除；主要为
  Web 展示、组件测试、禁止门禁和促销范围文档。
- `src/stripe_entitlements/stripe_gateway.py` 的 Checkout Session `params` 无
  `allow_promotion_codes` 和 `discounts`；仅新增说明该不变量的注释，没有新增促销业务接线。
- `src/stripe_entitlements/config.py` 无促销码 Settings 字段；`.env.example` 明确说明不存在
  `CHECKOUT_ALLOW_PROMOTION_CODES` 开关。
- `tests/test_checkout_promo_prohibition.py` 覆盖：
  - Starter/Pro/Ultra、月付/年付、新客户/已有客户的 Session 参数均省略
    `allow_promotion_codes` 和 `discounts`；
  - `StripeGateway` 构造签名、`create_checkout_session` 签名和实例属性均无可开启入口；
  - `Settings` 无 `checkout_allow_promotion_codes` 字段，环境变量及显式额外参数均不能开启；
  - 任意折扣对象、折扣列表以及零或非零折扣金额仍触发 Invoice fail-closed。
- 公开范围抽查通过：
  - Landing FAQ 和范围说明明确 coupons 不在已实现范围；年度 savings 被描述为目录价算术，
    不创建或声称创建 Stripe Coupon；
  - Pricing metadata 与比较区明确年度价差来自目录价格，不创建或模拟 Coupon/促销码；
  - Account 只描述数据库中的 webhook-authoritative 投影、套餐变更、付款方式、Invoice 与取消
    管理，没有促销码入口或支持声明。
- 定向测试通过：
  - `.venv/bin/pytest tests/test_checkout_promo_prohibition.py tests/test_invoice_policy.py -q`
    → `22 passed`；
  - `cd web && npx vitest run app/seo.test.tsx lib/money.test.ts components/AccountScreen.test.tsx`
    → `3 passed` test files、`20 passed` tests。
- `git diff --check origin/main...HEAD` 通过。
- 审查未使用 Stripe 密钥，也未运行 real-Stripe 或会修改外部账单状态的测试。

## 风险

- 促销码目前是明确的禁止态而非已实现能力。若未来单独加入
  `allow_promotion_codes`，Stripe 可能先收取折后款，而当前 Invoice policy 会拒绝发放权益并
  创建 incident；禁止门禁必须持续作为合并门槛。
- 本次证据是静态审查、后端单元测试和前端组件测试，不包含真实浏览器响应式/视觉检查或
  real-Stripe Checkout。它足以证明当前禁止态，但不证明未来促销码兑换链路。
- Landing 的 coupons 否认声明已有 SEO 测试锁定；Pricing 和 Account 的范围一致性仍主要
  依赖组件测试与人工抽查。后续文案调整可能造成页面间漂移。

## 建议下一步

1. 合并前保持 `tests/test_checkout_promo_prohibition.py` 为必过门禁，不允许以默认关闭的旗标
   形式预接 `allow_promotion_codes`。
2. 将 Pricing 的「不创建或模拟 Coupon/促销码」和 Account 的「无促销入口」加入专门的
   公共范围回归断言，降低文案漂移风险。
3. 只有当折扣资金政策、允许的 Coupon 形状、Invoice gross/discount/net 事实持久化、
   fail-closed 运营处置及真实 Checkout 端到端矩阵能够原子落地时，才进入促销码启用阶段。
