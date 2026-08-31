export type AppLocale = "en" | "zh-CN";

export const DEFAULT_LOCALE: AppLocale = "en";
export const LOCALE_STORAGE_KEY = "stripe-entitlements-locale";

export function isAppLocale(value: unknown): value is AppLocale {
  return value === "en" || value === "zh-CN";
}

export function intlLocale(locale: AppLocale): "en-US" | "zh-CN" {
  return locale === "zh-CN" ? "zh-CN" : "en-US";
}

type TranslationValue = string | number;

const zhCN: Record<string, string> = {
  "Primary navigation": "主导航",
  Overview: "概览",
  Pricing: "定价",
  Account: "账户",
  Source: "源码",
  "Switch language to Chinese": "切换为中文",
  "Switch language to English": "切换为英文",
  "Reference UI only. Stripe and webhook state remain server-authoritative.":
    "仅作参考界面。Stripe 与 webhook 状态始终以服务端为准。",
  "Demo environment notice": "演示环境提示",
  "PUBLIC SIMULATION — browser-local sample data only. No Stripe request, payment, webhook, database, or account is used.":
    "公开模拟 — 仅使用浏览器本地样例数据，不会发起 Stripe 请求、支付、webhook、数据库或账户操作。",
  "DEMO ONLY — mock billing data or browser-exposed demo authentication is active. Production runtime rejects this configuration.":
    "仅限演示 — 当前启用了模拟账单数据或浏览器可见的演示认证，生产运行时会拒绝此配置。",
  "Reset simulation": "重置模拟",
  "PUBLIC SIMULATION": "公开模拟",
  "DEMO ONLY": "仅限演示",
  "Browser-local sample data only.": "仅使用浏览器本地样例数据。",
  "No Stripe request, payment, webhook, database, or account is used.":
    "不会使用 Stripe 请求、支付、webhook、数据库或账户。",
  "Mock billing or browser demo authentication is active.":
    "已启用模拟账单或浏览器演示认证。",
  "Production rejects this configuration.": "生产环境会拒绝此配置。",
  "Loading billing data…": "正在加载账单数据…",
  "Loading plan catalog…": "正在加载套餐目录…",
  "Loading account state…": "正在加载账户状态…",
  "Billing request failed": "账单请求失败",
  "We could not load this billing state.": "无法加载此账单状态。",
  "We could not load your account projection.": "无法加载你的账户投影。",
  "This failure changed nothing: billing state is rendered only from the server’s webhook-backed projection, never inferred client-side.":
    "本次失败未改变任何内容：账单状态只来自服务端由 webhook 驱动的投影，绝不会在客户端推断。",
  "Try again": "重试",
  "Retrying…": "正在重试…",

  "Explicit billing, structured entitlements": "显式账单，结构化权益",
  "Choose a plan without hiding the billing consequences.":
    "选择套餐，同时看清每一个账单后果。",
  "Plan identity comes from stable catalog keys. Prices are display and billing data—not tier detection logic.":
    "套餐身份来自稳定的目录键；价格只是展示与计费数据，不承担等级识别逻辑。",
  "Billing interval": "计费周期",
  Monthly: "按月",
  Yearly: "按年",
  month: "月付",
  year: "年付",
  "/mo": "/月",
  "/yr": "/年",
  "CATALOG / LIVE": "目录 / 实时",
  "plans · intervals": "套餐 · 周期",
  "WEBHOOK VERIFIED": "WEBHOOK 已验证",
  "Save {{percent}}%": "省 {{percent}}%",
  "Save up to {{percent}}%": "最高省 {{percent}}%",
  "Plans are ready. Loading the authenticated account state…":
    "套餐已就绪，正在加载已认证账户状态…",
  Recommended: "推荐",
  "Plan key: {{key}}": "套餐键：{{key}}",
  "/month": "/月",
  "or {{amount}}/mo with yearly billing": "按年支付相当于 {{amount}}/月",
  "/mo equivalent": "/月（折算）",
  "{{amount}} billed yearly": "每年支付 {{amount}}",
  "Save {{amount}}/year": "每年节省 {{amount}}",
  "Everything in {{name}}, plus:": "包含 {{name}} 全部内容，另加：",
  "Includes:": "包含：",
  "Annual payment; credits continue on monthly grant slots":
    "按年付款；额度仍按月度授予周期发放",
  "Choose {{name}} {{interval}}": "选择 {{name}} {{interval}}",
  "Loading account…": "正在加载账户…",
  "Current plan": "当前套餐",
  "Cancellation scheduled": "已安排取消",
  "Preparing…": "正在准备…",
  "Start {{name}}": "开始使用 {{name}}",
  "Preview {{name}} change": "预览切换到 {{name}}",
  "One-time credit packs": "一次性额度包",
  "Add burst capacity without changing your plan": "不更换套餐，也能补充峰值容量",
  "Sample packs add browser-local credits without changing plan features or limits. No payment is created.":
    "样例额度包只增加浏览器本地额度，不改变套餐功能或限制，也不会创建支付。",
  "Packs are one-time Stripe payments, not subscriptions. They add only product credits, never plan features or higher limits, and remain separate from monthly grant resets.":
    "额度包是一次性 Stripe 支付而非订阅；它只增加产品额度，不解锁套餐功能或更高限制，并与月度额度重置保持独立。",
  "Pack key: {{key}}": "额度包键：{{key}}",
  credits: "额度",
  "{{amount}} one time · expires {{days}} days after {{event}}":
    "一次性 {{amount}} · {{event}}后 {{days}} 天到期",
  "the simulated purchase": "模拟购买",
  payment: "支付",
  "Preparing simulation…": "正在准备模拟…",
  "Preparing Stripe Checkout…": "正在准备 Stripe Checkout…",
  "Buy {{name}}": "购买 {{name}}",
  "The simulation delays its browser-local projection so the return page does not grant sample credits synchronously.":
    "模拟会延迟写入浏览器本地投影，因此返回页不会同步授予样例额度。",
  "The return page does not grant credits. The balance changes only after a signed payment_intent.succeeded webhook is committed.":
    "返回页不会授予额度；余额只会在已签名的 payment_intent.succeeded webhook 提交后改变。",
  "Compare plans": "套餐对比",
  "Every value below comes from the canonical sample catalog. The yearly discount is the catalog’s explicit annual price—no Stripe Coupon or promotion code is created or simulated.":
    "下列数值均来自标准样例目录。年度折扣来自目录中明确的年价，不会创建或模拟 Stripe 优惠券或促销码。",
  "Every value below comes from the same catalog the billing server enforces. The yearly discount is the catalog’s explicit annual price—no Stripe Coupon or promotion code is created or simulated.":
    "下列数值均来自账单服务实际执行的同一目录。年度折扣来自目录中明确的年价，不会创建或模拟 Stripe 优惠券或促销码。",
  "Scroll sideways to compare every plan.": "横向滚动可比较所有套餐。",
  "Plan price and entitlement comparison": "套餐价格与权益对比",
  "What you get": "你将获得",
  "Monthly price": "月付价格",
  "Yearly price": "年付价格",
  "Yearly savings vs monthly": "相比月付的年度节省",
  Included: "已包含",
  "Not included": "未包含",
  "Choosing a plan changes only browser-local sample state after a simulated projection delay. It never creates Checkout or contacts Stripe.":
    "选择套餐只会在模拟投影延迟后改变浏览器本地样例状态，不会创建 Checkout 或联系 Stripe。",
  "Choosing a plan starts Checkout or a server-calculated change preview; entitlements change only after webhook-verified account state, never from the redirect alone.":
    "选择套餐会启动 Checkout 或服务端计算的变更预览；权益只在 webhook 验证后的账户状态中改变，绝不会仅凭重定向生效。",
  "The browser-local simulation records the pending period-end change.":
    "浏览器本地模拟已记录周期末待生效变更。",
  "The server accepted the request. The account API reports the pending period-end change.":
    "服务端已接受请求，账户 API 已报告周期末待生效变更。",
  "Core conversion tools for individual workflows.": "面向个人工作流的核心转换工具。",
  "Higher limits, batch conversion, and API access.":
    "更高限制、批量转换与 API 访问。",
  "Priority processing and high-volume automation limits.":
    "优先处理与高吞吐自动化限额。",
  "A small one-time balance for occasional extra jobs.":
    "适合偶尔额外任务的小额一次性余额。",
  "A one-time credit balance for bursty product usage.":
    "适合突发产品用量的一次性额度余额。",
  "A larger one-time balance for high-volume bursts.":
    "适合高并发峰值的较大一次性余额。",
  "Credits per monthly grant": "每月授予额度",
  "PDF to PowerPoint": "PDF 转 PowerPoint",
  "Image to PowerPoint": "图片转 PowerPoint",
  "Batch conversion": "批量转换",
  "API access": "API 访问",
  "Priority queue": "优先队列",
  "Maximum file size": "最大文件大小",
  "Maximum pages per job": "单任务最大页数",
  "Concurrent jobs": "并发任务数",
  "API keys": "API 密钥",
  pages: "页",
  jobs: "个任务",
  keys: "个密钥",

  "Browser-local account simulation": "浏览器本地账户模拟",
  "Webhook-authoritative account projection": "以 webhook 为准的账户投影",
  "Your billing account": "你的账单账户",
  "This view reports isolated sample plan, credit, and entitlement state stored only for this browser tab.":
    "此视图展示仅保存在当前浏览器标签页中的隔离样例套餐、额度与权益状态。",
  "This view reports stored plan identity, interval, credits, and entitlements independently. A price is never used to guess the current tier.":
    "此视图分别展示已存储的套餐身份、周期、额度与权益；绝不会通过价格猜测当前等级。",
  "POSTGRESQL PROJECTION": "POSTGRESQL 投影",
  AUTHORITATIVE: "权威状态",
  "browser-local": "浏览器本地",
  "read model · no client grants": "只读模型 · 客户端不授予权益",
  "Payment attention needed": "支付需要处理",
  "Your latest payment has not settled": "最近一笔支付尚未结算",
  "Stripe reports this subscription as past due.": "Stripe 报告该订阅已逾期。",
  "Product access is paused until Stripe reports the invoice as paid.":
    "在 Stripe 报告发票已支付前，产品访问会保持暂停。",
  "Update the payment method in the Stripe Billing Portal below; entitlements resume only after the paid webhook is processed.":
    "请在下方 Stripe Billing Portal 更新支付方式；只有已支付 webhook 处理完成后，权益才会恢复。",
  "Pending billing change": "待处理的账单变更",
  "Your current benefits remain active until {{date}}. No immediate entitlement switch is shown.":
    "当前权益将在 {{date}} 前保持有效，不会显示即时权益切换。",
  "The change is awaiting billing/webhook completion from {{date}}.":
    "该变更自 {{date}} 起等待账单/webhook 完成。",
  "Stripe needs one more payment step before this change can settle.":
    "此变更结算前，Stripe 还需要完成一步支付操作。",
  "Continue payment on Stripe": "前往 Stripe 继续支付",
  "Current plan → Free": "当前套餐 → 免费版",
  "Your current benefits remain active until {{date}}. Plan changes are paused while cancellation is pending; use the Stripe Billing Portal to resume the subscription first.":
    "当前权益将在 {{date}} 前保持有效。取消待处理期间套餐变更会暂停；请先在 Stripe Billing Portal 恢复订阅。",
  Dismiss: "关闭",
  Subscription: "订阅",
  Free: "免费版",
  "No sample subscription is active. Use “Review plan changes” below to simulate one without contacting Stripe.":
    "当前没有生效的样例订阅。可使用下方“查看套餐变更”进行模拟，不会联系 Stripe。",
  "No Stripe subscription is active for this account. Use “Review plan changes” below to start one — access is granted only after the paid webhook is processed, never by the redirect back to this app.":
    "此账户没有生效的 Stripe 订阅。可使用下方“查看套餐变更”开始订阅；访问权限只会在已支付 webhook 处理后授予，绝不会因为重定向回应用而生效。",
  "Plan key": "套餐键",
  Status: "状态",
  "Upgrade settlement": "升级结算方式",
  "Product access": "产品访问",
  Enforceable: "可执行",
  Paused: "已暂停",
  "Current period ends": "当前周期结束",
  None: "无",
  Credits: "额度",
  "available credits": "可用额度",
  "No grant is scheduled. Credit grants start with a paid subscription period and are recorded with database-enforced idempotency.":
    "当前没有计划中的额度授予。额度从已支付订阅周期开始发放，并由数据库强制保证幂等记录。",
  "Subscription balance": "订阅余额",
  "Purchased balance": "购买余额",
  "Grant amount": "授予数量",
  "Next grant": "下次授予",
  "Active credit-pack lots": "生效中的额度包批次",
  "{{amount}} credits": "{{amount}} 额度",
  "expires {{date}}": "{{date}} 到期",
  "Packs add spendable credits only. They do not change this account’s plan features, limits, or subscription status.":
    "额度包只增加可消费额度，不会改变此账户的套餐功能、限制或订阅状态。",
  "Structured entitlements": "结构化权益",
  "What the product may enforce": "产品可以执行的权益",
  "No entitlements granted": "尚未授予权益",
  "Nothing enforceable yet": "目前没有可执行内容",
  "Sample entitlements appear after the browser-local projection. Nothing here is a payment or production entitlement.":
    "样例权益会在浏览器本地投影后出现；此处任何内容都不是支付或生产权益。",
  "Structured entitlements appear here after a subscription webhook projects them. The product enforces exactly what is listed — nothing is inferred from prices or redirects.":
    "订阅 webhook 完成投影后，结构化权益会显示在此。产品只执行明确列出的内容，不会从价格或重定向推断。",
  Manage: "管理",
  "Plan changes and billing management": "套餐变更与账单管理",
  "Plan changes and the Portal return are simulated inside this browser tab. No server, payment method, invoice, or cancellation is changed.":
    "套餐变更与 Portal 返回均在当前浏览器标签页内模拟，不会改变服务端、支付方式、发票或取消状态。",
  "Plan and interval changes stay in this app so the server can enforce the safe transition matrix. The Stripe Billing Portal handles payment methods, invoices, and cancellation.":
    "套餐与周期变更留在本应用内，由服务端执行安全转换矩阵；Stripe Billing Portal 负责支付方式、发票与取消。",
  "Projection loaded {{date}}. Refreshing re-reads browser-local sample state.":
    "投影加载于 {{date}}。刷新只会重新读取浏览器本地样例状态。",
  "Projection loaded {{date}}. Refreshing re-reads the webhook-backed account API and never mutates billing state.":
    "投影加载于 {{date}}。刷新只会重新读取 webhook 驱动的账户 API，绝不会修改账单状态。",
  "Refreshing…": "正在刷新…",
  "Refresh simulation": "刷新模拟",
  "Refresh projection": "刷新投影",
  "Opening Portal…": "正在打开 Portal…",
  "Open simulated Portal": "打开模拟 Portal",
  "Open Stripe Billing Portal": "打开 Stripe Billing Portal",
  "Review plan changes": "查看套餐变更",

  "Simulated account state is ready": "模拟账户状态已就绪",
  "Webhook-backed account state is ready": "Webhook 驱动的账户状态已就绪",
  "This billing return cannot be verified": "无法验证此次账单返回",
  "Payment may still be processing": "支付可能仍在处理中",
  "Waiting for simulated projection": "正在等待模拟投影",
  "Waiting for webhook confirmation": "正在等待 webhook 确认",
  "Simulation returned": "模拟流程已返回",
  "Checkout returned": "Checkout 已返回",
  "Simulated redirect returned": "模拟重定向已返回",
  "Returned from checkout": "已从 Checkout 返回",
  "Browser-local projection applied": "浏览器本地投影已应用",
  "Webhook projection applied": "Webhook 投影已应用",
  "Sample credits available": "样例额度已可用",
  "Purchased credits available": "购买额度已可用",
  "Sample entitlements active": "样例权益已生效",
  "Entitlements enforceable": "权益可执行",
  "Browser-local sample state now shows the requested {{target}}. No Checkout, payment, webhook, or server account was created.":
    "浏览器本地样例状态现已显示请求的 {{target}}。未创建 Checkout、支付、webhook 或服务端账户。",
  "{{pack}} credit pack": "{{pack}} 额度包",
  "{{plan}} plan": "{{plan}} 套餐",
  "The account API now reports the {{pack}} funding lot for this exact Checkout Session. The return redirect itself was not treated as proof of payment.":
    "账户 API 现已报告与此 Checkout Session 精确对应的 {{pack}} 资金批次；返回重定向本身不会被视为支付凭证。",
  "The account API now reports {{plan}} as active. The success redirect itself was not treated as proof of entitlement.":
    "账户 API 现已报告 {{plan}} 处于生效状态；成功重定向本身不会被视为权益凭证。",
  "The return URL must identify exactly one valid catalog plan/interval or one credit pack and Checkout Session. Review the account state directly; this page will not infer a successful purchase.":
    "返回 URL 必须且只能标识一个有效目录套餐/周期，或一个额度包与 Checkout Session。请直接检查账户状态；本页面不会推断购买成功。",
  "{{attempts}} polls finished without a {{projection}} {{target}} result. No entitlement or purchased balance. {{guidance}}":
    "完成 {{attempts}} 次轮询后仍未获得 {{projection}} 的 {{target}} 结果，因此没有权益或购买余额。{{guidance}}",
  simulated: "模拟投影",
  "webhook-projected": "webhook 投影",
  "Resetting the public simulation is safe.": "可以安全地重置公开模拟。",
  "Stripe may still be processing. Checking again is safe and repeatable.":
    "Stripe 可能仍在处理；再次检查是安全且可重复的。",
  "Poll {{attempt}} of {{max}}. Entitlements are granted only after the {{source}}; refreshing this page is safe.":
    "正在进行第 {{attempt}}/{{max}} 次轮询。只有在{{source}}后才会授予权益；刷新本页是安全的。",
  "browser-local simulation applies its delayed sample projection":
    "浏览器本地模拟应用延迟样例投影",
  "backend processes Stripe state": "后端处理 Stripe 状态",
  Plan: "套餐",
  "Credit balance": "额度余额",
  "Check account state again": "再次检查账户状态",
  "View account": "查看账户",
  "Back to pricing": "返回定价",

  "The payment did not complete": "支付未完成",
  "Stripe could not complete the payment, so no plan or credit change was recorded.":
    "Stripe 未能完成支付，因此没有记录任何套餐或额度变更。",
  "Check the payment method through the Stripe Billing Portal on your account page, then retry the change from pricing.":
    "请在账户页通过 Stripe Billing Portal 检查支付方式，然后从定价页重新尝试变更。",
  "The payment flow was canceled": "支付流程已取消",
  "You left the Stripe payment flow before it finished. Your existing account state remains unchanged.":
    "你在 Stripe 支付流程结束前离开了页面，现有账户状态保持不变。",
  "Restart the same change from the pricing page whenever you are ready; a retried intent reuses its original idempotency key.":
    "准备好后可从定价页重新发起同一变更；重试意图会复用原始幂等键。",
  "Payment authentication did not complete": "支付认证未完成",
  "The additional authentication step Stripe requested was not completed, so the payment did not settle.":
    "Stripe 要求的额外认证步骤未完成，因此支付没有结算。",
  "Retry the change and finish the authentication prompt, or update the payment method in the Billing Portal first.":
    "请重试变更并完成认证提示，或先在 Billing Portal 更新支付方式。",
  "The billing operation could not be completed": "账单操作未能完成",
  "The billing operation stopped before it finished.": "账单操作在完成前停止。",
  "Review your account state before retrying.": "重试前请先检查账户状态。",
  "Billing action stopped": "账单操作已停止",
  "Nothing was assumed about your entitlement state: plans and credits change only after the backend verifies the matching Stripe webhook.":
    "系统没有对你的权益状态作任何假设：只有后端验证匹配的 Stripe webhook 后，套餐与额度才会改变。",
  "Error code: {{code}}": "错误代码：{{code}}",
  "Review account": "检查账户",

  "Browser-local change preview": "浏览器本地变更预览",
  "Server-calculated change preview": "服务端计算的变更预览",
  "This simulated change applies immediately": "此模拟变更将立即生效",
  "This simulated change starts at period end": "此模拟变更将在周期末开始",
  "Payment required — your current plan remains active":
    "需要支付 — 当前套餐仍保持生效",
  "Pay the prorated difference for this period": "支付本周期的按比例差额",
  "This change requires immediate settlement": "此变更需要立即结算",
  "This change starts at period end": "此变更将在周期末开始",
  "Immediate sample projection": "即时样例投影",
  "No sample change today": "今天不会改变样例状态",
  "This changes only versioned browser-local simulation state. It creates no Stripe invoice, payment, webhook, database row, or real entitlement.":
    "这只会改变带版本的浏览器本地模拟状态，不会创建 Stripe 发票、支付、webhook、数据库记录或真实权益。",
  "The Stripe invoice is still open": "Stripe 发票仍处于未结状态",
  "The requested target is not active. Continue to Stripe to pay or authenticate the invoice. After payment, this app still waits for the webhook-projected account before showing the new entitlements.":
    "请求的目标尚未生效。请前往 Stripe 支付或认证发票；支付后，本应用仍会等待 webhook 投影到账户后才显示新权益。",
  "Prorated amount due: {{amount}}": "应付按比例差额：{{amount}}",
  "Your current billing-period end stays unchanged. Stripe credits the unused source tier and charges the target tier for the same remaining time. After the paid Invoice is verified, the server adds exactly {{credits}} credits—the catalog entitlement difference, not a credit amount inferred from cash.":
    "当前计费周期结束时间不变。Stripe 退回来源等级未使用部分，并按同一剩余时长收取目标等级费用。已支付发票验证后，服务端会准确增加 {{credits}} 额度，即目录权益差额，而不是从现金金额推断出的额度。",
  "Immediate amount due: {{amount}}": "立即应付：{{amount}}",
  "The server accepted this as an independently funded target invoice: cross-invoice proration and customer-balance credit are both zero. Stripe may charge the payment method or require authentication. Entitlements change only after the bill is paid and webhook state is applied.":
    "服务端将其作为独立出资的目标发票接受：跨发票按比例调整与客户余额抵扣均为零。Stripe 可能扣款或要求认证；只有账单支付且 webhook 状态应用后，权益才会改变。",
  "No charge today": "今天不扣款",
  "Your current plan remains active until {{date}}. The new plan and interval begin at that period boundary.":
    "当前套餐将在 {{date}} 前保持生效；新套餐与周期从该边界开始。",
  "Unused-plan credit": "未使用套餐抵扣",
  "Next invoice": "下张发票",
  Effective: "生效时间",
  "I understand this changes only browser-local sample state and does not charge or contact Stripe.":
    "我理解这只改变浏览器本地样例状态，不会扣款或联系 Stripe。",
  "I understand that Stripe will charge the prorated difference and the upgrade still requires webhook confirmation.":
    "我理解 Stripe 会收取按比例差额，且升级仍需 webhook 确认。",
  "I understand that immediate settlement may charge me and still requires webhook confirmation.":
    "我理解立即结算可能会扣款，且仍需 webhook 确认。",
  "I understand that the current plan remains active until period end.":
    "我理解当前套餐会保持生效直到周期末。",
  Cancel: "取消",
  "Open Stripe invoice": "打开 Stripe 发票",
  "Confirming…": "正在确认…",
  "Confirm simulated change": "确认模拟变更",
  "Confirm billing change": "确认账单变更",

  "Open-source billing reference": "开源账单参考实现",
  "Billing events are chaos.": "账单事件纷繁无序。",
  "Your entitlements aren’t.": "你的权益不该如此。",
  "PROJECTED STATE": "投影状态",
  "An open-source Stripe billing reference with native FastAPI and TypeScript/Next.js backends over PostgreSQL, turning subscriptions, exact fractional credits, and one-time credit packs into deterministic access.":
    "一个开源 Stripe 账单参考实现：原生 FastAPI 与 TypeScript/Next.js 后端运行于 PostgreSQL 之上，将订阅、精确小数额度与一次性额度包转化为确定的访问状态。",
  "Explore the live demo": "体验在线演示",
  "View the source": "查看源码",
  "two native backends": "两套原生后端",
  "bounded billing policy": "边界明确的账单策略",
  "Reference stack": "参考技术栈",
  "Stripe test mode": "Stripe 测试模式",

  "Race-safe Stripe webhooks": "竞态安全的 Stripe webhook",
  "PostgreSQL event inboxes, row locks, business idempotency keys, and deterministic out-of-order projection.":
    "通过 PostgreSQL 事件收件箱、行锁、业务幂等键与确定性的乱序投影处理并发。",
  "Subscription entitlements": "订阅权益",
  "Structured plan limits, monthly credit grants, annual funding slots, refunds, disputes, and grant-epoch-safe usage.":
    "结构化套餐限制、月度额度授予、年度资金时段、退款、争议与授予纪元安全的消费。",
  "Exact fractional credits and credit packs": "精确小数额度与额度包",
  "One million integer atoms per credit, one-time Checkout packs, expiring funding lots, source-aware consumption, cash clawbacks, and product-operation refunds without floating-point drift.":
    "每额度使用一百万整数原子，支持一次性 Checkout 额度包、到期资金批次、来源感知消费、现金追回与产品操作退款，全程避免浮点漂移。",
  "Full-price or prorated upgrades": "全价或按比例升级",
  "Choose full_period_reset or prorated_delta. Both define a complete 6 × 6 monthly/yearly transition matrix with durable intent, SCA recovery, and refund convergence.":
    "可选择 full_period_reset 或 prorated_delta；两者都定义完整的 6 × 6 月付/年付转换矩阵，并覆盖持久意图、SCA 恢复与退款收敛。",
  "Real Stripe test gates": "真实 Stripe 测试门禁",
  "Test-mode API, Test Clock renewal, Playwright Checkout, decline, 3DS, signed webhook, and UI projection gates.":
    "覆盖测试模式 API、Test Clock 续费、Playwright Checkout、拒付、3DS、签名 webhook 与 UI 投影门禁。",
  "The invariants": "系统不变量",
  "A Stripe billing reference built on invariants.": "一个以不变量为基础的 Stripe 账单参考实现。",
  "The reference makes the hard parts visible: event identity, exact arithmetic, explicit transition policy, and two runtimes that converge on the same database contract.":
    "这个参考实现把困难部分全部显性化：事件身份、精确算术、明确的转换策略，以及收敛到同一数据库契约的两套运行时。",
  "Native FastAPI and TypeScript parity": "原生 FastAPI 与 TypeScript 对等实现",
  "Independent runtimes share the PostgreSQL schema, plan catalog, settlement policy, and exact-credit golden vectors.":
    "两套独立运行时共享 PostgreSQL 模式、套餐目录、结算策略与精确额度黄金向量。",

  Receive: "接收",
  "Verify Stripe’s signature against the exact raw request body before JSON becomes trusted input.":
    "在 JSON 成为可信输入前，使用完全原始的请求体验证 Stripe 签名。",
  Settle: "结算",
  "Claim the Event ID and commit inbox, ledger, entitlement, and incident effects in one PostgreSQL transaction.":
    "认领 Event ID，并在一个 PostgreSQL 事务中提交收件箱、账本、权益与事件影响。",
  Enforce: "执行",
  "Product code reads server-projected features, limits, and exact credit balances. The browser never grants access.":
    "产品代码读取服务端投影的功能、限制与精确额度余额；浏览器永远不能授予访问权限。",
  "Receive · settle · enforce": "接收 · 结算 · 执行",
  "Out-of-order events in. An ordered ledger out.": "输入可以乱序，输出账本必须有序。",
  "Three boundaries turn a noisy provider stream into product state. Each boundary has one job, one authority, and a failure mode that stays inspectable.":
    "三道边界把嘈杂的支付提供商事件流转为产品状态；每道边界只有一个职责、一个权威来源，并保留可检查的失败模式。",
  "Browser reads this state; it cannot mint it.": "浏览器只能读取此状态，不能凭空生成它。",
  "The upgrade matrix": "升级矩阵",
  "All 36 plan transitions, defined.": "36 种套餐转换，全部明确定义。",
  "Three plans, two intervals, no undefined cell. Every source state maps to every target state with an explicit outcome, so billing behavior never depends on a support guess.":
    "三个套餐、两个周期，没有未定义单元格。每个来源状态都以明确结果映射到每个目标状态，账单行为无需依赖人工猜测。",

  "Proof, not promises": "证据，而非承诺",
  "Proven against real Stripe test mode.": "已通过真实 Stripe 测试模式验证。",
  "The payment lifecycle has automated gates against real Stripe test mode, with PostgreSQL race tests for delivery permutations.":
    "支付生命周期具备真实 Stripe 测试模式自动门禁，并用 PostgreSQL 竞态测试覆盖各种投递排列。",
  "AUTOMATED EVIDENCE": "自动化证据",
  "stripe checkout · paid session": "stripe checkout · 已支付会话",
  "a real test-mode purchase settles into credits": "真实测试模式购买可结算为额度",
  "card declined": "银行卡被拒",
  "no entitlement changes; the retry path stays clean": "权益不变，重试路径保持干净",
  "3-D Secure challenge": "3-D Secure 验证",
  "SCA recovery completes before webhook-authoritative settlement":
    "SCA 恢复在 webhook 权威结算前完成",
  "signed webhook delivery": "签名 webhook 投递",
  "signature checked on the exact raw body before parsing": "解析前对完全原始请求体校验签名",
  "Test Clock renewal": "Test Clock 续费",
  "cross-period grants advance without duplicate slots": "跨周期授予前进且不会重复时段",
  "UI projection": "UI 投影",
  "the account screen reads the database, never the browser": "账户页读取数据库，而不是浏览器推断",
  "Inspect the test gates": "检查测试门禁",
  "Test-mode evidence is explicit. It is not presented as live-production payload evidence.":
    "测试模式证据会明确标注，不会冒充实时生产负载证据。",

  "Bundled reference catalog": "内置参考目录",
  "Three tiers, monthly and annual billing.": "三个等级，支持月付与年付。",
  "Prices are explicit billing data. Stable plan rank controls upgrade direction, while annual savings remain a display-only calculation.":
    "价格是明确的账单数据；稳定的套餐等级控制升级方向，而年度节省只用于展示计算。",
  REFERENCE: "参考",
  "/ month": "/ 月",
  "credits per monthly grant": "每月授予额度",
  "No annual saving claimed": "未声明年度节省",
  "Save {{amount}} on annual billing": "年付可节省 {{amount}}",
  "Explore {{name}}": "查看 {{name}}",
  "Scrollable reference plan comparison": "可滚动的参考套餐对比",
  "Reference Stripe subscription plans and annual savings":
    "Stripe 参考订阅套餐与年度节省",
  Annual: "年付总额",
  "Annual total": "年度总额",
  "Annual saving": "年度节省",
  "Monthly credits": "月度额度",
  "No saving claimed": "未声明节省",
  "One-time funding": "一次性资金",
  "Stripe credit packs with exact source attribution.": "具有精确来源归属的 Stripe 额度包。",
  "Each payment creates its own expiring funding lot. Product usage records the exact subscription or pack source, so cash refunds, disputes, and Job refunds converge without floating-point drift.":
    "每笔支付都会创建独立的到期资金批次。产品使用会记录准确的订阅或额度包来源，使现金退款、争议与任务退款在无浮点漂移的情况下收敛。",
  "Scrollable one-time credit pack comparison": "可滚动的一次性额度包对比",
  "Reference one-time Stripe credit packs": "Stripe 参考一次性额度包",
  "Credit pack": "额度包",
  "Exact credits": "精确额度",
  "One-time price": "一次性价格",
  "Expiry after payment": "支付后有效期",
  "{{days}} days": "{{days}} 天",
  "Scope boundary": "范围边界",
  "This example does not claim coupons, trials, tax, multi-currency, seats, or metered billing. Adapt and test those policies before advertising them.":
    "本示例不声称支持优惠券、试用、税务、多币种、席位或计量账单；宣传前请先适配并测试这些策略。",

  "Frequently asked questions": "常见问题",
  "Stripe billing template FAQ": "Stripe 账单模板常见问题",
  "The implementation is deliberately explicit about what it proves, what it supports, and where your product still owns policy.":
    "这个实现会明确说明它证明了什么、支持什么，以及哪些策略仍由你的产品负责。",
  "Is this an official Stripe billing framework?": "这是 Stripe 官方账单框架吗？",
  "No. It is an independent, open-source reference implementation for a deliberately bounded single-item subscription and credit-entitlement policy.":
    "不是。它是一个独立的开源参考实现，面向边界明确的单项订阅与额度权益策略。",
  "Can I use the Stripe billing backend without Python?": "可以不用 Python 使用 Stripe 账单后端吗？",
  "Yes. Choose either the independent Python/FastAPI implementation or the native TypeScript/Node/Next.js implementation. Both use the same PostgreSQL schema, plan catalog, settlement policies, and accounting invariants.":
    "可以。你可以选择独立的 Python/FastAPI 实现，或原生 TypeScript/Node/Next.js 实现；两者使用相同的 PostgreSQL 模式、套餐目录、结算策略与会计不变量。",
  "Does the template support monthly and annual subscriptions?": "模板支持月付和年付订阅吗？",
  "Yes. Starter, Pro, and Ultra each have monthly and annual prices. Annual invoices fund monthly credit slots, and an opt-in Stripe Test Clock gate covers cross-year renewal.":
    "支持。Starter、Pro 与 Ultra 均提供月价和年价；年度发票为月度额度时段提供资金，并可通过可选 Stripe Test Clock 门禁覆盖跨年续费。",
  "Does it support Stripe prorated subscription upgrades?": "支持 Stripe 按比例订阅升级吗？",
  "Yes. The prorated-delta template accepts a paid two-line monthly upgrade Invoice, preserves the current period, and adds the fixed catalog entitlement difference. Annual and unsupported invoice shapes defer or fail closed.":
    "支持。prorated-delta 模板接受已支付的双行月度升级发票，保留当前周期并增加固定目录权益差额；年度和不支持的发票形态会延期或安全失败。",
  "What do the two subscription change templates cover?": "两种订阅变更模板覆盖哪些场景？",
  "full_period_reset and prorated_delta each define all 36 source-to-target cells across three monthly and three yearly states. Annual-origin changes, interval changes under the delta policy, and downgrades remain period-end.":
    "full_period_reset 与 prorated_delta 都定义了三个按月状态与三个按年状态之间的全部 36 个转换单元；年付来源变更、差额策略下的周期变更以及降级均保持周期末生效。",
  "How are annual savings calculated?": "年度节省如何计算？",
  "The UI compares twelve monthly payments with the explicit annual price in the same currency. It displays savings only when the annual total is lower.":
    "界面会用同币种下十二次月付总额与明确年价比较，只有年度总额更低时才显示节省。",
  "Does it support one-time Stripe credit packs?": "支持一次性 Stripe 额度包吗？",
  "Yes. Hosted Checkout payment Sessions fund independently expiring credit lots after a signed payment_intent.succeeded webhook. Packs add credits only; they never grant subscription features or higher plan limits.":
    "支持。托管 Checkout 支付会话会在签名 payment_intent.succeeded webhook 后为独立到期额度批次出资；额度包只增加额度，不授予订阅功能或更高套餐限制。",
  "Can product credits be fractional?": "产品额度可以是小数吗？",
  "Yes. One credit is represented as one million integer atoms from PostgreSQL through the HTTP and browser boundaries. Decimal strings are exact and binary floating point is rejected for authoritative balances.":
    "可以。从 PostgreSQL 到 HTTP 与浏览器边界，一个额度始终表示为一百万整数原子；小数字符串保持精确，权威余额拒绝二进制浮点数。",
  "Are coupons, trials, tax, and multi-currency billing included?": "是否包含优惠券、试用、税务与多币种账单？",
  "No. Those policies are intentionally outside the implemented scope and are not advertised as supported behavior.":
    "不包含。这些策略被有意排除在实现范围外，也不会被宣传为已支持行为。",
  "Is the design safe for multiple API or worker instances?": "该设计对多个 API 或 worker 实例安全吗？",
  "Yes, when every instance shares one PostgreSQL primary. Database locks, constraints, leases, and idempotency provide coordination; PostgreSQL remains the writable truth.":
    "安全，前提是所有实例共享同一个 PostgreSQL 主库。数据库锁、约束、租约与幂等性负责协调，PostgreSQL 始终是可写真相。",

  "Project call to action": "项目行动号召",
  "Ship the invariant, not the demo": "交付不变量，而不是演示",
  "Start from a billing system that shows its work.": "从一个能解释自身行为的账单系统开始。",
  "Read the invariants, run the gates, then adapt the bounded policy to your product instead of hiding billing decisions in webhook branches.":
    "阅读不变量、运行测试门禁，再把边界明确的策略适配到你的产品，而不是把账单决策藏进 webhook 分支。",
  "View on GitHub": "在 GitHub 查看",
  "Open the reference UI": "打开参考界面",

  "delivery #2 · late": "第 2 次投递 · 延迟",
  "duplicate delivery": "重复投递",
  "arrived before paid": "早于支付事件到达",
  "same-second tie": "同秒并列",
  unordered: "无序",
  "INPUT · AT-LEAST-ONCE": "输入 · 至少一次",
  "One payment. Many deliveries.": "一次支付，多次投递。",
  "Retries, duplicates, and out-of-order facts share the same wire.":
    "重试、重复与乱序事实共用同一条传输通道。",
  retrying: "重试中",
  "ordering unknown": "顺序未知",
  "browser return ≠ grant": "浏览器返回 ≠ 权益授予",
  consistent: "一致",
  "OUTPUT · POSTGRESQL": "输出 · POSTGRESQL",
  enforceable: "可执行",
  interval: "周期",
  "credits balance": "额度余额",
  allowed: "允许",
  committed: "已提交",
  absorbed: "已吸收",
  "effectively-once PostgreSQL effects": "事实上的单次 PostgreSQL 效果",
  "raw signature · row lock · business key": "原始签名 · 行锁 · 业务键",
  "Compare raw Stripe events with projected PostgreSQL entitlements":
    "比较原始 Stripe 事件与投影后的 PostgreSQL 权益",
  "Raw Stripe stream": "原始 Stripe 事件流",
  "duplicate · late · retryable": "重复 · 延迟 · 可重试",
  "Drag to compare": "拖动对比",
  "Enforceable state": "可执行状态",
  "ordered · exact · auditable": "有序 · 精确 · 可审计",
  "No-op: already on this plan and interval": "无操作：已处于此套餐和周期",
  "Immediate prorated settlement in the current period": "在当前周期立即按比例结算",
  "Scheduled at period end": "安排在周期末生效",
  "Scroll sideways for the yearly target columns.": "横向滚动可查看年付目标列。",
  "Scrollable plan transition matrix": "可滚动的套餐转换矩阵",
  "Outcome of every plan change under the prorated_delta template, from the row state to the column state":
    "prorated_delta 模板下每种套餐变更的结果，从行状态转换到列状态",
  "from \\ to": "从 \\ 到",
  "prorated_delta · paid two-line Invoice · +{{credits}} credits · period preserved":
    "prorated_delta · 已支付双行发票 · +{{credits}} 额度 · 保留周期",
  "prorated_delta · non-positive credit difference · scheduled at period end":
    "prorated_delta · 额度差非正 · 安排在周期末生效",
  "Starter → Pro · monthly (highlighted cell)": "Starter → Pro · 月付（高亮单元格）",
  "{{from}} → {{to}} · monthly (highlighted cell)":
    "{{from}} → {{to}} · 月付（高亮单元格）",
  "prorated_delta settles it immediately: a paid two-line Invoice, +{{credits}} credits, and the current period preserved.":
    "prorated_delta 会立即结算：已支付双行发票、增加 {{credits}} 额度，并保留当前周期。",
  "prorated_delta schedules it at period end because immediate delta settlement requires a positive credit difference.":
    "prorated_delta 会将其安排在周期末生效，因为即时差额结算要求额度差为正。",
  "Immediate prorated settlement": "立即按比例结算",
  "No-op": "无操作",
  "Shown: the prorated_delta template. The full_period_reset template defines the same 36 cells and instead settles monthly-origin upgrades immediately at the full target price.":
    "当前展示 prorated_delta 模板。full_period_reset 模板定义相同的 36 个单元格，但会按完整目标价格立即结算月付来源升级。",
};

export function translate(
  locale: AppLocale,
  source: string,
  values: Record<string, TranslationValue> = {},
): string {
  const template = locale === "zh-CN" ? (zhCN[source] ?? source) : source;
  return template.replace(/\{\{([a-zA-Z0-9_]+)\}\}/gu, (match, key: string) =>
    key in values ? String(values[key]) : match,
  );
}
