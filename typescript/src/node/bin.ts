#!/usr/bin/env node

import { parseNodeBillingCommand, runNodeBillingCommand } from "./cli.js";

let exitCode: number;
try {
  exitCode = await runNodeBillingCommand(
    parseNodeBillingCommand(process.argv.slice(2)),
  );
} catch (error) {
  const message = error instanceof Error ? error.message : "invalid command";
  console.error(message);
  exitCode = 1;
}
process.exitCode = exitCode;
