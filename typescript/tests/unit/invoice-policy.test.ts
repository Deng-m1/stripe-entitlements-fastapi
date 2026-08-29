import { describe, expect, it } from "vitest";

import {
  hasUnsupportedInvoiceAdjustments,
  hasUnsupportedInvoicePaymentShape,
} from "../../src/invoice-policy.js";

describe("Invoice adjustment policy", () => {
  it("accepts explicit empty adjustment fields and safe zero balances", () => {
    const invoice = {
      starting_balance: 0,
      ending_balance: 0,
      pre_payment_credit_notes_amount: 0,
      post_payment_credit_notes_amount: 0,
      amount_overpaid: 0,
      automatic_tax: { enabled: false },
      discount: null,
      discounts: [],
      default_tax_rates: [],
      total_tax_amounts: [],
      total_taxes: [],
      total_discount_amounts: [],
    };
    const lines = [
      {
        discounts: [],
        tax_amounts: [],
        taxes: [],
        discount_amounts: [],
        pretax_credit_amounts: [],
        tax_rates: [],
      },
    ];
    expect(hasUnsupportedInvoiceAdjustments(invoice, lines)).toBe(false);
  });

  it.each([
    [{ discount: {} }, [], "discount object"],
    [{ total_discount_amounts: [{ amount: 0 }] }, [], "zero discount object"],
    [{ total_tax_amounts: [{ amount: 0 }] }, [], "zero tax object"],
    [{ automatic_tax: { enabled: true } }, [], "automatic tax"],
    [{ automatic_tax: {} }, [], "missing automatic-tax flag"],
    [{ starting_balance: -1 }, [], "starting balance"],
    [{ ending_balance: 1 }, [], "ending balance"],
    [{ pre_payment_credit_notes_amount: 1 }, [], "pre-payment credit note"],
    [{ post_payment_credit_notes_amount: 1 }, [], "post-payment credit note"],
    [{ amount_overpaid: 1 }, [], "overpayment"],
    [{}, [{ discount_amounts: [{ amount: 0 }] }], "line discount"],
    [{}, [{ tax_amounts: [{ amount: 0 }] }], "line tax"],
  ] as const)(
    "rejects unsupported adjustment shape %#",
    (invoice, lines, _name) => {
      void _name;
      expect(hasUnsupportedInvoiceAdjustments(invoice, lines)).toBe(true);
    },
  );

  it.each([true, 0.5, Number.MAX_SAFE_INTEGER + 1, "0", 0n])(
    "rejects a malformed explicit zero balance %#",
    (value) => {
      expect(
        hasUnsupportedInvoiceAdjustments({ starting_balance: value }, []),
      ).toBe(true);
    },
  );

  it.each([null, [], "invoice", new (class Invoice {})()])(
    "rejects a non-JSON Invoice mapping %#",
    (invoice) => {
      expect(hasUnsupportedInvoiceAdjustments(invoice, [])).toBe(true);
    },
  );

  it("rejects malformed lines and accessor-bearing objects without invoking them", () => {
    let accessed = false;
    const invoice = Object.defineProperty({}, "discount", {
      enumerable: true,
      get: () => {
        accessed = true;
        return null;
      },
    });
    expect(hasUnsupportedInvoiceAdjustments(invoice, [])).toBe(true);
    expect(accessed).toBe(false);
    expect(hasUnsupportedInvoiceAdjustments({}, [null])).toBe(true);
    expect(hasUnsupportedInvoiceAdjustments({}, {})).toBe(true);
  });
});

describe("Invoice payment collection policy", () => {
  it.each([
    {},
    { payments: null },
    { payments: { data: [] } },
    {
      payments: {
        has_more: false,
        data: [{ status: "paid", payment: { type: "charge" } }],
      },
    },
    {
      paid_out_of_band: false,
      amount_overpaid: 0,
      payments: {
        data: [{ status: "paid", payment: { type: "payment_intent" } }],
      },
    },
    { payments: { data: [{}] } },
  ])("accepts a supported single-payment shape %#", (invoice) => {
    expect(hasUnsupportedInvoicePaymentShape(invoice)).toBe(false);
  });

  it.each([
    [{ paid_out_of_band: true }, "out-of-band collection"],
    [{ paid_out_of_band: 0 }, "malformed out-of-band marker"],
    [{ amount_overpaid: 1 }, "overpayment"],
    [{ amount_overpaid: true }, "boolean overpayment"],
    [{ amount_overpaid: 0.1 }, "fractional overpayment"],
    [{ amount_overpaid: Number.MAX_SAFE_INTEGER + 1 }, "unsafe overpayment"],
    [{ payments: [] }, "array collection"],
    [{ payments: { has_more: true, data: [] } }, "pagination"],
    [{ payments: { has_more: 0, data: [] } }, "malformed pagination marker"],
    [{ payments: { data: {} } }, "non-array data"],
    [{ payments: { data: [null] } }, "non-mapping payment"],
    [
      { payments: { data: [{ status: "paid" }, { status: "paid" }] } },
      "multiple payments",
    ],
    [{ payments: { data: [{ status: "open" }] } }, "unpaid mapping"],
    [{ payments: { data: [{ status: false }] } }, "malformed status"],
    [{ payments: { data: [{ payment: [] }] } }, "array payment details"],
    [
      { payments: { data: [{ payment: { type: "out_of_band" } }] } },
      "unsupported payment type",
    ],
  ] as const)("rejects unsupported payment shape %#", (invoice, _name) => {
    void _name;
    expect(hasUnsupportedInvoicePaymentShape(invoice)).toBe(true);
  });

  it("rejects non-record and prototype-bearing collections", () => {
    class Payments {
      public readonly data: readonly unknown[] = [];
    }
    expect(hasUnsupportedInvoicePaymentShape([])).toBe(true);
    expect(
      hasUnsupportedInvoicePaymentShape({ payments: new Payments() }),
    ).toBe(true);
  });
});
