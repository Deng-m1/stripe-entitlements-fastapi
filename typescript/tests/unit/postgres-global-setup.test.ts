import { describe, expect, test, vi } from "vitest";

import {
  parseTestContainers,
  removeContainer,
  removeContainerSynchronously,
  sweepOrphanedContainers,
} from "../support/postgres-global-setup.js";

describe("disposable PostgreSQL container cleanup", () => {
  test("parses labeled containers and skips malformed ownership metadata", () => {
    const warn = vi.fn();
    expect(
      parseTestContainers(
        ["active-id\t101", "missing-owner\t", "invalid-owner\tnan", ""].join(
          "\n",
        ),
        warn,
      ),
    ).toEqual([{ id: "active-id", ownerPid: 101 }]);
    expect(warn).toHaveBeenCalledTimes(2);
  });

  test("removes dead owners without disturbing concurrent live owners", async () => {
    const commands: string[][] = [];
    const runDocker = vi.fn(async (arguments_: readonly string[]) => {
      commands.push([...arguments_]);
      if (arguments_[0] === "ps") {
        return "live-container\t101\ndead-container\t202";
      }
      return arguments_.at(-1) ?? "";
    });

    await expect(
      sweepOrphanedContainers(runDocker, (pid) => pid === 101),
    ).resolves.toEqual(["dead-container"]);
    expect(commands.filter(([command]) => command === "rm")).toEqual([
      ["rm", "-f", "dead-container"],
    ]);
  });

  test("surfaces strict cleanup failures", async () => {
    const failure = new Error("docker daemon refused cleanup");
    const runDocker = vi.fn(async () => Promise.reject(failure));
    await expect(removeContainer("owned-container", runDocker)).rejects.toBe(
      failure,
    );

    const synchronousDocker = vi.fn(() => {
      throw failure;
    });
    expect(() =>
      removeContainerSynchronously("owned-container", synchronousDocker),
    ).toThrow(failure);
  });
});
