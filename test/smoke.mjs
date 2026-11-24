#!/usr/bin/env node
/**
 * dsh-pending-notice-waker acceptance suite
 *
 * Nine scenarios, each with its own throwaway DSH_HOME. A real .smart-restart is never touched
 * (its fingerprint is compared before and after):
 *   A 活会话：followup 一次，通知归档 *.done-*
 *   B 离线会话：agents.get 返回空、resume 成功，followup 仍被调用
 *   C 过期：when 为 48 小时前 → 归档 stale，不 followup
 *   D 会话不存在：resume 抛 "... not found" → 归档 dropped，且只尝试一次
 *   E 失败上限：resume 抛普通错误三次（三次独立运行共用同一 inbox）→ attempts 1→2→3，
 *     前两次保留在 inbox，第三次归档 failed-attempts
 *   F 并发：处理期间往 pending-notice.json 再写一份 → 两份都被处理，互不覆盖
 *   G prompt：extra.resultPath 非空 → followup 文本里出现该路径
 *   H 限流：throttle.json 预置该 session 两条 5 分钟前时间戳 → 归档 throttled，不 followup
 *   I 归档保留：archive/ 预置 60 个文件 → 处理一条后只剩最新 50 个
 *
 * 另跑：node --check lib/index.js、PowerShell Parser 解析 plugin-install.ps1。
 *
 * 用法：
 *   node test/smoke.mjs                 全部跑一遍，任一 FAIL → exit 1
 *   node test/smoke.mjs --only E,F      只跑指定场景（便于复现）
 *   node test/smoke.mjs --keep-all      保留所有临时 DSH_HOME（默认只保留 FAIL 的）
 *   node test/smoke.mjs --verbose       打印每次运行后的目录清单
 *
 * 复现失败场景：脚本会保留该场景的临时 DSH_HOME 并打印路径；目录里有 pending-notice.json、
 * inbox/、archive/、throttle.json、waker.log，可直接对照断言与日志定位。
 *
 * The suite only writes its own temp directories; it never modifies the implementation under test.
 */

import { mkdtemp, mkdir, writeFile, readFile, readdir, rm, stat, utimes } from "node:fs/promises";
import { existsSync } from "node:fs";
import { tmpdir, homedir } from "node:os";
import { join } from "node:path";
import { pathToFileURL } from "node:url";
import { spawn } from "node:child_process";
import { randomBytes } from "node:crypto";

const WAKER_MODULE = process.env.WAKER_TEST_MODULE && process.env.WAKER_TEST_MODULE.trim() !== ""
  ? process.env.WAKER_TEST_MODULE.trim()
  : "C:\\tools\\dsh-pending-notice-waker\\lib\\index.js";
const INSTALLER_PS1 = process.env.INSTALLER_PS1 && process.env.INSTALLER_PS1.trim() !== ""
  ? process.env.INSTALLER_PS1.trim()
  : join(homedir(), "dsh-restart-win", "scripts", "dsh-plugin-install.ps1");

const ARGS = process.argv.slice(2);
const VERBOSE = ARGS.includes("--verbose");
const KEEP_ALL = ARGS.includes("--keep-all");
const ONLY = (() => {
  const index = ARGS.indexOf("--only");
  if (index < 0) return null;
  const value = ARGS[index + 1];
  if (!value) return null;
  return new Set(value.split(",").map((item) => item.trim().toUpperCase()).filter(Boolean));
})();

/** 真实 DSH_HOME：只读、只用于隔离检查（确认全程没有碰它）。 */
const REAL_DSH_HOME = process.env.DSH_HOME && process.env.DSH_HOME.trim() !== ""
  ? process.env.DSH_HOME.trim()
  : join(homedir(), ".dsh");

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

// ---------------------------------------------------------------- 断言

function makeChecks() {
  const list = [];
  const push = (label, ok, actual = null, expected = undefined) => {
    list.push({ label, ok, actual, expected });
    return ok;
  };
  return {
    list,
    eq(label, actual, expected) {
      return push(label, JSON.stringify(actual) === JSON.stringify(expected), actual, expected);
    },
    ok(label, condition, actual = null) {
      return push(label, Boolean(condition), actual, true);
    },
    note(label, value) {
      list.push({ label, ok: true, actual: value, expected: null, note: true });
    },
  };
}

function renderCheck(check) {
  if (check.note) return `  · ${check.label}: ${check.actual}`;
  if (check.ok) {
    const actual = check.actual === null || check.actual === undefined ? "" : ` [${JSON.stringify(check.actual)}]`;
    return `  ✓ ${check.label}${actual}`;
  }
  return `  ✗ ${check.label}（期望 ${JSON.stringify(check.expected)}，实际 ${JSON.stringify(check.actual)}）`;
}

// ---------------------------------------------------------------- 临时 DSH_HOME 与路径

const stateRoot = (home) => join(home, ".smart-restart");
const noticeFile = (home) => join(stateRoot(home), "pending-notice.json");
const inboxDir = (home) => join(stateRoot(home), "inbox");
const archiveDir = (home) => join(stateRoot(home), "archive");
const throttleFile = (home) => join(stateRoot(home), "throttle.json");
const logFile = (home) => join(stateRoot(home), "waker.log");

async function listFiles(dir) {
  try {
    const entries = await readdir(dir, { withFileTypes: true });
    return entries.filter((entry) => entry.isFile()).map((entry) => entry.name).sort();
  } catch {
    return [];
  }
}

function countArchive(files, reason) {
  return files.filter((name) => name.includes(`.${reason}-`)).length;
}

function isoAgoMs(ms) {
  return new Date(Date.now() - ms).toISOString();
}

function notice(sessionId, overrides = {}) {
  return {
    sessionId,
    reason: "plugin-install",
    when: new Date().toISOString(),
    attempts: 0,
    extra: { package: "dsh-pending-notice-waker", resultPath: "", logPath: "" },
    ...overrides,
  };
}

async function writeNotice(home, payload) {
  await mkdir(stateRoot(home), { recursive: true });
  await writeFile(noticeFile(home), JSON.stringify(payload, null, 2), "utf8");
}

async function readInboxNotices(home) {
  const names = await listFiles(inboxDir(home));
  const items = [];
  for (const name of names) {
    const file = join(inboxDir(home), name);
    try {
      items.push({ name, data: JSON.parse(await readFile(file, "utf8")) });
    } catch (error) {
      items.push({ name, parseError: String(error) });
    }
  }
  return items;
}

async function logTail(home, lines = 16) {
  try {
    const raw = await readFile(logFile(home), "utf8");
    const all = raw.trim() === "" ? [] : raw.trim().split(/\r?\n/);
    return all.slice(-lines).join("\n") || "(empty waker.log)";
  } catch {
    return "(no waker.log)";
  }
}

async function diagnostics(home) {
  const inbox = await listFiles(inboxDir(home));
  const archive = await listFiles(archiveDir(home));
  return [
    `    pending-notice.json: ${existsSync(noticeFile(home)) ? "exists" : "absent"}`,
    `    inbox (${inbox.length}): ${inbox.join(", ") || "-"}`,
    `    archive (${archive.length}): ${archive.slice(0, 10).join(", ")}${archive.length > 10 ? " …" : ""}`,
    `    waker.log tail:\n${(await logTail(home)).split("\n").map((line) => "      " + line).join("\n")}`,
  ].join("\n");
}

// ---------------------------------------------------------------- 目录静止检测

async function treeSnapshot(root) {
  const lines = [];
  async function walk(dir, rel) {
    let entries;
    try {
      entries = await readdir(dir, { withFileTypes: true });
    } catch {
      return;
    }
    entries.sort((left, right) => left.name.localeCompare(right.name));
    for (const entry of entries) {
      const absolute = join(dir, entry.name);
      const relative = rel === "" ? entry.name : `${rel}/${entry.name}`;
      if (entry.isDirectory()) {
        lines.push(`D ${relative}`);
        await walk(absolute, relative);
      } else {
        try {
          const info = await stat(absolute);
          lines.push(`F ${relative} ${info.size} ${Math.round(info.mtimeMs)}`);
        } catch {
          lines.push(`F ${relative} ?`);
        }
      }
    }
  }
  await walk(root, "");
  return lines.join("\n");
}

async function waitFor(predicate, timeoutMs = 7000, intervalMs = 25) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    try {
      const value = await predicate();
      if (value) return value;
    } catch {
      // 谓词在文件正在改名时可能抛：继续轮询
    }
    await sleep(intervalMs);
  }
  return null;
}

async function waitQuiet(home, rec, quietMs = 320, timeoutMs = 7000) {
  const deadline = Date.now() + timeoutMs;
  let previous = null;
  let stableSince = 0;
  while (Date.now() < deadline) {
    const counters = rec ? `${rec.get.length}/${rec.resume.length}/${rec.followup.length}` : "";
    const signature = `${await treeSnapshot(home)}\nrec ${counters}`;
    if (signature === previous) {
      if (Date.now() - stableSince >= quietMs) return true;
    } else {
      previous = signature;
      stableSince = Date.now();
    }
    await sleep(25);
  }
  return false;
}

// ---------------------------------------------------------------- 被测插件加载与 mock ctx

function textOf(message) {
  if (message === null || message === undefined) return "";
  if (typeof message === "string") return message;
  const content = message.content;
  if (typeof content === "string") return content;
  if (Array.isArray(content)) {
    return content
      .map((part) => (typeof part === "string" ? part : part && typeof part.text === "string" ? part.text : ""))
      .join("\n");
  }
  if (typeof message.text === "string") return message.text;
  return "";
}

/**
 * 每个 run 都用一个带随机 query 的 file URL 重新 import，
 * 等价于「宿主重启一次、插件模块重新加载一次」。
 *
 * opts:
 *   online: boolean             agents.get 是否直接给到 agent（默认 true）
 *   resumeError: Error|string   resume 抛错内容
 *   resumeDelayMs: number       resume 延迟（给并发场景制造窗口）
 *   resumeResult: 'agent'|any   resume 返回值（默认 { agent }）
 */
function makeRunner(home) {
  const runs = [];
  async function run(tag, opts = {}) {
    const {
      online = true,
      resumeError = null,
      resumeDelayMs = 0,
      resumeResult = "agent",
    } = opts;

    const url = `${pathToFileURL(WAKER_MODULE).href}?run=${encodeURIComponent(tag)}-${randomBytes(4).toString("hex")}`;
    const module = await import(url);
    const apply = module.apply ?? module.default?.apply;
    if (typeof apply !== "function") throw new Error("被测模块没有导出 apply()");

    const rec = {
      tag,
      get: [],
      resume: [],
      followup: [],
      texts: [],
      effect: 0,
      disposers: [],
      applyError: null,
    };

    const agent = {
      followup(message) {
        rec.followup.push(message);
        rec.texts.push(textOf(message));
        return Promise.resolve();
      },
    };

    const ctx = {
      agents: {
        get(sessionId) {
          rec.get.push(sessionId);
          return online ? agent : undefined;
        },
        async resume(request) {
          rec.resume.push(request);
          if (resumeDelayMs > 0) await sleep(resumeDelayMs);
          if (resumeError) {
            throw resumeError instanceof Error ? resumeError : new Error(String(resumeError));
          }
          if (resumeResult === "agent") return { agent, sessionId: request?.resumeSessionId ?? null };
          return resumeResult;
        },
      },
      effect(fn) {
        rec.effect += 1;
        try {
          const disposer = fn();
          if (typeof disposer === "function") rec.disposers.push(disposer);
        } catch (error) {
          rec.applyError = String(error);
        }
      },
    };

    // 关键：先让 DSH_HOME 指向临时目录，再加载模块 / apply；
    // timer 回调可能在 apply 返回之后才跑，所以 DSH_HOME 要一直保持到本轮静止。
    process.env.DSH_HOME = home;
    try {
      await apply(ctx, { delaySec: 0, maxAgeHours: 24 });
    } catch (error) {
      rec.applyError = String(error);
    }
    runs.push(rec);
    return rec;
  }
  return { run, runs };
}

// ---------------------------------------------------------------- 场景

async function caseA({ home, check }) {
  const runner = makeRunner(home);
  const payload = notice("sess-A", { reason: "install: dsh-pending-notice-waker" });
  await writeNotice(home, payload);

  const rec = await runner.run("A1", { online: true });
  await waitFor(async () => countArchive(await listFiles(archiveDir(home)), "done") >= 1);
  await waitQuiet(home, rec);

  const archived = await listFiles(archiveDir(home));
  const inbox = await listFiles(inboxDir(home));
  check.eq("archive 里 .done- 文件数", countArchive(archived, "done"), 1);
  check.eq("followup 调用次数", rec.followup.length, 1);
  check.eq("agents.get 调用次数", rec.get.length, 1);
  check.eq("resume 调用次数（在线会话不该 resume）", rec.resume.length, 0);
  check.eq("inbox 剩余文件数", inbox.length, 0);
  check.ok("pending-notice.json 已被搬走", !existsSync(noticeFile(home)));
  check.ok("followup 文本包含 reason", (rec.texts[0] || "").includes("install: dsh-pending-notice-waker"), (rec.texts[0] || "").slice(0, 160));
  check.ok("waker.log 已创建", existsSync(logFile(home)));
}

async function caseB({ home, check }) {
  const runner = makeRunner(home);
  await writeNotice(home, notice("sess-B", { reason: "offline-resume" }));

  const rec = await runner.run("B1", { online: false });
  await waitFor(async () => countArchive(await listFiles(archiveDir(home)), "done") >= 1);
  await waitQuiet(home, rec);

  const archived = await listFiles(archiveDir(home));
  check.eq("archive 里 .done- 文件数", countArchive(archived, "done"), 1);
  check.eq("agents.get 调用次数", rec.get.length, 1);
  check.eq("resume 调用次数", rec.resume.length, 1);
  check.eq("resume 参数 resumeSessionId", rec.resume[0]?.resumeSessionId ?? null, "sess-B");
  check.eq("followup 调用次数", rec.followup.length, 1);
  check.eq("inbox 剩余文件数", (await listFiles(inboxDir(home))).length, 0);
  check.ok("pending-notice.json 已被搬走", !existsSync(noticeFile(home)));
}

async function caseC({ home, check }) {
  const runner = makeRunner(home);
  await writeNotice(home, notice("sess-C", { when: isoAgoMs(48 * 3600_000), reason: "stale-check" }));

  const rec = await runner.run("C1", { online: true });
  await waitFor(async () => countArchive(await listFiles(archiveDir(home)), "stale") >= 1);
  await waitQuiet(home, rec);

  const archived = await listFiles(archiveDir(home));
  check.eq("archive 里 .stale- 文件数", countArchive(archived, "stale"), 1);
  check.eq("archive 里 .done- 文件数", countArchive(archived, "done"), 0);
  check.eq("followup 调用次数", rec.followup.length, 0);
  check.eq("agents.get 调用次数", rec.get.length, 0);
  check.eq("resume 调用次数", rec.resume.length, 0);
  check.eq("inbox 剩余文件数", (await listFiles(inboxDir(home))).length, 0);
  check.ok("pending-notice.json 已被搬走", !existsSync(noticeFile(home)));
}

async function caseD({ home, check }) {
  const runner = makeRunner(home);
  await writeNotice(home, notice("sess-D", { reason: "ghost-session" }));

  const rec = await runner.run("D1", {
    online: false,
    resumeError: new Error("session sess-D not found"),
  });
  await waitFor(async () => countArchive(await listFiles(archiveDir(home)), "dropped") >= 1);
  await waitQuiet(home, rec);

  let archived = await listFiles(archiveDir(home));
  check.eq("archive 里 .dropped- 文件数", countArchive(archived, "dropped"), 1);
  check.eq("第一轮 resume 调用次数", rec.resume.length, 1);
  check.eq("followup 调用次数", rec.followup.length, 0);
  check.eq("inbox 剩余文件数", (await listFiles(inboxDir(home))).length, 0);
  check.eq("failed-attempts 归档数（not found 不该走重试）", countArchive(archived, "failed-attempts"), 0);

  // 第二轮：确认不会因为 inbox 重放而再次尝试
  const runner2 = makeRunner(home);
  const rec2 = await runner2.run("D2", { online: false, resumeError: new Error("session sess-D not found") });
  await waitQuiet(home, rec2);
  archived = await listFiles(archiveDir(home));
  check.eq("第二轮 resume 调用次数", rec2.resume.length, 0);
  check.eq("第二轮后 .dropped- 文件数仍为", countArchive(archived, "dropped"), 1);
}

async function caseE({ home, check }) {
  const runner = makeRunner(home);
  await writeNotice(home, notice("sess-E", { reason: "transient-failure" }));
  const resumeError = new Error("ECONNRESET: temporary failure while resuming");

  async function attemptsInInbox() {
    const items = await readInboxNotices(home);
    if (items.length !== 1) return { count: items.length, attempts: null };
    return { count: 1, attempts: items[0]?.data?.attempts ?? null };
  }

  // 第一次运行：attempts 1，留 inbox
  const rec1 = await runner.run("E1", { online: false, resumeError });
  const seen1 = await waitFor(async () => {
    const state = await attemptsInInbox();
    return state.count === 1 && state.attempts === 1 ? state : null;
  });
  await waitQuiet(home, rec1);
  check.ok("第一轮后 inbox 有且仅有 1 份通知", (await attemptsInInbox()).count === 1, JSON.stringify(await attemptsInInbox()));
  check.eq("第一轮后 attempts", seen1?.attempts ?? null, 1);
  check.eq("第一轮 followup 调用次数", rec1.followup.length, 0);
  check.eq("第一轮 resume 调用次数", rec1.resume.length, 1);
  check.eq("第一轮后 archive 文件数", (await listFiles(archiveDir(home))).length, 0);

  // 第二次运行（新模块实例，共用同一 inbox）：attempts 2
  const runner2 = makeRunner(home);
  const rec2 = await runner2.run("E2", { online: false, resumeError });
  const seen2 = await waitFor(async () => {
    const state = await attemptsInInbox();
    return state.count === 1 && state.attempts === 2 ? state : null;
  });
  await waitQuiet(home, rec2);
  check.eq("第二轮后 attempts", seen2?.attempts ?? null, 2);
  check.eq("第二轮后 inbox 通知数", (await attemptsInInbox()).count, 1);
  check.eq("第二轮 followup 调用次数", rec2.followup.length, 0);
  check.eq("第二轮 archive 文件数", (await listFiles(archiveDir(home))).length, 0);

  // 第三次运行：attempts 3 → 归档 failed-attempts
  const runner3 = makeRunner(home);
  const rec3 = await runner3.run("E3", { online: false, resumeError });
  await waitFor(async () => countArchive(await listFiles(archiveDir(home)), "failed-attempts") >= 1);
  await waitQuiet(home, rec3);

  const archived = await listFiles(archiveDir(home));
  check.eq("第三轮后 .failed-attempts- 文件数", countArchive(archived, "failed-attempts"), 1);
  check.eq("第三轮后 inbox 通知数", (await readInboxNotices(home)).length, 0);
  check.eq("第三轮 followup 调用次数", rec3.followup.length, 0);
  check.eq("三次运行 resume 总次数", rec1.resume.length + rec2.resume.length + rec3.resume.length, 3);
}

async function caseF({ home, check }) {
  const runner = makeRunner(home);
  await writeNotice(home, notice("sess-F1", {
    reason: "concurrent-notice-1",
    extra: { package: "dsh-pending-notice-waker", resultPath: "C:\\tmp\\result-f1.json", logPath: "" },
  }));

  // resume 延迟 250ms：保证「正在处理第一份」时我们有时间写第二份
  const rec1 = await runner.run("F1", { online: false, resumeDelayMs: 250 });
  const claimed = await waitFor(async () => (await listFiles(inboxDir(home))).length >= 1);
  check.ok("第一份通知已被搬进 inbox（rename 生效）", Boolean(claimed), claimed ? "yes" : "timeout");

  // 处理期间再写一份新的 pending-notice.json（模拟安装脚本停机前写入）
  await writeNotice(home, notice("sess-F2", {
    reason: "concurrent-notice-2",
    extra: { package: "dsh-pending-notice-waker", resultPath: "C:\\tmp\\result-f2.json", logPath: "" },
  }));

  await waitQuiet(home, rec1);

  let runsNeeded = 1;
  let rec2 = null;
  const pendingLeft = existsSync(noticeFile(home));
  const inboxLeft = (await listFiles(inboxDir(home))).length;
  if (pendingLeft || inboxLeft > 0) {
    runsNeeded = 2;
    const runner2 = makeRunner(home);
    rec2 = await runner2.run("F2", { online: true });
    await waitQuiet(home, rec2);
  }

  const texts = [...rec1.texts, ...(rec2 ? rec2.texts : [])];
  const followups = rec1.followup.length + (rec2 ? rec2.followup.length : 0);
  const archived = await listFiles(archiveDir(home));
  const archivedNotices = [];
  for (const name of archived) {
    try {
      archivedNotices.push(JSON.parse(await readFile(join(archiveDir(home), name), "utf8")));
    } catch {
      // 非 JSON 的忽略
    }
  }
  const archivedSessions = archivedNotices.map((item) => item?.sessionId).sort();

  check.note("本次处理了两份通知所需的运行轮数", runsNeeded);
  check.eq("followup 总次数", followups, 2);
  check.eq("reason-F1 出现次数", texts.filter((text) => text.includes("concurrent-notice-1")).length, 1);
  check.eq("reason-F2 出现次数", texts.filter((text) => text.includes("concurrent-notice-2")).length, 1);
  check.eq("archive 里 .done- 文件数", countArchive(archived, "done"), 2);
  check.eq("归档的 sessionId（互不覆盖）", archivedSessions, ["sess-F1", "sess-F2"]);
  check.ok("pending-notice.json 已清空", !existsSync(noticeFile(home)));
  check.eq("inbox 剩余文件数", (await listFiles(inboxDir(home))).length, 0);
}

async function caseG({ home, check }) {
  const runner = makeRunner(home);
  const resultPath = "<LOCALAPPDATA>\\\\dsh-restart\\\\dsh-plugin-install-20261118-213500.json";
  await writeNotice(home, notice("sess-G", {
    reason: "with-result-path",
    extra: { package: "dsh-pending-notice-waker", resultPath, logPath: "<LOCALAPPDATA>\\\\dsh-restart\\\\dsh-plugin-install-20261118-213500.log" },
  }));

  const rec = await runner.run("G1", { online: true });
  await waitFor(async () => countArchive(await listFiles(archiveDir(home)), "done") >= 1);
  await waitQuiet(home, rec);

  const text = rec.texts[0] || "";
  check.eq("followup 调用次数", rec.followup.length, 1);
  check.ok("followup 文本包含 extra.resultPath", text.includes(resultPath), text.slice(0, 200));
  check.ok("followup 文本非空", text.trim().length > 0, text.length);
  check.note("文本里是否带「安装结果：」标注", text.includes("安装结果：") ? "yes" : "no（t1 契约建议带，t3 G 只要求路径出现）");
  check.note("followup 文本", JSON.stringify(text));
}

async function caseH({ home, check }) {
  await mkdir(stateRoot(home), { recursive: true });
  const stamps = [isoAgoMs(5 * 60_000), isoAgoMs(5 * 60_000)];
  await writeFile(throttleFile(home), JSON.stringify({ "sess-H": stamps }), "utf8");
  const runner = makeRunner(home);
  await writeNotice(home, notice("sess-H", { reason: "throttled-check" }));

  const rec = await runner.run("H1", { online: true });
  await waitFor(async () => countArchive(await listFiles(archiveDir(home)), "throttled") >= 1);
  await waitQuiet(home, rec);

  const archived = await listFiles(archiveDir(home));
  check.eq("archive 里 .throttled- 文件数", countArchive(archived, "throttled"), 1);
  check.eq("archive 里 .done- 文件数", countArchive(archived, "done"), 0);
  check.eq("followup 调用次数", rec.followup.length, 0);
  check.eq("agents.get 调用次数（限流应在取 agent 之前）", rec.get.length, 0);
  check.eq("resume 调用次数", rec.resume.length, 0);
  check.eq("inbox 剩余文件数", (await listFiles(inboxDir(home))).length, 0);
  check.ok("pending-notice.json 已被搬走", !existsSync(noticeFile(home)));
}

/**
 * 预置 60 个「真实风格」归档文件：n-2026-01-01T00-mm-00-000Z-deadbeef.json.done-2026-01-01T00-mm-00-000Z.json
 * mm = 00..59，mtime 与文件名同步递增（两种排序口径都一致，避免测试自己制造歧义）。
 */
async function seedArchive(home, count = 60) {
  await mkdir(archiveDir(home), { recursive: true });
  const names = [];
  for (let mm = 0; mm < count; mm += 1) {
    const pad = String(mm).padStart(2, "0");
    const stamp = `2026-01-01T00-${pad}-00-000Z`;
    const fileName = `n-${stamp}-deadbeef.json.done-${stamp}.json`;
    const file = join(archiveDir(home), fileName);
    await writeFile(file, JSON.stringify({ sessionId: `old-${pad}` }), "utf8");
    const when = new Date(`2026-01-01T00:${pad}:00.000Z`);
    await utimes(file, when, when);
    names.push(fileName);
  }
  return names;
}

async function caseI({ home, check }) {
  const seeded = await seedArchive(home, 60);
  check.eq("预置 archive 文件数", (await listFiles(archiveDir(home))).length, 60);

  const runner = makeRunner(home);
  await writeNotice(home, notice("sess-I", { reason: "retention-check" }));
  const rec = await runner.run("I1", { online: true });
  await waitFor(async () => countArchive(await listFiles(archiveDir(home)), "done") >= 1);
  await waitQuiet(home, rec);

  const after = await listFiles(archiveDir(home));
  const seededAfter = after.filter((name) => name.startsWith("n-2026-01-01T00-"));
  const newlyArchived = after.filter((name) => !seeded.includes(name));
  const minuteOf = (name) => {
    const matched = /T00-(\d{2})-00-000Z/.exec(name);
    return matched ? Number(matched[1]) : NaN;
  };
  const newest = seeded.filter((name) => minuteOf(name) >= 11);
  const oldest = seeded.filter((name) => minuteOf(name) <= 10);

  check.eq("处理一条后 archive 文件总数", after.length, 50);
  check.eq("保留的最新 49 个预置文件数", seededAfter.length, 49);
  check.eq("被清掉的最旧 11 个预置文件数", seeded.filter((name) => !after.includes(name)).length, 11);
  check.ok("最新预置文件仍在（mm=59）", after.includes(newest[newest.length - 1]), newest[newest.length - 1]);
  check.ok("最旧预置文件已清（mm=00）", !after.includes(oldest[0]), oldest[0]);
  check.eq("本次新归档的文件数", newlyArchived.length, 1);
  check.ok("本次新归档的是 .done-", (newlyArchived[0] || "").includes(".done-"), newlyArchived[0] ?? "(none)");

  // 精确集合断言：mm 11..59 全在、mm 00..10 全不在
  const missingKept = newest.filter((name) => !after.includes(name));
  const survivingDropped = oldest.filter((name) => after.includes(name));
  check.eq("应保留却缺失的文件数", missingKept.length, 0);
  check.eq("应删除却残留的文件数", survivingDropped.length, 0);
}

const SCENARIOS = [
  ["A", "活会话：followup 一次 + 归档 done", caseA],
  ["B", "离线会话：resume 成功 + followup", caseB],
  ["C", "过期通知：归档 stale，不唤醒", caseC],
  ["D", "会话不存在：归档 dropped，只尝试一次", caseD],
  ["E", "失败上限：attempts 1→2→3，第三次归档 failed-attempts", caseE],
  ["F", "并发：处理期间再写一份，两份都处理且不覆盖", caseF],
  ["G", "prompt：extra.resultPath 出现在唤醒消息里", caseG],
  ["H", "限流：60 分钟内已 2 次 → 归档 throttled", caseH],
  ["I", "归档自清：60 个旧文件 → 只剩最新 50 个", caseI],
];

// ---------------------------------------------------------------- 静态检查

function runProcess(command, args, timeoutMs) {
  return new Promise((resolve) => {
    let child;
    try {
      child = spawn(command, args, { windowsHide: true });
    } catch (error) {
      resolve({ code: -1, stdout: "", stderr: `spawn failed: ${error}` });
      return;
    }
    let stdout = "";
    let stderr = "";
    child.stdout.on("data", (chunk) => { stdout += chunk; });
    child.stderr.on("data", (chunk) => { stderr += chunk; });
    const timer = setTimeout(() => {
      try { child.kill(); } catch { /* ignore */ }
    }, timeoutMs);
    child.on("error", (error) => {
      clearTimeout(timer);
      resolve({ code: -1, stdout, stderr: `spawn failed: ${error}` });
    });
    child.on("close", (code) => {
      clearTimeout(timer);
      resolve({ code: code ?? -1, stdout, stderr });
    });
  });
}

async function checkNodeSyntax() {
  const result = await runProcess(process.execPath, ["--check", WAKER_MODULE], 60000);
  return {
    label: "静态检查 node --check lib/index.js",
    ok: result.code === 0,
    actual: result.code === 0 ? "exit 0" : `exit ${result.code}: ${(result.stderr || result.stdout).trim().split(/\r?\n/).slice(0, 6).join(" | ")}`,
  };
}

async function checkPowerShellParse() {
  const script = [
    "$tokens = $null; $errors = $null;",
    `[void][System.Management.Automation.Language.Parser]::ParseFile('${INSTALLER_PS1}', [ref]$tokens, [ref]$errors);`,
    "if ($errors.Count -eq 0) { 'PARSE_OK tokens=' + @($tokens).Count }",
    "else { 'PARSE_FAIL errors=' + $errors.Count; $errors | ForEach-Object { 'ERR: ' + $_.Message }; exit 3 }",
  ].join(" ");
  let result = await runProcess("pwsh", ["-NoProfile", "-NonInteractive", "-Command", script], 120000);
  if (result.code === -1 && /spawn failed/.test(result.stderr)) {
    result = await runProcess("powershell.exe", ["-NoProfile", "-NonInteractive", "-Command", script], 120000);
  }
  const ok = result.code === 0 && result.stdout.includes("PARSE_OK");
  const detail = result.stdout.trim() || result.stderr.trim();
  return {
    label: "静态检查 PowerShell Parser 解析 plugin-install.ps1",
    ok,
    actual: ok ? detail : `exit ${result.code}: ${detail.split(/\r?\n/).slice(0, 8).join(" | ")}`,
  };
}

// ---------------------------------------------------------------- 真实 .dsh 隔离检查

async function realStateFingerprint() {
  const root = join(REAL_DSH_HOME, ".smart-restart");
  const parts = [];
  for (const relative of ["pending-notice.json", "throttle.json", "waker.log"]) {
    const file = join(root, relative);
    try {
      const info = await stat(file);
      parts.push(`${relative}:${info.size}:${Math.round(info.mtimeMs)}`);
    } catch {
      parts.push(`${relative}:absent`);
    }
  }
  for (const relative of ["inbox", "archive"]) {
    const dir = join(root, relative);
    try {
      const entries = await readdir(dir);
      parts.push(`${relative}:${entries.length}`);
    } catch {
      parts.push(`${relative}:absent`);
    }
  }
  return parts.join("|");
}

// ---------------------------------------------------------------- 主流程

async function main() {
  const startedAt = new Date();
  const checks = [];
  const results = [];

  console.log("# dsh-pending-notice-waker acceptance suite");
  console.log(`node: ${process.version}`);
  try {
    const info = await stat(WAKER_MODULE);
    console.log(`waker: ${WAKER_MODULE} (${info.size} bytes, mtime ${info.mtime.toISOString()})`);
  } catch {
    console.log(`waker: ${WAKER_MODULE} (MISSING)`);
  }
  try {
    const info = await stat(INSTALLER_PS1);
    console.log(`installer: ${INSTALLER_PS1} (${info.size} bytes, mtime ${info.mtime.toISOString()})`);
  } catch {
    console.log(`installer: ${INSTALLER_PS1} (MISSING)`);
  }
  console.log(`真实 DSH_HOME（只读，隔离检查用）: ${REAL_DSH_HOME}`);
  console.log("");

  const realBefore = await realStateFingerprint();

  // 静态检查
  console.log("== 静态检查 ==");
  const staticChecks = [await checkNodeSyntax(), await checkPowerShellParse()];
  for (const item of staticChecks) {
    checks.push(item);
    console.log(`  ${item.ok ? "PASS" : "FAIL"}  ${item.label}: ${item.actual}`);
  }
  console.log("");

  // 先找一个哨兵 DSH_HOME，保证任何时刻（包括 setup 阶段）都不会指向真实 .dsh
  const sentinel = await mkdtemp(join(tmpdir(), "waker-sentinel-"));
  process.env.DSH_HOME = sentinel;

  // 九个场景
  console.log("== 九场景 ==");
  for (const [id, title, fn] of SCENARIOS) {
    if (ONLY && !ONLY.has(id)) continue;
    const home = await mkdtemp(join(tmpdir(), `waker-${id}-`));
    process.env.DSH_HOME = home;
    const check = makeChecks();
    const result = { id, title, home, checks: check.list, pass: false, error: null, diag: "" };
    const scenarioStarted = Date.now();
    try {
      await fn({ home, check });
      result.pass = check.list.every((item) => item.ok);
    } catch (error) {
      result.error = error && error.stack ? error.stack : String(error);
      result.pass = false;
    } finally {
      // 收尾：把 DSH_HOME 挪回哨兵，避免后续任何延迟回调碰到真实目录
      process.env.DSH_HOME = sentinel;
      if (!result.pass) {
        result.diag = await diagnostics(home);
      }
      if (result.pass && !KEEP_ALL) {
        await rm(home, { recursive: true, force: true }).catch(() => {});
      }
    }
    result.ms = Date.now() - scenarioStarted;
    results.push(result);

    console.log(`[${id}] ${title} → ${result.pass ? "PASS" : "FAIL"}  (${result.ms}ms)`);
    for (const item of result.checks) console.log(renderCheck(item));
    if (result.error) console.log(`  ✗ 场景抛异常: ${result.error.split("\n").slice(0, 8).join("\n")}`);
    if (!result.pass) {
      console.log(`  临时 DSH_HOME（已保留，复现用）: ${result.home}`);
      if (result.diag) console.log(result.diag);
    } else if (VERBOSE || KEEP_ALL) {
      console.log(`  临时 DSH_HOME: ${home}`);
    }
    console.log("");
  }

  // 隔离检查
  const realAfter = await realStateFingerprint();
  const isolationOk = realBefore === realAfter;
  console.log("== 真实 DSH_HOME 隔离检查 ==");
  console.log(`  ${isolationOk ? "PASS" : "FAIL"}  真实 .smart-restart 全程未被触碰`);
  if (!isolationOk) {
    console.log(`    before: ${realBefore}`);
    console.log(`    after : ${realAfter}`);
  }
  console.log("");

  checks.push({ label: "真实 DSH_HOME 隔离", ok: isolationOk, actual: isolationOk ? "unchanged" : "changed" });

  // 清理
  await rm(sentinel, { recursive: true, force: true }).catch(() => {});
  delete process.env.DSH_HOME;

  // 汇总
  const passed = results.filter((item) => item.pass).length;
  const expectedCount = ONLY ? results.length : SCENARIOS.length;
  console.log("========== 汇总 ==========");
  for (const item of results) {
    const dots = ".".repeat(Math.max(2, 30 - item.id.length - item.title.length));
    console.log(`  ${item.id} ${item.title} ${dots} ${item.pass ? "PASS" : "FAIL"}`);
  }
  for (const item of staticChecks) {
    console.log(`  * ${item.label} ${".".repeat(Math.max(2, 30 - item.label.length))} ${item.ok ? "PASS" : "FAIL"}`);
  }
  console.log(`  九场景: ${passed}/${expectedCount} PASS | 静态检查: ${staticChecks.filter((item) => item.ok).length}/${staticChecks.length} PASS | 隔离: ${isolationOk ? "PASS" : "FAIL"}`);
  console.log(`耗时: ${((Date.now() - startedAt.getTime()) / 1000).toFixed(1)}s`);

  const allOk = results.length === expectedCount
    && results.every((item) => item.pass)
    && staticChecks.every((item) => item.ok)
    && isolationOk;

  if (!allOk) {
    console.log("");
    console.log("失败场景复现：");
    for (const item of results.filter((entry) => !entry.pass)) {
      console.log(`  node C:\\tools\\_waker-test.mjs --only ${item.id} --keep-all`);
      console.log(`    临时目录: ${item.home}`);
    }
  }

  console.log(allOk ? "\nRESULT: ALL PASS" : "\nRESULT: FAIL");
  process.exit(allOk ? 0 : 1);
}

main().catch((error) => {
  console.error("验收脚本自身崩溃：", error);
  process.exit(2);
});
