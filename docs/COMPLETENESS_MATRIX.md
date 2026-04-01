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
| API 基础对话链路 | Y | Y | Y | P | Y | P | P0 | `scripts/smoke-test.ts` 已覆盖基础 prompt，且可通过手动在线 smoke workflow 重复执行 |
| Query / QueryEngine 主循环 | Y | P | Y | P | P | P | P0 | 主骨架可读、可运行，已被基础 smoke 间接覆盖 |
| BashTool | Y | Y | Y | P | Y | P | P0 | 在线 smoke 已实测通过，且已接入手动在线 smoke workflow |
| FileRead / FileEdit / FileWrite | Y | Y | Y | P | Y | P | P0 | `Read/Write/Edit` 在线 smoke 已实测通过 |
| Glob / Grep | Y | Y | Y | P | Y | P | P0 | 在线 smoke 已通过；`ripgrep` 缺失时已回退 system `rg` |
| /compact | Y | Y | Y | P | Y | P | P0 | 在线 smoke 已验证 headless `/compact` 的 `compact_boundary` 事件与压缩后继续追问 |
| /memory | Y | N | Y | P | N | P | P1 | 命令本身是 `local-jsx` 交互式编辑器，不是稳定的 headless smoke 面；运行时 CLAUDE.md/记忆加载应单独看 query/context 路径 |
| CLAUDE.md 自动上下文 | Y | Y | Y | P | Y | P | P1 | 在线 smoke 已验证 cwd 下 `CLAUDE.md` 自动注入并影响首轮回答 |
| AgentTool / Task | Y | Y | Y | P | Y | P | P1 | 在线 smoke 已验证 `Agent/Task` tool_use、`local_agent` 启停事件与最终 token 回收 |
| MCP 基础连接 | Y | Y | Y | P | Y | Y | P1 | 在线 smoke 已覆盖本地 stdio 资源链路、HTTP + 静态 `Authorization` header 鉴权资源链路，以及 HTTP + `headersHelper` 鉴权资源链路；另有单测覆盖 helper 的 env 透传、JSON 校验和静/动态 header 合并。浏览器特化 MCP 的 workspace package 已从相邻 restored source 回填，`BROWSER_TOOLS` 不再为空；另外已补官方 CRX 下载/解包辅助脚本和 native host `ping/pong` 离线自检，但真实 Chrome 扩展仍未完成在线 smoke |
| WebFetch | Y | Y | Y | P | Y | P | P1 | 在线 smoke 已验证公开静态页抓取与标题抽取；仍不覆盖认证/private URL |
| /doctor | Y | Y | Y | P | Y | Y | P1 | 离线 smoke 已验证交互诊断屏渲染锚点 |
| /resume | Y | Y | Y | P | Y | Y | P1 | 在线 smoke 已验证 `--continue` 与 `--resume <session-id>` 恢复上下文 |
| WebSearch | Y | Y | Y | P | Y | P | P2 | 在线 smoke 已验证 `tool_use -> 结构化 hits`；不对外部搜索排序和最终自由生成回答做固定快照断言 |
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

- 离线 smoke：`bun run smoke`
- Claude in Chrome readiness：`bun run smoke -- --checks chrome-readiness`
- Claude in Chrome runtime smoke：`bun run smoke -- --checks chrome-smoke`
- 在线 smoke：`bun run smoke:online`
- 在线 smoke 也支持只跑部分检查：`bun run smoke -- --online --checks api-basic,claude-md-context,read-tool,write-tool,edit-tool,notebook-edit-tool,grep-tool,glob-tool,agent-flow,webfetch-tool,websearch-tool,mcp-flow,mcp-http-auth-flow,mcp-http-headers-helper-flow,compact-flow,resume-flow`
- GitHub Actions：`.github/workflows/ci.yml` 默认跑离线 smoke；`.github/workflows/online-smoke.yml` 提供手动在线 smoke 入口
- 多步工具 smoke 默认预算上限已提高到 `$0.20`，避免工具已完成但被过低预算误伤
