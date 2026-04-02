#!/usr/bin/env bun
/**
 * 代码健康度检查脚本
 *
 * 对齐当前仓库的完成度标准：
 * - 全仓 Biome lint
 * - 离线 smoke
 * - Bun test
 * - 构建
 * - 可选 Knip
 * - 可选在线 smoke
 */

import { $ } from "bun";

const DIVIDER = "─".repeat(60);
const INCLUDE_KNIP = process.env.HEALTH_CHECK_INCLUDE_KNIP === "1";
const INCLUDE_ONLINE_SMOKE = process.env.HEALTH_CHECK_ONLINE === "1";

interface Metric {
  label: string;
  value: string | number;
  status: "ok" | "warn" | "error" | "info" | "skip";
}

interface CommandResult {
  exitCode: number;
  output: string;
}

const metrics: Metric[] = [];

function add(
  label: string,
  value: string | number,
  status: Metric["status"] = "info",
) {
  metrics.push({ label, value, status });
}

function icon(status: Metric["status"]): string {
  switch (status) {
    case "ok":
      return "[OK]";
    case "warn":
      return "[!!]";
    case "error":
      return "[XX]";
    case "info":
      return "[--]";
    case "skip":
      return "[SK]";
  }
}

async function run(command: string): Promise<CommandResult> {
  const proc = Bun.spawn(["zsh", "-lc", command], {
    stdout: "pipe",
    stderr: "pipe",
  });
  const [stdout, stderr, exitCode] = await Promise.all([
    new Response(proc.stdout).text(),
    new Response(proc.stderr).text(),
    proc.exited,
  ]);
  return {
    exitCode,
    output: stdout + stderr,
  };
}

function parseCount(output: string, kind: "errors" | "warnings"): number {
  const match = output.match(new RegExp(`Found (\\d+) ${kind}?`));
  return match ? Number.parseInt(match[1], 10) : 0;
}

function formatBytes(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`;
  return `${(bytes / 1024 / 1024).toFixed(1)} MB`;
}

async function checkCodeSize() {
  const tsFiles = await $`find src -name '*.ts' -o -name '*.tsx' | grep -v node_modules`.text();
  const fileCount = tsFiles.trim().split("\n").filter(Boolean).length;
  add("TypeScript 文件数", fileCount, "info");

  const loc = await $`find src -name '*.ts' -o -name '*.tsx' | grep -v node_modules | xargs wc -l | tail -1`.text();
  const totalLines = loc.trim().split(/\s+/)[0] ?? "?";
  add("总代码行数 (src/)", totalLines, "info");
}

async function checkLint() {
  const result = await run("bun x biome lint --max-diagnostics=200 .");
  const output = result.output;
  const errors = parseCount(output, "errors");
  const warnings = parseCount(output, "warnings");

  add("Biome lint", result.exitCode === 0 ? "通过" : "失败", result.exitCode === 0 ? "ok" : "error");
  add("Lint 错误", errors, errors === 0 ? "ok" : "error");
  add("Lint 警告", warnings, warnings === 0 ? "ok" : "warn");
}

async function checkOfflineSmoke() {
  const result = await run("bun run smoke");
  const output = result.output;
  const hasPassed =
    output.includes("all selected smoke checks passed") ||
    output.includes("All checks passed") ||
    output.includes("0 failed");
  add(
    "离线 smoke",
    result.exitCode === 0 ? "通过" : "失败",
    result.exitCode === 0 && hasPassed ? "ok" : result.exitCode === 0 ? "warn" : "error",
  );
}

async function checkTests() {
  const result = await run("bun test");
  const output = result.output;
  const passMatch = output.match(/(\d+) pass/);
  const failMatch = output.match(/(\d+) fail/);
  const pass = passMatch ? Number.parseInt(passMatch[1], 10) : 0;
  const fail = failMatch ? Number.parseInt(failMatch[1], 10) : 0;

  add("测试通过", pass, pass > 0 ? "ok" : "warn");
  add("测试失败", fail, fail === 0 ? "ok" : "error");
}

async function checkBuild() {
  const result = await run("bun run build");
  if (result.exitCode === 0) {
    const stat = await Bun.file("dist/cli.js").stat();
    const size = formatBytes(stat.size);
    add("构建状态", "成功", "ok");
    add("产物大小 (dist/cli.js)", size, "info");
  } else {
    add("构建状态", "失败", "error");
  }
}

async function checkKnip() {
  if (!INCLUDE_KNIP) {
    add("Knip", "跳过 (HEALTH_CHECK_INCLUDE_KNIP=1 可启用)", "skip");
    return;
  }

  const result = await run("bunx knip-bun");
  const output = result.output;
  const unusedFiles = output.match(/Unused files \((\d+)\)/);
  const unusedExports = output.match(/Unused exports \((\d+)\)/);
  const unusedDeps = output.match(/Unused dependencies \((\d+)\)/);

  add("未使用文件", unusedFiles?.[1] ?? "0", "info");
  add("未使用导出", unusedExports?.[1] ?? "0", "info");
  add(
    "未使用依赖",
    unusedDeps?.[1] ?? "0",
    unusedDeps && Number(unusedDeps[1]) > 0 ? "warn" : "ok",
  );
}

async function checkOnlineSmoke() {
  if (!INCLUDE_ONLINE_SMOKE) {
    add("在线 smoke", "跳过 (HEALTH_CHECK_ONLINE=1 可启用)", "skip");
    return;
  }

  const result = await run("bun run smoke:online");
  add("在线 smoke", result.exitCode === 0 ? "通过" : "失败", result.exitCode === 0 ? "ok" : "error");
}

console.log("");
console.log(DIVIDER);
console.log("  代码健康度检查报告");
console.log(`  ${new Date().toLocaleString("zh-CN")}`);
console.log(DIVIDER);

await checkCodeSize();
await checkLint();
await checkOfflineSmoke();
await checkTests();
await checkBuild();
await checkKnip();
await checkOnlineSmoke();

console.log("");
for (const metric of metrics) {
  console.log(`  ${icon(metric.status)}  ${metric.label.padEnd(24)} ${metric.value}`);
}

const errorCount = metrics.filter(metric => metric.status === "error").length;
const warnCount = metrics.filter(metric => metric.status === "warn").length;

console.log("");
console.log(DIVIDER);
if (errorCount > 0) {
  console.log(`  结果: ${errorCount} 个错误, ${warnCount} 个警告`);
} else if (warnCount > 0) {
  console.log(`  结果: 无错误, ${warnCount} 个警告`);
} else {
  console.log("  结果: 全部通过");
}
console.log(DIVIDER);
console.log("");

process.exit(errorCount > 0 ? 1 : 0);
