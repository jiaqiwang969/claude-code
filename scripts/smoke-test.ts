#!/usr/bin/env bun

import { randomUUID } from "node:crypto";
import { spawn } from "node:child_process";
import { chmod, mkdtemp, readdir, rm, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
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

const DIVIDER = "─".repeat(72);
const DEFAULT_MODEL = process.env.SMOKE_MODEL || "claude-sonnet-4-6";
const DEFAULT_MAX_BUDGET_USD = Number(process.env.SMOKE_MAX_BUDGET_USD || "0.20");
const DEFAULT_COMMAND_TIMEOUT_MS = Number(process.env.SMOKE_COMMAND_TIMEOUT_MS || "120000");
const KNOWN_UNREGISTERED_TOOL_DIRS = new Set([
  "DiscoverSkillsTool",
  "MCPTool",
  "McpAuthTool",
  "ReviewArtifactTool",
]);
const OFFLINE_CHECKS = [
  "dist",
  "version",
  "help",
  "tool-registry",
  "command-registry",
  "hot-path-stubs",
  "doctor",
] as const;
const ONLINE_CHECKS = [
  "api-basic",
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
const OPTIONAL_LOCAL_CHECKS = ["chrome-readiness", "chrome-smoke"] as const;
const ALL_CHECKS = [...OFFLINE_CHECKS, ...ONLINE_CHECKS, ...OPTIONAL_LOCAL_CHECKS];

type CheckName = (typeof ALL_CHECKS)[number];

const args = parseArgs(Bun.argv.slice(2));
const selectedChecks = resolveChecks(args.checks, args.online);
const results: CheckResult[] = [];

function parseArgs(argv: string[]) {
  const parsed = {
    online: false,
    checks: [] as string[],
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
      parsed.checks = (argv[index + 1] || "")
        .split(",")
        .map((item) => item.trim())
        .filter(Boolean);
      index += 1;
      continue;
    }

    if (arg.startsWith("--checks=")) {
      parsed.checks = arg
        .slice("--checks=".length)
        .split(",")
        .map((item) => item.trim())
        .filter(Boolean);
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

function resolveChecks(requestedChecks: string[], includeOnline: boolean): CheckName[] {
  if (requestedChecks.length > 0) {
    const invalid = requestedChecks.filter((check) => !ALL_CHECKS.includes(check as CheckName));
    if (invalid.length > 0) {
      throw new Error(`Unknown smoke check(s): ${invalid.join(", ")}`);
    }
    return requestedChecks as CheckName[];
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
  const offenders: string[] = [];
  for (const file of files) {
    const source = await Bun.file(file).text();
    if (source.includes("Auto-generated stub") || source.includes("replace with real implementation")) {
      offenders.push(file);
    }
  }

  if (offenders.length > 0) {
    return {
      status: "error" as const,
      detail: `stub marker found in hot path: ${offenders.join(", ")}`,
    };
  }

  return { status: "ok" as const, detail: `${files.length} hot-path files are stub-free` };
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

  return { status: "ok" as const, detail: "basic API prompt succeeded" };
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

    return {
      status: "ok" as const,
      detail: "cwd CLAUDE.md context loaded and token recalled",
    };
  } finally {
    await rm(tempDir, { recursive: true, force: true });
  }
}

async function checkBashTool() {
  const result = await runCommand([
    "node",
    "dist/cli.js",
    "-p",
    "Use Bash to run: uuidgen. Reply with the exact stdout only.",
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
  ]);

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

  const toolResult = toolResultContent(events, "Bash");
  const finalEvent = lastJsonObject(result.stdout);
  const finalResult = finalEvent?.result ? String(finalEvent.result) : "";
  if (!toolResult || finalResult !== toolResult) {
    return {
      status: "error" as const,
      detail: "Bash tool result did not match final response",
    };
  }

  return { status: "ok" as const, detail: "Bash tool_use observed and echoed back" };
}

async function checkReadTool() {
  const tempDir = await mkdtemp(join(tmpdir(), "claude-code-smoke-"));
  const fixturePath = join(tempDir, "fixture.txt");
  const token = `SMOKE_READ_${Math.random().toString(36).slice(2, 10)}`;

  try {
    await writeFile(fixturePath, token, "utf8");
    const result = await runCommand([
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
    ]);

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

    const finalEvent = lastJsonObject(result.stdout);
    const finalResult = finalEvent?.result ? String(finalEvent.result) : "";
    if (finalResult !== token) {
      return {
        status: "error" as const,
        detail: `expected token ${token}, got ${finalResult || "<empty>"}`,
      };
    }

    return { status: "ok" as const, detail: "Read tool_use observed and echoed back" };
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
    const result = await runCommand([
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
    ]);

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
    const result = await runCommand([
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
    ]);

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

    const result = await runCommand([
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
    ]);

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

    const finalEvent = lastJsonObject(result.stdout);
    const finalResult = finalEvent?.result ? String(finalEvent.result) : "";
    if (!finalResult.includes(sampleText)) {
      return {
        status: "error" as const,
        detail: "final response did not include agent-retrieved sample text",
      };
    }

    return {
      status: budgetLimited(result) ? ("warn" as const) : ("ok" as const),
      detail: budgetLimited(result)
        ? "Agent/Task tool_use and local_agent completion observed, but budget cap was hit after completion"
        : "Agent/Task tool_use and local_agent completion observed with final sample text recall",
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

    const result = await runCommand([
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
    ]);

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
      { cwd: tempDir },
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
      { cwd: tempDir },
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
  return stripVTControlCharacters(output).replace(/\u0008/g, "").replace(/\s+/g, " ").trim();
}

function normalizeTerminalAnchorOutput(output: string): string {
  return stripVTControlCharacters(output).replace(/\u0008/g, "").replace(/\s+/g, "").trim();
}

function compactOutput(output: string): string {
  return output.replace(/\s+/g, " ").trim().slice(0, 240) || "<empty>";
}

async function main() {
  console.log("");
  console.log(DIVIDER);
  console.log("  Claude Code Smoke");
  console.log(`  mode: ${args.online ? "offline + online" : "offline"}`);
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
    doctor: checkDoctor,
    "chrome-readiness": checkChromeReadiness,
    "api-basic": checkApiBasic,
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

await main();
