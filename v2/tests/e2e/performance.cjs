#!/usr/bin/env node
/** Stable entry point; protocol changes use a named, immutable harness version. */
require('./performance-v3.cjs').main().catch(error => {
  console.error(error.stack || String(error));
  process.exitCode = 1;
});
