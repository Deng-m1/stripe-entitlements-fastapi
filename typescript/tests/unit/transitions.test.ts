import { fileURLToPath } from "node:url";

import { beforeAll, describe, expect, it } from "vitest";

import { PlanCatalog } from "../../src/catalog.js";
import { decideTransition } from "../../src/transitions.js";
import type { TransitionPolicy } from "../../src/types.js";

const ROOT_CATALOG = fileURLToPath(
  new URL("../../../plans.toml", import.meta.url),
);
let catalog: PlanCatalog;

beforeAll(async () => {
  catalog = await PlanCatalog.fromToml(ROOT_CATALOG);
});

describe.each<TransitionPolicy>(["full_period_reset", "prorated_delta"])(
  "%s transition matrix",
  (policy) => {
    it("matches every documented plan and interval cell", () => {
      const states = [
        ["starter", "month"],
        ["starter", "year"],
        ["pro", "month"],
        ["pro", "year"],
        ["ultra", "month"],
        ["ultra", "year"],
      ] as const;
      const fullPeriodReset = [
        [
          "noop",
          "immediate",
          "immediate",
          "immediate",
          "immediate",
          "immediate",
        ],
        [
          "period_end",
          "noop",
          "period_end",
          "period_end",
          "period_end",
          "period_end",
        ],
        [
          "period_end",
          "period_end",
          "noop",
          "immediate",
          "immediate",
          "immediate",
        ],
        [
          "period_end",
          "period_end",
          "period_end",
          "noop",
          "period_end",
          "period_end",
        ],
        [
          "period_end",
          "period_end",
          "period_end",
          "period_end",
          "noop",
          "immediate",
        ],
        [
          "period_end",
          "period_end",
          "period_end",
          "period_end",
          "period_end",
          "noop",
        ],
      ] as const;
      const proratedDelta = [
        [
          "noop",
          "period_end",
          "immediate",
          "period_end",
          "immediate",
          "period_end",
        ],
        [
          "period_end",
          "noop",
          "period_end",
          "period_end",
          "period_end",
          "period_end",
        ],
        [
          "period_end",
          "period_end",
          "noop",
          "period_end",
          "immediate",
          "period_end",
        ],
        [
          "period_end",
          "period_end",
          "period_end",
          "noop",
          "period_end",
          "period_end",
        ],
        [
          "period_end",
          "period_end",
          "period_end",
          "period_end",
          "noop",
          "period_end",
        ],
        [
          "period_end",
          "period_end",
          "period_end",
          "period_end",
          "period_end",
          "noop",
        ],
      ] as const;
      const expected =
        policy === "full_period_reset" ? fullPeriodReset : proratedDelta;

      for (const [
        sourceIndex,
        [sourceKey, sourceInterval],
      ] of states.entries()) {
        for (const [
          targetIndex,
          [targetKey, targetInterval],
        ] of states.entries()) {
          const decision = decideTransition(
            catalog.require(sourceKey),
            sourceInterval,
            catalog.require(targetKey),
            targetInterval,
            policy,
          );
          expect(
            decision.timing,
            `${sourceKey}/${sourceInterval} -> ${targetKey}/${targetInterval}`,
          ).toBe(expected[sourceIndex]?.[targetIndex]);
          expect(decision.policy).toBe(policy);
        }
      }
    });

    it("defers every annual-origin change", () => {
      const current = catalog.require("starter");
      for (const target of catalog.ordered()) {
        for (const interval of ["month", "year"] as const) {
          const decision = decideTransition(
            current,
            "year",
            target,
            interval,
            policy,
          );
          expect(decision.timing).toBe(
            target.key === current.key && interval === "year"
              ? "noop"
              : "period_end",
          );
        }
      }
    });
  },
);

it("makes monthly higher-tier upgrades immediate under both explicit policies", () => {
  const starter = catalog.require("starter");
  const pro = catalog.require("pro");
  expect(
    decideTransition(starter, "month", pro, "month", "full_period_reset")
      .timing,
  ).toBe("immediate");
  expect(
    decideTransition(starter, "month", pro, "month", "prorated_delta").timing,
  ).toBe("immediate");
});

it("defers a prorated rank upgrade without a positive credit delta", () => {
  const starter = catalog.require("starter");
  const pro = {
    ...catalog.require("pro"),
    monthlyCredits: starter.monthlyCredits,
  };

  expect(
    decideTransition(starter, "month", pro, "month", "full_period_reset")
      .timing,
  ).toBe("immediate");
  const delta = decideTransition(
    starter,
    "month",
    pro,
    "month",
    "prorated_delta",
  );
  expect(delta.timing).toBe("period_end");
  expect(delta.reason).toBe(
    "prorated delta requires a positive credit difference",
  );
});
