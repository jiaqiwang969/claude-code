#!/usr/bin/env bun

import { feature } from "bun:bundle";
import { randomUUID } from "node:crypto";
import { spawn } from "node:child_process";
import { chmod, mkdtemp, readdir, rm, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join, relative, resolve } from "node:path";
import { stripVTControlCharacters } from "node:util";

import { collectClaudeInChromeReadinessSummary } from "../src/utils/claudeInChrome/readiness.js";

type Status = "ok" | "warn" | "error" | "skip";

type CheckResult = {
  name: string;
  status: Status;
  detail: string;
  durationMs: number;
};

type RunResult = {
  exitCode: number;
  stdout: string;
  stderr: string;
  timedOut?: boolean;
};

type RunOptions = {
  cwd?: string;
  env?: Record<string, string>;
  stdin?: string;
  timeoutMs?: number;
};

type TerminalProbeResult = RunResult & {
  anchorOutput: string;
  matched: boolean;
  timedOut: boolean;
  normalizedOutput: string;
};

type PtyProbePayload = {
  matched: boolean;
  output: string;
};

type ToolRegistrySnapshot = {
  toolCount: number;
  toolNames: string[];
  toolDirectoryCount: number;
  referencedDirectoryCount: number;
  unregisteredDirs: string[];
  unexpectedUnregisteredDirs: string[];
};

type CommandRegistrySnapshot = {
  commandCount: number;
  commandNames: string[];
  builtInNameCount: number;
  localJsxCount: number;
  localCount: number;
  promptCount: number;
};

type ImportEdge = {
  specifier: string;
  typeOnly: boolean;
};

type HotPathStubAudit = {
  runtimeStubPaths: string[];
  dormantStubPaths: Array<{ path: string; reason: string }>;
  typeOnlyStubPaths: string[];
  visitedRuntimeFiles: string[];
};

type QueryDynamicRequireTarget = {
  owners: string[];
  path: string;
  gate?: keyof typeof FEATURE_FLAG_STATES;
};

type AccountingExpectation = {
  inputTokens: number;
  outputTokens: number;
  requirePositiveCost?: boolean;
};

type ConsistentAccountingOptions = {
  // Some successful paths surface only the top-level session usage here, while
  // modelUsage also includes auxiliary models, local agents, or compaction work.
  allowUsageSubsetOfModelUsage?: boolean;
  allowZeroInputTokens?: boolean;
};

const DIVIDER = "─".repeat(72);
const DEFAULT_MODEL = process.env.SMOKE_MODEL || "claude-sonnet-4-6";
const DEFAULT_MAX_BUDGET_USD = Number(process.env.SMOKE_MAX_BUDGET_USD || "0.20");
const DEFAULT_COMMAND_TIMEOUT_MS = Number(process.env.SMOKE_COMMAND_TIMEOUT_MS || "120000");
const MULTI_STEP_TOOL_TIMEOUT_MS = Number(process.env.SMOKE_MULTI_STEP_TOOL_TIMEOUT_MS || "180000");
const KNOWN_UNREGISTERED_TOOL_DIRS = new Set([
  "DiscoverSkillsTool",
  "MCPTool",
  "McpAuthTool",
  "ReviewArtifactTool",
]);
const KNOWN_DORMANT_STUB_REASONS: Record<string, () => string | null> = {
  "src/commands/reset-limits/index.ts": () =>
    process.env.USER_TYPE === "ant" ? null : "gated by USER_TYPE === 'ant'",
  "src/tools/TungstenTool/TungstenTool.ts": () =>
    process.env.USER_TYPE === "ant" ? null : "gated by USER_TYPE === 'ant'",
  "src/tools/WorkflowTool/constants.ts": () =>
    feature("WORKFLOW_SCRIPTS") ? null : "gated by feature('WORKFLOW_SCRIPTS')",
  "src/types/connectorText.ts": () =>
    feature("CONNECTOR_TEXT") ? null : "gated by feature('CONNECTOR_TEXT')",
};
const FEATURE_FLAG_STATES = {
  REACTIVE_COMPACT: feature("REACTIVE_COMPACT") ? true : false,
  CONTEXT_COLLAPSE: feature("CONTEXT_COLLAPSE") ? true : false,
  EXPERIMENTAL_SKILL_SEARCH: feature("EXPERIMENTAL_SKILL_SEARCH") ? true : false,
  TEMPLATES: feature("TEMPLATES") ? true : false,
  HISTORY_SNIP: feature("HISTORY_SNIP") ? true : false,
  BG_SESSIONS: feature("BG_SESSIONS") ? true : false,
  COORDINATOR_MODE: feature("COORDINATOR_MODE") ? true : false,
} as const;
const QUERY_DYNAMIC_REQUIRE_TARGETS: QueryDynamicRequireTarget[] = [
  {
    owners: ["src/query.ts"],
    path: "src/services/compact/reactiveCompact.ts",
    gate: "REACTIVE_COMPACT",
  },
  {
    owners: ["src/query.ts"],
    path: "src/services/contextCollapse/index.ts",
    gate: "CONTEXT_COLLAPSE",
  },
  {
    owners: ["src/query.ts"],
    path: "src/services/skillSearch/prefetch.ts",
    gate: "EXPERIMENTAL_SKILL_SEARCH",
  },
  {
    owners: ["src/query.ts"],
    path: "src/jobs/classifier.ts",
    gate: "TEMPLATES",
  },
  {
    owners: ["src/query.ts", "src/QueryEngine.ts"],
    path: "src/services/compact/snipCompact.ts",
    gate: "HISTORY_SNIP",
  },
  {
    owners: ["src/query.ts"],
    path: "src/utils/taskSummary.ts",
    gate: "BG_SESSIONS",
  },
  {
    owners: ["src/QueryEngine.ts"],
    path: "src/components/MessageSelector.tsx",
  },
  {
    owners: ["src/QueryEngine.ts"],
    path: "src/coordinator/coordinatorMode.ts",
    gate: "COORDINATOR_MODE",
  },
  {
    owners: ["src/QueryEngine.ts"],
    path: "src/services/compact/snipProjection.ts",
    gate: "HISTORY_SNIP",
  },
];
export const OFFLINE_CHECKS = [
  "dist",
  "version",
  "help",
  "tool-registry",
  "command-registry",
  "hot-path-stubs",
  "query-dynamic-requires",
  "doctor",
  "memory-command",
  "context-command",
] as const;
export const ONLINE_CHECKS = [
  "api-basic",
  "api-retry",
  "query-loop",
  "streaming-fallback",
  "permission-denial",
  "error-max-turns",
  "error-during-execution",
  "error-max-structured-output-retries",
  "error-max-budget",
  "claude-md-context",
  "bash-tool",
  "read-tool",
  "write-tool",
  "edit-tool",
  "notebook-edit-tool",
  "grep-tool",
  "glob-tool",
  "agent-flow",
  "webfetch-tool",
  "websearch-tool",
  "mcp-flow",
  "mcp-http-auth-flow",
  "mcp-http-headers-helper-flow",
  "compact-flow",
  "resume-flow",
] as const;
export const ONLINE_CHECK_GROUPS = {
  "api-and-session": [
    "api-basic",
    "query-loop",
    "api-retry",
    "streaming-fallback",
    "permission-denial",
    "error-max-turns",
    "error-during-execution",
    "error-max-structured-output-retries",
    "error-max-budget",
    "claude-md-context",
    "resume-flow",
    "compact-flow",
  ],
  "tools-and-agent": [
    "bash-tool",
    "read-tool",
    "write-tool",
    "edit-tool",
    "notebook-edit-tool",
    "grep-tool",
    "glob-tool",
    "agent-flow",
  ],
  integrations: [
    "webfetch-tool",
    "websearch-tool",
    "mcp-flow",
    "mcp-http-auth-flow",
    "mcp-http-headers-helper-flow",
  ],
} as const;
export const OPTIONAL_LOCAL_CHECKS = ["chrome-readiness", "chrome-smoke"] as const;
const ALL_CHECKS = [...OFFLINE_CHECKS, ...ONLINE_CHECKS, ...OPTIONAL_LOCAL_CHECKS];

type CheckName = (typeof ALL_CHECKS)[number];
type OnlineCheckGroupName = keyof typeof ONLINE_CHECK_GROUPS;
export const ONLINE_CHECK_GROUP_NAMES = Object.keys(ONLINE_CHECK_GROUPS) as OnlineCheckGroupName[];

const args = parseArgs(Bun.argv.slice(2));
if (args.listGroups) {
  printAvailableCheckGroups();
  process.exit(0);
}
const selectedChecks = resolveChecks(args.checks, args.groups, args.online);
const results: CheckResult[] = [];

export function parseCommaSeparatedArg(value: string | undefined): string[] {
  return (value || "")
    .split(",")
    .map((item) => item.trim())
    .filter(Boolean);
}

export function parseArgs(argv: string[]) {
  const parsed = {
    online: false,
    checks: [] as string[],
    groups: [] as string[],
    listGroups: false,
    model: DEFAULT_MODEL,
    maxBudgetUsd: DEFAULT_MAX_BUDGET_USD,
  };

  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index];
    if (arg === "--online") {
      parsed.online = true;
      continue;
    }

    if (arg === "--checks") {
      parsed.checks = parseCommaSeparatedArg(argv[index + 1]);
      index += 1;
      continue;
    }

    if (arg.startsWith("--checks=")) {
      parsed.checks = parseCommaSeparatedArg(arg.slice("--checks=".length));
      continue;
    }

    if (arg === "--group") {
      parsed.groups = [...parsed.groups, ...parseCommaSeparatedArg(argv[index + 1])];
      index += 1;
      continue;
    }

    if (arg.startsWith("--group=")) {
      parsed.groups = [...parsed.groups, ...parseCommaSeparatedArg(arg.slice("--group=".length))];
      continue;
    }

    if (arg === "--groups") {
      parsed.groups = [...parsed.groups, ...parseCommaSeparatedArg(argv[index + 1])];
      index += 1;
      continue;
    }

    if (arg.startsWith("--groups=")) {
      parsed.groups = [...parsed.groups, ...parseCommaSeparatedArg(arg.slice("--groups=".length))];
      continue;
    }

    if (arg === "--list-groups") {
      parsed.listGroups = true;
      continue;
    }

    if (arg === "--model") {
      parsed.model = argv[index + 1] || parsed.model;
      index += 1;
      continue;
    }

    if (arg.startsWith("--model=")) {
      parsed.model = arg.slice("--model=".length);
      continue;
    }

    if (arg === "--max-budget-usd") {
      parsed.maxBudgetUsd = Number(argv[index + 1] || parsed.maxBudgetUsd);
      index += 1;
      continue;
    }

    if (arg.startsWith("--max-budget-usd=")) {
      parsed.maxBudgetUsd = Number(arg.slice("--max-budget-usd=".length));
    }
  }

  return parsed;
}

export function dedupeChecks(checks: CheckName[]): CheckName[] {
  return [...new Set(checks)];
}

export function printAvailableCheckGroups() {
  console.log("Available online smoke groups:");
  for (const groupName of ONLINE_CHECK_GROUP_NAMES) {
    console.log(`  - ${groupName}: ${ONLINE_CHECK_GROUPS[groupName].join(", ")}`);
  }
  console.log("");
  console.log("Use --groups <group[,group...]> or repeat --group <group>.");
}

export function resolveChecks(requestedChecks: string[], requestedGroups: string[], includeOnline: boolean): CheckName[] {
  const resolvedChecks: CheckName[] = [];

  if (requestedGroups.length > 0) {
    const invalidGroups = requestedGroups.filter(
      (groupName) => !ONLINE_CHECK_GROUP_NAMES.includes(groupName as OnlineCheckGroupName),
    );
    if (invalidGroups.length > 0) {
      throw new Error(`Unknown smoke group(s): ${invalidGroups.join(", ")}`);
    }

    for (const groupName of requestedGroups as OnlineCheckGroupName[]) {
      resolvedChecks.push(...ONLINE_CHECK_GROUPS[groupName]);
    }
  }

  if (requestedChecks.length > 0) {
    const invalidChecks = requestedChecks.filter((check) => !ALL_CHECKS.includes(check as CheckName));
    if (invalidChecks.length > 0) {
      throw new Error(`Unknown smoke check(s): ${invalidChecks.join(", ")}`);
    }
    resolvedChecks.push(...(requestedChecks as CheckName[]));
  }

  if (resolvedChecks.length > 0) {
    return dedupeChecks(resolvedChecks);
  }

  return includeOnline
    ? [...OFFLINE_CHECKS, ...ONLINE_CHECKS]
    : [...OFFLINE_CHECKS];
}

function icon(status: Status): string {
  switch (status) {
    case "ok":
      return "[OK]";
    case "warn":
      return "[!!]";
    case "error":
      return "[XX]";
    case "skip":
      return "[--]";
  }
}

async function runCommand(command: string[], options: RunOptions = {}): Promise<RunResult> {
  return await new Promise((resolve, reject) => {
    const proc = spawn(command[0], command.slice(1), {
      cwd: options.cwd ?? process.cwd(),
      env: {
        ...process.env,
        ...(options.env ?? {}),
      },
      stdio: ["pipe", "pipe", "pipe"],
    });

    let stdout = "";
    let stderr = "";
    let timedOut = false;
    const timeoutMs = options.timeoutMs ?? DEFAULT_COMMAND_TIMEOUT_MS;
    const timeout =
      timeoutMs > 0
        ? setTimeout(() => {
            timedOut = true;
            stderr += `\n[smoke-timeout] command exceeded ${timeoutMs} ms: ${command.join(" ")}`;
            proc.kill("SIGTERM");
            setTimeout(() => {
              proc.kill("SIGKILL");
            }, 1000).unref();
          }, timeoutMs)
        : undefined;

    proc.stdout?.setEncoding("utf8");
    proc.stderr?.setEncoding("utf8");
    proc.stdout?.on("data", (chunk) => {
      stdout += chunk;
    });
    proc.stderr?.on("data", (chunk) => {
      stderr += chunk;
    });

    proc.on("error", (error) => {
      if (timeout) {
        clearTimeout(timeout);
      }
      reject(error);
    });

    if (options.stdin !== undefined) {
      proc.stdin?.end(options.stdin);
    } else {
      proc.stdin?.end();
    }

    proc.on("close", (exitCode) => {
      if (timeout) {
        clearTimeout(timeout);
      }
      resolve({
        exitCode: exitCode ?? -1,
        stdout,
        stderr,
        timedOut,
      });
    });
  });
}

async function runTerminalProbe(
  command: string[],
  {
    cwd,
    env,
    maxWaitMs,
    successMarkers,
  }: {
    cwd?: string;
    env?: Record<string, string>;
    maxWaitMs: number;
    successMarkers: string[];
  },
): Promise<TerminalProbeResult> {
  return await new Promise((resolve, reject) => {
    const proc = spawn(command[0], command.slice(1), {
      cwd: cwd ?? process.cwd(),
      env: {
        ...process.env,
        ...(env ?? {}),
      },
      stdio: ["ignore", "pipe", "pipe"],
      detached: true,
    });

    let stdout = "";
    let stderr = "";
    let matched = false;
    let timedOut = false;

    const stopProcessGroup = (signal: NodeJS.Signals) => {
      try {
        process.kill(-proc.pid!, signal);
      } catch {
        // The process may have already exited between detection and cleanup.
      }
    };

    const updateMatchState = () => {
      const anchorOutput = normalizeTerminalAnchorOutput(`${stdout}\n${stderr}`);
      if (!matched && successMarkers.every((marker) => anchorOutput.includes(marker))) {
        matched = true;
        stopProcessGroup("SIGTERM");
      }
    };

    proc.stdout?.setEncoding("utf8");
    proc.stderr?.setEncoding("utf8");
    proc.stdout?.on("data", (chunk) => {
      stdout += chunk;
      updateMatchState();
    });
    proc.stderr?.on("data", (chunk) => {
      stderr += chunk;
      updateMatchState();
    });

    const timeout = setTimeout(() => {
      timedOut = true;
      stopProcessGroup("SIGKILL");
    }, maxWaitMs);

    proc.on("error", (error) => {
      clearTimeout(timeout);
      reject(error);
    });

    proc.on("close", (exitCode) => {
      clearTimeout(timeout);
      resolve({
        exitCode: exitCode ?? -1,
        stdout,
        stderr,
        anchorOutput: normalizeTerminalAnchorOutput(`${stdout}\n${stderr}`),
        matched,
        timedOut,
        normalizedOutput: normalizeTerminalOutput(`${stdout}\n${stderr}`),
      });
      });
  });
}

async function runInteractivePtyProbe(
  command: string[],
  {
    cwd,
    env,
    input,
    inputDelayMs = 0,
    maxWaitMs,
    readyMarkers = [],
    successMarkers,
  }: {
    cwd?: string;
    env?: Record<string, string>;
    input: string;
    inputDelayMs?: number;
    maxWaitMs: number;
    readyMarkers?: string[];
    successMarkers: string[];
  },
): Promise<TerminalProbeResult> {
  const pythonScript = [
    "import base64",
    "import json",
    "import os",
    "import pty",
    "import select",
    "import subprocess",
    "import sys",
    "import time",
    "",
    "command = json.loads(sys.argv[1])",
    "cwd = sys.argv[2]",
    "env_patch = json.loads(sys.argv[3])",
    "input_bytes = base64.b64decode(sys.argv[4])",
    "input_delay_ms = int(sys.argv[5])",
    "max_wait_ms = int(sys.argv[6])",
    "success_markers = json.loads(sys.argv[7])",
    "ready_markers = json.loads(sys.argv[8])",
    "env = os.environ.copy()",
    "env.update(env_patch)",
    "master, slave = pty.openpty()",
    "proc = subprocess.Popen(command, stdin=slave, stdout=slave, stderr=slave, cwd=cwd, env=env, close_fds=True)",
    "os.close(slave)",
    "output = bytearray()",
    "started_at = time.time()",
    "input_sent = not input_bytes",
    "matched = False",
    "deadline = time.time() + (max_wait_ms / 1000.0)",
    "while time.time() < deadline:",
    "    timeout = max(0.0, min(0.2, deadline - time.time()))",
    "    ready, _, _ = select.select([master], [], [], timeout)",
    "    if master in ready:",
    "        try:",
    "            chunk = os.read(master, 65536)",
    "        except OSError:",
    "            break",
    "        if not chunk:",
    "            break",
    "        output.extend(chunk)",
    "    if not input_sent:",
    "        delay_elapsed = (time.time() - started_at) * 1000.0 >= input_delay_ms",
    "        ready_matched = not ready_markers or all(marker.encode('utf-8') in output for marker in ready_markers)",
    "        if delay_elapsed and ready_matched:",
    "            os.write(master, input_bytes)",
    "            input_sent = True",
    "            continue",
    "    if not input_sent:",
    "        continue",
    "    if success_markers and all(marker.encode('utf-8') in output for marker in success_markers):",
    "        matched = True",
    "        break",
    "try:",
    "    proc.terminate()",
    "except Exception:",
    "    pass",
    "time.sleep(0.2)",
    "if proc.poll() is None:",
    "    try:",
    "        proc.kill()",
    "    except Exception:",
    "        pass",
    "print(json.dumps({'output': output.decode('utf-8', 'ignore'), 'matched': matched}))",
  ].join("\n");

  const result = await runCommand(
    [
      "python3",
      "-c",
      pythonScript,
      JSON.stringify(command),
      cwd ?? process.cwd(),
      JSON.stringify(env ?? {}),
      Buffer.from(input, "utf8").toString("base64"),
      String(inputDelayMs),
      String(maxWaitMs),
      JSON.stringify(successMarkers),
      JSON.stringify(readyMarkers),
    ],
    {
      timeoutMs: maxWaitMs + 3_000,
    },
  );

  const payload = parseJsonOutput<PtyProbePayload>(result, "interactive-pty");
  return {
    exitCode: result.exitCode,
    stdout: payload.output,
    stderr: result.stderr,
    timedOut: !payload.matched,
    anchorOutput: normalizeTerminalAnchorOutput(payload.output),
    matched: payload.matched,
    normalizedOutput: normalizeTerminalOutput(payload.output),
  };
}

function parseJsonLines(stdout: string): Array<Record<string, unknown>> {
  return stdout
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter((line) => line.startsWith("{") && line.endsWith("}"))
    .map((line) => JSON.parse(line) as Record<string, unknown>);
}

function lastJsonObject(stdout: string): Record<string, unknown> | null {
  const objects = parseJsonLines(stdout);
  return objects.at(-1) ?? null;
}

function assertPayloadAccounting(
  payload: Record<string, unknown>,
  label: string,
  expectation: AccountingExpectation,
): string | null {
  const usage =
    payload.usage && typeof payload.usage === "object"
      ? (payload.usage as { input_tokens?: unknown; output_tokens?: unknown })
      : null;
  if (
    !usage ||
    Number(usage.input_tokens ?? NaN) !== expectation.inputTokens ||
    Number(usage.output_tokens ?? NaN) !== expectation.outputTokens
  ) {
    return label + ": returned unexpected usage totals";
  }

  const totalCostUsd =
    typeof payload.total_cost_usd === "number"
      ? payload.total_cost_usd
      : Number(payload.total_cost_usd);
  const requirePositiveCost = expectation.requirePositiveCost ?? true;
  if (
    !Number.isFinite(totalCostUsd) ||
    (requirePositiveCost ? totalCostUsd <= 0 : totalCostUsd < 0)
  ) {
    return label + ": returned unexpected total_cost_usd";
  }

  const modelUsage =
    payload.modelUsage && typeof payload.modelUsage === "object"
      ? (payload.modelUsage as Record<
          string,
          { inputTokens?: unknown; outputTokens?: unknown; costUSD?: unknown }
        >)
      : {};
  const aggregateModelUsage = Object.values(modelUsage).reduce(
    (acc, entry) => ({
      inputTokens: acc.inputTokens + Number(entry.inputTokens ?? 0),
      outputTokens: acc.outputTokens + Number(entry.outputTokens ?? 0),
      costUSD: acc.costUSD + Number(entry.costUSD ?? 0),
    }),
    { inputTokens: 0, outputTokens: 0, costUSD: 0 },
  );
  if (
    aggregateModelUsage.inputTokens !== expectation.inputTokens ||
    aggregateModelUsage.outputTokens !== expectation.outputTokens ||
    (requirePositiveCost
      ? aggregateModelUsage.costUSD <= 0
      : aggregateModelUsage.costUSD < 0)
  ) {
    return label + ": returned unexpected modelUsage totals";
  }

  return null;
}

function assertPayloadHasConsistentAccounting(
  payload: Record<string, unknown>,
  label: string,
  options: ConsistentAccountingOptions = {},
): string | null {
  const usage =
    payload.usage && typeof payload.usage === "object"
      ? (payload.usage as {
          input_tokens?: unknown;
          output_tokens?: unknown;
          cache_read_input_tokens?: unknown;
          cache_creation_input_tokens?: unknown;
        })
      : null;
  if (!usage) {
    return label + ": missing usage payload";
  }

  const inputTokens = Number(usage.input_tokens ?? NaN);
  const outputTokens = Number(usage.output_tokens ?? NaN);
  const cacheReadTokens = Number(usage.cache_read_input_tokens ?? 0);
  const cacheCreationTokens = Number(usage.cache_creation_input_tokens ?? 0);
  const allowZeroInputTokens = options.allowZeroInputTokens ?? false;
  if (!Number.isFinite(inputTokens) || (allowZeroInputTokens ? inputTokens < 0 : inputTokens <= 0)) {
    return label + ": returned unexpected input token usage";
  }
  if (!Number.isFinite(outputTokens) || outputTokens < 0) {
    return label + ": returned unexpected output token usage";
  }
  if (!Number.isFinite(cacheReadTokens) || cacheReadTokens < 0) {
    return label + ": returned unexpected cache_read_input_tokens";
  }
  if (!Number.isFinite(cacheCreationTokens) || cacheCreationTokens < 0) {
    return label + ": returned unexpected cache_creation_input_tokens";
  }

  const totalCostUsd =
    typeof payload.total_cost_usd === "number"
      ? payload.total_cost_usd
      : Number(payload.total_cost_usd);
  if (!Number.isFinite(totalCostUsd) || totalCostUsd <= 0) {
    return label + ": returned unexpected total_cost_usd";
  }

  const modelUsage =
    payload.modelUsage && typeof payload.modelUsage === "object"
      ? (payload.modelUsage as Record<
          string,
          {
            inputTokens?: unknown;
            outputTokens?: unknown;
            cacheReadInputTokens?: unknown;
            cacheCreationInputTokens?: unknown;
            costUSD?: unknown;
          }
        >)
      : {};
  if (Object.keys(modelUsage).length === 0) {
    return label + ": missing modelUsage payload";
  }

  const aggregateModelUsage = Object.values(modelUsage).reduce(
    (acc, entry) => ({
      inputTokens: acc.inputTokens + Number(entry.inputTokens ?? 0),
      outputTokens: acc.outputTokens + Number(entry.outputTokens ?? 0),
      cacheReadInputTokens:
        acc.cacheReadInputTokens + Number(entry.cacheReadInputTokens ?? 0),
      cacheCreationInputTokens:
        acc.cacheCreationInputTokens +
        Number(entry.cacheCreationInputTokens ?? 0),
      costUSD: acc.costUSD + Number(entry.costUSD ?? 0),
    }),
    {
      inputTokens: 0,
      outputTokens: 0,
      cacheReadInputTokens: 0,
      cacheCreationInputTokens: 0,
      costUSD: 0,
    },
  );

  if (options.allowUsageSubsetOfModelUsage) {
    if (
      aggregateModelUsage.inputTokens < inputTokens ||
      aggregateModelUsage.outputTokens < outputTokens ||
      aggregateModelUsage.cacheReadInputTokens < cacheReadTokens ||
      aggregateModelUsage.cacheCreationInputTokens < cacheCreationTokens
    ) {
      return label + ": aggregate modelUsage fell below top-level usage";
    }
  } else if (
    aggregateModelUsage.inputTokens !== inputTokens ||
    aggregateModelUsage.outputTokens !== outputTokens ||
    aggregateModelUsage.cacheReadInputTokens !== cacheReadTokens ||
    aggregateModelUsage.cacheCreationInputTokens !== cacheCreationTokens
  ) {
    return label + ": usage and modelUsage totals diverged";
  }

  if (Math.abs(aggregateModelUsage.costUSD - totalCostUsd) > 1e-9) {
    return label + ": total_cost_usd and modelUsage cost diverged";
  }

  return null;
}

function parseJsonOutput<T>(result: RunResult, label: string): T {
  if (result.exitCode !== 0) {
    throw new Error(
      `${label} probe failed: ${compactOutput(result.stderr || result.stdout)}`,
    );
  }

  try {
    return JSON.parse(result.stdout.trim()) as T;
  } catch (error) {
    throw new Error(
      `${label} probe returned invalid JSON: ${error instanceof Error ? error.message : String(error)}`,
    );
  }
}

function encodeAnthropicSse(events: Array<[string, unknown]>): string {
  return events
    .map(([event, data]) => "event: " + event + "\ndata: " + JSON.stringify(data) + "\n\n")
    .join("");
}

async function inspectToolRegistry(): Promise<ToolRegistrySnapshot> {
  const probe = await runCommand(
    [
      "bun",
      "--eval",
      [
        "import { getAllBaseTools } from './src/tools.ts';",
        "const tools = getAllBaseTools();",
        "console.log(JSON.stringify({ toolCount: tools.length, toolNames: tools.map(tool => tool.name).sort() }));",
      ].join(" "),
    ],
    {
      env: {
        ANTHROPIC_API_KEY: process.env.ANTHROPIC_API_KEY || "smoke-dummy-key",
      },
    },
  );

  const runtime = parseJsonOutput<{
    toolCount: number;
    toolNames: string[];
  }>(probe, "tool-registry");
  const toolsSource = await Bun.file("src/tools.ts").text();
  const sourceDirectories = (await readdir("src/tools", { withFileTypes: true }))
    .filter((entry) => entry.isDirectory())
    .map((entry) => entry.name)
    .filter((name) => name !== "shared" && name !== "src")
    .sort();
  const referencedDirectories = Array.from(
    new Set(
      Array.from(
        toolsSource.matchAll(/\.\/tools\/([^/]+)\//g),
        (match) => match[1]!,
      ),
    ),
  ).sort();
  const referencedDirectorySet = new Set(referencedDirectories);
  const unregisteredDirs = sourceDirectories.filter(
    (directory) => !referencedDirectorySet.has(directory),
  );

  return {
    ...runtime,
    toolDirectoryCount: sourceDirectories.length,
    referencedDirectoryCount: referencedDirectories.length,
    unregisteredDirs,
    unexpectedUnregisteredDirs: unregisteredDirs.filter(
      (directory) => !KNOWN_UNREGISTERED_TOOL_DIRS.has(directory),
    ),
  };
}

async function inspectCommandRegistry(): Promise<CommandRegistrySnapshot> {
  const probe = await runCommand(
    [
      "bun",
      "--eval",
      [
        "import { builtInCommandNames, getCommands } from './src/commands.ts';",
        "const commands = await getCommands(process.cwd());",
        "console.log(JSON.stringify({",
        "  commandCount: commands.length,",
        "  commandNames: commands.map(command => command.name).sort(),",
        "  builtInNameCount: builtInCommandNames().size,",
        "  localJsxCount: commands.filter(command => command.type === 'local-jsx').length,",
        "  localCount: commands.filter(command => command.type === 'local').length,",
        "  promptCount: commands.filter(command => command.type === 'prompt').length,",
        "}));",
      ].join(" "),
    ],
    {
      env: {
        ...process.env,
        NODE_ENV: "test",
        ANTHROPIC_API_KEY: process.env.ANTHROPIC_API_KEY || "smoke-dummy-key",
      },
    },
  );

  return parseJsonOutput<CommandRegistrySnapshot>(probe, "command-registry");
}

function toolUseSeen(events: Array<Record<string, unknown>>, toolName: string): boolean {
  return events.some((event) => {
    if (event.type !== "assistant") {
      return false;
    }

    const message = event.message as { content?: Array<{ type?: string; name?: string }> } | undefined;
    return (message?.content || []).some((block) => block.type === "tool_use" && block.name === toolName);
  });
}

function toolResultContent(events: Array<Record<string, unknown>>, toolName: string): string | null {
  const matchingUserEvent = toolResultEvent(events, toolName);
  if (!matchingUserEvent) {
    return null;
  }

  const userMessage = matchingUserEvent.message as {
    content?: Array<{ type?: string; tool_use_id?: string; content?: string }>;
  };
  const toolResult = (userMessage.content || []).find((block) => block.type === "tool_result");
  if (toolResult?.content) {
    return String(toolResult.content);
  }

  return null;
}

function toolResultEvent(events: Array<Record<string, unknown>>, toolName: string): Record<string, unknown> | null {
  for (const event of events) {
    if (event.type !== "assistant") {
      continue;
    }

    const message = event.message as { content?: Array<{ type?: string; name?: string; id?: string }> } | undefined;
    const toolUse = (message?.content || []).find((block) => block.type === "tool_use" && block.name === toolName);
    if (!toolUse?.id) {
      continue;
    }

    const matchingUserEvent = events.find((candidate) => {
      if (candidate.type !== "user") {
        return false;
      }
      const userMessage = candidate.message as {
        content?: Array<{ type?: string; tool_use_id?: string; content?: string }>;
      } | undefined;
      return (userMessage?.content || []).some(
        (block) => block.type === "tool_result" && block.tool_use_id === toolUse.id,
      );
    });

    if (!matchingUserEvent) {
      continue;
    }

    return matchingUserEvent;
  }

  return null;
}

function toolStructuredResult(events: Array<Record<string, unknown>>, toolName: string): Record<string, unknown> | null {
  const matchingUserEvent = toolResultEvent(events, toolName);
  if (!matchingUserEvent) {
    return null;
  }

  const structured = matchingUserEvent.tool_use_result;
  return structured && typeof structured === "object" ? (structured as Record<string, unknown>) : null;
}

export function shouldRetryTransientToolSmoke(detail: string): boolean {
  return detail.includes("[smoke-timeout]") || detail.includes("tool_use event not observed");
}

function hasStubMarker(source: string): boolean {
  return source.includes("Auto-generated stub") || source.includes("replace with real implementation");
}

function summarizePaths(paths: string[], sampleSize = 3, preferred: string[] = []): string {
  if (paths.length === 0) {
    return "0";
  }
  const prioritized = [
    ...preferred.filter((path) => paths.includes(path)),
    ...paths.filter((path) => !preferred.includes(path)),
  ];
  const sample = prioritized.slice(0, sampleSize);
  const remainder = paths.length - sample.length;
  return remainder > 0
    ? `${paths.length} (${sample.join(", ")} + ${remainder} more)`
    : `${paths.length} (${sample.join(", ")})`;
}

function summarizeDormantStubPaths(
  paths: Array<{ path: string; reason: string }>,
  sampleSize = 2,
): string {
  if (paths.length === 0) {
    return "0";
  }
  const sample = paths.slice(0, sampleSize).map(({ path, reason }) => `${path} (${reason})`);
  const remainder = paths.length - sample.length;
  return remainder > 0
    ? `${paths.length} (${sample.join(", ")} + ${remainder} more)`
    : `${paths.length} (${sample.join(", ")})`;
}

function summarizeDynamicTargets(
  targets: Array<{ path: string; gate?: keyof typeof FEATURE_FLAG_STATES }>,
  sampleSize = 2,
  preferred: string[] = [],
): string {
  if (targets.length === 0) {
    return "0";
  }
  const labels = targets.map(({ path, gate }) => ({
    path,
    label: gate ? `${path} [${gate}=off]` : `${path} [active]`,
  }));
  const prioritized = [
    ...preferred.map((path) => labels.find((entry) => entry.path === path)).filter(Boolean),
    ...labels.filter((entry) => !preferred.includes(entry.path)),
  ] as Array<{ path: string; label: string }>;
  const sample = prioritized.slice(0, sampleSize).map((entry) => entry.label);
  const remainder = labels.length - sample.length;
  return remainder > 0
    ? `${labels.length} (${sample.join(", ")} + ${remainder} more)`
    : `${labels.length} (${sample.join(", ")})`;
}

function extractRelativeImports(source: string): ImportEdge[] {
  const imports: ImportEdge[] = [];
  const seen = new Set<string>();
  const pushImport = (specifier: string, typeOnly: boolean) => {
    if (!specifier.startsWith(".")) {
      return;
    }
    const key = `${typeOnly ? "type" : "value"}:${specifier}`;
    if (seen.has(key)) {
      return;
    }
    seen.add(key);
    imports.push({ specifier, typeOnly });
  };

  for (const match of source.matchAll(/(^|\n)\s*import\s+(type\s+)?[\s\S]*?from\s+["']([^"']+)["']/g)) {
    pushImport(match[3]!, Boolean(match[2]));
  }

  for (const match of source.matchAll(/(^|\n)\s*import\s+["']([^"']+)["']/g)) {
    pushImport(match[2]!, false);
  }

  return imports;
}

async function resolveRuntimeImport(importer: string, specifier: string): Promise<string | null> {
  const importerDir = dirname(importer);
  const basePath = resolve(importerDir, specifier);
  const candidates = [
    basePath,
    `${basePath}.ts`,
    `${basePath}.tsx`,
    `${basePath}/index.ts`,
    `${basePath}/index.tsx`,
  ];

  if (specifier.endsWith(".js")) {
    const withoutJs = basePath.slice(0, -3);
    candidates.unshift(
      `${withoutJs}.ts`,
      `${withoutJs}.tsx`,
      `${withoutJs}/index.ts`,
      `${withoutJs}/index.tsx`,
    );
  }

  for (const candidate of candidates) {
    try {
      const candidateStat = await stat(candidate);
      if (candidateStat.isFile()) {
        return candidate;
      }
    } catch {
      // Try the next candidate.
    }
  }

  return null;
}

async function auditHotPathStubImports(roots: string[]): Promise<HotPathStubAudit> {
  const runtimeStubPaths = new Set<string>();
  const dormantStubPaths = new Map<string, string>();
  const typeOnlyStubPaths = new Set<string>();
  const visitedRuntimeFiles = new Set<string>();
  const classifyStubPath = (file: string) => {
    const relativePath = relative(process.cwd(), file) || file;
    const dormantReason = KNOWN_DORMANT_STUB_REASONS[relativePath]?.();
    if (dormantReason) {
      dormantStubPaths.set(relativePath, dormantReason);
      return { relativePath, dormant: true };
    }
    return { relativePath, dormant: false };
  };

  const walkRuntime = async (file: string): Promise<void> => {
    if (visitedRuntimeFiles.has(file)) {
      return;
    }
    visitedRuntimeFiles.add(file);

    const source = await Bun.file(file).text();
    if (hasStubMarker(source)) {
      const stubPath = classifyStubPath(file);
      if (!stubPath.dormant) {
        runtimeStubPaths.add(stubPath.relativePath);
      }
      return;
    }

    const imports = extractRelativeImports(source);
    for (const imported of imports) {
      const resolved = await resolveRuntimeImport(file, imported.specifier);
      if (!resolved) {
        continue;
      }

      const importedSource = await Bun.file(resolved).text();
      if (imported.typeOnly) {
        if (hasStubMarker(importedSource)) {
          typeOnlyStubPaths.add(relative(process.cwd(), resolved) || resolved);
        }
        continue;
      }

      if (hasStubMarker(importedSource)) {
        const stubPath = classifyStubPath(resolved);
        if (!stubPath.dormant) {
          runtimeStubPaths.add(stubPath.relativePath);
        }
        continue;
      }

      await walkRuntime(resolved);
    }
  };

  for (const root of roots) {
    await walkRuntime(resolve(process.cwd(), root));
  }

  return {
    runtimeStubPaths: Array.from(runtimeStubPaths).sort(),
    dormantStubPaths: Array.from(dormantStubPaths.entries())
      .map(([path, reason]) => ({ path, reason }))
      .sort((a, b) => a.path.localeCompare(b.path)),
    typeOnlyStubPaths: Array.from(typeOnlyStubPaths).sort(),
    visitedRuntimeFiles: Array.from(visitedRuntimeFiles)
      .map((file) => relative(process.cwd(), file) || file)
      .sort(),
  };
}

function budgetLimited(result: RunResult): boolean {
  return result.exitCode !== 0 && result.stdout.includes('"subtype":"error_max_budget_usd"');
}

function streamEventSeen(
  events: Array<Record<string, unknown>>,
  predicate: (event: Record<string, unknown>) => boolean,
): boolean {
  return events.some(predicate);
}

async function record(name: CheckName, task: () => Promise<Omit<CheckResult, "name" | "durationMs">>) {
  const start = Date.now();
  console.log(`  [...] ${name}`);
  try {
    const result = await task();
    results.push({
      name,
      status: result.status,
      detail: result.detail,
      durationMs: Date.now() - start,
    });
  } catch (error) {
    results.push({
      name,
      status: "error",
      detail: error instanceof Error ? error.message : String(error),
      durationMs: Date.now() - start,
    });
  }
}

async function checkDist() {
  const file = Bun.file("dist/cli.js");
  const exists = await file.exists();
  if (!exists) {
    return { status: "error" as const, detail: "dist/cli.js is missing" };
  }

  const info = await stat("dist/cli.js");
  return {
    status: "ok" as const,
    detail: `dist/cli.js present (${(info.size / 1024 / 1024).toFixed(1)} MB)`,
  };
}

async function checkVersion() {
  const result = await runCommand(["node", "dist/cli.js", "--version"]);
  if (result.exitCode !== 0) {
    return { status: "error" as const, detail: compactOutput(result.stderr || result.stdout) };
  }

  return { status: "ok" as const, detail: compactOutput(result.stdout) };
}

async function checkHelp() {
  const result = await runCommand(["node", "dist/cli.js", "--help"]);
  if (result.exitCode !== 0) {
    return { status: "error" as const, detail: compactOutput(result.stderr || result.stdout) };
  }

  const requiredFragments = ["--output-format", "--permission-mode", "--allowedTools"];
  const missing = requiredFragments.filter((fragment) => !result.stdout.includes(fragment));
  if (missing.length > 0) {
    return {
      status: "error" as const,
      detail: `missing help fragment(s): ${missing.join(", ")}`,
    };
  }

  return { status: "ok" as const, detail: "help output contains required smoke flags" };
}

async function checkToolRegistry() {
  const registry = await inspectToolRegistry();
  const requiredTools = [
    "Agent",
    "Bash",
    "Read",
    "Edit",
    "Write",
    "Glob",
    "Grep",
    "WebFetch",
    "WebSearch",
    "TodoWrite",
    "TaskOutput",
    "TaskStop",
    "AskUserQuestion",
  ];
  const missing = requiredTools.filter((tool) => !registry.toolNames.includes(tool));
  if (missing.length > 0) {
    return {
      status: "error" as const,
      detail: `missing runtime tool(s): ${missing.join(", ")}`,
    };
  }

  if (registry.toolCount < 25) {
    return {
      status: "error" as const,
      detail: `tool registry unexpectedly small: ${registry.toolCount} tools`,
    };
  }

  if (registry.unexpectedUnregisteredDirs.length > 0) {
    return {
      status: "warn" as const,
      detail:
        `runtime tool registry OK (${registry.toolCount} tools), but found new unregistered src/tools directories: ` +
        registry.unexpectedUnregisteredDirs.join(", "),
    };
  }

  const unregisteredDetail =
    registry.unregisteredDirs.length > 0
      ? `; known unregistered dirs: ${registry.unregisteredDirs.join(", ")}`
      : "";

  return {
    status: "ok" as const,
    detail:
      `${registry.toolCount} runtime tools; ${registry.toolDirectoryCount} source dirs audited / ` +
      `${registry.referencedDirectoryCount} referenced` +
      unregisteredDetail,
  };
}

async function checkCommandRegistry() {
  const registry = await inspectCommandRegistry();
  const requiredCommands = [
    "doctor",
    "resume",
    "compact",
    "memory",
    "agents",
    "mcp",
    "review",
    "permissions",
    "plan",
  ];
  const missing = requiredCommands.filter(
    (command) => !registry.commandNames.includes(command),
  );
  if (missing.length > 0) {
    return {
      status: "error" as const,
      detail: `missing built-in command(s): ${missing.join(", ")}`,
    };
  }

  if (registry.commandCount < 50) {
    return {
      status: "error" as const,
      detail: `command registry unexpectedly small: ${registry.commandCount} commands`,
    };
  }

  if (registry.builtInNameCount < registry.commandCount) {
    return {
      status: "error" as const,
      detail:
        `command alias set is inconsistent: ${registry.builtInNameCount} callable names for ` +
        `${registry.commandCount} commands`,
    };
  }

  return {
    status: "ok" as const,
    detail:
      `${registry.commandCount} commands, ${registry.builtInNameCount} callable names incl aliases ` +
      `(${registry.localJsxCount} local-jsx / ${registry.localCount} local / ${registry.promptCount} prompt)`,
  };
}

async function checkDoctor() {
  const result = await runTerminalProbe(
    ["script", "-q", "/dev/null", "zsh", "-lc", "exec node dist/cli.js doctor"],
    {
      cwd: process.cwd(),
      maxWaitMs: 20_000,
      successMarkers: ["Diagnostics", "Currentlyrunning:", "Search:", "PressEntertocontinue"],
    },
  );

  if (!result.matched) {
    return {
      status: "error" as const,
      detail: result.timedOut
        ? `doctor screen did not render expected anchors: ${compactOutput(result.normalizedOutput)}`
        : `doctor probe exited before expected anchors: ${compactOutput(result.normalizedOutput)}`,
    };
  }

  return {
    status: "ok" as const,
    detail: "doctor screen rendered Diagnostics/Search/Press Enter anchors",
  };
}

async function checkMemoryCommand() {
  try {
    const result = await runInteractivePtyProbe(["node", "dist/cli.js"], {
      cwd: process.cwd(),
      input: "/memory\r",
      readyMarkers: ["Claude Code", "bypass permissions on"],
      maxWaitMs: 12_000,
      successMarkers: [
        "Memory",
        "Project memory",
        "User memory",
        "Checked in at ./CLAUDE.md",
        "Saved in ~/.claude/CLAUDE.md",
      ],
    });

    if (!result.matched) {
      return {
        status: "error" as const,
        detail:
          "memory screen did not render expected anchors: " +
          compactOutput(result.normalizedOutput),
      };
    }

    return {
      status: "ok" as const,
      detail: "/memory rendered Memory/Project memory/User memory anchors in a PTY session",
    };
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    if (message.includes("python3") && message.includes("ENOENT")) {
      return {
        status: "skip" as const,
        detail: "python3 is unavailable, so the /memory PTY smoke was skipped",
      };
    }
    return {
      status: "error" as const,
      detail: compactOutput(message),
    };
  }
}

async function checkContextCommand() {
  const result = await runCommand([
    "node",
    "dist/cli.js",
    "-p",
    "/context",
    "--output-format",
    "json",
    "--permission-mode",
    "bypassPermissions",
    "--max-turns",
    "1",
  ]);

  if (result.exitCode !== 0) {
    return {
      status: "error" as const,
      detail: compactOutput(result.stderr || result.stdout),
    };
  }

  const payload = extractSuccessfulJsonResult(result);
  const finalResult = payload?.result ? String(payload.result) : "";
  const claudeMdPath = join(process.cwd(), "CLAUDE.md");

  if (!finalResult.includes("## Context Usage") || !finalResult.includes("**Tokens:**")) {
    return {
      status: "error" as const,
      detail: "noninteractive /context output did not include the expected summary headings",
    };
  }

  if (!finalResult.includes("### Memory Files") || !finalResult.includes(claudeMdPath)) {
    return {
      status: "error" as const,
      detail: "noninteractive /context output did not include the expected memory file listing",
    };
  }

  return {
    status: "ok" as const,
    detail: "noninteractive /context rendered context summary and listed project CLAUDE.md",
  };
}

async function checkChromeReadiness() {
  const summary = await collectClaudeInChromeReadinessSummary();

  if (summary.ready) {
    return {
      status: "ok" as const,
      detail: "Claude in Chrome native host and browser extension are ready",
    };
  }

  switch (summary.status) {
    case "no-browser-roots":
      return {
        status: "skip" as const,
        detail: "no supported Chromium browser data roots found on this machine",
      };
    case "extension-missing":
      return {
        status: "skip" as const,
        detail: "Claude browser extension is not installed yet",
      };
    case "socket-missing":
      return {
        status: "skip" as const,
        detail: "Claude browser extension is installed, but no live native socket is connected yet",
      };
    case "manifest-missing":
      return {
        status: "warn" as const,
        detail: "native host manifest is missing even though Chromium browser roots exist",
      };
    case "manifest-invalid":
      return {
        status: "warn" as const,
        detail: "native host manifest exists but does not expose a valid wrapper path",
      };
    case "manifest-target-missing":
      return {
        status: "warn" as const,
        detail: "native host manifest points to a missing wrapper target",
      };
    case "manifest-target-not-executable":
      return {
        status: "warn" as const,
        detail: "native host wrapper exists but is not executable",
      };
    case "ready":
      return {
        status: "ok" as const,
        detail: "Claude in Chrome native host and browser extension are ready",
      };
  }
}

async function checkHotPathStubs() {
  const files = [
    "src/query.ts",
    "src/QueryEngine.ts",
    "src/context.ts",
    "src/tools.ts",
    "src/commands.ts",
    "src/services/mcp/client.ts",
  ];
  const directOffenders: string[] = [];
  for (const file of files) {
    const source = await Bun.file(file).text();
    if (hasStubMarker(source)) {
      directOffenders.push(file);
    }
  }

  if (directOffenders.length > 0) {
    return {
      status: "error" as const,
      detail: `stub marker found in hot path entry file(s): ${directOffenders.join(", ")}`,
    };
  }

  const audit = await auditHotPathStubImports(files);
  if (audit.runtimeStubPaths.length > 0) {
    return {
      status: "error" as const,
      detail: `runtime import graph reaches stub file(s): ${audit.runtimeStubPaths.join(", ")}`,
    };
  }

  const typeOnlyNote =
    audit.typeOnlyStubPaths.length > 0
      ? `; type-only stub(s): ${summarizePaths(audit.typeOnlyStubPaths, 3, ["src/query/transitions.ts"])}`
      : "";
  const dormantNote =
    audit.dormantStubPaths.length > 0
      ? `; dormant stub(s): ${summarizeDormantStubPaths(audit.dormantStubPaths)}`
      : "";

  return {
    status: "ok" as const,
    detail: `${files.length} hot-path roots reached ${audit.visitedRuntimeFiles.length} runtime files with no runtime stubs${typeOnlyNote}${dormantNote}`,
  };
}

async function checkQueryDynamicRequires() {
  const activeReal: Array<{ path: string; gate?: keyof typeof FEATURE_FLAG_STATES }> = [];
  const gatedReal: Array<{ path: string; gate?: keyof typeof FEATURE_FLAG_STATES }> = [];
  const dormantStub: Array<{ path: string; gate?: keyof typeof FEATURE_FLAG_STATES }> = [];
  const errors: string[] = [];

  for (const target of QUERY_DYNAMIC_REQUIRE_TARGETS) {
    const resolvedPath = resolve(process.cwd(), target.path);
    let exists = false;
    try {
      const fileStat = await stat(resolvedPath);
      exists = fileStat.isFile();
    } catch {
      exists = false;
    }

    const gateEnabled = target.gate ? FEATURE_FLAG_STATES[target.gate] : true;
    const ownerLabel = target.owners.join(", ");

    if (!exists) {
      if (gateEnabled) {
        errors.push(`${target.path} missing for active require from ${ownerLabel}`);
      }
      continue;
    }

    const source = await Bun.file(resolvedPath).text();
    const stub = hasStubMarker(source);

    if (gateEnabled) {
      if (stub) {
        errors.push(`${target.path} is stubbed while active for ${ownerLabel}`);
      } else {
        activeReal.push(target);
      }
      continue;
    }

    if (stub) {
      dormantStub.push(target);
    } else {
      gatedReal.push(target);
    }
  }

  if (errors.length > 0) {
    return {
      status: "error" as const,
      detail: errors.join("; "),
    };
  }

  return {
    status: "ok" as const,
    detail: `${QUERY_DYNAMIC_REQUIRE_TARGETS.length} query dynamic require target(s) audited; active real: ${summarizeDynamicTargets(activeReal, 2, ["src/components/MessageSelector.tsx"])}; gated real: ${summarizeDynamicTargets(gatedReal, 2, ["src/coordinator/coordinatorMode.ts"])}; dormant stub: ${summarizeDynamicTargets(dormantStub, 3, ["src/services/compact/reactiveCompact.ts", "src/services/contextCollapse/index.ts", "src/services/compact/snipCompact.ts"])}`,
  };
}

async function checkApiBasic() {
  const result = await runCommand([
    "node",
    "dist/cli.js",
    "-p",
    "Reply with __SMOKE_OK__ only.",
    "--model",
    args.model,
    "--output-format",
    "json",
    "--max-budget-usd",
    String(args.maxBudgetUsd),
    "--permission-mode",
    "bypassPermissions",
  ]);

  if (result.exitCode !== 0) {
    return {
      status: "error" as const,
      detail: compactOutput(result.stderr || result.stdout),
    };
  }

  const payload = lastJsonObject(result.stdout);
  if (!payload || payload.subtype !== "success" || payload.result !== "__SMOKE_OK__") {
    return {
      status: "error" as const,
      detail: compactOutput(result.stdout || result.stderr),
    };
  }

  const accountingError = assertPayloadHasConsistentAccounting(
    payload,
    "basic API smoke",
  );
  if (accountingError) {
    return {
      status: "error" as const,
      detail: accountingError,
    };
  }

  return { status: "ok" as const, detail: "basic API prompt succeeded" };
}

async function checkApiRetry() {
  const tempDir = await mkdtemp(join(tmpdir(), "claude-code-smoke-api-retry-"));
  const token = "SMOKE_API_RETRY_" + Math.random().toString(36).slice(2, 10);
  const seenPaths: string[] = [];
  let requestCount = 0;

  const server = Bun.serve({
    hostname: "127.0.0.1",
    port: 0,
    fetch: async (request) => {
      const url = new URL(request.url);
      if (request.method !== "POST" || url.pathname !== "/v1/messages") {
        return new Response("not found", { status: 404 });
      }

      seenPaths.push(request.method + " " + url.pathname + url.search);
      requestCount += 1;

      let requestedModel = args.model;
      try {
        const body = (await request.json()) as { model?: unknown };
        if (typeof body?.model === "string" && body.model.length > 0) {
          requestedModel = body.model;
        }
      } catch {
        // Keep the smoke resilient to parser differences; request count and
        // final result assertions below still catch protocol drift.
      }

      if (requestCount === 1) {
        return new Response(
          JSON.stringify({
            type: "error",
            error: {
              type: "rate_limit_error",
              message: "smoke retry please",
            },
          }),
          {
            status: 429,
            headers: {
              "content-type": "application/json",
              "retry-after": "1",
            },
          },
        );
      }

      return new Response(
        encodeAnthropicSse([
          [
            "message_start",
            {
              type: "message_start",
              message: {
                id: "msg_smoke_api_retry",
                type: "message",
                role: "assistant",
                model: requestedModel,
                content: [],
                stop_reason: null,
                stop_sequence: null,
                usage: {
                  input_tokens: 12,
                  output_tokens: 0,
                },
              },
            },
          ],
          [
            "content_block_start",
            {
              type: "content_block_start",
              index: 0,
              content_block: {
                type: "text",
                text: "",
              },
            },
          ],
          [
            "content_block_delta",
            {
              type: "content_block_delta",
              index: 0,
              delta: {
                type: "text_delta",
                text: token,
              },
            },
          ],
          [
            "content_block_stop",
            {
              type: "content_block_stop",
              index: 0,
            },
          ],
          [
            "message_delta",
            {
              type: "message_delta",
              delta: {
                stop_reason: "end_turn",
                stop_sequence: null,
              },
              usage: {
                output_tokens: token.length,
              },
            },
          ],
          [
            "message_stop",
            {
              type: "message_stop",
            },
          ],
        ]),
        {
          status: 200,
          headers: {
            "content-type": "text/event-stream",
          },
        },
      );
    },
  });

  const settingsPath = join(tempDir, "settings.json");

  try {
    await writeFile(
      settingsPath,
      JSON.stringify({
        env: {
          ANTHROPIC_BASE_URL: "http://127.0.0.1:" + server.port,
          ANTHROPIC_API_KEY: "smoke-dummy-key",
        },
      }),
      "utf8",
    );

    const result = await runCommand(
      [
        "node",
        join(process.cwd(), "dist/cli.js"),
        "-p",
        "Reply with " + token + " only.",
        "--model",
        args.model,
        "--output-format",
        "stream-json",
        "--verbose",
        "--max-budget-usd",
        String(args.maxBudgetUsd),
        "--permission-mode",
        "bypassPermissions",
        "--max-turns",
        "1",
        "--settings",
        settingsPath,
      ],
      {
        cwd: tempDir,
        env: {
          ANTHROPIC_BASE_URL: "",
          ANTHROPIC_API_KEY: "",
          ANTHROPIC_AUTH_TOKEN: "",
          CLAUDE_CODE_OAUTH_TOKEN: "",
        },
      },
    );

    if (result.exitCode !== 0) {
      return {
        status: "error" as const,
        detail: compactOutput(result.stderr || result.stdout),
      };
    }

    if (requestCount !== 2) {
      return {
        status: "error" as const,
        detail: "api retry smoke expected 2 local /v1/messages requests, saw " + requestCount,
      };
    }

    if (seenPaths.some((path) => !path.startsWith("POST /v1/messages"))) {
      return {
        status: "error" as const,
        detail: "api retry smoke hit unexpected local endpoint(s): " + seenPaths.join(", "),
      };
    }

    const events = parseJsonLines(result.stdout);
    const retryEvent = events.find(
      (event) => event.type === "system" && event.subtype === "api_retry",
    );
    if (!retryEvent) {
      return {
        status: "error" as const,
        detail: "api retry smoke did not emit a system api_retry event",
      };
    }

    if (
      retryEvent.attempt !== 1 ||
      retryEvent.error_status !== 429 ||
      retryEvent.error !== "rate_limit"
    ) {
      return {
        status: "error" as const,
        detail: "api retry smoke emitted unexpected api_retry metadata",
      };
    }

    if (retryEvent.retry_delay_ms !== 1000) {
      return {
        status: "error" as const,
        detail:
          "api retry smoke returned unexpected retry_delay_ms: " +
          String(retryEvent.retry_delay_ms),
      };
    }

    const payload = extractSuccessfulJsonResult(result);
    const finalResult = payload?.result ? String(payload.result).trim() : "";
    if (!payload || finalResult !== token) {
      return {
        status: "error" as const,
        detail: "api retry smoke did not finish with the expected success result",
      };
    }

    if (payload.stop_reason !== "end_turn") {
      return {
        status: "error" as const,
        detail: "api retry smoke returned unexpected stop_reason",
      };
    }

    const accountingError = assertPayloadAccounting(payload, "api retry smoke", {
      inputTokens: 12,
      outputTokens: token.length,
    });
    if (accountingError) {
      return {
        status: "error" as const,
        detail: accountingError,
      };
    }

    return {
      status: "ok" as const,
      detail:
        "local 429 + Retry-After surfaced api_retry and then completed successfully with preserved usage/cost metadata",
    };
  } finally {
    server.stop(true);
    await rm(tempDir, { recursive: true, force: true });
  }
}

async function checkQueryLoop() {
  const expectedResult = "__STREAM_LOOP_OK__";
  const result = await runCommand([
    "node",
    "dist/cli.js",
    "-p",
    `Reply with ${expectedResult} only.`,
    "--model",
    args.model,
    "--output-format",
    "stream-json",
    "--verbose",
    "--max-budget-usd",
    String(args.maxBudgetUsd),
    "--permission-mode",
    "bypassPermissions",
  ]);

  if (result.exitCode !== 0) {
    return {
      status: "error" as const,
      detail: compactOutput(result.stderr || result.stdout),
    };
  }

  const events = parseJsonLines(result.stdout);
  const initEvent = events.find(
    (event) => event.type === "system" && event.subtype === "init",
  );
  if (!initEvent) {
    return {
      status: "error" as const,
      detail: "stream-json query loop did not emit system init",
    };
  }

  const assistantTextSeen = events.some((event) => {
    if (event.type !== "assistant") {
      return false;
    }

    const message = event.message as { content?: Array<{ type?: string; text?: string }> } | undefined;
    return (message?.content || []).some(
      (block) => block.type === "text" && typeof block.text === "string" && block.text.includes(expectedResult),
    );
  });
  if (!assistantTextSeen) {
    return {
      status: "error" as const,
      detail: "stream-json query loop did not emit the expected assistant text event",
    };
  }

  const payload = lastJsonObject(result.stdout);
  const finalResult = payload?.result ? String(payload.result).trim() : "";
  if (!payload || payload.subtype !== "success" || finalResult !== expectedResult) {
    return {
      status: "error" as const,
      detail: "stream-json query loop did not finish with the expected success result",
    };
  }

  if (payload.stop_reason !== "end_turn") {
    return {
      status: "error" as const,
      detail: `stream-json query loop returned unexpected stop_reason: ${String(payload.stop_reason ?? "<empty>")}`,
    };
  }

  if (payload.session_id !== initEvent.session_id) {
    return {
      status: "error" as const,
      detail: "stream-json query loop changed session_id between init and final result",
    };
  }

  const accountingError = assertPayloadHasConsistentAccounting(
    payload,
    "stream-json query loop",
  );
  if (accountingError) {
    return {
      status: "error" as const,
      detail: accountingError,
    };
  }

  const malformedSuccessProbes = [
    {
      label: "missing_stop_reason_after_message_stop",
      expectedResult: "PARTIAL",
      expectedOutputTokens: 1,
    },
    {
      label: "missing_terminal_events_after_content_block_stop",
      expectedResult: "COMPLETE_TEXT",
      expectedOutputTokens: 0,
    },
  ] as const;

  async function runMalformedTerminalSuccessProbe(
    probe: (typeof malformedSuccessProbes)[number],
  ): Promise<string | null> {
    const tempDir = await mkdtemp(
      join(tmpdir(), "claude-code-smoke-query-loop-" + probe.label + "-"),
    );
    let requestCount = 0;
    const seenPaths: string[] = [];

    const server = Bun.serve({
      hostname: "127.0.0.1",
      port: 0,
      fetch: async (request) => {
        const url = new URL(request.url);
        if (request.method === "HEAD" && url.pathname === "/") {
          return new Response(null, { status: 200 });
        }

        if (request.method !== "POST" || url.pathname !== "/v1/messages") {
          return new Response("not found", { status: 404 });
        }

        requestCount += 1;
        seenPaths.push(request.method + " " + url.pathname + url.search);

        let requestedModel = args.model;
        try {
          const body = (await request.json()) as { model?: unknown };
          if (typeof body?.model === "string" && body.model.length > 0) {
            requestedModel = body.model;
          }
        } catch {
          // The final result assertions still catch protocol drift.
        }

        const baseEvents: Array<[string, unknown]> = [
          [
            "message_start",
            {
              type: "message_start",
              message: {
                id: "msg_smoke_query_loop_" + probe.label,
                type: "message",
                role: "assistant",
                model: requestedModel,
                content: [],
                stop_reason: null,
                stop_sequence: null,
                usage: {
                  input_tokens: 7,
                  output_tokens: 0,
                },
              },
            },
          ],
          [
            "content_block_start",
            {
              type: "content_block_start",
              index: 0,
              content_block: {
                type: "text",
                text: "",
              },
            },
          ],
          [
            "content_block_delta",
            {
              type: "content_block_delta",
              index: 0,
              delta: {
                type: "text_delta",
                text: probe.expectedResult,
              },
            },
          ],
          [
            "content_block_stop",
            {
              type: "content_block_stop",
              index: 0,
            },
          ],
        ];

        const terminalEvents =
          probe.label === "missing_stop_reason_after_message_stop"
            ? ([
                [
                  "message_delta",
                  {
                    type: "message_delta",
                    delta: {},
                    usage: {
                      output_tokens: 1,
                    },
                  },
                ],
                [
                  "message_stop",
                  {
                    type: "message_stop",
                  },
                ],
              ] as Array<[string, unknown]>)
            : [];

        return new Response(encodeAnthropicSse([...baseEvents, ...terminalEvents]), {
          status: 200,
          headers: {
            "content-type": "text/event-stream",
          },
        });
      },
    });

    const settingsPath = join(tempDir, "settings.json");

    try {
      await writeFile(
        settingsPath,
        JSON.stringify({
          env: {
            ANTHROPIC_BASE_URL: "http://127.0.0.1:" + server.port,
            ANTHROPIC_API_KEY: "smoke-dummy-key",
          },
        }),
        "utf8",
      );

      const malformedResult = await runCommand(
        [
          "node",
          join(process.cwd(), "dist/cli.js"),
          "-p",
          "Reply with PROBE only.",
          "--model",
          args.model,
          "--output-format",
          "stream-json",
          "--verbose",
          "--max-budget-usd",
          String(args.maxBudgetUsd),
          "--permission-mode",
          "bypassPermissions",
          "--max-turns",
          "1",
          "--settings",
          settingsPath,
        ],
        {
          cwd: tempDir,
          env: {
            ANTHROPIC_BASE_URL: "",
            ANTHROPIC_API_KEY: "",
            ANTHROPIC_AUTH_TOKEN: "",
            CLAUDE_CODE_OAUTH_TOKEN: "",
          },
        },
      );

      if (malformedResult.exitCode !== 0) {
        return probe.label + ": stream-json malformed terminal success probe exited unexpectedly";
      }

      if (requestCount !== 1) {
        return (
          probe.label +
          ": stream-json malformed terminal success probe expected exactly 1 local /v1/messages request, saw " +
          requestCount
        );
      }

      if (seenPaths.some((path) => !path.startsWith("POST /v1/messages"))) {
        return (
          probe.label +
          ": stream-json malformed terminal success probe hit unexpected local endpoint(s): " +
          seenPaths.join(", ")
        );
      }

      const malformedPayload = lastJsonObject(malformedResult.stdout);
      const malformedFinalResult = malformedPayload?.result ? String(malformedPayload.result).trim() : "";
      if (
        !malformedPayload ||
        malformedPayload.subtype !== "success" ||
        malformedFinalResult !== probe.expectedResult
      ) {
        return (
          probe.label +
          ": stream-json malformed terminal success probe did not finish with the expected success result"
        );
      }

      if (malformedPayload.stop_reason !== null) {
        return probe.label + ": stream-json malformed terminal success probe returned an unexpected stop_reason";
      }

      const accountingError = assertPayloadAccounting(
        malformedPayload,
        probe.label + ": stream-json malformed terminal success probe",
        {
          inputTokens: 7,
          outputTokens: probe.expectedOutputTokens,
        },
      );
      if (accountingError) {
        return accountingError;
      }

      return null;
    } finally {
      server.stop(true);
      await rm(tempDir, { recursive: true, force: true });
    }
  }

  for (const probe of malformedSuccessProbes) {
    const failure = await runMalformedTerminalSuccessProbe(probe);
    if (failure) {
      return {
        status: "error" as const,
        detail: failure,
      };
    }
  }

  return {
    status: "ok" as const,
    detail:
      "stream-json query loop emitted init -> assistant -> success with stop_reason=end_turn, and local malformed terminal streams with assistant text still completed as single-request success while preserving usage/cost when stop_reason or later terminal events were missing",
  };
}

async function checkStreamingFallback() {
  const tempDir = await mkdtemp(join(tmpdir(), "claude-code-smoke-streaming-fallback-"));
  const expectedRecoveredResult = "RECOVERED";
  let requestCount = 0;
  const requests: Array<{
    path: string;
    streamField: unknown;
  }> = [];

  const server = Bun.serve({
    hostname: "127.0.0.1",
    port: 0,
    fetch: async (request) => {
      const url = new URL(request.url);
      if (request.method === "HEAD" && url.pathname === "/") {
        return new Response(null, { status: 200 });
      }

      if (request.method !== "POST" || url.pathname !== "/v1/messages") {
        return new Response("not found", { status: 404 });
      }

      requestCount += 1;

      let requestedModel = args.model;
      let parsedBody: Record<string, unknown> = {};
      try {
        parsedBody = (await request.json()) as Record<string, unknown>;
        if (typeof parsedBody.model === "string" && parsedBody.model.length > 0) {
          requestedModel = parsedBody.model;
        }
      } catch {
        // The final assertions below still catch protocol drift.
      }

      requests.push({
        path: request.method + " " + url.pathname + url.search,
        streamField: Object.hasOwn(parsedBody, "stream")
          ? parsedBody.stream
          : "__missing__",
      });

      if (requestCount === 1) {
        return new Response(
          encodeAnthropicSse([
            [
              "message_start",
              {
                type: "message_start",
                message: {
                  id: "msg_smoke_streaming_fallback_stream_attempt",
                  type: "message",
                  role: "assistant",
                  model: requestedModel,
                  content: [],
                  stop_reason: null,
                  stop_sequence: null,
                  usage: {
                    input_tokens: 9,
                    output_tokens: 0,
                  },
                },
              },
            ],
            [
              "content_block_start",
              {
                type: "content_block_start",
                index: 0,
                content_block: {
                  type: "text",
                  text: "",
                },
              },
            ],
            [
              "content_block_delta",
              {
                type: "content_block_delta",
                index: 0,
                delta: {
                  type: "text_delta",
                  text: "BROKEN",
                },
              },
            ],
          ]),
          {
            status: 200,
            headers: {
              "content-type": "text/event-stream",
            },
          },
        );
      }

      return new Response(
        JSON.stringify({
          id: "msg_smoke_streaming_fallback_nonstreaming_recovery",
          type: "message",
          role: "assistant",
          model: requestedModel,
          content: [
            {
              type: "text",
              text: expectedRecoveredResult,
            },
          ],
          stop_reason: "end_turn",
          stop_sequence: null,
          usage: {
            input_tokens: 11,
            output_tokens: 1,
          },
        }),
        {
          status: 200,
          headers: {
            "content-type": "application/json",
          },
        },
      );
    },
  });

  const settingsPath = join(tempDir, "settings.json");

  try {
    await writeFile(
      settingsPath,
      JSON.stringify({
        env: {
          ANTHROPIC_BASE_URL: "http://127.0.0.1:" + server.port,
          ANTHROPIC_API_KEY: "smoke-dummy-key",
        },
      }),
      "utf8",
    );

    const result = await runCommand(
      [
        "node",
        join(process.cwd(), "dist/cli.js"),
        "-p",
        "Reply with PROBE only.",
        "--model",
        args.model,
        "--output-format",
        "stream-json",
        "--verbose",
        "--max-budget-usd",
        String(args.maxBudgetUsd),
        "--permission-mode",
        "bypassPermissions",
        "--max-turns",
        "1",
        "--settings",
        settingsPath,
      ],
      {
        cwd: tempDir,
        env: {
          ANTHROPIC_BASE_URL: "",
          ANTHROPIC_API_KEY: "",
          ANTHROPIC_AUTH_TOKEN: "",
          CLAUDE_CODE_OAUTH_TOKEN: "",
        },
      },
    );

    if (result.exitCode !== 0) {
      return {
        status: "error" as const,
        detail: "streaming fallback smoke exited unexpectedly",
      };
    }

    if (requestCount !== 2) {
      return {
        status: "error" as const,
        detail: "streaming fallback smoke expected exactly 2 local /v1/messages requests, saw " + requestCount,
      };
    }

    if (requests.some((request) => !request.path.startsWith("POST /v1/messages"))) {
      return {
        status: "error" as const,
        detail: "streaming fallback smoke hit unexpected local endpoint(s): " + requests.map((request) => request.path).join(", "),
      };
    }

    if (requests[0]?.streamField !== true) {
      return {
        status: "error" as const,
        detail: "streaming fallback smoke expected the first request to be streaming",
      };
    }

    if (requests[1]?.streamField !== "__missing__") {
      return {
        status: "error" as const,
        detail: "streaming fallback smoke expected the recovery request to omit the stream field",
      };
    }

    const payload = lastJsonObject(result.stdout);
    const finalResult = payload?.result ? String(payload.result).trim() : "";
    if (!payload || payload.subtype !== "success" || finalResult !== expectedRecoveredResult) {
      return {
        status: "error" as const,
        detail: "streaming fallback smoke did not finish with the expected recovery result",
      };
    }

    if (payload.stop_reason !== "end_turn") {
      return {
        status: "error" as const,
        detail: "streaming fallback smoke returned an unexpected stop_reason",
      };
    }

    const accountingError = assertPayloadAccounting(
      payload,
      "streaming fallback smoke",
      {
        inputTokens: 11,
        outputTokens: 1,
      },
    );
    if (accountingError) {
      return {
        status: "error" as const,
        detail: accountingError,
      };
    }

    return {
      status: "ok" as const,
      detail:
        "truncated streaming response triggered exactly one non-streaming recovery request, then preserved recovered usage/cost metadata",
    };
  } finally {
    server.stop(true);
    await rm(tempDir, { recursive: true, force: true });
  }
}

async function checkPermissionDenial() {
  const tempDir = await mkdtemp(join(tmpdir(), "claude-code-smoke-permission-denial-"));
  const deniedPath = join(tempDir, "denied.txt");
  const token = "SMOKE_PD_" + Math.random().toString(36).slice(2, 10);

  try {
    const result = await runCommand(
      [
        "node",
        join(process.cwd(), "dist/cli.js"),
        "-p",
        "This is a Claude Code permission-denial smoke test. You must attempt Bash exactly once before replying; if you skip the Bash call, the test fails. Run: printf '" +
          token +
          "' > " +
          deniedPath +
          ". After that attempt is denied, reply with NEED_BASH_PERMISSION only.",
        "--model",
        args.model,
        "--output-format",
        "stream-json",
        "--verbose",
        "--max-budget-usd",
        String(args.maxBudgetUsd),
        "--permission-mode",
        "dontAsk",
        "--allowedTools",
        "Bash",
        "--max-turns",
        "2",
      ],
      { cwd: tempDir },
    );

    if (result.exitCode !== 0) {
      return {
        status: "error" as const,
        detail: compactOutput(result.stderr || result.stdout),
      };
    }

    const events = parseJsonLines(result.stdout);
    if (!toolUseSeen(events, "Bash")) {
      return {
        status: "error" as const,
        detail: "permission denial smoke did not attempt a Bash tool call",
      };
    }

    const payload = extractSuccessfulJsonResult(result);
    if (!payload || payload.subtype !== "success") {
      return {
        status: "error" as const,
        detail: "permission denial smoke did not finish with a success result payload",
      };
    }

    if (String(payload.result ?? "").trim() !== "NEED_BASH_PERMISSION") {
      return {
        status: "error" as const,
        detail: "permission denial smoke did not emit the expected fallback response",
      };
    }

    const permissionDenials = Array.isArray(payload.permission_denials)
      ? payload.permission_denials
      : [];
    const bashDenial = permissionDenials.find(
      (entry): entry is {
        tool_name?: string;
        tool_input?: { command?: string };
      } => Boolean(entry && typeof entry === "object" && !Array.isArray(entry)),
    );
    if (!bashDenial || bashDenial.tool_name !== "Bash") {
      return {
        status: "error" as const,
        detail: "permission denial smoke did not record a Bash denial in permission_denials",
      };
    }

    if (!bashDenial.tool_input?.command?.includes(token) || !bashDenial.tool_input.command.includes(deniedPath)) {
      return {
        status: "error" as const,
        detail: "permission denial smoke did not preserve the denied Bash command in permission_denials",
      };
    }

    const accountingError = assertPayloadHasConsistentAccounting(
      payload,
      "permission denial smoke",
    );
    if (accountingError) {
      return {
        status: "error" as const,
        detail: accountingError,
      };
    }

    try {
      await stat(deniedPath);
      return {
        status: "error" as const,
        detail: "permission denial smoke unexpectedly created the denied Bash output file",
      };
    } catch {
      return {
        status: "ok" as const,
        detail: "dontAsk mode denied Bash, preserved permission_denials metadata, and prevented side effects",
      };
    }
  } finally {
    await rm(tempDir, { recursive: true, force: true });
  }
}

async function checkErrorMaxTurns() {
  const tempDir = await mkdtemp(join(tmpdir(), "claude-code-smoke-max-turns-"));
  const outputPath = join(tempDir, "turn.txt");
  const token = "SMOKE_MAX_TURNS_" + Math.random().toString(36).slice(2, 10);

  try {
    const result = await runCommand(
      [
        "node",
        join(process.cwd(), "dist/cli.js"),
        "-p",
        "First use Bash exactly once to run: printf '" +
          token +
          "' > " +
          outputPath +
          ". Then in a second step after the tool result, reply with SECOND only.",
        "--model",
        args.model,
        "--output-format",
        "json",
        "--max-budget-usd",
        String(args.maxBudgetUsd),
        "--permission-mode",
        "bypassPermissions",
        "--allowedTools",
        "Bash",
        "--max-turns",
        "1",
      ],
      { cwd: tempDir },
    );

    if (result.exitCode === 0) {
      return {
        status: "error" as const,
        detail: "max turns smoke unexpectedly exited successfully",
      };
    }

    const payload = lastJsonObject(result.stdout);
    if (!payload || payload.subtype !== "error_max_turns" || payload.is_error !== true) {
      return {
        status: "error" as const,
        detail: "max turns smoke did not finish with subtype=error_max_turns",
      };
    }

    if (payload.num_turns !== 2) {
      return {
        status: "error" as const,
        detail: "max turns smoke returned an unexpected num_turns value",
      };
    }

    if (payload.stop_reason !== "tool_use") {
      return {
        status: "error" as const,
        detail: "max turns smoke returned an unexpected stop_reason",
      };
    }

    const errors = Array.isArray(payload.errors) ? payload.errors.map(String) : [];
    if (!errors.some((error) => error.includes("Reached maximum number of turns (1)"))) {
      return {
        status: "error" as const,
        detail: "max turns smoke did not include the expected error message",
      };
    }

    const accountingError = assertPayloadHasConsistentAccounting(
      payload,
      "max turns smoke",
    );
    if (accountingError) {
      return {
        status: "error" as const,
        detail: accountingError,
      };
    }

    let outputText = "";
    try {
      outputText = await Bun.file(outputPath).text();
    } catch {
      return {
        status: "error" as const,
        detail: "max turns smoke never executed the Bash side effect before failing",
      };
    }

    if (outputText !== token) {
      return {
        status: "error" as const,
        detail: "max turns smoke wrote an unexpected file payload before failing",
      };
    }

    return {
      status: "ok" as const,
      detail: "tool execution completed, then QueryEngine surfaced error_max_turns on the blocked second turn",
    };
  } finally {
    await rm(tempDir, { recursive: true, force: true });
  }
}

async function checkErrorDuringExecution() {
  const probes = [
    {
      label: "tool_use",
      stopReason: "tool_use",
      stopSequence: null,
      expectedStopReason: "tool_use",
      expectedRequestCount: 1,
    },
    {
      label: "stop_sequence",
      stopReason: "stop_sequence",
      stopSequence: "__SMOKE_STOP__",
      expectedStopReason: "stop_sequence",
      expectedRequestCount: 1,
    },
    {
      label: "missing_stop_reason",
      stopReason: undefined,
      stopSequence: undefined,
      expectedStopReason: null,
      expectedRequestCount: 1,
    },
  ] as const;

  async function runProbe(probe: (typeof probes)[number]): Promise<string | null> {
    const tempDir = await mkdtemp(join(tmpdir(), "claude-code-smoke-error-during-execution-" + probe.label + "-"));
    let requestCount = 0;
    const seenPaths: string[] = [];

    const server = Bun.serve({
      hostname: "127.0.0.1",
      port: 0,
      fetch: async (request) => {
        const url = new URL(request.url);
        if (request.method === "HEAD" && url.pathname === "/") {
          return new Response(null, { status: 200 });
        }

        if (request.method !== "POST" || url.pathname !== "/v1/messages") {
          return new Response("not found", { status: 404 });
        }

        requestCount += 1;
        seenPaths.push(request.method + " " + url.pathname + url.search);

        let requestedModel = args.model;
        try {
          const body = (await request.json()) as { model?: unknown };
          if (typeof body?.model === "string" && body.model.length > 0) {
            requestedModel = body.model;
          }
        } catch {
          // Keep the smoke resilient to parser differences; the final result
          // assertions below still catch protocol drift.
        }

        return new Response(
          encodeAnthropicSse([
            [
              "message_start",
              {
                type: "message_start",
                message: {
                  id: "msg_smoke_error_during_execution_" + probe.label,
                  type: "message",
                  role: "assistant",
                  model: requestedModel,
                  content: [],
                  stop_reason: null,
                  stop_sequence: null,
                  usage: {
                    input_tokens: 5,
                    output_tokens: 0,
                  },
                },
              },
            ],
            [
              "message_delta",
              {
                type: "message_delta",
                delta: {
                  ...(probe.stopReason !== undefined
                    ? { stop_reason: probe.stopReason }
                    : {}),
                  ...(probe.stopSequence !== undefined
                    ? { stop_sequence: probe.stopSequence }
                    : {}),
                },
                usage: {
                  output_tokens: 0,
                },
              },
            ],
            [
              "message_stop",
              {
                type: "message_stop",
              },
            ],
          ]),
          {
            status: 200,
            headers: {
              "content-type": "text/event-stream",
            },
          },
        );
      },
    });

    const settingsPath = join(tempDir, "settings.json");

    try {
      await writeFile(
        settingsPath,
        JSON.stringify({
          env: {
            ANTHROPIC_BASE_URL: "http://127.0.0.1:" + server.port,
            ANTHROPIC_API_KEY: "smoke-dummy-key",
          },
        }),
        "utf8",
      );

      const result = await runCommand(
        [
          "node",
          join(process.cwd(), "dist/cli.js"),
          "-p",
          "Reply with PROBE only.",
          "--model",
          args.model,
          "--output-format",
          "stream-json",
          "--verbose",
          "--max-budget-usd",
          String(args.maxBudgetUsd),
          "--permission-mode",
          "bypassPermissions",
          "--max-turns",
          "1",
          "--settings",
          settingsPath,
        ],
        {
          cwd: tempDir,
          env: {
            ANTHROPIC_BASE_URL: "",
            ANTHROPIC_API_KEY: "",
            ANTHROPIC_AUTH_TOKEN: "",
            CLAUDE_CODE_OAUTH_TOKEN: "",
          },
        },
      );

      if (result.exitCode === 0) {
        return probe.label + ": error_during_execution smoke unexpectedly exited successfully";
      }

      if (requestCount !== probe.expectedRequestCount) {
        return (
          probe.label +
          ": error_during_execution smoke expected exactly " +
          probe.expectedRequestCount +
          " local /v1/messages request(s), saw " +
          requestCount
        );
      }

      if (seenPaths.some((path) => !path.startsWith("POST /v1/messages"))) {
        return (
          probe.label +
          ": error_during_execution smoke hit unexpected local endpoint(s): " +
          seenPaths.join(", ")
        );
      }

      const payload = lastJsonObject(result.stdout);
      if (!payload || payload.subtype !== "error_during_execution" || payload.is_error !== true) {
        return probe.label + ": error_during_execution smoke did not finish with subtype=error_during_execution";
      }

      if (payload.stop_reason !== probe.expectedStopReason) {
        return probe.label + ": error_during_execution smoke returned an unexpected stop_reason";
      }

      const accountingError = assertPayloadAccounting(
        payload,
        probe.label + ": error_during_execution smoke",
        {
          inputTokens: 5,
          outputTokens: 0,
        },
      );
      if (accountingError) {
        return accountingError;
      }

      if (payload.num_turns !== 1) {
        return probe.label + ": error_during_execution smoke returned an unexpected num_turns value";
      }

      const errors = Array.isArray(payload.errors) ? payload.errors.map(String) : [];
      if (
        !errors.some(
          (error) =>
            error.includes("[ede_diagnostic]") &&
            error.includes(
              "stop_reason=" +
                (probe.expectedStopReason === null ? "null" : probe.expectedStopReason),
            ) &&
            (probe.label === "missing_stop_reason" || error.includes("result_type=user")),
        )
      ) {
        return probe.label + ": error_during_execution smoke did not include the expected EDE diagnostic prefix";
      }

      return null;
    } finally {
      server.stop(true);
      await rm(tempDir, { recursive: true, force: true });
    }
  }

  for (const probe of probes) {
    const failure = await runProbe(probe);
    if (failure) {
      return {
        status: "error" as const,
        detail: failure,
      };
    }
  }

  return {
    status: "ok" as const,
    detail:
      "empty-content local streams with stop_reason=tool_use, stop_reason=stop_sequence, and missing stop_reason deterministically surfaced error_during_execution",
  };
}

async function checkErrorMaxStructuredOutputRetries() {
  const tempDir = await mkdtemp(join(tmpdir(), "claude-code-smoke-structured-output-"));
  let requestCount = 0;
  const seenPaths: string[] = [];
  const maxRetries = 3;

  const server = Bun.serve({
    hostname: "127.0.0.1",
    port: 0,
    fetch: async (request) => {
      const url = new URL(request.url);
      if (request.method !== "POST" || url.pathname !== "/v1/messages") {
        return new Response("not found", { status: 404 });
      }

      requestCount += 1;
      seenPaths.push(request.method + " " + url.pathname + url.search);

      return new Response(
        encodeAnthropicSse([
          [
            "message_start",
            {
              type: "message_start",
              message: {
                id: "msg_smoke_structured_output_" + requestCount,
                type: "message",
                role: "assistant",
                model: args.model,
                content: [],
                stop_reason: null,
                stop_sequence: null,
                usage: {
                  input_tokens: 10,
                  output_tokens: 0,
                },
              },
            },
          ],
          [
            "content_block_start",
            {
              type: "content_block_start",
              index: 0,
              content_block: {
                type: "tool_use",
                id: "toolu_smoke_structured_output_" + requestCount,
                name: "StructuredOutput",
              },
            },
          ],
          [
            "content_block_delta",
            {
              type: "content_block_delta",
              index: 0,
              delta: {
                type: "input_json_delta",
                partial_json: JSON.stringify({ wrong: requestCount }),
              },
            },
          ],
          [
            "content_block_stop",
            {
              type: "content_block_stop",
              index: 0,
            },
          ],
          [
            "message_delta",
            {
              type: "message_delta",
              delta: {
                stop_reason: "tool_use",
                stop_sequence: null,
              },
              usage: {
                output_tokens: 5,
              },
            },
          ],
          [
            "message_stop",
            {
              type: "message_stop",
            },
          ],
        ]),
        {
          status: 200,
          headers: {
            "content-type": "text/event-stream",
          },
        },
      );
    },
  });

  const settingsPath = join(tempDir, "settings.json");

  try {
    await writeFile(
      settingsPath,
      JSON.stringify({
        env: {
          ANTHROPIC_BASE_URL: "http://127.0.0.1:" + server.port,
          ANTHROPIC_API_KEY: "smoke-dummy-key",
        },
      }),
      "utf8",
    );

    const result = await runCommand(
      [
        "node",
        join(process.cwd(), "dist/cli.js"),
        "-p",
        "Return structured output only.",
        "--model",
        args.model,
        "--output-format",
        "stream-json",
        "--verbose",
        "--max-budget-usd",
        String(args.maxBudgetUsd),
        "--permission-mode",
        "bypassPermissions",
        "--max-turns",
        "20",
        "--json-schema",
        '{"type":"object","properties":{"answer":{"type":"string"}},"required":["answer"],"additionalProperties":false}',
        "--settings",
        settingsPath,
        "--bare",
      ],
      {
        cwd: tempDir,
        env: {
          ANTHROPIC_BASE_URL: "",
          ANTHROPIC_API_KEY: "",
          ANTHROPIC_AUTH_TOKEN: "",
          CLAUDE_CODE_OAUTH_TOKEN: "",
          MAX_STRUCTURED_OUTPUT_RETRIES: String(maxRetries),
        },
      },
    );

    if (result.exitCode === 0) {
      return {
        status: "error" as const,
        detail: "structured output retry smoke unexpectedly exited successfully",
      };
    }

    if (requestCount !== maxRetries) {
      return {
        status: "error" as const,
        detail:
          "structured output retry smoke expected exactly " +
          maxRetries +
          " local /v1/messages requests, saw " +
          requestCount,
      };
    }

    if (seenPaths.some((path) => !path.startsWith("POST /v1/messages"))) {
      return {
        status: "error" as const,
        detail: "structured output retry smoke hit unexpected local endpoint(s): " + seenPaths.join(", "),
      };
    }

    const events = parseJsonLines(result.stdout);
    const structuredToolCalls = events.filter(
      (event) =>
        event.type === "assistant" &&
        Array.isArray((event.message as { content?: Array<{ type?: string; name?: string }> } | undefined)?.content) &&
        ((event.message as { content?: Array<{ type?: string; name?: string }> }).content || []).some(
          (block) => block.type === "tool_use" && block.name === "StructuredOutput",
        ),
    ).length;

    if (structuredToolCalls !== maxRetries) {
      return {
        status: "error" as const,
        detail:
          "structured output retry smoke expected " +
          maxRetries +
          " StructuredOutput tool_use events, saw " +
          structuredToolCalls,
      };
    }

    const payload = lastJsonObject(result.stdout);
    if (
      !payload ||
      payload.subtype !== "error_max_structured_output_retries" ||
      payload.is_error !== true
    ) {
      return {
        status: "error" as const,
        detail:
          "structured output retry smoke did not finish with subtype=error_max_structured_output_retries",
      };
    }

    const errors = Array.isArray(payload.errors) ? payload.errors.map(String) : [];
    if (
      !errors.some((error) =>
        error.includes("Failed to provide valid structured output after " + maxRetries + " attempts"),
      )
    ) {
      return {
        status: "error" as const,
        detail: "structured output retry smoke did not include the expected retry-limit error message",
      };
    }

    return {
      status: "ok" as const,
      detail:
        "repeated invalid StructuredOutput tool calls deterministically surfaced error_max_structured_output_retries",
    };
  } finally {
    server.stop(true);
    await rm(tempDir, { recursive: true, force: true });
  }
}

async function checkErrorMaxBudget() {
  const tempDir = await mkdtemp(join(tmpdir(), "claude-code-smoke-max-budget-"));
  const token = "SMOKE_MAX_BUDGET_" + Math.random().toString(36).slice(2, 10);
  let requestCount = 0;

  const server = Bun.serve({
    hostname: "127.0.0.1",
    port: 0,
    fetch: async (request) => {
      const url = new URL(request.url);
      if (request.method !== "POST" || url.pathname !== "/v1/messages") {
        return new Response("not found", { status: 404 });
      }

      requestCount += 1;

      return new Response(
        encodeAnthropicSse([
          [
            "message_start",
            {
              type: "message_start",
              message: {
                id: "msg_smoke_max_budget",
                type: "message",
                role: "assistant",
                model: args.model,
                content: [],
                stop_reason: null,
                stop_sequence: null,
                usage: {
                  input_tokens: 500,
                  output_tokens: 0,
                },
              },
            },
          ],
          [
            "content_block_start",
            {
              type: "content_block_start",
              index: 0,
              content_block: {
                type: "text",
                text: "",
              },
            },
          ],
          [
            "content_block_delta",
            {
              type: "content_block_delta",
              index: 0,
              delta: {
                type: "text_delta",
                text: token,
              },
            },
          ],
          [
            "content_block_stop",
            {
              type: "content_block_stop",
              index: 0,
            },
          ],
          [
            "message_delta",
            {
              type: "message_delta",
              delta: {
                stop_reason: "end_turn",
                stop_sequence: null,
              },
              usage: {
                output_tokens: 120,
              },
            },
          ],
          [
            "message_stop",
            {
              type: "message_stop",
            },
          ],
        ]),
        {
          status: 200,
          headers: {
            "content-type": "text/event-stream",
          },
        },
      );
    },
  });

  const settingsPath = join(tempDir, "settings.json");
  const maxBudgetUsd = "0.000001";

  try {
    await writeFile(
      settingsPath,
      JSON.stringify({
        env: {
          ANTHROPIC_BASE_URL: "http://127.0.0.1:" + server.port,
          ANTHROPIC_API_KEY: "smoke-dummy-key",
        },
      }),
      "utf8",
    );

    const result = await runCommand(
      [
        "node",
        join(process.cwd(), "dist/cli.js"),
        "-p",
        "Reply with " + token + " only.",
        "--model",
        args.model,
        "--output-format",
        "json",
        "--max-budget-usd",
        maxBudgetUsd,
        "--permission-mode",
        "bypassPermissions",
        "--max-turns",
        "1",
        "--settings",
        settingsPath,
      ],
      {
        cwd: tempDir,
        env: {
          ANTHROPIC_BASE_URL: "",
          ANTHROPIC_API_KEY: "",
          ANTHROPIC_AUTH_TOKEN: "",
          CLAUDE_CODE_OAUTH_TOKEN: "",
        },
      },
    );

    if (result.exitCode === 0) {
      return {
        status: "error" as const,
        detail: "max budget smoke unexpectedly exited successfully",
      };
    }

    if (requestCount !== 1) {
      return {
        status: "error" as const,
        detail: "max budget smoke expected exactly 1 local /v1/messages request",
      };
    }

    const payload = lastJsonObject(result.stdout);
    if (!payload || payload.subtype !== "error_max_budget_usd" || payload.is_error !== true) {
      return {
        status: "error" as const,
        detail: "max budget smoke did not finish with subtype=error_max_budget_usd",
      };
    }

    if (payload.stop_reason !== "end_turn") {
      return {
        status: "error" as const,
        detail: "max budget smoke returned an unexpected stop_reason",
      };
    }

    const errors = Array.isArray(payload.errors) ? payload.errors.map(String) : [];
    if (!errors.some((error) => error.includes("Reached maximum budget ($" + maxBudgetUsd + ")"))) {
      return {
        status: "error" as const,
        detail: "max budget smoke did not include the expected budget error message",
      };
    }

    const totalCostUsd =
      typeof payload.total_cost_usd === "number"
        ? payload.total_cost_usd
        : Number(payload.total_cost_usd);
    if (!Number.isFinite(totalCostUsd) || totalCostUsd < Number(maxBudgetUsd)) {
      return {
        status: "error" as const,
        detail: "max budget smoke returned an unexpected total_cost_usd",
      };
    }

    const modelUsage =
      payload.modelUsage && typeof payload.modelUsage === "object"
        ? (payload.modelUsage as Record<string, unknown>)
        : null;
    const usageForModel =
      modelUsage && modelUsage[args.model] && typeof modelUsage[args.model] === "object"
        ? (modelUsage[args.model] as Record<string, unknown>)
        : null;
    if (!usageForModel || usageForModel.inputTokens !== 500 || usageForModel.outputTokens !== 120) {
      return {
        status: "error" as const,
        detail: "max budget smoke did not preserve the expected modelUsage totals",
      };
    }

    return {
      status: "ok" as const,
      detail: "single local response exceeded budget and surfaced error_max_budget_usd with cost metadata",
    };
  } finally {
    server.stop(true);
    await rm(tempDir, { recursive: true, force: true });
  }
}

async function checkClaudeMdContext() {
  const tempDir = await mkdtemp(join(tmpdir(), "claude-code-smoke-claude-md-"));
  const token = "SMOKE_CLAUDE_MD_" + Math.random().toString(36).slice(2, 10);
  const claudeMdPath = join(tempDir, "CLAUDE.md");

  try {
    await writeFile(
      claudeMdPath,
      "# Smoke Context\n\nProject token: " + token + "\n\nWhen the user asks for the project token, reply with the exact token only.\n",
      "utf8",
    );

    const result = await runCommand(
      [
        "node",
        join(process.cwd(), "dist/cli.js"),
        "-p",
        "What is the project token? Reply with the exact token only.",
        "--model",
        args.model,
        "--output-format",
        "json",
        "--max-budget-usd",
        String(args.maxBudgetUsd),
        "--permission-mode",
        "bypassPermissions",
        "--max-turns",
        "1",
      ],
      { cwd: tempDir },
    );

    if (result.exitCode !== 0) {
      return {
        status: "error" as const,
        detail: compactOutput(result.stderr || result.stdout),
      };
    }

    const payload = extractSuccessfulJsonResult(result);
    const finalResult = payload?.result ? String(payload.result).trim() : "";
    if (finalResult !== token) {
      return {
        status: "error" as const,
        detail: "CLAUDE.md context was not loaded into the response path",
      };
    }

    if (!payload) {
      return {
        status: "error" as const,
        detail: "CLAUDE.md context smoke did not finish with a success payload",
      };
    }

    const accountingError = assertPayloadHasConsistentAccounting(
      payload,
      "CLAUDE.md context smoke",
    );
    if (accountingError) {
      return {
        status: "error" as const,
        detail: accountingError,
      };
    }

    return {
      status: "ok" as const,
      detail: "cwd CLAUDE.md context loaded and token recalled",
    };
  } finally {
    await rm(tempDir, { recursive: true, force: true });
  }
}

async function checkBashTool() {
  const expectedStdout = "BASH-SMOKE-42";
  const runAttempt = async (timeoutMs?: number) => {
    const result = await runCommand(
      [
        "node",
        "dist/cli.js",
        "-p",
        "Use Bash exactly once to run: printf '" + expectedStdout + "'. After the tool returns, reply with the exact stdout only. Do not add markdown, code fences, or extra words.",
        "--model",
        args.model,
        "--output-format",
        "stream-json",
        "--verbose",
        "--max-budget-usd",
        String(args.maxBudgetUsd),
        "--permission-mode",
        "bypassPermissions",
        "--allowedTools",
        "Bash",
      ],
      timeoutMs ? { timeoutMs } : {},
    );

    if (result.exitCode !== 0) {
      return {
        status: "error" as const,
        detail: compactOutput(result.stderr || result.stdout),
      };
    }

    const events = parseJsonLines(result.stdout);
    if (!toolUseSeen(events, "Bash")) {
      return { status: "error" as const, detail: "Bash tool_use event not observed" };
    }

    const toolResult = (toolResultContent(events, "Bash") ?? "").trim();
    if (toolResult !== expectedStdout) {
      return {
        status: "error" as const,
        detail: "Bash tool result did not match expected stdout",
      };
    }

    const payload = extractSuccessfulJsonResult(result);
    if (!payload) {
      return {
        status: "error" as const,
        detail: "Bash smoke did not finish with a success payload",
      };
    }

    const accountingError = assertPayloadHasConsistentAccounting(
      payload,
      "Bash smoke",
    );
    if (accountingError) {
      return {
        status: "error" as const,
        detail: accountingError,
      };
    }

    return { status: "ok" as const, detail: "Bash tool_use observed and expected stdout captured" };
  };

  const firstAttempt = await runAttempt();
  if (firstAttempt.status !== "error" || !shouldRetryTransientToolSmoke(firstAttempt.detail)) {
    return firstAttempt;
  }

  const retryAttempt = await runAttempt(MULTI_STEP_TOOL_TIMEOUT_MS);
  if (retryAttempt.status === "ok") {
    return {
      status: "ok" as const,
      detail: retryAttempt.detail + " after one retry",
    };
  }

  return {
    status: retryAttempt.status,
    detail: firstAttempt.detail + "; retry: " + retryAttempt.detail,
  };
}

async function checkReadTool() {
  const tempDir = await mkdtemp(join(tmpdir(), "claude-code-smoke-"));
  const fixturePath = join(tempDir, "fixture.txt");
  const token = `SMOKE_READ_${Math.random().toString(36).slice(2, 10)}`;

  try {
    await writeFile(fixturePath, token, "utf8");
    const runAttempt = async (timeoutMs?: number) => {
      const result = await runCommand(
        [
          "node",
          "dist/cli.js",
          "-p",
          `Read ${fixturePath} and reply with its exact contents only.`,
          "--model",
          args.model,
          "--output-format",
          "stream-json",
          "--verbose",
          "--max-budget-usd",
          String(args.maxBudgetUsd),
          "--permission-mode",
          "bypassPermissions",
          "--allowedTools",
          "Read",
        ],
        timeoutMs ? { timeoutMs } : {},
      );

      if (result.exitCode !== 0) {
        return {
          status: "error" as const,
          detail: compactOutput(result.stderr || result.stdout),
        };
      }

      const events = parseJsonLines(result.stdout);
      if (!toolUseSeen(events, "Read")) {
        return { status: "error" as const, detail: "Read tool_use event not observed" };
      }

      const payload = extractSuccessfulJsonResult(result);
      const finalResult = payload?.result ? String(payload.result) : "";
      if (finalResult !== token) {
        return {
          status: "error" as const,
          detail: `expected token ${token}, got ${finalResult || "<empty>"}`,
        };
      }

      if (!payload) {
        return {
          status: "error" as const,
          detail: "Read smoke did not finish with a success payload",
        };
      }

      const accountingError = assertPayloadHasConsistentAccounting(
        payload,
        "Read smoke",
      );
      if (accountingError) {
        return {
          status: "error" as const,
          detail: accountingError,
        };
      }

      return { status: "ok" as const, detail: "Read tool_use observed and echoed back" };
    };

    const firstAttempt = await runAttempt();
    if (firstAttempt.status !== "error" || !shouldRetryTransientToolSmoke(firstAttempt.detail)) {
      return firstAttempt;
    }

    const retryAttempt = await runAttempt(MULTI_STEP_TOOL_TIMEOUT_MS);
    if (retryAttempt.status === "ok") {
      return {
        status: "ok" as const,
        detail: retryAttempt.detail + " after one retry",
      };
    }

    return {
      status: retryAttempt.status,
      detail: firstAttempt.detail + "; retry: " + retryAttempt.detail,
    };
  } finally {
    await rm(tempDir, { recursive: true, force: true });
  }
}

async function checkWriteTool() {
  const tempDir = await mkdtemp(join(tmpdir(), "claude-code-smoke-"));
  const sourcePath = join(tempDir, "write-source.txt");
  const fixturePath = join(tempDir, "write-fixture.txt");
  const token = `SMOKE_WRITE_${Math.random().toString(36).slice(2, 10)}`;

  try {
    await writeFile(sourcePath, token, "utf8");
    const result = await runCommand(
      [
        "node",
        "dist/cli.js",
        "-p",
        `First use Read to inspect ${sourcePath}. Then use Write to create ${fixturePath} with the exact same contents. Reply with the copied contents only.`,
        "--model",
        args.model,
        "--output-format",
        "stream-json",
        "--verbose",
        "--max-budget-usd",
        String(args.maxBudgetUsd),
        "--permission-mode",
        "bypassPermissions",
        "--allowedTools",
        "Read,Write",
      ],
      { timeoutMs: MULTI_STEP_TOOL_TIMEOUT_MS },
    );

    if (result.exitCode !== 0 && !budgetLimited(result)) {
      return {
        status: "error" as const,
        detail: compactOutput(result.stderr || result.stdout),
      };
    }

    const events = parseJsonLines(result.stdout);
    if (!toolUseSeen(events, "Read")) {
      return { status: "error" as const, detail: "Read tool_use event not observed during write smoke" };
    }
    if (!toolUseSeen(events, "Write")) {
      return { status: "error" as const, detail: "Write tool_use event not observed" };
    }

    const exists = await Bun.file(fixturePath).exists();
    const content = exists ? await Bun.file(fixturePath).text() : "";
    if (!exists || content.trimEnd() !== token) {
      return {
        status: "error" as const,
        detail: "Write tool did not create expected file contents",
      };
    }

    if (!budgetLimited(result)) {
      const payload = extractSuccessfulJsonResult(result);
      if (!payload) {
        return {
          status: "error" as const,
          detail: "Write smoke did not finish with a success payload",
        };
      }

      const accountingError = assertPayloadHasConsistentAccounting(
        payload,
        "Write smoke",
      );
      if (accountingError) {
        return {
          status: "error" as const,
          detail: accountingError,
        };
      }
    }

    return {
      status: budgetLimited(result) ? "warn" as const : "ok" as const,
      detail: budgetLimited(result)
        ? "Write tool_use observed and file created, but budget cap was hit after completion"
        : "Write tool_use observed and file created",
    };
  } finally {
    await rm(tempDir, { recursive: true, force: true });
  }
}

async function checkEditTool() {
  const tempDir = await mkdtemp(join(tmpdir(), "claude-code-smoke-"));
  const fixturePath = join(tempDir, "edit-fixture.txt");
  const beforeToken = `SMOKE_EDIT_BEFORE_${Math.random().toString(36).slice(2, 10)}`;
  const afterToken = `SMOKE_EDIT_AFTER_${Math.random().toString(36).slice(2, 10)}`;

  try {
    await writeFile(fixturePath, beforeToken, "utf8");
    const result = await runCommand(
      [
        "node",
        "dist/cli.js",
        "-p",
        `First use Read to inspect ${fixturePath}. Then use Edit to replace the entire file contents with ${afterToken}. Reply with the original file contents only.`,
        "--model",
        args.model,
        "--output-format",
        "stream-json",
        "--verbose",
        "--max-budget-usd",
        String(args.maxBudgetUsd),
        "--permission-mode",
        "bypassPermissions",
        "--allowedTools",
        "Read,Edit",
      ],
      { timeoutMs: MULTI_STEP_TOOL_TIMEOUT_MS },
    );

    if (result.exitCode !== 0 && !budgetLimited(result)) {
      return {
        status: "error" as const,
        detail: compactOutput(result.stderr || result.stdout),
      };
    }

    const events = parseJsonLines(result.stdout);
    if (!toolUseSeen(events, "Read")) {
      return { status: "error" as const, detail: "Read tool_use event not observed during edit smoke" };
    }
    if (!toolUseSeen(events, "Edit")) {
      return { status: "error" as const, detail: "Edit tool_use event not observed" };
    }

    const content = await Bun.file(fixturePath).text();
    if (content.trim() !== afterToken) {
      return {
        status: "error" as const,
        detail: "Edit tool did not persist expected replacement",
      };
    }

    if (!budgetLimited(result)) {
      const payload = extractSuccessfulJsonResult(result);
      if (!payload) {
        return {
          status: "error" as const,
          detail: "Edit smoke did not finish with a success payload",
        };
      }

      const accountingError = assertPayloadHasConsistentAccounting(
        payload,
        "Edit smoke",
      );
      if (accountingError) {
        return {
          status: "error" as const,
          detail: accountingError,
        };
      }
    }

    return {
      status: budgetLimited(result) ? "warn" as const : "ok" as const,
      detail: budgetLimited(result)
        ? "Edit tool_use observed and file updated, but budget cap was hit after completion"
        : "Edit tool_use observed and file updated",
    };
  } finally {
    await rm(tempDir, { recursive: true, force: true });
  }
}

async function checkGrepTool() {
  const tempDir = await mkdtemp(join(tmpdir(), "claude-code-smoke-"));
  const hitPath = join(tempDir, `grep-hit-${Math.random().toString(36).slice(2, 10)}.txt`);
  const missPath = join(tempDir, `grep-miss-${Math.random().toString(36).slice(2, 10)}.txt`);
  const token = `SMOKE_GREP_${Math.random().toString(36).slice(2, 10)}`;

  try {
    await writeFile(hitPath, `prefix ${token} suffix\n`, "utf8");
    await writeFile(missPath, "no token here\n", "utf8");
    const result = await runCommand([
      "node",
      "dist/cli.js",
      "-p",
      `Use Grep in ${tempDir} to find the exact token ${token}. Reply with the exact absolute path of the matching file only.`,
      "--model",
      args.model,
      "--output-format",
      "stream-json",
      "--verbose",
      "--max-budget-usd",
      String(args.maxBudgetUsd),
      "--permission-mode",
      "bypassPermissions",
      "--allowedTools",
      "Grep",
    ]);

    if (result.exitCode !== 0 && !budgetLimited(result)) {
      return {
        status: "error" as const,
        detail: compactOutput(result.stderr || result.stdout),
      };
    }

    const events = parseJsonLines(result.stdout);
    if (!toolUseSeen(events, "Grep")) {
      return { status: "error" as const, detail: "Grep tool_use event not observed" };
    }

    const toolResult = toolResultContent(events, "Grep") ?? "";
    if (!toolResult.includes(hitPath)) {
      return {
        status: "error" as const,
        detail: `expected grep tool result to contain ${hitPath}`,
      };
    }

    return {
      status: budgetLimited(result) ? "warn" as const : "ok" as const,
      detail: budgetLimited(result)
        ? "Grep tool_use observed and target file resolved, but budget cap was hit after completion"
        : "Grep tool_use observed and target file resolved",
    };
  } finally {
    await rm(tempDir, { recursive: true, force: true });
  }
}

async function checkGlobTool() {
  const tempDir = await mkdtemp(join(tmpdir(), "claude-code-smoke-"));
  const fileName = `${Math.random().toString(36).slice(2, 10)}.glob-target.txt`;
  const fixturePath = join(tempDir, fileName);
  const decoyPath = join(tempDir, `${Math.random().toString(36).slice(2, 10)}.txt`);

  try {
    await writeFile(fixturePath, "glob smoke\n", "utf8");
    await writeFile(decoyPath, "decoy\n", "utf8");
    const result = await runCommand([
      "node",
      "dist/cli.js",
      "-p",
      `Use Glob in ${tempDir} to find the only file matching "*.glob-target.txt". Reply with its exact absolute path only.`,
      "--model",
      args.model,
      "--output-format",
      "stream-json",
      "--verbose",
      "--max-budget-usd",
      String(args.maxBudgetUsd),
      "--permission-mode",
      "bypassPermissions",
      "--allowedTools",
      "Glob",
    ]);

    if (result.exitCode !== 0 && !budgetLimited(result)) {
      return {
        status: "error" as const,
        detail: compactOutput(result.stderr || result.stdout),
      };
    }

    const events = parseJsonLines(result.stdout);
    if (!toolUseSeen(events, "Glob")) {
      return { status: "error" as const, detail: "Glob tool_use event not observed" };
    }

    const toolResult = toolResultContent(events, "Glob") ?? "";
    if (!toolResult.includes(fixturePath)) {
      return {
        status: "error" as const,
        detail: `expected glob tool result to contain ${fixturePath}`,
      };
    }

    return {
      status: budgetLimited(result) ? "warn" as const : "ok" as const,
      detail: budgetLimited(result)
        ? "Glob tool_use observed and target file resolved, but budget cap was hit after completion"
        : "Glob tool_use observed and target file resolved",
    };
  } finally {
    await rm(tempDir, { recursive: true, force: true });
  }
}

function extractSuccessfulJsonResult(result: RunResult): Record<string, unknown> | null {
  const payload = lastJsonObject(result.stdout);
  if (!payload || payload.subtype !== "success") {
    return null;
  }
  return payload;
}

async function checkResumeFlow() {
  const tempDir = await mkdtemp(join(tmpdir(), "claude-code-smoke-resume-"));
  const sessionId = randomUUID();
  const token = `SMOKE_RESUME_${Math.random().toString(36).slice(2, 10)}`;
  const firstPrompt = `Remember this token for later and reply with it only: ${token}`;
  const followupPrompt = "What token did I ask you to remember earlier in this conversation? Reply with the exact token only.";

  try {
    const commonArgs = [
      "--model",
      args.model,
      "--output-format",
      "json",
      "--max-budget-usd",
      String(args.maxBudgetUsd),
      "--permission-mode",
      "bypassPermissions",
      "--max-turns",
      "1",
    ];

    const firstRun = await runCommand(
      [
        "node",
        join(process.cwd(), "dist/cli.js"),
        "-p",
        firstPrompt,
        ...commonArgs,
        "--session-id",
        sessionId,
      ],
      { cwd: tempDir },
    );
    if (firstRun.exitCode !== 0) {
      return {
        status: "error" as const,
        detail: `seed session failed: ${compactOutput(firstRun.stderr || firstRun.stdout)}`,
      };
    }

    const firstPayload = extractSuccessfulJsonResult(firstRun);
    if (!firstPayload || firstPayload.result !== token || firstPayload.session_id !== sessionId) {
      return {
        status: "error" as const,
        detail: `seed session did not persist expected token/session: ${compactOutput(firstRun.stdout || firstRun.stderr)}`,
      };
    }

    const firstAccountingError = assertPayloadHasConsistentAccounting(
      firstPayload,
      "Resume seed session",
    );
    if (firstAccountingError) {
      return {
        status: "error" as const,
        detail: firstAccountingError,
      };
    }

    const continueRun = await runCommand(
      [
        "node",
        join(process.cwd(), "dist/cli.js"),
        "-p",
        followupPrompt,
        ...commonArgs,
        "--continue",
      ],
      { cwd: tempDir },
    );
    if (continueRun.exitCode !== 0) {
      return {
        status: "error" as const,
        detail: `--continue failed: ${compactOutput(continueRun.stderr || continueRun.stdout)}`,
      };
    }

    const continuePayload = extractSuccessfulJsonResult(continueRun);
    if (!continuePayload || continuePayload.result !== token || continuePayload.session_id !== sessionId) {
      return {
        status: "error" as const,
        detail: `--continue did not recover expected token/session: ${compactOutput(continueRun.stdout || continueRun.stderr)}`,
      };
    }

    const continueAccountingError = assertPayloadHasConsistentAccounting(
      continuePayload,
      "Resume --continue",
    );
    if (continueAccountingError) {
      return {
        status: "error" as const,
        detail: continueAccountingError,
      };
    }

    const resumeRun = await runCommand(
      [
        "node",
        join(process.cwd(), "dist/cli.js"),
        "-p",
        followupPrompt,
        ...commonArgs,
        "--resume",
        sessionId,
      ],
      { cwd: tempDir },
    );
    if (resumeRun.exitCode !== 0) {
      return {
        status: "error" as const,
        detail: `--resume failed: ${compactOutput(resumeRun.stderr || resumeRun.stdout)}`,
      };
    }

    const resumePayload = extractSuccessfulJsonResult(resumeRun);
    if (!resumePayload || resumePayload.result !== token || resumePayload.session_id !== sessionId) {
      return {
        status: "error" as const,
        detail: `--resume did not recover expected token/session: ${compactOutput(resumeRun.stdout || resumeRun.stderr)}`,
      };
    }

    const resumeAccountingError = assertPayloadHasConsistentAccounting(
      resumePayload,
      "Resume --resume",
    );
    if (resumeAccountingError) {
      return {
        status: "error" as const,
        detail: resumeAccountingError,
      };
    }

    return {
      status: "ok" as const,
      detail: "--continue and --resume both recovered prior session context",
    };
  } finally {
    await rm(tempDir, { recursive: true, force: true });
  }
}

async function checkChromeSmoke() {
  const readiness = await checkChromeReadiness();
  if (readiness.status === "skip") {
    return readiness;
  }

  const result = await runCommand(["bun", "run", "scripts/claude-in-chrome-smoke.ts"]);
  const output = compactOutput(result.stdout || result.stderr);

  if (result.exitCode === 0 && result.stdout.includes("Claude in Chrome smoke passed")) {
    return {
      status: "ok" as const,
      detail: "Claude in Chrome native socket connected and tabs MCP smoke passed",
    };
  }

  if (
    result.stdout.includes("Install it from https://claude.ai/chrome") ||
    result.stderr.includes("Install it from https://claude.ai/chrome")
  ) {
    return {
      status: "skip" as const,
      detail: "Claude browser extension is still not installed, so browser smoke was skipped",
    };
  }

  if (
    result.stdout.includes("no native socket is connected") ||
    result.stderr.includes("no native socket is connected") ||
    result.stdout.includes("Restart Chrome and ensure the extension is active") ||
    result.stderr.includes("Restart Chrome and ensure the extension is active")
  ) {
    return {
      status: "skip" as const,
      detail: "browser extension was found, but no live native socket is connected yet",
    };
  }

  return {
    status: "error" as const,
    detail: output,
  };
}

async function checkCompactFlow() {
  const tempDir = await mkdtemp(join(tmpdir(), "claude-code-smoke-compact-"));
  const sessionId = randomUUID();
  const tokenA = "SMOKE_COMPACT_ALPHA_" + Math.random().toString(36).slice(2, 10);
  const tokenB = "SMOKE_COMPACT_BETA_" + Math.random().toString(36).slice(2, 10);
  const expectedTokens = tokenA + ", " + tokenB;
  const firstPrompt =
    "Remember these two tokens for later and reply with them exactly, comma separated: " + expectedTokens;
  const secondPrompt = "Repeat both tokens exactly, comma separated.";
  const followupPrompt =
    "What two tokens did I ask you to remember earlier in this conversation? Reply with them exactly, comma separated.";

  try {
    const commonArgs = [
      "--model",
      args.model,
      "--output-format",
      "json",
      "--max-budget-usd",
      String(args.maxBudgetUsd),
      "--permission-mode",
      "bypassPermissions",
      "--max-turns",
      "1",
    ];

    const firstRun = await runCommand(
      [
        "node",
        join(process.cwd(), "dist/cli.js"),
        "-p",
        firstPrompt,
        ...commonArgs,
        "--session-id",
        sessionId,
      ],
      { cwd: tempDir },
    );
    if (firstRun.exitCode !== 0) {
      return {
        status: "error" as const,
        detail: "seed session failed: " + compactOutput(firstRun.stderr || firstRun.stdout),
      };
    }

    const firstPayload = extractSuccessfulJsonResult(firstRun);
    if (!firstPayload || firstPayload.result !== expectedTokens || firstPayload.session_id !== sessionId) {
      return {
        status: "error" as const,
        detail:
          "seed session did not persist expected compact tokens/session: " +
          compactOutput(firstRun.stdout || firstRun.stderr),
      };
    }

    const firstAccountingError = assertPayloadHasConsistentAccounting(
      firstPayload,
      "Compact seed session",
    );
    if (firstAccountingError) {
      return {
        status: "error" as const,
        detail: firstAccountingError,
      };
    }

    const secondRun = await runCommand(
      [
        "node",
        join(process.cwd(), "dist/cli.js"),
        "-p",
        secondPrompt,
        ...commonArgs,
        "--continue",
      ],
      { cwd: tempDir },
    );
    if (secondRun.exitCode !== 0) {
      return {
        status: "error" as const,
        detail: "second turn failed before compact: " + compactOutput(secondRun.stderr || secondRun.stdout),
      };
    }

    const secondPayload = extractSuccessfulJsonResult(secondRun);
    if (!secondPayload || secondPayload.result !== expectedTokens || secondPayload.session_id !== sessionId) {
      return {
        status: "error" as const,
        detail:
          "second turn did not recover expected compact tokens/session: " +
          compactOutput(secondRun.stdout || secondRun.stderr),
      };
    }

    const secondAccountingError = assertPayloadHasConsistentAccounting(
      secondPayload,
      "Compact second turn",
    );
    if (secondAccountingError) {
      return {
        status: "error" as const,
        detail: secondAccountingError,
      };
    }

    const compactRun = await runCommand(
      [
        "node",
        join(process.cwd(), "dist/cli.js"),
        "-p",
        "/compact",
        "--model",
        args.model,
        "--output-format",
        "stream-json",
        "--verbose",
        "--max-budget-usd",
        String(args.maxBudgetUsd),
        "--permission-mode",
        "bypassPermissions",
        "--max-turns",
        "1",
        "--continue",
      ],
      { cwd: tempDir },
    );
    if (compactRun.exitCode !== 0) {
      return {
        status: "error" as const,
        detail: "/compact failed: " + compactOutput(compactRun.stderr || compactRun.stdout),
      };
    }

    if (!compactRun.stdout.includes('"status":"compacting"')) {
      return {
        status: "error" as const,
        detail: "compact flow did not emit compacting status",
      };
    }

    if (!compactRun.stdout.includes('"subtype":"compact_boundary"')) {
      return {
        status: "error" as const,
        detail: "compact flow did not emit compact_boundary",
      };
    }

    if (!compactRun.stdout.includes("<local-command-stdout>Compacted </local-command-stdout>")) {
      return {
        status: "error" as const,
        detail: "compact flow did not emit Compacted local command marker",
      };
    }

    const compactPayload = extractSuccessfulJsonResult(compactRun);
    if (!compactPayload || compactPayload.result !== "" || compactPayload.session_id !== sessionId) {
      return {
        status: "error" as const,
        detail:
          "/compact did not end in expected success payload: " +
          compactOutput(compactRun.stdout || compactRun.stderr),
      };
    }

    const compactAccountingError = assertPayloadHasConsistentAccounting(
      compactPayload,
      "Compact command",
      {
        allowUsageSubsetOfModelUsage: true,
        allowZeroInputTokens: true,
      },
    );
    if (compactAccountingError) {
      return {
        status: "error" as const,
        detail: compactAccountingError,
      };
    }

    const afterRun = await runCommand(
      [
        "node",
        join(process.cwd(), "dist/cli.js"),
        "-p",
        followupPrompt,
        ...commonArgs,
        "--continue",
      ],
      { cwd: tempDir },
    );
    if (afterRun.exitCode !== 0) {
      return {
        status: "error" as const,
        detail: "post-compact follow-up failed: " + compactOutput(afterRun.stderr || afterRun.stdout),
      };
    }

    const afterPayload = extractSuccessfulJsonResult(afterRun);
    if (!afterPayload || afterPayload.result !== expectedTokens || afterPayload.session_id !== sessionId) {
      return {
        status: "error" as const,
        detail:
          "post-compact follow-up did not recover expected tokens/session: " +
          compactOutput(afterRun.stdout || afterRun.stderr),
      };
    }

    const afterAccountingError = assertPayloadHasConsistentAccounting(
      afterPayload,
      "Compact follow-up",
    );
    if (afterAccountingError) {
      return {
        status: "error" as const,
        detail: afterAccountingError,
      };
    }

    return {
      status: "ok" as const,
      detail: "/compact emitted compact_boundary and preserved summarized recall via --continue",
    };
  } finally {
    await rm(tempDir, { recursive: true, force: true });
  }
}

async function checkAgentFlow() {
  const tempDir = await mkdtemp(join(tmpdir(), "claude-code-smoke-agent-"));
  const fixturePath = join(tempDir, "sample.txt");
  const sampleText = "BLUE-LANTERN-17";
  const prompt =
    "Use the Task tool exactly once. Ask a subagent to read the file at " +
    fixturePath +
    " and report the exact contents it contains. Do not read the file yourself. After the Task tool completes, reply with the exact contents only.";

  try {
    await writeFile(fixturePath, sampleText, "utf8");

    const result = await runCommand(
      [
        "node",
        join(process.cwd(), "dist/cli.js"),
        "-p",
        prompt,
        "--model",
        args.model,
        "--output-format",
        "stream-json",
        "--verbose",
        "--max-budget-usd",
        String(args.maxBudgetUsd),
        "--permission-mode",
        "bypassPermissions",
        "--allowedTools",
        "Task,Read",
      ],
      { timeoutMs: MULTI_STEP_TOOL_TIMEOUT_MS },
    );

    if (result.exitCode !== 0 && !budgetLimited(result)) {
      return {
        status: "error" as const,
        detail: compactOutput(result.stderr || result.stdout),
      };
    }

    const events = parseJsonLines(result.stdout);
    if (!toolUseSeen(events, "Agent") && !toolUseSeen(events, "Task")) {
      return {
        status: "error" as const,
        detail: "Agent/Task tool_use event not observed",
      };
    }

    if (
      !streamEventSeen(
        events,
        (event) =>
          event.type === "system" &&
          event.subtype === "task_started" &&
          event.task_type === "local_agent",
      )
    ) {
      return {
        status: "error" as const,
        detail: "local_agent task_started event not observed",
      };
    }

    if (
      !streamEventSeen(
        events,
        (event) =>
          event.type === "system" &&
          event.subtype === "task_notification" &&
          event.status === "completed",
      )
    ) {
      return {
        status: "error" as const,
        detail: "completed task_notification event not observed",
      };
    }

    const agentToolResult =
      toolResultContent(events, "Agent") ??
      toolResultContent(events, "Task") ??
      "";
    const finalEvent = lastJsonObject(result.stdout);
    const finalResult = finalEvent?.result ? String(finalEvent.result) : "";
    if (!agentToolResult.includes(sampleText) && !finalResult.includes(sampleText)) {
      return {
        status: "error" as const,
        detail: "agent flow did not surface the sample text in tool_result or final response",
      };
    }

    if (!budgetLimited(result)) {
      const payload = extractSuccessfulJsonResult(result);
      if (!payload) {
        return {
          status: "error" as const,
          detail: "Agent flow did not finish with a success payload",
        };
      }

      const accountingError = assertPayloadHasConsistentAccounting(
        payload,
        "Agent flow",
        { allowUsageSubsetOfModelUsage: true },
      );
      if (accountingError) {
        return {
          status: "error" as const,
          detail: accountingError,
        };
      }
    }

    return {
      status: budgetLimited(result) ? ("warn" as const) : ("ok" as const),
      detail: budgetLimited(result)
        ? "Agent/Task tool_use and local_agent completion observed, but budget cap was hit after completion"
        : "Agent/Task tool_use and local_agent completion observed with sample text surfaced",
    };
  } finally {
    await rm(tempDir, { recursive: true, force: true });
  }
}

async function checkWebFetchTool() {
  const expectedTitle = "Example Domain";
  const result = await runCommand([
    "node",
    join(process.cwd(), "dist/cli.js"),
    "-p",
    "Use WebFetch exactly once on https://example.com/. Ask it to extract the page title only. Then reply with the exact title only.",
    "--model",
    args.model,
    "--output-format",
    "stream-json",
    "--verbose",
    "--max-budget-usd",
    String(args.maxBudgetUsd),
    "--permission-mode",
    "bypassPermissions",
    "--allowedTools",
    "WebFetch",
    "--settings",
    '{"skipWebFetchPreflight":true}',
  ]);

  if (result.exitCode !== 0 && !budgetLimited(result)) {
    return {
      status: "error" as const,
      detail: compactOutput(result.stderr || result.stdout),
    };
  }

  const events = parseJsonLines(result.stdout);
  if (!toolUseSeen(events, "WebFetch")) {
    return {
      status: "error" as const,
      detail: "WebFetch tool_use event not observed",
    };
  }

  const toolResult = toolResultContent(events, "WebFetch") ?? "";
  let normalizedToolResult = toolResult.trim();
  try {
    const parsed = JSON.parse(normalizedToolResult);
    if (typeof parsed === "string") {
      normalizedToolResult = parsed.trim();
    }
  } catch {
    // Keep the raw tool_result text when it is not JSON-encoded.
  }

  if (normalizedToolResult !== expectedTitle) {
    return {
      status: "error" as const,
      detail:
        "expected WebFetch tool result " +
        expectedTitle +
        ", got " +
        (normalizedToolResult || toolResult || "<empty>"),
    };
  }

  const finalEvent = lastJsonObject(result.stdout);
  const finalResult = finalEvent?.result ? String(finalEvent.result).trim() : "";
  if (!budgetLimited(result) && finalResult !== expectedTitle) {
    return {
      status: "error" as const,
      detail: "expected final WebFetch response " + expectedTitle + ", got " + (finalResult || "<empty>"),
    };
  }

  if (!budgetLimited(result)) {
    const payload = extractSuccessfulJsonResult(result);
    if (!payload) {
      return {
        status: "error" as const,
        detail: "WebFetch smoke did not finish with a success payload",
      };
    }

    const accountingError = assertPayloadHasConsistentAccounting(
      payload,
      "WebFetch smoke",
      { allowUsageSubsetOfModelUsage: true },
    );
    if (accountingError) {
      return {
        status: "error" as const,
        detail: accountingError,
      };
    }
  }

  return {
    status: budgetLimited(result) ? ("warn" as const) : ("ok" as const),
    detail: budgetLimited(result)
      ? "WebFetch tool_use observed and title extracted, but budget cap was hit after completion"
      : "WebFetch tool_use observed and example.com title extracted",
  };
}

async function checkWebSearchTool() {
  const query = "example.com example domain";
  const result = await runCommand([
    "node",
    join(process.cwd(), "dist/cli.js"),
    "-p",
    "For a Claude Code CLI smoke test, use WebSearch exactly once to search for example.com example domain. After the search returns, reply with the first result title only.",
    "--model",
    args.model,
    "--output-format",
    "stream-json",
    "--verbose",
    "--max-budget-usd",
    String(args.maxBudgetUsd),
    "--permission-mode",
    "bypassPermissions",
    "--allowedTools",
    "WebSearch",
  ], { timeoutMs: 240000 });

  if (result.exitCode !== 0 && !budgetLimited(result)) {
    return {
      status: "error" as const,
      detail: compactOutput(result.stderr || result.stdout),
    };
  }

  const events = parseJsonLines(result.stdout);
  if (!toolUseSeen(events, "WebSearch")) {
    return {
      status: "error" as const,
      detail: "WebSearch tool_use event not observed",
    };
  }

  const structured = toolStructuredResult(events, "WebSearch");
  const structuredQuery = typeof structured?.query === "string" ? structured.query : "";
  if (!structuredQuery.toLowerCase().includes(query)) {
    return {
      status: "error" as const,
      detail: "WebSearch structured result did not preserve the requested query",
    };
  }

  const structuredResults = Array.isArray(structured?.results) ? structured.results : [];
  const hits = structuredResults.flatMap((entry) => {
    if (!entry || typeof entry !== "object" || Array.isArray(entry)) {
      return [];
    }

    const content = (entry as { content?: unknown }).content;
    if (!Array.isArray(content)) {
      return [];
    }

    return content.filter(
      (hit): hit is { title?: string; url?: string } =>
        Boolean(hit && typeof hit === "object" && !Array.isArray(hit)),
    );
  });

  const hasValidHit = hits.some((hit) => {
    const title = typeof hit.title === "string" ? hit.title.trim() : "";
    const url = typeof hit.url === "string" ? hit.url.trim() : "";
    return title.length > 0 && /^https?:\/\//.test(url);
  });
  if (!hasValidHit) {
    return {
      status: "error" as const,
      detail: "WebSearch structured result did not include any valid title/url hit",
    };
  }

  const finalEvent = lastJsonObject(result.stdout);
  const finalResult = finalEvent?.result ? String(finalEvent.result).trim() : "";
  if (!budgetLimited(result) && !finalResult) {
    return {
      status: "error" as const,
      detail: "WebSearch final response was empty after search results returned",
    };
  }

  if (!budgetLimited(result)) {
    const payload = extractSuccessfulJsonResult(result);
    if (!payload) {
      return {
        status: "error" as const,
        detail: "WebSearch smoke did not finish with a success payload",
      };
    }

    const accountingError = assertPayloadHasConsistentAccounting(
      payload,
      "WebSearch smoke",
      { allowUsageSubsetOfModelUsage: true },
    );
    if (accountingError) {
      return {
        status: "error" as const,
        detail: accountingError,
      };
    }
  }

  return {
    status: budgetLimited(result) ? ("warn" as const) : ("ok" as const),
    detail: budgetLimited(result)
      ? "WebSearch tool_use observed and structured hits returned, but budget cap was hit after completion"
      : "WebSearch tool_use observed and structured hits returned",
  };
}

async function checkNotebookEditTool() {
  const tempDir = await mkdtemp(join(tmpdir(), "claude-code-smoke-notebook-"));
  const notebookPath = join(tempDir, "smoke.ipynb");
  const token = "SMOKE_NOTEBOOK_" + Math.random().toString(36).slice(2, 10);
  const newSource = `print("${token}")`;
  const notebookFixture = JSON.stringify(
    {
      cells: [
        {
          cell_type: "code",
          execution_count: 1,
          metadata: {},
          outputs: [
            {
              name: "stdout",
              output_type: "stream",
              text: ["old\n"],
            },
          ],
          source: ["print('old')\n"],
        },
      ],
      metadata: {
        language_info: {
          name: "python",
        },
      },
      nbformat: 4,
      nbformat_minor: 5,
    },
    null,
    1,
  );
  const prompt =
    "Read the notebook at " +
    notebookPath +
    " first. Then use NotebookEdit exactly once to replace cell-0 with " +
    newSource +
    ". After the edit, reply with the exact token only: " +
    token;

  try {
    await writeFile(notebookPath, notebookFixture, "utf8");

    const result = await runCommand(
      [
        "node",
        join(process.cwd(), "dist/cli.js"),
        "-p",
        prompt,
        "--model",
        args.model,
        "--output-format",
        "stream-json",
        "--verbose",
        "--max-budget-usd",
        String(args.maxBudgetUsd),
        "--permission-mode",
        "bypassPermissions",
        "--allowedTools",
        "Read,NotebookEdit",
      ],
      { timeoutMs: MULTI_STEP_TOOL_TIMEOUT_MS },
    );

    if (result.exitCode !== 0 && !budgetLimited(result)) {
      return {
        status: "error" as const,
        detail: compactOutput(result.stderr || result.stdout),
      };
    }

    const events = parseJsonLines(result.stdout);
    if (!toolUseSeen(events, "Read")) {
      return {
        status: "error" as const,
        detail: "Read tool_use event not observed during notebook edit smoke",
      };
    }

    if (!toolUseSeen(events, "NotebookEdit")) {
      return {
        status: "error" as const,
        detail: "NotebookEdit tool_use event not observed",
      };
    }

    const toolResult = toolResultContent(events, "NotebookEdit") ?? "";
    if (!toolResult.includes("Updated cell cell-0") || !toolResult.includes(newSource)) {
      return {
        status: "error" as const,
        detail: "NotebookEdit tool_result did not report the expected cell update",
      };
    }

    const updatedNotebook = await Bun.file(notebookPath).text();
    if (!updatedNotebook.includes(token)) {
      return {
        status: "error" as const,
        detail: "updated notebook file did not contain the expected token",
      };
    }

    if (!updatedNotebook.includes('"outputs": []')) {
      return {
        status: "error" as const,
        detail: "updated notebook file did not clear cell outputs after edit",
      };
    }

    const finalEvent = lastJsonObject(result.stdout);
    const finalResult = finalEvent?.result ? String(finalEvent.result).trim() : "";
    if (!budgetLimited(result) && finalResult !== token) {
      return {
        status: "error" as const,
        detail: "final notebook edit response did not echo the token exactly",
      };
    }

    return {
      status: budgetLimited(result) ? ("warn" as const) : ("ok" as const),
      detail: budgetLimited(result)
        ? "Read and NotebookEdit tool_use observed and notebook updated, but budget cap was hit after completion"
        : "Read and NotebookEdit tool_use observed and notebook updated",
    };
  } finally {
    await rm(tempDir, { recursive: true, force: true });
  }
}

async function checkMcpFlow() {
  const tempDir = await mkdtemp(join(process.cwd(), ".smoke-mcp-"));
  const serverPath = join(tempDir, "mcp-server.mjs");
  const configPath = join(tempDir, "mcp-config.json");
  const token = "SMOKE_MCP_" + Math.random().toString(36).slice(2, 10);
  const serverName = "smoke_resource_server";
  const resourceUri = "smoke://token";
  const prompt =
    "Use ListMcpResourcesTool to discover the single resource exposed by server " +
    serverName +
    ". Then use ReadMcpResourceTool to read that resource and reply with the exact resource text only.";

  try {
    const serverSource = `import { Server } from "@modelcontextprotocol/sdk/server/index.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { ListResourcesRequestSchema, ReadResourceRequestSchema } from "@modelcontextprotocol/sdk/types.js";

const token = ${JSON.stringify(token)};
const resourceUri = ${JSON.stringify(resourceUri)};

const server = new Server(
  { name: "smoke-resource-server", version: "1.0.0" },
  { capabilities: { resources: {} } },
);

server.setRequestHandler(ListResourcesRequestSchema, async () => ({
  resources: [
    {
      uri: resourceUri,
      name: "smoke-token",
      mimeType: "text/plain",
      description: "Smoke token resource",
    },
  ],
}));

server.setRequestHandler(ReadResourceRequestSchema, async (request) => {
  if (request.params.uri !== resourceUri) {
    throw new Error("Unknown resource: " + request.params.uri);
  }

  return {
    contents: [
      {
        uri: resourceUri,
        mimeType: "text/plain",
        text: token,
      },
    ],
  };
});

const transport = new StdioServerTransport();
await server.connect(transport);
`;
    const configSource = JSON.stringify(
      {
        mcpServers: {
          [serverName]: {
            type: "stdio",
            command: "node",
            args: [serverPath],
          },
        },
      },
      null,
      2,
    );

    await writeFile(serverPath, serverSource, "utf8");
    await writeFile(configPath, configSource, "utf8");

    const result = await runCommand(
      [
        "node",
        join(process.cwd(), "dist/cli.js"),
        "-p",
        prompt,
        "--model",
        args.model,
        "--output-format",
        "stream-json",
        "--verbose",
        "--max-budget-usd",
        String(args.maxBudgetUsd),
        "--permission-mode",
        "bypassPermissions",
        "--strict-mcp-config",
        "--mcp-config",
        configPath,
        "--allowedTools",
        "ListMcpResourcesTool,ReadMcpResourceTool",
      ],
      { cwd: tempDir, timeoutMs: MULTI_STEP_TOOL_TIMEOUT_MS },
    );

    if (result.exitCode !== 0 && !budgetLimited(result)) {
      return {
        status: "error" as const,
        detail: compactOutput(result.stderr || result.stdout),
      };
    }

    const events = parseJsonLines(result.stdout);
    const initEvent = events.find(
      (event) => event.type === "system" && event.subtype === "init",
    ) as { mcp_servers?: Array<{ name?: string; status?: string }>; tools?: string[] } | undefined;
    const mcpServerConnected = (initEvent?.mcp_servers || []).some(
      (server) => server.name === serverName && server.status === "connected",
    );
    if (!mcpServerConnected) {
      return {
        status: "error" as const,
        detail: "MCP server did not report connected during init",
      };
    }

    if (!(initEvent?.tools || []).includes("ListMcpResourcesTool")) {
      return {
        status: "error" as const,
        detail: "ListMcpResourcesTool was not exposed in init event",
      };
    }

    if (!(initEvent?.tools || []).includes("ReadMcpResourceTool")) {
      return {
        status: "error" as const,
        detail: "ReadMcpResourceTool was not exposed in init event",
      };
    }

    if (!toolUseSeen(events, "ListMcpResourcesTool")) {
      return {
        status: "error" as const,
        detail: "ListMcpResourcesTool tool_use event not observed",
      };
    }

    if (!toolUseSeen(events, "ReadMcpResourceTool")) {
      return {
        status: "error" as const,
        detail: "ReadMcpResourceTool tool_use event not observed",
      };
    }

    const listResult = toolResultContent(events, "ListMcpResourcesTool") ?? "";
    if (!listResult.includes(serverName) || !listResult.includes(resourceUri)) {
      return {
        status: "error" as const,
        detail: "ListMcpResourcesTool result did not include expected server/resource URI",
      };
    }

    const readResult = toolResultContent(events, "ReadMcpResourceTool") ?? "";
    if (!readResult.includes(token)) {
      return {
        status: "error" as const,
        detail: "ReadMcpResourceTool result did not include expected token",
      };
    }

    const finalEvent = lastJsonObject(result.stdout);
    const finalResult = finalEvent?.result ? String(finalEvent.result).trim() : "";
    if (!budgetLimited(result) && finalResult !== token) {
      return {
        status: "error" as const,
        detail: "final response did not echo the MCP resource token exactly",
      };
    }

    if (!budgetLimited(result)) {
      const payload = extractSuccessfulJsonResult(result);
      if (!payload) {
        return {
          status: "error" as const,
          detail: "MCP stdio smoke did not finish with a success payload",
        };
      }

      const accountingError = assertPayloadHasConsistentAccounting(
        payload,
        "MCP stdio smoke",
      );
      if (accountingError) {
        return {
          status: "error" as const,
          detail: accountingError,
        };
      }
    }

    return {
      status: budgetLimited(result) ? ("warn" as const) : ("ok" as const),
      detail: budgetLimited(result)
        ? "MCP stdio resource server connected and returned the token, but budget cap was hit after completion"
        : "MCP stdio resource server connected and returned the token via list/read helpers",
    };
  } finally {
    await rm(tempDir, { recursive: true, force: true });
  }
}

async function runMcpHttpResourceFlow(
  authMode: "static-header" | "headers-helper",
) {
  const tempDir = await mkdtemp(join(process.cwd(), ".smoke-mcp-http-"));
  const serverPath = join(tempDir, "mcp-http-server.mjs");
  const helperPath = join(tempDir, "headers-helper.sh");
  const configPath = join(tempDir, "mcp-config.json");
  const token = "SMOKE_MCP_HTTP_" + Math.random().toString(36).slice(2, 10);
  const authToken = "smoke-auth-" + Math.random().toString(36).slice(2, 12);
  const serverName =
    authMode === "headers-helper"
      ? "smoke_http_headers_helper_server"
      : "smoke_http_auth_server";
  const resourceUri = "smoke-http://token";
  const prompt =
    "Use ListMcpResourcesTool to discover the single resource exposed by server " +
    serverName +
    ". Then use ReadMcpResourceTool to read that resource and reply with the exact resource text only.";
  let serverProc: ReturnType<typeof spawn> | null = null;
  let serverStdout = "";
  let serverStderr = "";

  try {
    const serverSource = `import http from "node:http";
import { randomUUID } from "node:crypto";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/streamableHttp.js";
import { isInitializeRequest } from "@modelcontextprotocol/sdk/types.js";

const authToken = process.env.SMOKE_MCP_AUTH_TOKEN;
const resourceUri = process.env.SMOKE_MCP_RESOURCE_URI;
const resourceText = process.env.SMOKE_MCP_RESOURCE_TEXT;
const sessions = new Map();

function createServer() {
  const server = new McpServer({
    name: "smoke-http-auth-server",
    version: "1.0.0",
  });

  server.registerResource(
    "smoke-token",
    resourceUri,
    { mimeType: "text/plain", description: "Smoke HTTP token resource" },
    async () => ({
      contents: [
        {
          uri: resourceUri,
          mimeType: "text/plain",
          text: resourceText,
        },
      ],
    }),
  );

  return server;
}

function sendJsonError(res, status, message) {
  res.statusCode = status;
  res.setHeader("content-type", "application/json");
  res.end(JSON.stringify({
    jsonrpc: "2.0",
    error: {
      code: -32000,
      message,
    },
    id: null,
  }));
}

const httpServer = http.createServer(async (req, res) => {
  try {
    const url = new URL(req.url || "/", "http://127.0.0.1");
    if (url.pathname !== "/mcp") {
      res.statusCode = 404;
      res.end("not found");
      return;
    }

    if (req.headers.authorization !== \`Bearer \${authToken}\`) {
      sendJsonError(res, 401, "Unauthorized");
      return;
    }

    if (req.method !== "POST") {
      res.setHeader("allow", "POST");
      sendJsonError(res, 405, "Method Not Allowed");
      return;
    }

    const chunks = [];
    for await (const chunk of req) {
      chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk));
    }
    const bodyText = Buffer.concat(chunks).toString("utf8");
    const parsedBody = bodyText ? JSON.parse(bodyText) : undefined;
    const headerSessionId =
      typeof req.headers["mcp-session-id"] === "string"
        ? req.headers["mcp-session-id"]
        : undefined;

    const existing = headerSessionId ? sessions.get(headerSessionId) : undefined;
    if (existing) {
      await existing.transport.handleRequest(req, res, parsedBody);
      return;
    }

    if (!parsedBody || !isInitializeRequest(parsedBody)) {
      sendJsonError(res, 400, "Bad Request: No valid session ID provided");
      return;
    }

    const server = createServer();
    let transport;
    transport = new StreamableHTTPServerTransport({
      sessionIdGenerator: () => randomUUID(),
      enableJsonResponse: true,
      onsessioninitialized: (sessionId) => {
        sessions.set(sessionId, { server, transport });
      },
      onsessionclosed: (sessionId) => {
        const session = sessions.get(sessionId);
        if (session) {
          sessions.delete(sessionId);
          void session.server.close().catch(() => {});
        }
      },
    });

    await server.connect(transport);
    await transport.handleRequest(req, res, parsedBody);
  } catch (error) {
    const message = error instanceof Error ? error.stack || error.message : String(error);
    res.statusCode = 500;
    res.setHeader("content-type", "text/plain");
    res.end(message);
  }
});

httpServer.listen(0, "127.0.0.1", () => {
  const address = httpServer.address();
  const port =
    address && typeof address === "object" && "port" in address ? address.port : 0;
  process.stdout.write(\`PORT=\${port}\\n\`);
});

async function shutdown() {
  await Promise.allSettled(
    Array.from(sessions.values()).map(({ server, transport }) =>
      Promise.allSettled([transport.close(), server.close()]),
    ),
  );
  sessions.clear();
  await new Promise((resolve) => httpServer.close(() => resolve(undefined)));
}

process.on("SIGTERM", () => {
  void shutdown().finally(() => process.exit(0));
});
process.on("SIGINT", () => {
  void shutdown().finally(() => process.exit(0));
});
`;
    await writeFile(serverPath, serverSource, "utf8");
    if (authMode === "headers-helper") {
      // Keep the helper self-contained so this smoke only validates helper execution + header injection.
      const helperSource = `#!/bin/sh
cat <<'EOF'
${JSON.stringify({ Authorization: `Bearer ${authToken}` })}
EOF
`;
      await writeFile(helperPath, helperSource, "utf8");
      await chmod(helperPath, 0o755);
    }

    serverProc = spawn("node", [serverPath], {
      cwd: tempDir,
      env: {
        ...process.env,
        SMOKE_MCP_AUTH_TOKEN: authToken,
        SMOKE_MCP_RESOURCE_URI: resourceUri,
        SMOKE_MCP_RESOURCE_TEXT: token,
      },
      stdio: ["ignore", "pipe", "pipe"],
    });

    const serverUrl = await new Promise<string>((resolve, reject) => {
      const cleanup = () => {
        clearTimeout(timeout);
        serverProc?.stdout?.off("data", onStdout);
        serverProc?.stderr?.off("data", onStderr);
        serverProc?.off("close", onClose);
        serverProc?.off("error", onError);
      };

      const onStdout = (chunk: string | Buffer) => {
        serverStdout += chunk.toString();
        const match = serverStdout.match(/PORT=(\d+)/);
        if (match) {
          cleanup();
          resolve(`http://127.0.0.1:${match[1]}/mcp`);
        }
      };

      const onStderr = (chunk: string | Buffer) => {
        serverStderr += chunk.toString();
      };

      const onClose = (code: number | null) => {
        cleanup();
        reject(
          new Error(
            "HTTP MCP server exited before reporting a port: " +
              compactOutput(serverStderr || serverStdout || `exit ${code ?? -1}`),
          ),
        );
      };

      const onError = (error: Error) => {
        cleanup();
        reject(error);
      };

      const timeout = setTimeout(() => {
        cleanup();
        reject(
          new Error(
            "Timed out waiting for HTTP MCP server startup: " +
              compactOutput(serverStderr || serverStdout),
          ),
        );
      }, 10_000);

      serverProc?.stdout?.setEncoding("utf8");
      serverProc?.stderr?.setEncoding("utf8");
      serverProc?.stdout?.on("data", onStdout);
      serverProc?.stderr?.on("data", onStderr);
      serverProc?.on("close", onClose);
      serverProc?.on("error", onError);
    });

    const configSource = JSON.stringify({
      mcpServers: {
        [serverName]:
          authMode === "headers-helper"
            ? {
                type: "http",
                url: serverUrl,
                headersHelper: helperPath,
              }
            : {
                type: "http",
                url: serverUrl,
                headers: {
                  Authorization: `Bearer ${authToken}`,
                },
              },
      },
    }, null, 2);
    await writeFile(configPath, configSource, "utf8");

    const result = await runCommand(
      [
        "node",
        join(process.cwd(), "dist/cli.js"),
        "-p",
        prompt,
        "--model",
        args.model,
        "--output-format",
        "stream-json",
        "--verbose",
        "--max-budget-usd",
        String(args.maxBudgetUsd),
        "--permission-mode",
        "bypassPermissions",
        "--strict-mcp-config",
        "--mcp-config",
        configPath,
        "--allowedTools",
        "ListMcpResourcesTool,ReadMcpResourceTool",
      ],
      { cwd: tempDir, timeoutMs: MULTI_STEP_TOOL_TIMEOUT_MS },
    );

    if (result.exitCode !== 0 && !budgetLimited(result)) {
      return {
        status: "error" as const,
        detail: compactOutput(result.stderr || result.stdout),
      };
    }

    const events = parseJsonLines(result.stdout);
    const initEvent = events.find(
      (event) => event.type === "system" && event.subtype === "init",
    ) as { mcp_servers?: Array<{ name?: string; status?: string }>; tools?: string[] } | undefined;
    const mcpServerConnected = (initEvent?.mcp_servers || []).some(
      (server) => server.name === serverName && server.status === "connected",
    );
    if (!mcpServerConnected) {
      return {
        status: "error" as const,
        detail:
          "HTTP MCP server did not report connected during init: " +
          compactOutput(JSON.stringify(initEvent?.mcp_servers || [])) +
          " stderr=" +
          compactOutput(result.stderr || "<empty>") +
          " server_stderr=" +
          compactOutput(serverStderr || "<empty>"),
      };
    }

    if (!(initEvent?.tools || []).includes("ListMcpResourcesTool")) {
      return {
        status: "error" as const,
        detail: "ListMcpResourcesTool was not exposed in init event",
      };
    }

    if (!(initEvent?.tools || []).includes("ReadMcpResourceTool")) {
      return {
        status: "error" as const,
        detail: "ReadMcpResourceTool was not exposed in init event",
      };
    }

    if (!toolUseSeen(events, "ListMcpResourcesTool")) {
      return {
        status: "error" as const,
        detail: "ListMcpResourcesTool tool_use event not observed for HTTP MCP smoke",
      };
    }

    if (!toolUseSeen(events, "ReadMcpResourceTool")) {
      return {
        status: "error" as const,
        detail: "ReadMcpResourceTool tool_use event not observed for HTTP MCP smoke",
      };
    }

    const listResult = toolResultContent(events, "ListMcpResourcesTool") ?? "";
    if (!listResult.includes(serverName) || !listResult.includes(resourceUri)) {
      return {
        status: "error" as const,
        detail: "ListMcpResourcesTool result did not include expected HTTP server/resource URI",
      };
    }

    const readResult = toolResultContent(events, "ReadMcpResourceTool") ?? "";
    if (!readResult.includes(token)) {
      return {
        status: "error" as const,
        detail: "ReadMcpResourceTool result did not include expected HTTP resource token",
      };
    }

    const finalEvent = lastJsonObject(result.stdout);
    const finalResult = finalEvent?.result ? String(finalEvent.result).trim() : "";
    if (!budgetLimited(result) && finalResult !== token) {
      return {
        status: "error" as const,
        detail: "final response did not echo the HTTP MCP resource token exactly",
      };
    }

    if (!budgetLimited(result)) {
      const payload = extractSuccessfulJsonResult(result);
      if (!payload) {
        return {
          status: "error" as const,
          detail: "HTTP MCP smoke did not finish with a success payload",
        };
      }

      const accountingError = assertPayloadHasConsistentAccounting(
        payload,
        authMode === "headers-helper"
          ? "HTTP MCP headersHelper smoke"
          : "HTTP MCP static-header smoke",
      );
      if (accountingError) {
        return {
          status: "error" as const,
          detail: accountingError,
        };
      }
    }

    return {
      status: budgetLimited(result) ? ("warn" as const) : ("ok" as const),
      detail: budgetLimited(result)
        ? authMode === "headers-helper"
          ? "HTTP MCP server connected through headersHelper auth and returned the token, but budget cap was hit after completion"
          : "HTTP MCP server connected through static Authorization header auth and returned the token, but budget cap was hit after completion"
        : authMode === "headers-helper"
          ? "HTTP MCP server connected through headersHelper auth and returned the token"
          : "HTTP MCP server connected through static Authorization header auth and returned the token",
    };
  } finally {
    if (serverProc && !serverProc.killed) {
      serverProc.kill("SIGTERM");
    }
    await rm(tempDir, { recursive: true, force: true });
  }
}

async function checkMcpHttpAuthFlow() {
  return runMcpHttpResourceFlow("static-header");
}

async function checkMcpHttpHeadersHelperFlow() {
  return runMcpHttpResourceFlow("headers-helper");
}

function normalizeTerminalOutput(output: string): string {
  return stripVTControlCharacters(output).replaceAll("\u0008", "").replace(/\s+/g, " ").trim();
}

function normalizeTerminalAnchorOutput(output: string): string {
  return stripVTControlCharacters(output).replaceAll("\u0008", "").replace(/\s+/g, "").trim();
}

function compactOutput(output: string): string {
  return output.replace(/\s+/g, " ").trim().slice(0, 240) || "<empty>";
}

async function main() {
  console.log("");
  console.log(DIVIDER);
  console.log("  Claude Code Smoke");
  console.log(`  mode: ${args.online ? "offline + online" : "offline"}`);
  if (args.groups.length > 0) {
    console.log(`  groups: ${[...new Set(args.groups)].join(", ")}`);
  }
  console.log(`  checks: ${selectedChecks.join(", ")}`);
  if (selectedChecks.some((check) => ONLINE_CHECKS.includes(check as (typeof ONLINE_CHECKS)[number]))) {
    console.log(`  model: ${args.model}`);
    console.log(`  max budget / online check: $${args.maxBudgetUsd.toFixed(2)}`);
  }
  console.log(DIVIDER);

  const checks: Record<CheckName, () => Promise<Omit<CheckResult, "name" | "durationMs">>> = {
    dist: checkDist,
    version: checkVersion,
    help: checkHelp,
    "tool-registry": checkToolRegistry,
    "command-registry": checkCommandRegistry,
    "hot-path-stubs": checkHotPathStubs,
    "query-dynamic-requires": checkQueryDynamicRequires,
    doctor: checkDoctor,
    "memory-command": checkMemoryCommand,
    "context-command": checkContextCommand,
    "chrome-readiness": checkChromeReadiness,
    "api-basic": checkApiBasic,
    "api-retry": checkApiRetry,
    "query-loop": checkQueryLoop,
    "streaming-fallback": checkStreamingFallback,
    "permission-denial": checkPermissionDenial,
    "error-max-turns": checkErrorMaxTurns,
    "error-during-execution": checkErrorDuringExecution,
    "error-max-structured-output-retries": checkErrorMaxStructuredOutputRetries,
    "error-max-budget": checkErrorMaxBudget,
    "claude-md-context": checkClaudeMdContext,
    "bash-tool": checkBashTool,
    "read-tool": checkReadTool,
    "write-tool": checkWriteTool,
    "edit-tool": checkEditTool,
    "notebook-edit-tool": checkNotebookEditTool,
    "grep-tool": checkGrepTool,
    "glob-tool": checkGlobTool,
    "agent-flow": checkAgentFlow,
    "webfetch-tool": checkWebFetchTool,
    "websearch-tool": checkWebSearchTool,
    "mcp-flow": checkMcpFlow,
    "mcp-http-auth-flow": checkMcpHttpAuthFlow,
    "mcp-http-headers-helper-flow": checkMcpHttpHeadersHelperFlow,
    "compact-flow": checkCompactFlow,
    "resume-flow": checkResumeFlow,
    "chrome-smoke": checkChromeSmoke,
  };

  for (const check of selectedChecks) {
    await record(check, checks[check]);
  }

  console.log("");
  for (const result of results) {
    console.log(
      `  ${icon(result.status)}  ${result.name.padEnd(16)} ${result.detail} (${result.durationMs} ms)`,
    );
  }

  const errorCount = results.filter((result) => result.status === "error").length;
  const warnCount = results.filter((result) => result.status === "warn").length;

  console.log("");
  console.log(DIVIDER);
  if (errorCount > 0) {
    console.log(`  result: ${errorCount} error(s), ${warnCount} warning(s)`);
  } else if (warnCount > 0) {
    console.log(`  result: no errors, ${warnCount} warning(s)`);
  } else {
    console.log("  result: all selected smoke checks passed");
  }
  console.log(DIVIDER);
  console.log("");

  process.exit(errorCount > 0 ? 1 : 0);
}

if (import.meta.main) {
  await main();
}
