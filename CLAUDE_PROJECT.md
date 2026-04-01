# Claude Code 项目架构说明

本文档补充 CLAUDE.md 中的通用指令，提供项目特定的架构信息。

## 项目概述

这是 Anthropic 官方 Claude Code CLI 工具的**反编译/逆向工程**版本。目标是恢复核心功能，同时精简次要能力。许多模块被 stub 化或通过 feature flag 关闭。代码库有 ~1341 个 tsc 错误（主要是 `unknown`/`never`/`{}` 类型），但不影响 Bun 运行时执行。

## 命令

```bash
# 安装依赖
bun install

# 开发模式（通过 Bun 直接执行）
bun run dev
# 等价于: bun run src/entrypoints/cli.tsx

# 管道模式
echo "say hello" | bun run src/entrypoints/cli.tsx -p

# 构建（输出 dist/cli.js, ~25MB）
bun run build
```

无测试运行器配置。无 linter 配置。

## 架构

### 运行时与构建

- **运行时**: Bun（非 Node.js）。所有导入、构建和执行使用 Bun API。
- **构建**: `bun build src/entrypoints/cli.tsx --outdir dist --target bun` — 单文件 bundle。
- **模块系统**: ESM (`"type": "module"`)，TSX 使用 `react-jsx` 转换。
- **Monorepo**: Bun workspaces — 内部包位于 `packages/`，通过 `workspace:*` 解析。

### 入口与引导

1. **`src/entrypoints/cli.tsx`** — 真正的入口点。顶部注入运行时 polyfill：
   - `feature()` 默认启用 `EXTRACT_MEMORIES`，其余返回 `false`（所有 feature flag 禁用，跳过未实现分支）。
   - `globalThis.MACRO` — 模拟构建时宏注入（VERSION, BUILD_TIME 等）。
   - `BUILD_TARGET`, `BUILD_ENV`, `INTERFACE_TYPE` 全局变量。
   - **`USER_TYPE=ant` 注入** — 解锁 294 处内部功能门控。
2. **`src/main.tsx`** — Commander.js CLI 定义。解析参数，初始化服务（auth, analytics, policy），然后启动 REPL 或管道模式。
3. **`src/entrypoints/init.ts`** — 一次性初始化（遥测、配置、信任对话框）。

### 核心循环

- **`src/query.ts`** — 主 API 查询函数。发送消息到 Claude API，处理流式响应，处理工具调用，管理对话轮次循环。
- **`src/QueryEngine.ts`** — 包装 `query()` 的高级编排器。管理对话状态、压缩、文件历史快照、归因和轮次级簿记。被 REPL 屏幕使用。
- **`src/screens/REPL.tsx`** — 交互式 REPL 屏幕（React/Ink 组件）。处理用户输入、消息显示、工具权限提示和键盘快捷键。

### API 层

- **`src/services/api/claude.ts`** — 核心 API 客户端。构建请求参数（系统提示、消息、工具、beta），调用 Anthropic SDK 流式端点，处理 `BetaRawMessageStreamEvent` 事件。
- 支持多个提供商：Anthropic 直连、AWS Bedrock、Google Vertex、Azure。
- 提供商选择在 `src/utils/model/providers.ts`。

### 工具系统

- **`src/Tool.ts`** — 工具接口定义（`Tool` 类型）和工具函数（`findToolByName`, `toolMatchesName`）。
- **`src/tools.ts`** — 工具注册表。组装工具列表；某些工具通过 `feature()` flag 或 `process.env.USER_TYPE` 条件加载。
- **`src/tools/<ToolName>/`** — 每个工具在自己的目录中（如 `BashTool`, `FileEditTool`, `GrepTool`, `AgentTool`）。
- 工具定义：`name`, `description`, `inputSchema`（JSON Schema）, `call()`（执行），可选的 React 组件用于渲染结果。

### UI 层（Ink）

- **`src/ink.ts`** — Ink 渲染包装器，注入 ThemeProvider。
- **`src/ink/`** — 自定义 Ink 框架（fork/内部）：自定义 reconciler、hooks（`useInput`, `useTerminalSize`, `useSearchHighlight`）、虚拟列表渲染。
- **`src/components/`** — 通过 Ink 在终端渲染的 React 组件。关键组件：
  - `App.tsx` — 根提供者（AppState, Stats, FpsMetrics）。
  - `Messages.tsx` / `MessageRow.tsx` — 对话消息渲染。
  - `PromptInput/` — 用户输入处理。
  - `permissions/` — 工具权限批准 UI。
- 组件使用 React Compiler 运行时（`react/compiler-runtime`）— 反编译输出有 `_c()` 记忆化调用。

### 状态管理

- **`src/state/AppState.tsx`** — 中央应用状态类型和上下文提供者。包含消息、工具、权限、MCP 连接等。
- **`src/state/store.ts`** — Zustand 风格的 AppState store。
- **`src/bootstrap/state.ts`** — 会话全局状态的模块级单例（session ID, CWD, project root, token counts）。

### 上下文与系统提示

- **`src/context.ts`** — 为 API 调用构建系统/用户上下文（git status, date, CLAUDE.md 内容, memory 文件）。
- **`src/utils/claudemd.ts`** — 从项目层次结构发现并加载 CLAUDE.md 文件。

### Feature Flag 系统

所有 `feature('FLAG_NAME')` 调用来自 `bun:bundle`（构建时 API）。在此反编译版本中，`feature()` 在 `cli.tsx` 中被 polyfill 为默认返回 `false`（除了 `EXTRACT_MEMORIES`）。这意味着所有 Anthropic 内部功能（COORDINATOR_MODE, KAIROS, PROACTIVE 等）被禁用。

### USER_TYPE 门控系统

代码库中有 294 处 `process.env.USER_TYPE === 'ant'` 检查。`cli.tsx` 入口已注入 `USER_TYPE=ant`，解锁：

| 功能 | 外部版本 | 内部版本（已解锁） |
|------|---------|------------------|
| Explore Agent 模型 | Haiku（降级） | inherit（继承主模型，通常是 Opus） |
| REPLTool | 不可用 | 可用 |
| SuggestBackgroundPRTool | 不可用 | 可用 |
| Agent 隔离模式 | worktree | worktree + remote |
| FileEdit 提示 | 标准 | 优化（最小唯一字符串提示） |
| Bash 权限 | 标准白名单 | 扩展（ANT_ONLY_SAFE_ENV_VARS） |
| Git 指令 | 详细手册 | 简化（推荐 skills） |
| 内部 Skills | 受限 | 完整访问 |
| Agent 调试日志 | 无 | 详细日志到 dump-prompts |
| Undercover 模式 | 禁用 | 自动激活（安全） |

**安全性验证**：OAuth 保持 prod 端点，Bridge 无覆盖。

### Stubbed/删除的模块

| 模块 | 状态 |
|------|------|
| Computer Use (`@ant/*`) | `packages/@ant/` 中的 stub 包 |
| `*-napi` 包（audio, image, url, modifiers） | `packages/` 中的 stub（除了完全实现的 `color-diff-napi`） |
| Analytics / GrowthBook / Sentry | 空实现 |
| Magic Docs / Voice Mode / LSP Server | 已移除 |
| Plugins / Marketplace | 已移除 |
| MCP OAuth | 简化 |

### 关键类型文件

- **`src/types/global.d.ts`** — 声明 `MACRO`, `BUILD_TARGET`, `BUILD_ENV` 和 Anthropic 内部标识符。
- **`src/types/internal-modules.d.ts`** — `bun:bundle`, `bun:ffi`, `@anthropic-ai/mcpb` 的类型声明。
- **`src/types/message.ts`** — 消息类型层次结构（UserMessage, AssistantMessage, SystemMessage 等）。
- **`src/types/permissions.ts`** — 权限模式和结果类型。

## 使用此代码库

- **不要尝试修复所有 tsc 错误** — 它们来自反编译，不影响运行时。
- **`feature()` polyfill** — `cli.tsx` 中 `feature()` 默认启用 `EXTRACT_MEMORIES`，其余返回 `false`。需要启用新 feature 时修改 `enabled` Set。
- **`USER_TYPE=ant` 已注入** — `cli.tsx` 入口处自动设置，解锁 294 处内部功能门控。
- **React Compiler 输出** — 组件有反编译的记忆化样板（`const $ = _c(N)`）。这是正常的。
- **`bun:bundle` 导入** — 在 `src/main.tsx` 和其他文件中，`import { feature } from 'bun:bundle'` 在构建时工作。在开发时，`cli.tsx` 中的 polyfill 提供它。
- **`src/` 路径别名** — tsconfig 将 `src/*` 映射到 `./src/*`。像 `import { ... } from 'src/utils/...'` 这样的导入是有效的。

## 验证工作流

由于没有配置测试运行器或 linter，验证依赖于：

1. **构建验证**: `bun run build` — 必须成功完成
2. **冒烟测试**: `bun run dev` — 快速交互测试
3. **管道模式测试**: `echo "test" | bun run src/entrypoints/cli.tsx -p` — 端到端验证

在报告任务完成前，至少运行构建验证。
