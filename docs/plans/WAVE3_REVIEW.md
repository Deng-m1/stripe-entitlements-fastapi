# Wave 3 审查

审查基线：`f130cb66fe0a30cd8e9ded6cffb2aad320aedb0d`。

## 结论

**代码项通过，文档仍有风险。** 已提交的 `HEAD` 和最终工作树中的可执行代码均未保留
`allow_promotion_codes` Session 传参或可开启旗标，符合无条件省略的政策边界。审查
期间曾短暂出现危险接线，但并行代理已将其清理；未跟踪文档仍有过期描述，合入前需收敛。

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

- 未跟踪的 `docs/PROMOTION_CODES.md` 仍声称存在默认关闭的
  `CHECKOUT_ALLOW_PROMOTION_CODES` / `Settings.checkout_allow_promotion_codes` hook，
  与最终代码和禁止可开启旗标的政策不一致；该描述不可按现状提交。
- 现有网关断言只覆盖默认 Checkout 请求。若未来再次加入显式开启路径，该断言可能仍然
  通过，回归门禁还不够强。
- 折扣 Invoice 当前会 fail-closed；若先开放促销码，可能出现客户已按折扣付款、权益未
  发放并产生 incident 的状态。
- 审查期间并行未提交文件持续变化；本次未覆盖或回滚其他代理的 UI 与规划文档改动。

## 下一步

1. 修正或暂缓提交 `docs/PROMOTION_CODES.md` 中不存在的 reserved hook 描述。
2. 增加覆盖构造签名、Settings 和 Session 参数的回归门禁，确保无法通过显式参数或环境
   变量开启。
3. 运行网关、配置、Invoice policy 及非 real-Stripe 后端测试，并再次执行本次 Web 定向
   测试与 `git diff --check`。
4. 只有在折扣资金政策、Invoice 允收规则、运营约束及端到端测试原子落地后，才重新评估
   促销码支持。
