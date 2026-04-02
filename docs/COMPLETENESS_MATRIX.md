# 完成度矩阵

> 目标：用同一套标准持续评估这个 fork 的真实完成度，避免被目录规模、README 勾选项或 stub 数量误导。

## 评估维度

- `Reachable`：能力是否真的接入 `src/tools.ts` 或 `src/commands.ts`，而不是只存在于目录里。
- `Smoke`：是否有端到端验证。
- `HotPathStubFree`：热路径是否会穿过 `Auto-generated stub`。
- `BundleParity`：行为是否与上层 `package/cli.js` 和 `package/cli.js.map` 对齐。
- `Regression`：是否有可重复的自动回归验证。
- `Observability`：失败时是否容易定位，是否有足够的日志、错误提示和诊断入口。
- `Priority`：后续投入优先级，`P0` 最高，`P3` 最低。

## 状态图例

- `Y`：已确认。
- `P`：部分确认，或只覆盖了其中一部分。
- `N`：未完成或当前证据表明不可用。
- `?`：尚未核实。
- `D`：dormant，代码存在但默认不可达，例如 feature flag、`USER_TYPE === 'ant'`、平台门控。

## 当前快照

快照时间：`2026-04-02`

| Surface | Reachable | Smoke | HotPathStubFree | BundleParity | Regression | Observability | Priority | 备注 |
|---|---|---|---|---|---|---|---|---|
| CLI 启动与版本输出 | Y | Y | Y | Y | Y | Y | P0 | `bun run smoke` 已覆盖 |
| API 基础对话链路 | Y | Y | Y | P | Y | P | P0 | `scripts/smoke-test.ts` 已覆盖基础 prompt，且 `api-basic` 现已附带最终 payload 的 accounting 一致性校验；`query-loop` 进一步覆盖 `stream-json` 主循环结果整形 |
| Query / QueryEngine 主循环 | Y | Y | Y | P | Y | P | P0 | 在线 smoke 已直接验证最小 `stream-json` 的 `init -> assistant -> result` 成功路径，以及两类“assistant 已产出文本后缺失 terminal metadata”容错路径：`stop_reason` 缺失，或 `content_block_stop` 之后的 terminal event 缺失，二者当前都保持单请求 success；同时也覆盖了本地假 Anthropic `429 + Retry-After` 驱动的 `api_retry` 事件、真不完整流式响应触发“1 次 `stream=true` 请求 + 1 次非流式恢复请求”的 recovery 路径、空 content block 且 `stop_reason=tool_use / stop_sequence / null` 触发的 `error_during_execution` 收口，其中 `missing stop_reason` 现已确认不会再额外触发一次非流式 fallback 请求；`api-retry`、`streaming-fallback`、`error-during-execution`、malformed-success probes、`permission-denial`、`error-max-turns`、`error-max-structured-output-retries` 与 `error-max-budget` 现在都已带最终 payload 的 accounting 护栏。对应 25 项在线套件已于 `2026-04-02` 批量跑通；`src/query/transitions.ts` 虽仍为 type-only stub，但当前未进入 runtime 热路径；离线 `query-dynamic-requires` 也已确认默认构建下没有已启用动态分支命中 stub；bundle 对齐仍需继续靠差异审计推进 |
| BashTool | Y | Y | Y | P | Y | P | P0 | 在线 smoke 已实测通过，且已接入手动在线 smoke workflow |
| FileRead / FileEdit / FileWrite | Y | Y | Y | P | Y | P | P0 | `Read/Write/Edit` 在线 smoke 已实测通过 |
| Glob / Grep | Y | Y | Y | P | Y | P | P0 | 在线 smoke 已通过；`ripgrep` 缺失时已回退 system `rg` |
| /compact | Y | Y | Y | P | Y | P | P0 | 在线 smoke 已验证 headless `/compact` 会发出 `compact_boundary`，并能在压缩后通过 `--continue` 保留摘要召回；最终 payload 允许顶层 `usage` 为 0，但 `modelUsage / total_cost_usd` 仍被回归锁住 |
| /memory | Y | Y | Y | P | Y | P | P1 | 离线 smoke 现已通过 PTY 会话真实输入 `/memory`，并校验 `Memory / Project memory / User memory / Checked in at ./CLAUDE.md / Saved in ~/.claude/CLAUDE.md` 这些稳定锚点；命令本身仍是 `local-jsx` 交互式编辑器，运行时 CLAUDE.md/记忆加载仍应单独看 `claude-md-context` 与 `/context` 非交互路径 |
| /context | Y | Y | Y | P | Y | Y | P1 | 离线 smoke 已验证非交互 `/context` 会输出上下文摘要，并列出当前项目 `CLAUDE.md` memory file |
| CLAUDE.md 自动上下文 | Y | Y | Y | P | Y | P | P1 | 在线 smoke 已验证 cwd 下 `CLAUDE.md` 自动注入并影响首轮回答 |
| AgentTool / Task | Y | Y | Y | P | Y | P | P1 | 在线 smoke 已验证 `Agent/Task` tool_use、`local_agent` 启停事件，以及 token 至少会出现在 `tool_result` 或最终回复之一；记账口径按“顶层 `usage` 是聚合 `modelUsage` 子集”回归 |
| MCP 基础连接 | Y | Y | Y | P | Y | Y | P1 | 在线 smoke 已覆盖本地 stdio 资源链路、HTTP + 静态 `Authorization` header 鉴权资源链路，以及 HTTP + `headersHelper` 鉴权资源链路；另有单测覆盖 helper 的 env 透传、JSON 校验和静/动态 header 合并。浏览器特化 MCP 的更细粒度状态见下方 Claude in Chrome 条目 |
| Claude in Chrome 本机浏览器 MCP | Y | Y | Y | P | Y | Y | P1 | 可选本机 smoke 已于 `2026-04-02` 实测通过：`bun run smoke -- --checks chrome-readiness,chrome-smoke` 返回全绿；其中 `claude-in-chrome:check` 已到 `READY`，`claude-in-chrome:smoke` 已完成 `tabs_context_mcp -> tabs_create_mcp` 最小闭环。该能力仍依赖本机 Chrome profile、扩展激活和登录态，不属于 CI 默认在线组 |
| WebFetch | Y | Y | Y | P | Y | P | P1 | 在线 smoke 已验证公开静态页抓取与标题抽取；最终 payload 允许 `modelUsage` 包含辅助模型成本，因此按“顶层 `usage` 是聚合 `modelUsage` 子集”回归；仍不覆盖认证/private URL |
| /doctor | Y | Y | Y | P | Y | Y | P1 | 离线 smoke 已验证交互诊断屏渲染锚点 |
| /resume | Y | Y | Y | P | Y | Y | P1 | 在线 smoke 已验证 `--continue` 与 `--resume <session-id>` 恢复上下文；`2026-04-02` 已修复 transcript 缺失 `fileHistorySnapshots` 时导致恢复链路退化为空历史的问题 |
| WebSearch | Y | Y | Y | P | Y | P | P2 | 在线 smoke 已验证 `tool_use -> 结构化 hits`；最终 payload 允许 `modelUsage` 包含辅助模型成本，因此按“顶层 `usage` 是聚合 `modelUsage` 子集”回归；不对外部搜索排序和最终自由生成回答做固定快照断言 |
| NotebookEdit | Y | Y | Y | P | Y | P | P2 | 在线 smoke 已验证 Read-before-Edit 与最小 notebook 单元替换；当前不覆盖多单元/输出图片场景 |
| Bridge / remote-control | P | N | P | P | N | P | P3 | 路径很多，恢复价值高，但不在当前主干闭环内 |
| Server / headless | P | N | N | N | N | N | P3 | 当前有多处 stub，不能按完成状态判断 |
| Ant-only / KAIROS / VOICE | D | N | ? | ? | N | P | P3 | 先按 dormant 处理，不纳入近期目标 |

## 升级标准

- 一个模块从 `Y/P/N` 的代码审计状态升级到“可用基座”，至少需要：`Reachable=Y`、`Smoke=Y`、`HotPathStubFree=Y`。
- 一个模块要升级到“稳定可维护”，还需要：`BundleParity=Y 或有明确偏离说明`，以及 `Regression=Y`。
- 对 `P0` 和 `P1` 模块，默认不接受“只有 README 勾选，没有 smoke”的完成定义。

## 建议用法

- 每次补一个模块，先更新本表，再决定是否需要更新 `docs/DIVERGENCE.md`。
- 新增运行时偏离时，先在 `docs/DIVERGENCE.md` 记录类别和证据，再决定是否属于主动增强。
- 默认先清 P0 和 P1，再碰 P2 和 P3。

## 自动化入口

- 健康检查总入口：`bun run health`
- `bun run health` 默认串行执行全仓 `biome lint`、离线 smoke、`bun test` 和 `bun run build`
- 需要把冗余代码检查也纳入时：`HEALTH_CHECK_INCLUDE_KNIP=1 bun run health`
- 需要把在线 smoke 也纳入时：`HEALTH_CHECK_ONLINE=1 bun run health`
- 离线 smoke：`bun run smoke`
- 离线单项也可跑：`bun run smoke -- --checks doctor,memory-command,context-command,hot-path-stubs,query-dynamic-requires`
- `hot-path-stubs` 会递归审计 `query.ts / QueryEngine.ts / context.ts / tools.ts / commands.ts / services/mcp/client.ts` 的静态 runtime import 图，并把 runtime stub、type-only stub、默认 dormant stub 分开报告
- `query-dynamic-requires` 会审计 `query.ts / QueryEngine.ts` 的动态 `require` 目标，校验“已启用分支不能命中 stub/缺文件”，并单独列出 gated real 与 dormant stub
- Claude in Chrome readiness：`bun run smoke -- --checks chrome-readiness`
- Claude in Chrome runtime smoke：`bun run smoke -- --checks chrome-smoke`
- 在线 smoke：`bun run smoke:online`
- 列出在线 smoke 分组：`bun run smoke -- --list-groups`
- 只跑某一组在线检查：`bun run smoke -- --online --groups tools-and-agent`
- 在线 smoke 也支持只跑部分检查：`bun run smoke -- --online --checks api-basic,api-retry,query-loop,streaming-fallback,permission-denial,error-max-turns,error-during-execution,error-max-structured-output-retries,error-max-budget,claude-md-context,bash-tool,read-tool,write-tool,edit-tool,notebook-edit-tool,grep-tool,glob-tool,agent-flow,webfetch-tool,websearch-tool,mcp-flow,mcp-http-auth-flow,mcp-http-headers-helper-flow,compact-flow,resume-flow`
- GitHub Actions：`.github/workflows/ci.yml` 默认跑离线 smoke；`.github/workflows/online-smoke.yml` 手动触发时默认按 `api-and-session / tools-and-agent / integrations` 3 组并行跑在线 smoke，也支持通过 `groups` 或 `checks` 输入切回自定义集合
- 多步工具 smoke 默认预算上限已提高到 `$0.20`，避免工具已完成但被过低预算误伤
- `write-tool / edit-tool / notebook-edit-tool` 这类多步在线 smoke 现在走专用超时 `SMOKE_MULTI_STEP_TOOL_TIMEOUT_MS`，默认 `180000` ms；其余检查继续沿用 `SMOKE_COMMAND_TIMEOUT_MS` 的默认 `120000` ms
- 手动触发 `.github/workflows/online-smoke.yml` 时，也可以直接覆盖 `command_timeout_ms` 和 `multi_step_timeout_ms`
- `.github/workflows/online-smoke.yml` 在 `checks` 和 `groups` 都留空时会默认并行跑 3 组，组内具体检查由 `scripts/smoke-test.ts` 的 `ONLINE_CHECK_GROUPS` 注册表统一定义；填写 `groups` 时会跑指定分组，填写 `checks` 时会直接跑指定检查集合
- 当前 25 项在线套件已在本地批量跑通一次，可作为手动 workflow 默认集合
