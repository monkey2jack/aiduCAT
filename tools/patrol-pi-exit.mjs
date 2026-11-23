#!/usr/bin/env node
/**
 * pi-exit-hang 巡检指标（工单 20261123 · 三、防回归）
 *
 * 统计一份 bridge-*.jsonl：
 *   - run started / completed / failed
 *   - 自然退出（pi-exit 且非 SIGTERM 引发）
 *   - code=143（SIGTERM 强杀）次数
 *   - completed→pi-exit >60s 的 run 数（收尾拖延）
 *   - pi-exit-after-request（requestExit 优雅退出埋点）与 p50/p95 延迟
 *   - pi-exit-escalate-sigkill / pi-busy-kill-wedged-child（楔死补刀）
 *
 * 阈值（工单第三节）：
 *   自然退出率 < 100%            → 🟡 黄
 *   连续两班自然退出 = 0          → 🔴 红（本脚本输出当班，连班判断由巡检并班看）
 *   run/failed 数（exit 引起）    → 单列展示
 *
 * 用法：node tools/patrol-pi-exit.mjs <bridge-log.jsonl> [--date YYYY-MM-DD] [--json]
 */
import { readFileSync } from 'node:fs';

const args = process.argv.slice(2);
const file = args.find((a) => !a.startsWith('--'));
const dateIdx = args.indexOf('--date');
const date = dateIdx >= 0 ? args[dateIdx + 1] : new Date().toISOString().slice(0, 10);
const asJson = args.includes('--json');

if (!file) {
  console.error('usage: node tools/patrol-pi-exit.mjs <bridge-log.jsonl> [--date YYYY-MM-DD] [--json]');
  process.exit(2);
}

const runs = new Map(); // runId -> {start, end, result, agent}
const exits = []; // {ts, pid, code, signal, session}
const reaps = []; // {ts, pid, session}
const exitAfterRequest = []; // delayMs[]
const escalates = [];
const busyKills = [];
let started = 0, completed = 0, failed = 0;
const failedLines = [];

const inDate = (ts) => ts.slice(0, 10) === date;

function isSigtermExit(code, signal) {
  return signal === 'SIGTERM' || code === 143;
}

function isSigkillExit(code, signal) {
  return signal === 'SIGKILL' || code === 137 || (code === null && signal === 'SIGKILL');
}

const raw = readFileSync(file, 'utf8');
for (const line of raw.split('\n')) {
  if (!line.trim()) continue;
  let d;
  try { d = JSON.parse(line); } catch { continue; }
  const ts = d.ts ?? '';
  if (!inDate(ts)) continue;
  const ev = d.event;
  if (d.phase === 'run' && ev === 'started') { started += 1; runs.set(d.runId, { start: ts }); }
  else if (d.phase === 'run' && ev === 'completed') {
    completed += 1;
    const r = runs.get(d.runId) ?? {};
    r.end = ts; r.result = d.result; runs.set(d.runId, r);
  } else if (d.phase === 'run' && ev === 'failed') {
    failed += 1;
    const r = runs.get(d.runId) ?? {};
    r.end = ts; r.result = 'failed'; r.error = String(d.error ?? '').slice(0, 120);
    runs.set(d.runId, r);
    failedLines.push({ ts, error: r.error, runId: d.runId });
  } else if (ev === 'pi-exit') {
    exits.push({ ts, pid: d.pid, code: d.code ?? null, signal: d.signal ?? null, session: d.session ?? '' });
  } else if (ev === 'pi-idle-reap') {
    reaps.push({ ts, pid: d.pid, session: d.session ?? '' });
  } else if (ev === 'pi-exit-after-request') {
    exitAfterRequest.push(d.delayMs ?? 0);
  } else if (ev === 'pi-exit-escalate-sigkill') {
    escalates.push({ ts, pid: d.pid });
  } else if (ev === 'pi-busy-kill-wedged-child') {
    busyKills.push({ ts, pid: d.pid });
  }
}

// completed→exit 归属：同 session 的下一个 pi-exit（且间隔 < 35min）算该 run 的收尾。
const exitLags = [];
const sortedExits = [...exits].sort((a, b) => a.ts.localeCompare(b.ts));
for (const [runId, r] of runs) {
  if (!r.end || r.result === undefined) continue;
  const session = r.session ?? '';
  void session; // session 归属需要 started 行携带 scope/session；此处用全局最近 exit 近似
  const next = sortedExits.find((e) => e.ts >= r.end);
  if (!next) continue;
  const lagMs = new Date(next.ts).getTime() - new Date(r.end).getTime();
  if (lagMs < 35 * 60_000) exitLags.push(lagMs);
}

const sigterm143 = exits.filter((e) => isSigtermExit(e.code, e.signal)).length;
const sigkill = exits.filter((e) => isSigkillExit(e.code, e.signal)).length;
const naturalExits = exits.length - sigterm143 - sigkill;
const over60s = exitLags.filter((ms) => ms > 60_000).length;
const naturalRate = exits.length === 0 ? null : naturalExits / exits.length;
const pct = (arr, p) => {
  if (arr.length === 0) return null;
  const s = [...arr].sort((a, b) => a - b);
  return s[Math.min(s.length - 1, Math.floor(s.length * p))];
};

const report = {
  date,
  log: file,
  runsStarted: started,
  runsCompleted: completed,
  runsFailed: failed,
  failedExcerpt: failedLines.slice(0, 10),
  piExits: exits.length,
  naturalExits,
  sigterm143,
  sigkillExternal: sigkill,
  naturalExitRate: naturalRate === null ? null : Number((naturalRate * 100).toFixed(1)),
  completedWithExitOver60s: over60s,
  exitAfterRequestCount: exitAfterRequest.length,
  exitAfterRequestP50Ms: pct(exitAfterRequest, 0.5),
  exitAfterRequestP95Ms: pct(exitAfterRequest, 0.95),
  sigkillEscalations: escalates.length,
  busyKills: busyKills.length,
};

if (asJson) {
  console.log(JSON.stringify(report, null, 2));
} else {
  console.log(`=== pi-exit 巡检 ${date} ===`);
  console.log(`run started/completed/failed : ${started} / ${completed} / ${failed}`);
  for (const f of report.failedExcerpt) console.log(`  FAIL ${f.ts} ${f.error} [${String(f.runId).slice(0, 8)}]`);
  console.log(`pi-exit 总数                 : ${exits.length}`);
  console.log(`  自然退出                   : ${naturalExits}`);
  console.log(`  SIGTERM(143)               : ${sigterm143}`);
  console.log(`  SIGKILL(外部/清扫)          : ${sigkill}`);
  console.log(`requestExit 优雅退出埋点      : ${exitAfterRequest.length}` +
    (report.exitAfterRequestP50Ms !== null ? ` (p50=${(report.exitAfterRequestP50Ms / 1000).toFixed(1)}s p95=${(report.exitAfterRequestP95Ms / 1000).toFixed(1)}s)` : ''));
  console.log(`SIGKILL 升级 / busy 补杀      : ${escalates.length} / ${busyKills.length}`);
  console.log(`completed→exit >60s          : ${over60s} / ${completed}`);
  let verdict = '🟢 绿';
  if (naturalRate !== null && naturalRate < 1) verdict = '🟡 黄（自然退出率 <100%）';
  if (naturalRate === 0 && exits.length > 0) verdict = '🔴 红（当班自然退出=0；连班红需看上一班）';
  if (exits.length === 0 && completed > 0) verdict = '🟡 黄（有完成、无退出记录——进程去向不明）';
  console.log(`当班判定                     : ${verdict}`);
  console.log('（阈值：自然退出率 <100% 即黄；连续两班 0 自然退出即红 —— 连班判断由巡检并班）');
}
