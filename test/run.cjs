#!/usr/bin/env node
/*
 * Runs the end-to-end tests, one Electron process each. Pass names to run only
 * those: `npm run test:e2e -- closing security`.
 */
const { spawnSync } = require("node:child_process");
const fs = require("node:fs");
const path = require("node:path");

const ROOT = path.resolve(__dirname, "..");
const ELECTRON = path.join(ROOT, "node_modules", ".bin", "electron");

/** [file, label, extra env] */
const SUITES = [
  ["dirty-state.cjs", "dirty-state"],
  ["closing.cjs", "closing"],
  ["save-during-edit.cjs", "save-during-edit"],
  ["non-scene-files.cjs", "non-scene-files"],
  ["file-operations.cjs", "file-operations"],
  ["concurrent-writes.cjs", "concurrent-writes"],
  ["image-round-trip.cjs", "image-round-trip"],
  ["library-install.cjs", "library-install"],
  ["reload-guard.cjs", "reload-guard"],
  ["security.cjs", "security"],
  ["startup-open.cjs", "startup-open (duplicate)", { EXD_CASE: "duplicate" }],
  ["startup-open.cjs", "startup-open (outside)", { EXD_CASE: "outside" }],
];

if (!fs.existsSync(path.join(ROOT, "dist", "index.html"))) {
  console.error("dist/ is missing — run `npm run build:renderer` first.");
  process.exit(1);
}
if (!fs.existsSync(ELECTRON)) {
  console.error("electron is missing — run `npm install` first.");
  process.exit(1);
}

const wanted = process.argv.slice(2);
const selected = wanted.length
  ? SUITES.filter(([file, label]) => wanted.some((w) => label.includes(w) || file.startsWith(w)))
  : SUITES;

if (!selected.length) {
  console.error(`no suite matches ${wanted.join(", ")}`);
  process.exit(1);
}

const failed = [];
for (const [file, label, env] of selected) {
  process.stdout.write(`${label.padEnd(26)}`);
  const started = Date.now();
  const run = spawnSync(ELECTRON, [path.join(__dirname, file)], {
    env: { ...process.env, ...env },
    encoding: "utf8",
  });
  const output = `${run.stdout ?? ""}${run.stderr ?? ""}`;
  const passed = run.status === 0;
  const counts = (output.match(/^PASS /gm) ?? []).length;
  console.log(`${passed ? "ok" : "FAILED"}  (${counts} checks, ${Math.round((Date.now() - started) / 1000)}s)`);
  if (!passed) {
    failed.push(label);
    for (const line of output.split("\n").filter((l) => /^(FAIL|ERROR)/.test(l))) {
      console.log(`    ${line}`);
    }
  }
}

console.log(
  failed.length
    ? `\n${failed.length} of ${selected.length} suites failed: ${failed.join(", ")}`
    : `\nall ${selected.length} suites passed`,
);
process.exit(failed.length ? 1 : 0);
