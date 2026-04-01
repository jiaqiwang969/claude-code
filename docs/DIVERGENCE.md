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
| Unverified | Claude in Chrome runtime parity | `packages/@ant/claude-for-chrome-mcp/src/*.ts`, `src/utils/claudeInChrome/packageBoundary.ts`, `src/utils/claudeInChrome/setup.ts`, `src/utils/claudeInChrome/setupPortable.ts`, `src/utils/claudeInChrome/officialExtension.ts`, `src/services/mcp/client.ts`, `scripts/install-claude-in-chrome-host.ts`, `scripts/claude-in-chrome-check.ts`, `scripts/claude-in-chrome-smoke.ts`, `scripts/open-claude-in-chrome-extension.ts`, `scripts/download-claude-in-chrome-extension.ts`, `scripts/launch-claude-in-chrome-unpacked.ts`, `scripts/claude-in-chrome-ping-host.ts` | workspace package 已从相邻 restored source 回填，源码层不再是 stub；fork 还补了 native host 安装/诊断/最小 smoke 链路，并修正了源码模式下 wrapper 误指向不存在 `cli.js` 的问题。后续又补了 Opera root-layout 扩展探测、manifest target 可执行性校验、一键打开扩展安装页脚本、live socket 诊断、官方 CRX 下载/解包辅助路径，以及 native host `ping/pong` 自检。当前本机验证表明 wrapper + host ping/pong 已通，官方 CRX 也能稳定解包并直启 Chrome，但 live socket 仍未稳定出现，因此浏览器运行时 parity 仍待最终验证 | 下一步优先看 `docs/CLAUDE_IN_CHROME_RESTORATION.md`，把真实浏览器登录/sidepanel/onboarding 状态纳入验证，而不是再把问题误判成 package stub 或 native host 缺失 |
| Restoration gap | 模板分类器 | `src/jobs/classifier.ts` | 当前为 stub，且只在 `TEMPLATES` 路径上加载 | 维持 dormant，除非要恢复模板工作流 |
| Restoration gap | CLI 兼容类型层 | `src/cli/src/tools.ts` | 当前仅保留 type stub | 先不把它当主战场，除非热路径开始穿透这里 |
| Restoration gap | query 子模块占位 | `src/query/transitions.ts` | 当前为 stub | 若未来 query 主循环触达这里，再回到 bundle 查证 |
| Intentional repair | `query.ts` 的数组和类型守卫 | `src/query.ts` 对比 `../restored-src/src/query.ts` | 增加了 `Array.isArray`、类型收窄和安全 cast | 这是可接受修补，应保留 |
| Intentional repair | `QueryEngine.ts` 的消息类型收窄 | `src/QueryEngine.ts` 对比 `../restored-src/src/QueryEngine.ts` | 增加 compact boundary 和 assistant message 的显式类型处理 | 这是可接受修补，应保留 |
| Intentional repair | `services/mcp/client.ts` 的 stdio server type narrowing | `src/services/mcp/client.ts` 对比 `../restored-src/src/services/mcp/client.ts` | 通过显式类型收窄减少误推断 | 这是可接受修补，应保留 |
| Intentional repair | ripgrep 缺失时回退 system `rg` | `src/utils/ripgrep.ts` | 当 bundled `dist/vendor/ripgrep/.../rg` 不存在时，自动退回系统 `rg` | 当前外部构建更稳，建议保留，直到 vendor 资产恢复或打包策略统一 |
| Fork enhancement | smoke 回归与 CI 入口 | `scripts/smoke-test.ts`, `.github/workflows/ci.yml`, `.github/workflows/online-smoke.yml`, `src/services/mcp/__tests__/headersHelper.test.ts` | 当前 fork 增加了离线 smoke、手动在线 smoke 和 `headersHelper` 单测，属于仓库治理增强，不是原 bundle 自带能力 | 建议保留，作为后续完成度判断的基线设施 |
| Unverified | feature-flag / ant-only 能力的真实可恢复性 | `src/tools.ts`, `src/commands.ts`, `docs/internals/feature-flags.mdx` | 代码面存在大量 dormant surface，但没有统一恢复策略 | 先当 dormant，不要当成默认缺失功能 |

## 更新流程

1. 先确认差异属于哪一类。
2. 再补证据路径。
3. 如果是 `Fork enhancement`，必须说明为什么要保留。
4. 如果是 `Restoration gap`，必须说明它是否阻塞 P0/P1。
5. 如果只是类型或稳定性修补，归到 `Intentional repair`，不要误报为“偏离原版”。
