# dsh-pending-notice-waker

Consume the `pending-notice.json` that a restart/install wrote **before** stopping the host, wake the interrupted DSH session exactly once on the next boot, then archive the notice. No polling, no resident watcher.

This is the other half of [dsh-restart-win](https://github.com/BrainZombie/dsh-restart-win): the engine stops the host, the waker brings the conversation back when it comes up.

## Why it exists

`dsh-restart-win` stops the host to install or restart safely. The agent's turn dies with it. Writing a file before the stop and consuming it after the boot is the only hand-off that survives, because it does not depend on the dead process still existing.

## Notice schema (v2)

Writers (`dsh-restart.ps1`, `dsh-plugin-install.ps1`) put `<DSH_HOME>/.smart-restart/pending-notice.json` in place:

```json
{
  "sessionId": "session-...",
  "reason": "plugin install: dsh-restart-win",
  "when": "2026-11-18T13:40:12.459Z",
  "attempts": 0,
  "extra": {
    "package": "dsh-restart-win",
    "resultPath": "<LOCALAPPDATA>\\dsh-restart\\dsh-plugin-install-20261118-214000.json",
    "logPath": "<LOCALAPPDATA>\\dsh-restart\\dsh-plugin-install-20261118-214000.log"
  }
}
```

`extra` and `attempts` are optional; the older shape still wakes. Writers should write `pending-notice.json.tmp` first and rename it into place — this plugin ignores `.tmp`.

## Directories (all under `<DSH_HOME>/.smart-restart`; nothing is written outside it)

| Path | Purpose |
| --- | --- |
| `pending-notice.json` | write entry point; this plugin only reads it, then renames it away immediately |
| `pending-notice.json.tmp` | in-progress write by an external writer; ignored |
| `inbox/` | claimed, in-flight notices (`n-<ISO>-<rand8>.json`); on failure they stay here for the next boot |
| `archive/` | terminal archive `<original name>.<reason>-<ISO>.json`, newest 50 kept |
| `throttle.json` | `{ "<sessionId>": ["<ISO>", ...] }`, per-session wake throttle |
| `waker.log` | append-only log, `[ISO] line` format |

## Order of operations

1. No `pending-notice.json` → return without writing a log line.
2. Rename into `inbox/` before processing, so an in-flight notice can never be overwritten.
3. Unparsable JSON → log it and leave the file in `inbox/` as evidence (never archived, never deleted).
4. Empty `sessionId` → archive `no-session-id`.
5. `when` older than `maxAgeHours` (default 24) → archive `stale`.
6. Same session already woken twice within 60 minutes → archive `throttled`.
7. `agents.get(sessionId)` empty → `agents.resume({ resumeSessionId })`. A `not found` error (case-insensitive) archives `dropped` with no retry.
8. Any other resume/followup failure → `attempts + 1` written atomically back into the `inbox/` copy; at 3 it archives `failed-attempts`.
9. Success → `agent.followup(...)` → archive `done`, and record the wake time in `throttle.json`.

Every error is confined to `waker.log`; nothing bubbles into the host, and a failing log write never blocks a wake.

## Preset restore (the part that is easy to get wrong)

`agents.resume({ resumeSessionId })` alone restores the conversation **without** the agent preset, so the official tool groups (`tool-fs`, `tool-pwsh`, `tool-jobs`, …) are never composed in and the woken session runs with only third-party plugin tools. Measured on a real host: 39 tools missing, and a `pwsh` call answered `unknown tool "pwsh"`.

This plugin therefore reads the persisted header and mounts the preset through the documented `setup` hook — the same mechanism `dsh-api-session-controller`, `dsh-acp` and `dsh-subagent` use:

```js
const persisted = await ctx.sessionPersistence.stat(sessionId);
const preset = persisted?.header?.agentPreset;
await ctx.agents.resume({
  resumeSessionId: sessionId,
  ...preset === undefined ? {} : {
    setup: async (agentCtx) => { await ctx.agentPresets.mount(agentCtx, preset); }
  }
});
```

A failed preset mount is logged and never blocks the wake.

Note that `agents.get(sessionId)` short-circuits the whole path: if the session is still live (for example the GUI opened it first), no resume happens and the preset is intact. That is why the symptom looks intermittent — it only appears when this plugin is the one that revives a dead session.

## Wake message

The `prompt` template supports `{reason}` and `{resultPath}`. When `extra.resultPath` is non-empty, one extra line is appended:

```
安装结果：<resultPath>（先读它再决定下一步）
```

## Config

| Key | Default | Meaning |
| --- | --- | --- |
| `enabled` | `true` | `false` logs one `disabled by config` line and touches nothing |
| `delaySec` | `6` | seconds after host start to run once (no polling) |
| `maxAgeHours` | `24` | notices older than this are archived, not delivered (min 1) |
| `prompt` | built-in | wake message template, supports `{reason}` / `{resultPath}` |

## Install

```powershell
pwsh -File <repo>\scripts\dsh-plugin-install.ps1 -Spec link:<path-to-this-repo> -Confirm -Bundle
```

or add the package to the profile and mount it as a bundle (`cordis.patch.yml` ships the insert).

## Test

```bash
node --check lib/index.js
node test/smoke.mjs            # 9 scenarios, each with its own temporary DSH_HOME
node test/smoke.mjs --only E,F # rerun selected scenarios
node test/smoke.mjs --keep-all # keep every temporary DSH_HOME, not just failing ones
```

The suite never touches a real `DSH_HOME`: it creates throwaway directories under the OS temp dir and fingerprints the real `.smart-restart` before and after to prove nothing leaked. Two extra checks: `node --check`, and a PowerShell `Parser::ParseFile` pass over `dsh-plugin-install.ps1` when that script is reachable through `INSTALLER_PS1` (skipped otherwise).

Requires Node >= 20, ESM.
