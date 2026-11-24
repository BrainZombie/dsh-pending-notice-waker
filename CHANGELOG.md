# 变更记录

## 0.2.0 — 唤醒时恢复 agent preset

2026-11-25。第一次公开发布，同时修掉一个会让被唤醒会话「少一半工具」的缺陷。

### 修复

- **唤醒后挂回 `header.agentPreset`**。此前只做 `agents.resume({ resumeSessionId })`，
  预设不参与组合，官方工具组（`tool-fs` / `tool-pwsh` / `tool-jobs` / `tool-skill` …）整批不挂，
  唤醒出来的会话只剩第三方插件工具。本机实测少 **39 个工具**，调 `pwsh` 直接
  `Error: unknown tool "pwsh"`。
  现在读 `sessionPersistence.stat(sessionId).header.agentPreset`，通过 `agents.resume({ setup })`
  挂回去——与 `dsh-api-session-controller`、`dsh-acp`、`dsh-subagent` 用的是同一个入口。
  挂载失败只写 `waker.log`，不阻断唤醒。
- 症状为什么看起来是间歇的：`agents.get(sessionId)` 命中时（会话还活着，例如 GUI 先打开过）
  根本不走 resume，预设完好；只有「宿主刚起来、GUI 还没打开、waker 抢先 resume」才会降级。

### 其它

- `inject` 增加 `agentPresets`。
- 新增 `test/smoke.mjs`（9 个场景 + `node --check` + PowerShell Parser 解析），
  每个场景独立临时 `DSH_HOME`，并对真实 `.smart-restart` 做前后指纹比对证明零写入。
- 包元数据补齐 `repository` / `homepage` / `bugs` / `keywords` / `author` / `LICENSE`；
  去掉 `private`，可发布。
- README 重写：通知 schema、目录约定、处理顺序、preset 恢复原理、配置项、安装与测试。

## 0.1.0 — 初版

2026-11-18。消费 `pending-notice.json`：宿主启动后延迟 `delaySec` 秒跑一次，把被中断的会话唤醒，
然后归档。限流、过期、失败重试（上限 3）、归档保留 50 份。
