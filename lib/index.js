/**
 * dsh-pending-notice-waker
 *
 * 重启引擎 / 安装脚本在停机前把 <DSH_HOME>\.smart-restart\pending-notice.json 写好，
 * 本插件在宿主启动后消费它：把被中断的会话唤醒一次，然后把通知归档。
 *
 * 目录约定（都相对于 <DSH_HOME>\.smart-restart，本插件不在这之外写任何文件）：
 *   pending-notice.json       写入口（外部写；本插件只读，读到后立刻搬走）
 *   pending-notice.json.tmp   外部写入中的临时文件（本插件忽略）
 *   inbox/                    已认领、处理中的通知；失败时留在这里，下次启动重试
 *   archive/                  终态归档 <原文件名>.<reason>-<ISO>.json，只保留最近 50 份
 *   throttle.json             { sessionId: [ISO, ...] }，同一会话限流用
 *   waker.log                 追加日志，保持 [ISO] 行格式
 *
 * 行为约束（都是刻意的）：
 *   - 宿主启动后 delaySec 秒跑一次，不轮询、不常驻监听；
 *   - 读到通知先 rename 进 inbox/ 再处理：处理中的文件不会被新通知覆盖；
 *   - 会话不存在（resume 报 not found）直接归档，不再重试；
 *   - 其它 resume/followup 失败累加 attempts，满 3 次归档 failed-attempts；
 *   - 同一会话 60 分钟内已有 2 次唤醒就不再唤醒，归档 throttled；
 *   - 通知超过 maxAgeHours 视为过期，只归档不唤醒；
 *   - 任何异常只写 waker.log，绝不向宿主冒泡（一个唤醒插件不值得让宿主起不来）。
 */
import { readFile, rename, mkdir, appendFile, writeFile, readdir, stat, unlink } from "node:fs/promises";
import { homedir } from "node:os";
import { join, basename } from "node:path";
import { randomUUID } from "node:crypto";

const name = "dsh-pending-notice-waker";
const inject = ["agents", "sessionPersistence", "agentPresets"];

const DEFAULT_PROMPT =
  "[dsh-restart] 宿主重启完成，继续被中断的工作。中断原因：{reason}\n" +
  "先确认上一次安装/升级的结果，再决定下一步；没有把握就如实说明卡在哪。";

const THROTTLE_WINDOW_MS = 60 * 60 * 1000;
const THROTTLE_MAX_WAKES = 2;
const MAX_ATTEMPTS = 3;
const ARCHIVE_KEEP = 50;
const LOCK_STALE_MS = 5 * 60 * 1000;

function dshHome() {
  const fromEnv = process.env.DSH_HOME;
  if (typeof fromEnv === "string" && fromEnv.trim() !== "") return fromEnv.trim();
  return join(homedir(), ".dsh");
}

function stateDir() {
  return join(dshHome(), ".smart-restart");
}

function noticePath() {
  return join(stateDir(), "pending-notice.json");
}

function inboxDir() {
  return join(stateDir(), "inbox");
}

function archiveDir() {
  return join(stateDir(), "archive");
}

function throttlePath() {
  return join(stateDir(), "throttle.json");
}

function logPath() {
  return join(stateDir(), "waker.log");
}

function lockPath() {
  return join(stateDir(), "waker.lock");
}

function nowIso() {
  return new Date().toISOString();
}

/** 用于文件名的时间戳：Windows 文件名不允许冒号。 */
function fileStamp(iso = nowIso()) {
  return iso.replace(/:/g, "-");
}

function shortId() {
  return randomUUID().replace(/-/g, "").slice(0, 8);
}

function messageOf(error) {
  return error instanceof Error ? error.message : String(error);
}

function logQuote(value) {
  return typeof value === "string" && value.trim() !== "" ? value.trim() : "";
}

async function log(line) {
  try {
    await mkdir(stateDir(), { recursive: true });
    await appendFile(logPath(), `[${nowIso()}] ${line}\n`, "utf8");
  } catch {
    // 日志写不进去也不影响主流程
  }
}

/**
 * 认领写入口：读 -> rename 到 inbox/ -> 以搬走的那份内容为准。
 * rename 是原子的，因此并发实例里只有一个能成功搬走；另一个看到 ENOENT，直接让路。
 * 先读再搬、搬完重读，避免「读到旧内容、却搬走新文件」时用错内容处理。
 */
async function claimNotice() {
  const source = noticePath();
  let raw;
  try {
    raw = await readFile(source, "utf8");
  } catch (error) {
    if (error?.code === "ENOENT") return null; // 没有通知：常态，不写日志
    await log(`notice read failed: ${messageOf(error)}`);
    return null;
  }

  const dir = inboxDir();
  try {
    await mkdir(dir, { recursive: true });
  } catch (error) {
    await log(`inbox mkdir failed: ${messageOf(error)}`);
    return null;
  }

  let file = "";
  for (let attempt = 0; attempt < 3; attempt += 1) {
    const candidate = join(dir, `n-${fileStamp()}-${shortId()}.json`);
    try {
      await rename(source, candidate);
      file = candidate;
      break;
    } catch (error) {
      if (error?.code === "ENOENT") return null; // 被另一个实例搬走了
      if (attempt === 2) {
        await log(`notice claim failed: ${messageOf(error)}`);
        return null;
      }
    }
  }
  if (file === "") return null;

  let content = raw;
  try {
    content = await readFile(file, "utf8");
  } catch {
    // 搬完读不回来（极少见）：退回搬之前读到的内容
  }
  return { file, raw: content };
}

async function listInbox() {
  const dir = inboxDir();
  try {
    const entries = await readdir(dir, { withFileTypes: true });
    return entries
      .filter((entry) => entry.isFile() && entry.name.endsWith(".json"))
      .map((entry) => join(dir, entry.name))
      .sort();
  } catch (error) {
    if (error?.code !== "ENOENT") await log(`inbox list failed: ${messageOf(error)}`);
    return [];
  }
}

/** 没有待办时连目录都不创建：空 DSH_HOME 跑一遍应当什么都不留下。 */
async function hasWork() {
  try {
    await stat(noticePath());
    return true;
  } catch {
    // 写入口不存在，继续看 inbox 里上次没处理完的
  }
  try {
    const entries = await readdir(inboxDir());
    return entries.some((entry) => entry.endsWith(".json"));
  } catch {
    return false;
  }
}

/**
 * 跨进程粗粒度锁：inbox 重放与认领必须串行，否则并发实例会把对方刚搬进 inbox 的
 * 通知再处理一遍。锁文件是残留（进程崩溃）时按 mtime 判过期。
 */
async function acquireLock(retried = false) {
  const file = lockPath();
  try {
    await mkdir(stateDir(), { recursive: true });
    await writeFile(file, `${nowIso()} pid=${process.pid}`, { encoding: "utf8", flag: "wx" });
    return {
      file,
      release: async () => {
        try {
          await unlink(file);
        } catch {
          // 已经不在就算了
        }
      },
    };
  } catch (error) {
    if (error?.code !== "EEXIST") {
      await log(`lock acquire failed: ${messageOf(error)}`);
      return null;
    }
  }

  if (!retried) {
    try {
      const info = await stat(file);
      if (Date.now() - info.mtimeMs > LOCK_STALE_MS) {
        await unlink(file);
        return acquireLock(true);
      }
    } catch {
      // 锁刚好被释放：再试一次
      return acquireLock(true);
    }
  }
  return null;
}

async function readThrottle() {
  let raw;
  try {
    raw = await readFile(throttlePath(), "utf8");
  } catch (error) {
    if (error?.code !== "ENOENT") await log(`throttle read failed: ${messageOf(error)}`);
    return {};
  }
  try {
    const parsed = JSON.parse(raw);
    if (parsed !== null && typeof parsed === "object" && !Array.isArray(parsed)) return parsed;
    await log("throttle.json is not an object, ignoring it");
    return {};
  } catch (error) {
    await log(`throttle.json unparsable, ignoring it: ${messageOf(error)}`);
    return {};
  }
}

function parseStamp(value) {
  if (typeof value === "number" && Number.isFinite(value)) return value;
  if (typeof value === "string") {
    const at = Date.parse(value);
    return Number.isFinite(at) ? at : NaN;
  }
  return NaN;
}

function recentWakes(throttle, sessionId, now) {
  const list = Array.isArray(throttle?.[sessionId]) ? throttle[sessionId] : [];
  const recent = [];
  for (const value of list) {
    const at = parseStamp(value);
    if (!Number.isFinite(at)) continue;
    if (at > now + 60_000) continue; // 时钟跑快的记录不当成有效限流依据
    if (now - at > THROTTLE_WINDOW_MS) continue;
    recent.push(at);
  }
  return recent;
}

async function writeJsonAtomic(target, value) {
  const temp = `${target}.tmp`;
  await writeFile(temp, JSON.stringify(value), "utf8");
  await rename(temp, target);
}

async function recordWake(sessionId) {
  const now = Date.now();
  const throttle = await readThrottle();
  const next = {};
  for (const [id, value] of Object.entries(throttle)) {
    if (id === sessionId || !Array.isArray(value)) continue;
    const kept = [];
    for (const entry of value) {
      const at = parseStamp(entry);
      if (!Number.isFinite(at)) continue;
      if (at > now + 60_000 || now - at > THROTTLE_WINDOW_MS) continue;
      kept.push(new Date(at).toISOString());
    }
    if (kept.length > 0) next[id] = kept.slice(-5);
  }
  const recent = recentWakes(throttle, sessionId, now).map((at) => new Date(at).toISOString());
  next[sessionId] = [...recent, new Date(now).toISOString()].slice(-5);
  try {
    await writeJsonAtomic(throttlePath(), next);
  } catch (error) {
    await log(`throttle write failed: ${messageOf(error)}`);
  }
}

async function pruneArchive() {
  const dir = archiveDir();
  try {
    const entries = await readdir(dir, { withFileTypes: true });
    const files = [];
    for (const entry of entries) {
      if (!entry.isFile()) continue;
      const file = join(dir, entry.name);
      try {
        const info = await stat(file);
        files.push({ file, mtimeMs: info.mtimeMs });
      } catch {
        // 刚被删掉/改名：忽略
      }
    }
    if (files.length <= ARCHIVE_KEEP) return;
    files.sort((left, right) => right.mtimeMs - left.mtimeMs);
    let removed = 0;
    for (const entry of files.slice(ARCHIVE_KEEP)) {
      try {
        await unlink(entry.file);
        removed += 1;
      } catch {
        // 删不掉就留着，下一次归档再清
      }
    }
    if (removed > 0) await log(`archive pruned: kept ${ARCHIVE_KEEP}, removed ${removed}`);
  } catch (error) {
    if (error?.code !== "ENOENT") await log(`archive prune failed: ${messageOf(error)}`);
  }
}

/** 终态归档：<原文件名>.<reason>-<ISO>.json，落在 archive/ 下。 */
async function archive(file, reason) {
  const dir = archiveDir();
  const base = basename(file);
  const stamp = fileStamp();
  try {
    await mkdir(dir, { recursive: true });
  } catch (error) {
    await log(`archive mkdir failed (${reason}): ${messageOf(error)}`);
    return false;
  }

  let target = join(dir, `${base}.${reason}-${stamp}.json`);
  try {
    await stat(target);
    target = join(dir, `${base}.${reason}-${stamp}-${shortId()}.json`);
  } catch {
    // 目标不存在，用默认名
  }

  try {
    await rename(file, target);
    await log(`archived (${reason}) -> ${target}`);
  } catch (error) {
    await log(`archive failed (${reason}): ${messageOf(error)}`);
    return false;
  }

  await pruneArchive();
  return true;
}

function userMessage(text) {
  return {
    id: randomUUID(),
    role: "user",
    content: [{ type: "text", text }],
    source: { kind: "user" },
  };
}

function buildPrompt(notice, options) {
  const reason = typeof notice?.reason === "string" && notice.reason.trim() !== "" ? notice.reason : "未知";
  const extra = notice?.extra !== null && typeof notice?.extra === "object" ? notice.extra : {};
  const resultPath = logQuote(extra.resultPath);
  let text = options.prompt.replaceAll("{reason}", reason).replaceAll("{resultPath}", resultPath);
  if (resultPath !== "") {
    text += `\n安装结果：${resultPath}（先读它再决定下一步）`;
  }
  return text;
}

/**
 * 非终态失败：attempts + 1 原子写回 inbox 那份，留待下次启动重试；
 * 满 3 次归档 failed-attempts。
 */
async function failAttempt(claimed, notice, sessionId, detail) {
  const base = notice !== null && typeof notice === "object" && !Array.isArray(notice) ? notice : {};
  const attempts = Math.max(0, Math.trunc(Number(base.attempts) || 0)) + 1;
  const updated = { ...base, sessionId, attempts };

  let persisted = false;
  try {
    await writeJsonAtomic(claimed.file, updated);
    persisted = true;
  } catch (error) {
    await log(`attempts write-back failed (${basename(claimed.file)}): ${messageOf(error)}`);
  }

  await log(
    `wake failed: session=${sessionId} attempts=${attempts}${persisted ? "" : " (attempts not persisted)"} ${detail}`,
  );

  if (attempts >= MAX_ATTEMPTS) {
    await log(`attempts reached ${attempts}, archiving failed-attempts: session=${sessionId}`);
    await archive(claimed.file, "failed-attempts");
  }
}

async function processNotice(ctx, options, claimed) {
  let notice;
  try {
    notice = JSON.parse(claimed.raw);
  } catch (error) {
    // 留在 inbox 里当证据，不删也不归档
    await log(`notice unparsable, kept in inbox (${basename(claimed.file)}): ${messageOf(error)}`);
    return;
  }

  const sessionId = typeof notice?.sessionId === "string" ? notice.sessionId.trim() : "";
  if (sessionId === "") {
    await log(`notice has no session id, archiving no-session-id (${basename(claimed.file)})`);
    await archive(claimed.file, "no-session-id");
    return;
  }

  const when = Date.parse(typeof notice?.when === "string" ? notice.when : "");
  if (Number.isFinite(when)) {
    const ageHours = (Date.now() - when) / 3_600_000;
    if (ageHours > options.maxAgeHours) {
      await log(
        `notice too old (${ageHours.toFixed(1)}h > ${options.maxAgeHours}h), archiving stale: session=${sessionId}`,
      );
      await archive(claimed.file, "stale");
      return;
    }
  } else {
    await log(`notice has no parsable when, treating as fresh: session=${sessionId}`);
  }

  const now = Date.now();
  const throttle = await readThrottle();
  const recent = recentWakes(throttle, sessionId, now);
  if (recent.length >= THROTTLE_MAX_WAKES) {
    await log(
      `throttled: session=${sessionId} already ${recent.length} wakes within 60m, archiving throttled`,
    );
    await archive(claimed.file, "throttled");
    return;
  }

  let agent = null;
  try {
    agent = await ctx.agents.get(sessionId);
  } catch (error) {
    await log(`agents.get failed: session=${sessionId} ${messageOf(error)}`);
    agent = null;
  }
  agent = agent ?? null;

  if (agent === null) {
    try {
      // 唤醒必须把 header.agentPreset 挂回去：不挂的话，官方工具组（tool-fs / tool-pwsh / tool-jobs…）
      // 整批不会按预设组合进来，恢复出来的会话只剩第三方插件工具（实测少 39 个工具，pwsh 直接 unknown）。
      let resumePreset;
      try {
        const persisted = await ctx.sessionPersistence.stat(sessionId);
        const raw = persisted?.header?.agentPreset;
        resumePreset = typeof raw === "string" && raw.trim() !== "" ? raw.trim() : void 0;
      } catch (error) {
        await log(`preset lookup failed: session=${sessionId} ${messageOf(error)}`);
        resumePreset = void 0;
      }
      const handle = await ctx.agents.resume({
        resumeSessionId: sessionId,
        ...resumePreset === void 0 ? {} : {
          setup: async (agentCtx) => {
            try {
              await ctx.agentPresets.mount(agentCtx, resumePreset);
            } catch (error) {
              await log(`preset mount failed: session=${sessionId} preset=${resumePreset} ${messageOf(error)}`);
            }
          }
        }
      });
      agent = handle?.agent ?? (typeof handle?.followup === "function" ? handle : null);
      if (agent !== null) await log(`resumed session ${sessionId}`);
    } catch (error) {
      const detail = messageOf(error);
      if (/not\s*found/i.test(detail)) {
        await log(`session not found, archiving dropped: session=${sessionId} ${detail}`);
        await archive(claimed.file, "dropped");
        return;
      }
      await failAttempt(claimed, notice, sessionId, `resume failed: ${detail}`);
      return;
    }
  }

  if (agent === null) {
    await failAttempt(claimed, notice, sessionId, "resume returned no agent");
    return;
  }

  const text = buildPrompt(notice, options);
  try {
    await agent.followup(userMessage(text));
  } catch (error) {
    await failAttempt(claimed, notice, sessionId, `followup failed: ${messageOf(error)}`);
    return;
  }

  const archived = await archive(claimed.file, "done");
  await recordWake(sessionId);
  await log(`woke session ${sessionId}${archived ? "" : " (archive failed, notice left in inbox)"}`);
}

async function wakeOnce(ctx, options) {
  if (!(await hasWork())) return; // 没有通知：常态，什么都不写

  const lock = await acquireLock();
  if (lock === null) {
    await log("skip: another waker instance is handling the notice");
    return;
  }

  try {
    const claimed = await claimNotice();
    const pending = await listInbox();

    // 先重放上次失败留在 inbox 里的（attempts 机制的落脚点）
    for (const file of pending) {
      if (claimed !== null && file === claimed.file) continue;
      try {
        const raw = await readFile(file, "utf8");
        await processNotice(ctx, options, { file, raw });
      } catch (error) {
        await log(`inbox retry failed (${basename(file)}): ${messageOf(error)}`);
      }
    }

    if (claimed !== null) {
      try {
        await processNotice(ctx, options, claimed);
      } catch (error) {
        await log(`notice handling crashed (${basename(claimed.file)}): ${messageOf(error)}`);
      }
    }
  } finally {
    await lock.release();
  }
}

function normalizeOptions(config) {
  const raw = config !== null && typeof config === "object" ? config : {};
  return {
    delaySec: Number.isFinite(Number(raw.delaySec)) ? Math.max(0, Number(raw.delaySec)) : 6,
    maxAgeHours: Number.isFinite(Number(raw.maxAgeHours)) ? Math.max(1, Number(raw.maxAgeHours)) : 24,
    prompt: typeof raw.prompt === "string" && raw.prompt.trim() !== "" ? raw.prompt : DEFAULT_PROMPT,
    enabled: raw.enabled !== false,
  };
}

function apply(ctx, config) {
  try {
    const options = normalizeOptions(config);

    if (!options.enabled) {
      void log("disabled by config");
      return;
    }

    const timer = setTimeout(() => {
      void wakeOnce(ctx, options).catch((error) => {
        void log(`wake crashed: ${messageOf(error)}`);
      });
    }, options.delaySec * 1000);
    if (typeof timer?.unref === "function") timer.unref();

    try {
      ctx.effect(() => () => clearTimeout(timer));
    } catch (error) {
      void log(`effect registration failed: ${messageOf(error)}`);
    }
  } catch (error) {
    void log(`apply failed: ${messageOf(error)}`);
  }
}

export { apply, inject, name };
