# 偏离清单

> 目标：把“还原缺口”、“主动修补”和“fork 增强”分开记录，避免以后把 runtime 改动、类型修补和逆向缺口混成一团。

## 分类规则

- `Restoration gap`：原始 bundle 行为存在，但当前仓库还原不完整，或仍以 stub 占位。
- `Intentional repair`：为了构建、类型安全或稳定性做的修补，目标是不改变行为，只让源码更可维护。
- `Fork enhancement`：明确偏离原始行为的增强或策略调整。
- `Unverified`：怀疑有差异，但还没有足够证据，不应直接下结论。

## 记录约束

- 每条记录都要给出代码证据，至少包含一个路径。
- 只记录运行时、构建或可维护性偏离；纯文档改动不进这张表。
- 如果一个差异已经被接受，就在“处理建议”里写清楚为什么保留，而不是让它一直停留在“待修复”。

## 当前已知偏离

| Category | Surface | Evidence | 现状 | 处理建议 |
|---|---|---|---|---|
| Fork enhancement | Cron 工具默认加载 | `src/tools.ts` 相比 `../restored-src/src/tools.ts` 去掉了 `AGENT_TRIGGERS` gate | 当前 fork 默认暴露 `CronCreate/CronDelete/CronList` | 视为主动增强，继续保留，但应在 README 或矩阵里说明 |
| Restoration gap | bundled ripgrep 资产缺失 | `dist/vendor/ripgrep` 缺失；运行时报 `spawn .../dist/vendor/ripgrep/.../rg ENOENT` | 外部构建产物未携带 bundled `rg`，Grep/Glob 原本会直接受影响 | 若后续要恢复 bundle 对齐，应补回 vendor 资产；当前先靠 system `rg` 回退兜底 |
| Restoration gap | server / headless 主入口 | `src/server/server.ts`, `src/server/parseConnectUrl.ts`, `src/server/serverLog.ts`, `src/server/sessionManager.ts` | 当前仍是 `Auto-generated stub` 或近似占位 | 不纳入近期主线目标，除非要补 remote/headless |
| Restoration gap | MCP skill 发现层 | `src/skills/mcpSkills.ts` | 当前返回空数组的 stub | 需要单独判断是“暂缓还原”还是“直接删除旧概念” |
| Fork enhancement | Claude in Chrome restore/diagnostic surface | `packages/@ant/claude-for-chrome-mcp/src/*.ts`, `src/utils/claudeInChrome/packageBoundary.ts`, `src/utils/claudeInChrome/setup.ts`, `src/utils/claudeInChrome/setupPortable.ts`, `src/utils/claudeInChrome/officialExtension.ts`, `src/services/mcp/client.ts`, `scripts/install-claude-in-chrome-host.ts`, `scripts/claude-in-chrome-check.ts`, `scripts/claude-in-chrome-smoke.ts`, `scripts/open-claude-in-chrome-extension.ts`, `scripts/download-claude-in-chrome-extension.ts`, `scripts/launch-claude-in-chrome-unpacked.ts`, `scripts/claude-in-chrome-ping-host.ts` | workspace package 已从相邻 restored source 回填，源码层不再是 stub；fork 还补了 native host 安装/诊断/最小 smoke 链路，并修正了源码模式下 wrapper 误指向不存在 `cli.js` 的问题。后续又补了 Opera root-layout 扩展探测、manifest target 可执行性校验、一键打开扩展安装页脚本、live socket 诊断、官方 CRX 下载/解包辅助路径，以及 native host `ping/pong` 自检。当前本机验证已进一步推进到 `claude-in-chrome:check` 返回 `READY`，且 `claude-in-chrome:smoke` 已完成 `tabs_context_mcp -> tabs_create_mcp` 最小真实闭环 | 建议保留；当前剩余工作应转向 bundle 细节差异审计和长期回归，而不是再把问题归因到 stub 或 native host 缺失 |
| Restoration gap | 模板分类器 | `src/jobs/classifier.ts` | 当前为 stub，且只在 `TEMPLATES` 路径上加载 | 维持 dormant，除非要恢复模板工作流 |
| Restoration gap | CLI 兼容类型层 | `src/cli/src/tools.ts` | 当前仅保留 type stub | 先不把它当主战场，除非热路径开始穿透这里 |
| Restoration gap | query 子模块占位 | `src/query/transitions.ts`, `src/query.ts` | `src/query/transitions.ts` 仍是 stub，但 `src/query.ts` 对它是 `import type`，当前只作为类型占位使用，不会进入 runtime 主循环 | 先标记为非阻塞 restoration gap；若后续出现运行时引用，再回到 bundle 查证 |
| Restoration gap | query feature-gated 子模块仍多为 dormant stub | `src/query.ts`, `src/QueryEngine.ts`, `src/services/compact/reactiveCompact.ts`, `src/services/contextCollapse/index.ts`, `src/services/skillSearch/prefetch.ts`, `src/jobs/classifier.ts`, `src/services/compact/snipCompact.ts`, `src/utils/taskSummary.ts`, `src/services/compact/snipProjection.ts` | 当前离线 `query-dynamic-requires` 审计结果是默认构建下 `1 active real + 1 gated real + 7 dormant stub`；这些 stub 目前都在关闭的 feature gate 后面，不是默认 P0 blocker，但若后续恢复相关 flag，就必须补真实实现 | 继续作为已知 gap 保留，并用离线 smoke 持续盯住“已启用分支不能命中 stub/缺文件” |
| Restoration gap | 默认 dormant 的 ant-only / feature-gated stub 仍被静态导入 | `src/commands/reset-limits/index.ts`, `src/tools/TungstenTool/TungstenTool.ts`, `src/tools/WorkflowTool/constants.ts`, `src/types/connectorText.ts`, `scripts/smoke-test.ts` | 当前离线 `hot-path-stubs` 审计已把这 4 处识别为默认 dormant：分别受 `USER_TYPE === 'ant'`、`feature('WORKFLOW_SCRIPTS')`、`feature('CONNECTOR_TEXT')` 门控，因此不算默认主链路 blocker，但一旦恢复对应能力仍需补真实实现 | 继续作为已知 gap 保留，并用离线 smoke 盯住，避免 dormant 范围意外扩大 |
| Intentional repair | `query.ts` 的数组和类型守卫 | `src/query.ts` 对比 `../restored-src/src/query.ts` | 增加了 `Array.isArray`、assistant 内容数组兜底、tool block 名称安全收窄和 withheld 判定 cast，用来保护 assistant/tool_use 内容遍历与 observable-input 回填逻辑，避免异常消息形状把主循环打崩 | 这是可接受修补，应保留 |
| Intentional repair | `services/api/claude.ts` 的 fallback usage 空值保护、terminal-state fallback 收窄与 malformed-success 计费兜底 | `src/services/api/claude.ts` | 非流式 fallback 的 synthetic assistant error message 可能没有 `usage`；当前 fork 在 finally 里先做空值保护，再决定是否累计 cost，避免 malformed stream 的原始错误被二次 `calculateUSDCost(...usage)` 崩溃覆盖。另补了一层 terminal-state 判定：若流式响应已经收到 `message_stop`，只是缺失 `stop_reason`，则不再额外触发一次非流式 fallback 请求，而是直接把 malformed terminal state 交给上层收口为 `error_during_execution`。对于已完成 `content_block_stop` 但缺失 `message_delta / message_stop` 的成功流，再补一层 streamed-cost 兜底，避免 `success` 结果把 `total_cost_usd` 和 `modelUsage` 记成 0 | 这是可接受修补，应保留 |
| Intentional repair | `QueryEngine.ts` 的消息类型收窄与 usage 补账 | `src/QueryEngine.ts` 对比 `../restored-src/src/QueryEngine.ts` | 增加 compact boundary / attachment / progress / stream_event 分支的显式类型处理，并从 `message_delta` 稳定提取 `stop_reason`，保持 SDK 结果整形、usage 累积和结束态透传稳定；当前对“assistant 文本已产出但缺失 `message_stop`”的流，再依据已完成的 `content_block_stop` 进行一次 usage flush，避免最终 `success` 的 `usage` 空掉；另外对 non-streaming fallback 这类直接产出最终 assistant message 的响应，也会在 assistant 分支按最终 `message.usage` 补记 `totalUsage`，避免 `usage` 与 `total_cost_usd / modelUsage` 脱节。在线 smoke 已覆盖本地假 Anthropic `429 + Retry-After` 的 `api_retry` 事件、最小成功路径、两类 malformed-success 单请求成功路径、真不完整流式响应后的 non-streaming recovery、`permission_denials` 归档、max-turns 收口、空 content + 非 `end_turn` 收尾导致的 `error_during_execution` 收口（当前已覆盖 `tool_use`、`stop_sequence` 与缺失 `stop_reason` 三种异常收尾）、structured-output 重试上限收口和超预算收口 | 这是可接受修补，应保留 |
| Intentional repair | `services/mcp/client.ts` 的 stdio server type narrowing | `src/services/mcp/client.ts` 对比 `../restored-src/src/services/mcp/client.ts` | 通过显式类型收窄减少误推断 | 这是可接受修补，应保留 |
| Intentional repair | `sessionStorage.ts` 的 resume 快照缺失保护 | `src/utils/sessionStorage.ts`, `src/utils/__tests__/sessionStorage.test.ts` | 当前在 `buildFileHistorySnapshotChain()` 中遇到“普通 transcript message 没有对应 `fileHistorySnapshots` 记录”的常见情况时会直接跳过，不再解构空值把 `loadTranscriptFromFile() / loadConversationForResume()` 打崩；新增回归测试覆盖“仅 user+assistant、无 file-history snapshot 的 jsonl transcript” | 这是可接受修补，应保留；它修复的是恢复链路对正常 transcript 过于脆弱的问题，不是主动改变产品语义 |
| Intentional repair | `/memory` 命令的可测试性抽取 | `src/commands/memory/memory.tsx`, `src/commands/memory/__tests__/memory.test.ts` | 当前把“创建 memory 文件、忽略 `EEXIST`、打开编辑器、生成编辑器提示文案”抽成可注入依赖的 helper，并补上单测；运行时行为不变，但核心副作用链路不再只能靠手工点 UI 回归 | 这是可接受修补，应保留；它提升的是可维护性和回归能力，不改变 `/memory` 的交互语义 |
| Intentional repair | `claude-in-chrome-smoke.ts` 的进程收口 | `scripts/claude-in-chrome-smoke.ts`, `scripts/smoke-test.ts` | 当前在 Claude in Chrome smoke 的成功和失败路径都显式调用 `socketClient.disconnect()`，避免脚本已经打印“smoke passed”但仍持有 native socket 句柄、导致项目级 harness 误判 120s 超时 | 这是可接受修补，应保留；它只修复脚本进程收口，不改变浏览器 MCP 的语义或工具面 |
| Intentional repair | `parse-keypress.ts` 的终端正则 raw-string 纠偏 | `src/ink/parse-keypress.ts`, `scripts/smoke-test.ts` | 当前已把一组 `RegExp(String.raw...)` 从“按普通字符串双重转义”纠正为真正的 raw-regex 形式，避免 `dist` 虽能构建、但 Node 启动时在 `FN_KEY_RE` 等表达式上抛 `Invalid regular expression: Unmatched ')'`，并已由离线 smoke 的 `help/tool-registry/doctor/context-command` 路径回归验证 | 这是可接受修补，应保留；后续若再引入 `String.raw` 正则，优先用单反斜杠的 raw 语义而不是普通字符串语义 |
| Intentional repair | ripgrep 缺失时回退 system `rg` | `src/utils/ripgrep.ts` | 当 bundled `dist/vendor/ripgrep/.../rg` 不存在时，自动退回系统 `rg` | 当前外部构建更稳，建议保留，直到 vendor 资产恢复或打包策略统一 |
| Intentional repair | `USER_TYPE` ant-only 门控恢复 | `src/main.tsx`, `src/screens/REPL.tsx`, `src/tools/AgentTool/AgentTool.tsx`, `src/tools/AgentTool/UI.tsx`, `src/components/PromptInput/PromptInput.tsx`, `src/utils/autoRunIssue.tsx` | 已把一批反编译留下的 ant 自比较表达式恢复成 `process.env.USER_TYPE ===/!== 'ant'`，让 ant-only 分支重新回到源码层的真实身份门控，并与 `docs/internals/ant-only-world.mdx` 和入口处 `USER_TYPE` 注入语义保持一致 | 继续保留；若后续再发现同类自比较，按 `USER_TYPE` 门控恢复，不要直接折叠成布尔常量 |
| Intentional repair | Biome 机械清理与 lint 基线收敛 | `scripts/health-check.ts`, `src/components/InvalidConfigDialog.tsx`, `src/services/mcp/client.ts`, `src/utils/bash/ShellSnapshot.ts`, `src/utils/staticRender.tsx`, `src/components/messages/AttachmentMessage.tsx`, `src/components/messages/UserPromptMessage.tsx` | 当前 fork 已清理一批无效 suppression、缺失 radix、`Math.pow`、无用 label、顶层 ignore 位置错误、`async Promise executor`，并已完成这批 `USER_TYPE` 门控归一化，普通机械噪声已明显收敛 | 继续保留这批机械修补；后续若再出现同类反编译产物，按 `USER_TYPE` 门控收敛即可 |
| Fork enhancement | `health` 健康检查入口与完成度标准对齐 | `scripts/health-check.ts`, `package.json`, `docs/COMPLETENESS_MATRIX.md` | 当前 `bun run health` 已升级为串行跑全仓 `biome lint`、离线 smoke、`bun test`、`bun run build`，并通过 `HEALTH_CHECK_INCLUDE_KNIP=1` 与 `HEALTH_CHECK_ONLINE=1` 暴露可选深检开关；不再停留在旧的“仅 `src/` lint + test + build + knip”口径 | 建议保留，作为完成度矩阵的聚合入口，减少“脚本存在但标准过时”的漂移 |
| Fork enhancement | query 动态 require 审计 | `scripts/smoke-test.ts`, `src/query.ts`, `src/QueryEngine.ts` | 当前离线 smoke 新增 `query-dynamic-requires`，会审计 `query.ts / QueryEngine.ts` 的动态 `require` 目标，并把 active real、gated real、dormant stub 分开报告 | 建议保留，作为 Query / QueryEngine parity 的自动回归护栏 |
| Fork enhancement | hot-path stub 审计递归化 | `scripts/smoke-test.ts` | 当前离线 smoke 会递归检查 `query.ts / QueryEngine.ts / context.ts / tools.ts / commands.ts / services/mcp/client.ts` 的静态 runtime import 图，并把 runtime stub、type-only stub、默认 dormant stub 分开报告 | 建议保留，作为 HotPathStubFree 的自动回归护栏 |
| Fork enhancement | smoke 回归与 CI 入口 | `scripts/smoke-test.ts`, `.github/workflows/ci.yml`, `.github/workflows/online-smoke.yml`, `src/services/mcp/__tests__/headersHelper.test.ts` | 当前 fork 增加了离线 smoke、手动在线 smoke 和 `headersHelper` 单测，属于仓库治理增强，不是原 bundle 自带能力 | 建议保留，作为后续完成度判断的基线设施 |
| Fork enhancement | online smoke 的 accounting/timeout 语义分层 | `scripts/smoke-test.ts`, `.github/workflows/online-smoke.yml`, `README.md`, `docs/COMPLETENESS_MATRIX.md`, `scripts/__tests__/smoke-test.test.ts` | 当前 fork 已把在线 smoke 分成“`usage` 必须与 `modelUsage` 严格一致”和“顶层 `usage` 允许是聚合 `modelUsage` 子集”两类，并为 `write/edit/notebook-edit/agent/MCP` 这类多步路径单独放宽命令超时。`2026-04-02` 又额外对 `bash-tool/read-tool` 增加了极窄的一次性重试：仅在 `[smoke-timeout]` 或 `tool_use event not observed` 这类已实测存在的瞬时抖动下重试一次，不放宽确定性断言失败 | 建议保留，作为在线回归稳定性的治理增强 |
| Unverified | feature-flag / ant-only 能力的真实可恢复性 | `src/tools.ts`, `src/commands.ts`, `docs/internals/feature-flags.mdx` | 代码面存在大量 dormant surface，但没有统一恢复策略 | 先当 dormant，不要当成默认缺失功能 |

## 更新流程

1. 先确认差异属于哪一类。
2. 再补证据路径。
3. 如果是 `Fork enhancement`，必须说明为什么要保留。
4. 如果是 `Restoration gap`，必须说明它是否阻塞 P0/P1。
5. 如果只是类型或稳定性修补，归到 `Intentional repair`，不要误报为“偏离原版”。
