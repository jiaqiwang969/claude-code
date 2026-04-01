# Claude in Chrome Restoration Map

> 目标：把 `@ant/claude-for-chrome-mcp` 这条缺口拆成可执行的恢复面，避免后续只知道“这里是 stub”，却不知道最小落地范围是什么。

## 当前结论

- 当前 workspace package 已从相邻 restored source 回填，不再是单文件 stub。
- 现在的边界变成：
  - package 源码已恢复
  - setup 层会基于 `BROWSER_TOOLS` 是否非空判断是否暴露能力
  - client 层仍保留 in-process server 形状校验，防止未来又退化成空对象
- 本机环境已推进到“host 已安装、扩展未安装”：
- `scripts/install-claude-in-chrome-host.ts` 已把 wrapper 和 Native Messaging manifest 安装到本机
- `detectExtensionInstallationPortable()` 仍确认未发现 Claude Chrome 扩展
- readiness 诊断现在还会校验 manifest 指向的 wrapper 是否真实存在且可执行，避免“manifest 在，但目标已经坏掉”的假阳性
- Opera 这种把 `Extensions/` 直接放在浏览器根目录的布局也已经纳入扩展探测

## 本机运行边界

当前这台机器的剩余阻塞不是源码，而是扩展侧环境：

- `/Applications/Google Chrome.app` 存在
- Chrome profile 目录存在，项目内检测也能扫到 `Default` / `Profile 1`
- `~/.claude/chrome/chrome-native-host` 已生成
- Chrome/Brave/Arc/Edge/Chromium/Vivaldi/Opera 的 Native Messaging manifest 已安装
- 但 Claude in Chrome 生产扩展 `fcoeoabgfenejglbffodgkkbkcdhcgfn` 仍未安装

因此目前状态应定义为：

- source restored
- package boundary verified
- server tool inventory verified
- local runtime blocked only by missing browser extension

## 标准化安装命令

先打开扩展安装页：

```bash
bun run claude-in-chrome:open-extension
```

再安装 native host：

```bash
bun run claude-in-chrome:install-host
```

这个脚本会：

- 生成 `~/.claude/chrome/chrome-native-host` wrapper
- 把 `com.anthropic.claude_code_browser_extension.json` 写到各 Chromium 浏览器的 NativeMessagingHosts 目录
- 自动复用当前可执行 CLI 入口，避免源码模式下误指向不存在的 `src/utils/claudeInChrome/cli.js`

如果不想先走 Chrome Store，也可以走官方 CRX 的实验辅助路径：

```bash
bun run claude-in-chrome:download-extension
bun run claude-in-chrome:launch-unpacked
```

这个路径会：

- 从 Google update service 下载生产扩展 `fcoeoabgfenejglbffodgkkbkcdhcgfn`
- 解包到 `~/.claude/chrome/official-extension/unpacked`
- 校验 `manifest.key` 推导出的扩展 ID 仍然是生产 ID
- 直启一个隔离 Chrome profile，并把 native host manifest 同步到该 profile 的 `NativeMessagingHosts/`

补充一个离线 host 自检：

```bash
bun run claude-in-chrome:ping-host
```

这个脚本会直接按 Chrome native messaging framing 对本地 wrapper 发 `ping`，确认：

- wrapper 能启动 `--chrome-native-host`
- host 能回 `pong`
- host 运行期间确实创建过本地 socket

## 标准化诊断命令

后续不要再靠手工翻目录判断，统一使用：

```bash
bun run claude-in-chrome:check
```

脚本会输出三件事：

- 本机有哪些 Chromium 浏览器数据目录真实存在
- Claude 浏览器扩展是否被项目内检测逻辑识别到
- 各浏览器 Native Messaging manifest 是否已安装
- 当前是否已经出现 live browser bridge socket

脚本返回码语义：

- `0`: 扩展、manifest 与 live socket 都已就绪
- `1`: 仍未就绪，不能做真实 Chrome MCP smoke

注意：

- `claude-in-chrome:check` 目前把“已安装扩展”定义为浏览器 profile 里能被常规探测到的扩展安装，或 live socket 已经起来。
- 如果你使用的是 `claude-in-chrome:launch-unpacked` 这种临时解包运行方式，但扩展还没有把 native socket 保持起来，`check` 仍可能显示 `Extension not found` / `No live socket`。
- 这不代表 native host 坏了，优先再跑一次 `bun run claude-in-chrome:ping-host` 区分 host 侧和浏览器侧。

## 标准化最小 smoke

扩展装好并重启 Chrome 后，直接跑：

```bash
bun run claude-in-chrome:smoke
```

这个脚本会按最小闭环验证：

- 先确认本机已检测到 Claude Chrome 扩展
- 再通过 native socket 调 `tabs_context_mcp`
- 然后调 `tabs_create_mcp`
- 最后再次读取 tab context，确认运行时链路已经打通

## 官方 CRX 实验路径的当前结论

当前这台机器已经得到两条新证据：

- `claude-in-chrome:ping-host` 可稳定通过，说明 wrapper、`--chrome-native-host` 入口和 socket listener 创建链路是通的
- 官方 CRX 可以稳定下载、解包，并且 `manifest.key` 推导出的扩展 ID 仍然是生产 ID

但还没有得到第三条关键证据：

- 浏览器侧没有稳定留下 live socket，因此 `claude-in-chrome:smoke` 仍不能通过

这意味着当前剩余 blocker 已经不是源码缺口，而更像是：

- 浏览器运行时没有进入“保持 native connection”状态
- 需要登录/打开 side panel/完成扩展内部 onboarding
- 或者 Chrome 对临时解包扩展与常规已安装扩展还有额外差异

## 当前仓库对 package 的直接依赖面

代码直接依赖以下导出：

- `BROWSER_TOOLS`
- `createClaudeForChromeMcpServer(context)`
- `ClaudeForChromeContext`
- `Logger`
- `PermissionMode`

当前调用点：

- `src/utils/claudeInChrome/setup.ts`
  - 用 `BROWSER_TOOLS` 生成 `allowedTools`
  - 负责注册 dynamic MCP config 和 system prompt
- `src/skills/bundled/claudeInChrome.ts`
  - 用 `BROWSER_TOOLS` 生成 bundled skill 的 `allowedTools`
- `src/utils/claudeInChrome/mcpServer.ts`
  - 构造 `ClaudeForChromeContext`
  - 调 `createClaudeForChromeMcpServer(context)` 启 stdio MCP server
- `src/services/mcp/client.ts`
  - 在 `claude-in-chrome` server 名下走 in-process MCP 分支

## 仓库里已经写死引用到的工具面

### Prompt / skill 明确引用的最小工具集

这些工具名已经在 prompt 和 skill 文本里被硬引用：

- `tabs_context_mcp`
- `tabs_create_mcp`
- `gif_creator`
- `read_console_messages`
- `javascript_tool`

如果真实 package 连这几个都没有，现有提示词和技能说明就会与运行时不一致。

### UI 渲染层已预留的更完整工具集

`src/utils/claudeInChrome/toolRendering.tsx` 当前预期的 `ChromeToolName` 包括：

- `javascript_tool`
- `read_page`
- `find`
- `form_input`
- `computer`
- `navigate`
- `resize_window`
- `gif_creator`
- `upload_image`
- `get_page_text`
- `tabs_context_mcp`
- `tabs_create_mcp`
- `update_plan`
- `read_console_messages`
- `read_network_requests`
- `shortcuts_list`
- `shortcuts_execute`

这意味着后续若要恢复 package，至少要回答两个问题：

- 真实服务端是否真的暴露这 17 个工具
- 如果只恢复子集，哪些 UI / prompt / skill 文案需要同步降级

## 最小可恢复范围

如果目标是把 Claude in Chrome 从“显式边界”推进到“最小可用”，建议按下面顺序：

1. 先恢复 package 基础导出
   - `BROWSER_TOOLS` 不再为空
   - `createClaudeForChromeMcpServer(context)` 返回可 `connect()` 的 MCP server
2. 再恢复最小工具集
   - `tabs_context_mcp`
   - `tabs_create_mcp`
   - `javascript_tool`
   - `read_console_messages`
3. 最后补扩展体验工具
   - `gif_creator`
   - `read_network_requests`
   - `computer`
   - 其他 UI 渲染层已经预留的工具

原因：

- 前 4 个足以支撑“获取当前 tab -> 新建 tab -> 执行 JS -> 读 console”这条最小浏览器调试闭环
- `gif_creator`、`read_network_requests`、`computer` 更像增强能力，不是最小闭环必需

## 恢复后应该满足的验证标准

- `setupClaudeInChrome()` 返回的 `allowedTools` 非空，且至少包含最小工具集
- `registerClaudeInChromeSkill()` 注册出的 skill 不再是空 `allowedTools`
- `node dist/cli.js --chrome ...` 在满足订阅/账户条件时，不再触发 stub 边界错误
- `connectToServer()` 的 in-process `claude-in-chrome` 分支能完成 `connect()`
- 至少有一条针对 `claude-in-chrome` 的 smoke 或 integration test

## 当前推荐下一跳

不是继续盲加 smoke。

优先顺序应改成：

1. 先运行 `bun run claude-in-chrome:check`
2. 若浏览器扩展未安装，先运行 `bun run claude-in-chrome:open-extension`
3. 若 manifest 缺失，再运行 `bun run claude-in-chrome:install-host`
4. 环境 ready 后，运行 `bun run claude-in-chrome:smoke` 做最小真实 smoke
   - `tabs_context_mcp`
   - `tabs_create_mcp`
5. 在真实 smoke 跑通前，回归测试只负责守住服务端工具面没退化
