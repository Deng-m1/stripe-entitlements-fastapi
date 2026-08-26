# Wave 3 审查

审查基线：`f130cb66fe0a30cd8e9ded6cffb2aad320aedb0d`。

## 结论

**阻断通过。** 已提交的 `HEAD` 明确要求 Checkout Session 无条件省略
`allow_promotion_codes`，但审查期间的并行未提交改动重新引入了可开启路径。该路径与
`docs/plans/TEST_GATES_PROMO_UI.md` 的政策边界直接冲突，在清理前不可合入。

## 通过项

- `git log main..HEAD` 仅包含：
  - `f130cb6 test: prohibit checkout promotion-code parameter`
  - `038dae9 test: add promo UI review gates`
- `git diff main...HEAD --stat`：3 个文件，165 行新增；变更集中在评审门禁、
  Invoice policy 测试和 Checkout 参数缺省断言。
- 已提交的 `tests/test_gateway.py` 断言默认 Checkout 请求不含
  `allow_promotion_codes`。
- `docs/plans/TEST_GATES_PROMO_UI.md` 已写明：不得提供默认关闭但可配置开启的开关。
- `cd web && npx vitest run app/seo.test.tsx lib/money.test.ts` 通过：2 个测试文件、
  7 个测试全部通过。

## 风险

- 审查快照中的未提交改动包含：
  - `.env.example` 暴露 `CHECKOUT_ALLOW_PROMOTION_CODES=false`；
  - `app.py` 将 `settings.checkout_allow_promotion_codes` 注入网关；
  - `stripe_gateway.py` 接受 `allow_promotion_codes: bool = False`，为真时向
    `stripe.checkout.Session.create` 传 `allow_promotion_codes=True`。
- 因此当前工作树仍存在可开启旗标和实际 Session 传参路径；默认关闭不能满足“无条件
  省略”不变量。
- 现有网关断言只覆盖默认构造。即使显式开启路径存在，该断言仍可通过，不能阻止回归。
- 折扣 Invoice 当前会 fail-closed；若先开放促销码，可能出现客户已按折扣付款、权益未
  发放并产生 incident 的状态。
- 审查期间这些未提交文件持续变化，表明另有并行代理正在修改同一工作树；本次未覆盖
  或回滚其代码。

## 下一步

1. 删除环境变量、Settings/App 注入、网关构造参数及 Session 条件传参，恢复无条件省略。
2. 增加覆盖所有构造/配置路径的回归门禁，确保无法通过显式参数或环境变量开启。
3. 清理后运行网关、配置、Invoice policy 及非 real-Stripe 后端测试，并再次执行本次 Web
   定向测试与 `git diff --check`。
4. 只有在折扣资金政策、Invoice 允收规则、运营约束及端到端测试原子落地后，才重新评估
   促销码支持。
