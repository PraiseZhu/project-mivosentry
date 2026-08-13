#!/usr/bin/env node
// MivoSentry G1 — 夜间机械审计引擎。见 docs/CONTRACTS.md「G1」节（唯一接口真相）。
//
// 用法:
//   node nightly-audit.mjs --repo <目标仓绝对路径> [--dims csv] [--out-dir reports] [--state-dir state]
//   node nightly-audit.mjs --sample --findings <findings.json> --report <nightly-report.md> --out <sample.md> [--per-group N] [--max-sample N]
//
// 本文件同时是 orchestrator 与 worker：orchestrator 为每个维度 fork 一个子进程执行
// `node nightly-audit.mjs --_worker <dim> --repo <path>`（内部用法，不对外文档化），
// 单维度独立超时/失败不拖垮整轮。
//
// --out-dir/--state-dir 未显式传入时，默认绑定本脚本自身所在仓（MivoSentry）根目录下的
// reports//state/，而非进程 cwd——避免从别的目录调用本脚本时把产物写去意料之外的位置。
// 无论默认还是显式传入，最终解析路径（含 symlink 穿透）都会与 --repo 的 realpath 比对，
// 位于 --repo 内一律拒绝执行（用法错误）——本工具对 --repo 只读是硬约束，不能被自己的输出
// 目录配置绕过。
//
// 退出码：
//   0 = 跑完（有无 finding 都算，只读自检 PASS，且 fingerprint 无碰撞）
//   1 = 用法错（缺 --repo；--dims 为空/含未知维度/含重复维度；--out-dir/--state-dir 解析后
//       位于 --repo 内；--sample 缺必需参数）
//   2 = 环境错（--repo 不存在/不是 git 仓；--sample 的 --findings/--report 读取或解析失败）
//   3 = fingerprint 唯一性断言失败（视为本工具身份种子生成逻辑自身的 bug，不写
//       state/findings-<date>.json，不静默把不可信的去重身份交给 G2）
//   4 = 只读自检失败（跑前/跑后 `git -C <repo> status --porcelain` 不一致，判定为本轮对
//       --repo 的只读契约被破坏）
//   注：0/1/2/3/4 已于 2026-08-01 收口进 docs/CONTRACTS.md v2 的 G1 节（权威定义在那里）。
//
// ---------------------------------------------------------------------------
// Findings 记录 schema（G1 唯一权威实现）：
//   line: 正整数 = 行级 finding 的实际行号；0 = 文件级或图级 finding 的 sentinel（无具体
//     行）。晨报/样例展示 file+line 组合时，line=0 一律只显示 file，不拼出 "file:0"（见
//     formatFileLine）。docs/CONTRACTS.md 的 line 字段语义文本由 lead 收口更新，此处先行
//     按新约定实现。
//   fingerprint 身份种子 = sha256(`${file}|${dim}|${category}|${anchor}`).slice(0,16)：
//     - line/span/count/evidence 全部不进种子，只作观测字段——同一个问题的行号会随其上方
//       代码增删而漂移、统计数字会逐日变化，这些波动不应产生新指纹（否则 G2 会把同一个
//       问题当新问题反复开单）。
//     - anchor 按 finding 性质分四类构造：
//         文本命中（todo-stale / secret-pattern / test-health 的 skip-only / dead-code 的
//           未用导出与未用变量）= 规范化行内容（或命中文本）的摘要 + 该内容在同文件内第
//           几次出现（#N 序号，去重同文件内多次出现的同一行文本互相碰撞）;
//         函数（debt-metric 长函数）= 具名函数用函数名，匿名函数用规范化函数头文本的
//           sha256（函数头 = 从函数起始到函数体起始之间的源码片段，如 "(state) => "），
//           同样附加文件内第几次出现该 anchor 的序号——直接解决"同 span 嵌套匿名箭头
//           函数"互相碰撞的问题（外层/内层箭头函数的函数头文本不同，天然可分辨）;
//         文件级（debt-metric 文件超长 / type-escape 汇总 / log-violation 兜底）= 固定字面
//           量（如 'file-too-long'）；deps-vuln 用稳定的 npm 包名——都不含任何数字统计;
//         图级（circular-dep）= 环成员排序后 join 的字符串，file 字段也取排序后的首个成员
//           ——保证同一个环无论 madge 报告顺序如何、无论从哪个成员开始报告，都得到同一
//           指纹与同一展示 file。
//   rename/移动策略 = 不追踪：文件改名、函数改名之后旧指纹自然失效、产生一条新 finding，
//     接受这是一次性重报（G1 是无状态机械扫描器，不做历史关联，成本不成比例）。
//   产物写出前会对全部 findings 做 fingerprint 唯一性断言（见 findFingerprintCollisions）；
//     一旦发现碰撞视为本工具自身 bug，不写 findings.json、退出码 3，避免把不可信的去重
//     身份静默交给 G2。
// ---------------------------------------------------------------------------
// 噪音路径 denylist（跨 todo-stale/type-escape/secret-pattern/test-health/debt-metric 生效，
// 见 isDenylisted）：`.claude/**`、`_tmp/**`、`history/**`、`docs/design-previews/**`、
// `**/*.bundle.js`。文件枚举本身也改为 `git ls-files --cached --others --exclude-standard`
// （尊重目标仓 .gitignore），denylist 是在此基础上的第二层过滤——因为像 `history/worktrees/`
// 这类宿主运行时产生的 untracked 但未被 .gitignore 命中的目录，只靠 --exclude-standard 挡
// 不住，必须显式列出。
//
// circular-dep 维度只使用目标仓 `node_modules/.bin/madge` 本地二进制；不存在则 n_a，绝不
// 通过 `npx --yes` 在夜巡期间联网拉取未锁定的依赖。

import { spawn, spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { existsSync, mkdirSync, readFileSync, realpathSync, writeFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const __filename = fileURLToPath(import.meta.url);
const SCRIPT_REPO_ROOT = path.resolve(path.dirname(__filename), '..', '..');

const DIMENSIONS = [
  'deps-vuln',
  'dead-code',
  'todo-stale',
  'log-violation',
  'type-escape',
  'secret-pattern',
  'circular-dep',
  'test-health',
  'debt-metric',
];
const KNOWN_DIMS = new Set(DIMENSIONS);

const DIM_TIMEOUT_MS = 120_000;
const INNER_CMD_TIMEOUT_MS = 100_000;
// circular-dep 维度里 madge 的超时；仅供测试通过环境变量注入更短的值来验证"超时→归入败桶
// 而非 n_a"的行为(见 dimCircularDep)，生产路径不设置该环境变量时走默认值 110_000ms。
const MADGE_TIMEOUT_MS_OVERRIDE = Number(process.env.MIVOSENTRY_MADGE_TIMEOUT_MS);
const MADGE_TIMEOUT_MS = Number.isFinite(MADGE_TIMEOUT_MS_OVERRIDE) && MADGE_TIMEOUT_MS_OVERRIDE > 0 ? MADGE_TIMEOUT_MS_OVERRIDE : 110_000;
const SEVERITY_ORDER = { P0: 0, P1: 1, P2: 2, P3: 3 };

// ---------- 共享工具 ----------

function sha256(str) {
  return createHash('sha256').update(str, 'utf8').digest('hex');
}

// D-A：身份种子 = file|dim|category|规范化内容锚点（顺序与 CONTRACTS.md v2 一致）。line/span/count/evidence
// 一律不参与——那些是观测字段，只应出现在 finding 对象的其它字段里。
function fingerprint(file, dim, category, anchor) {
  return sha256(`${file}|${dim}|${category}|${anchor}`).slice(0, 16);
}

// POSIX 单引号安全转义：把动态路径/参数拼进 shell 命令字符串（verify 字段）时使用，
// 防止文件名含空格/分号/`$()` 等字符时被注入或拼出失真的命令。
function shellQuote(value) {
  return `'${String(value).replace(/'/g, "'\\''")}'`;
}

// 规范化文本：折叠内部空白、去首尾空白——用于文本命中类 finding 的锚点内容，使锚点不随
// 缩进/行内空格变化漂移。
function normalizeContent(text) {
  return String(text).replace(/\s+/g, ' ').trim();
}

// 同一 key 第几次出现的计数器，用于给锚点内容相同的多条记录（如同文件内重复出现的同一行
// 文本、或结构相同的匿名函数头）附加区分序号，从根上保证 fingerprint 不可能碰撞（碰撞只可
// 能来自 sha256 摘要截断的天文小概率，而不是本工具自身的种子设计缺陷）。
function makeOccurrenceIndexer() {
  const seen = new Map();
  return (key) => {
    const n = (seen.get(key) || 0) + 1;
    seen.set(key, n);
    return n;
  };
}

function todayStr(d = new Date()) {
  const y = d.getFullYear();
  const m = String(d.getMonth() + 1).padStart(2, '0');
  const day = String(d.getDate()).padStart(2, '0');
  return `${y}-${m}-${day}`;
}

function addDays(date, delta) {
  return new Date(date.getTime() + delta * 86_400_000);
}

function daysBetween(a, b) {
  return Math.floor((b.getTime() - a.getTime()) / 86_400_000);
}

function runSync(cmd, args, opts = {}) {
  const res = spawnSync(cmd, args, {
    encoding: 'utf8',
    timeout: INNER_CMD_TIMEOUT_MS,
    killSignal: 'SIGKILL',
    maxBuffer: 64 * 1024 * 1024,
    ...opts,
  });
  // 先识别 spawnSync 超时时 Node 实际会设置的 error.code === 'ETIMEDOUT'（原判定要求
  // error==null 与此矛盾：实测 Node 在 timeout 触发时会同时填充 error 与 signal，导致原判定
  // 永远不命中，超时被下游 `if (res.error) throw` 分支当成普通执行失败，吞掉更准确的"超时"
  // 诊断信息）。status/signal 均空的旧启发式作为回退，兼容个别场景下 error 未被填充的情况。
  const timedOutByError = res.error != null && res.error.code === 'ETIMEDOUT';
  const timedOutBySignal = res.error == null && res.status == null && res.signal != null;
  const timedOut = timedOutByError || timedOutBySignal;
  return {
    status: res.status,
    signal: res.signal,
    stdout: res.stdout ?? '',
    stderr: res.stderr ?? '',
    // 超时导致的 error 在这里置空，让调用方 `if (res.error) ... if (res.timedOut) ...` 的
    // 既有顺序能正确落到 timedOut 分支，而不是被更早的 error 分支抢先吞掉。
    error: timedOutByError ? null : (res.error ?? null),
    timedOut,
  };
}

// 噪音路径 denylist：与目标仓 .gitignore 无关的第二层过滤，专门挡住宿主/工具运行时产生的
// 目录（不管是否已被 git 跟踪或忽略）。
function isDenylisted(rel) {
  return (
    rel === '.claude' ||
    rel.startsWith('.claude/') ||
    rel === '_tmp' ||
    rel.startsWith('_tmp/') ||
    rel === 'history' ||
    rel.startsWith('history/') ||
    rel.startsWith('docs/design-previews/') ||
    rel.endsWith('.bundle.js')
  );
}

function gitTrackedFiles(repo) {
  const res = runSync('git', ['-C', repo, 'ls-files', '--cached', '--others', '--exclude-standard', '-z']);
  if (res.error) throw new Error(`git ls-files 执行失败: ${res.error.message}`);
  if (res.timedOut) throw new Error('git ls-files 执行超时');
  if (res.status !== 0) throw new Error(`git ls-files 非零退出(exit=${res.status}): ${(res.stderr || '').slice(0, 300)}`);
  return res.stdout.split('\0').filter(Boolean);
}

// 文件枚举改为 `git ls-files --cached --others --exclude-standard`（尊重目标仓 .gitignore），
// 而不是原来的裸文件系统递归（只认识一个硬编码的小 SKIP_DIRS 集合，完全不看 .gitignore，
// 会把 .claude/worktrees、_tmp、node_modules 之外的各种忽略目录全部扫进来）。denylist 在此
// 基础上再挡一层（见 isDenylisted 的注释）。
function walkFiles(repo, exts) {
  const tracked = gitTrackedFiles(repo);
  const files = [];
  let excludedByDenylist = 0;
  for (const rel of tracked) {
    if (isDenylisted(rel)) {
      excludedByDenylist += 1;
      continue;
    }
    if (exts && !exts.some((e) => rel.endsWith(e))) continue;
    files.push(path.join(repo, rel));
  }
  return { files, trackedTotal: tracked.length, excludedByDenylist };
}

function scanNote(scan) {
  return `扫描 git 跟踪/未忽略文件共 ${scan.trackedTotal} 个，denylist(.claude/**、_tmp/**、history/**、docs/design-previews/**、**/*.bundle.js) 排除 ${scan.excludedByDenylist} 个噪音路径`;
}

function relFile(repo, absPath) {
  return path.relative(repo, absPath).split(path.sep).join('/');
}

function readTextOrNull(abs) {
  try {
    return readFileSync(abs, 'utf8');
  } catch {
    return null;
  }
}

// 把 targetPath 解析到「已存在的最近上级目录的 realpath」+ 尚不存在的字面剩余路径段，
// 使得即便 --out-dir/--state-dir 目前还不存在也能正确穿透中间目录的 symlink。移植自
// scripts/anchor/anchor-map.mjs 的同名函数（同一套只读边界校验，已在那边验证过）。
function resolveRealWithMissingTail(targetPath) {
  const abs = path.resolve(targetPath);
  const missingParts = [];
  let cur = abs;
  while (!existsSync(cur)) {
    missingParts.unshift(path.basename(cur));
    const parent = path.dirname(cur);
    if (parent === cur) break;
    cur = parent;
  }
  const curReal = existsSync(cur) ? realpathSync(cur) : cur;
  return missingParts.length ? path.join(curReal, ...missingParts) : curReal;
}

function isPathInsideRepo(repoRealAbs, candidatePath) {
  const candReal = resolveRealWithMissingTail(candidatePath);
  return candReal === repoRealAbs || candReal.startsWith(repoRealAbs + path.sep);
}

// D-B：file+line 组合展示时，line<=0（sentinel）一律只显示 file，不拼出 "file:0"。
function formatFileLine(file, line) {
  return line > 0 ? `${file}:${line}` : file;
}

// ---------- 维度 1: deps-vuln ----------

function dimDepsVuln(repo) {
  if (!existsSync(path.join(repo, 'package.json'))) {
    return { status: 'n_a', findings: [], note: '目标仓无 package.json' };
  }
  const res = runSync('npm', ['audit', '--json'], { cwd: repo });
  if (res.error) throw new Error(`npm audit 执行失败: ${res.error.message}`);
  if (res.timedOut) throw new Error('npm audit 超时（可能断网或注册表不可达）');
  let parsed;
  try {
    parsed = JSON.parse(res.stdout);
  } catch {
    throw new Error(`npm audit 输出非 JSON（可能断网/无 lockfile）: ${(res.stderr || res.stdout || '').slice(0, 300)}`);
  }
  if (parsed.error) {
    throw new Error(`npm audit 报错: ${parsed.error.summary || JSON.stringify(parsed.error).slice(0, 300)}`);
  }
  const sevMap = { critical: 'P0', high: 'P1', moderate: 'P2', low: 'P3', info: 'P3' };
  const findings = [];
  for (const [name, v] of Object.entries(parsed.vulnerabilities || {})) {
    const severity = sevMap[v.severity] || 'P2';
    const range = v.range || 'unknown';
    const fixNote = v.fixAvailable ? '有可用修复' : '无自动修复';
    const evidence = `${name}@${range} severity=${v.severity} (${fixNote})`;
    findings.push({
      dim: 'deps-vuln',
      file: 'package.json',
      line: 0,
      category: '依赖漏洞',
      evidence,
      severity,
      verify: `npm audit --json | grep -n ${shellQuote(name)}`,
      // 文件级锚点：npm 包名本身就是稳定唯一 key（npm audit 的 vulnerabilities 按包名去重），
      // 不含 range/severity/fixNote 等会随生态更新变化的观测字段。
      fingerprint: fingerprint('package.json', 'deps-vuln', '依赖漏洞', name),
    });
  }
  return { status: 'ok', findings };
}

// ---------- 维度 2: dead-code ----------

function findTsconfigs(repo) {
  const top = path.join(repo, 'tsconfig.json');
  if (!existsSync(top)) return [];
  try {
    const raw = readFileSync(top, 'utf8');
    const stripped = raw.replace(/\/\*[\s\S]*?\*\//g, '').replace(/(^|\s)\/\/.*$/gm, '');
    const json = JSON.parse(stripped);
    if (Array.isArray(json.references) && json.references.length) {
      return json.references.map((r) => path.join(repo, r.path));
    }
  } catch {
    // tsc 自身能容忍 JSONC/尾逗号，解析失败时直接把顶层文件交给 tsc 处理
  }
  return [top];
}

function dimDeadCode(repo) {
  const binTsPrune = path.join(repo, 'node_modules', '.bin', 'ts-prune');
  const binKnip = path.join(repo, 'node_modules', '.bin', 'knip');
  const binTsc = path.join(repo, 'node_modules', '.bin', 'tsc');
  const findings = [];
  const occ = makeOccurrenceIndexer();
  let note;

  if (existsSync(binTsPrune) || existsSync(binKnip)) {
    const useKnip = !existsSync(binTsPrune);
    const bin = useKnip ? binKnip : binTsPrune;
    const res = runSync(bin, [], { cwd: repo });
    if (res.error) throw new Error(`${useKnip ? 'knip' : 'ts-prune'} 执行失败: ${res.error.message}`);
    if (res.timedOut) throw new Error(`${useKnip ? 'knip' : 'ts-prune'} 执行超时`);
    const lines = (res.stdout || '').split('\n').filter(Boolean);
    for (const line of lines) {
      const m = line.match(/^(.+?):(\d+)\s*-\s*(.+)$/);
      if (!m) continue;
      const [, file, lineNo, name] = m;
      const rel = path.isAbsolute(file) ? relFile(repo, file) : file;
      const exportName = name.trim();
      const evidence = `未使用导出: ${exportName}`;
      const normalizedName = normalizeContent(exportName);
      const anchor = `${normalizedName}#${occ(`${rel}|${normalizedName}`)}`;
      findings.push({
        dim: 'dead-code',
        file: rel,
        line: Number(lineNo),
        category: '疑似死代码',
        evidence,
        severity: 'P3',
        verify: `sed -n '${lineNo}p' ${shellQuote(rel)}`,
        fingerprint: fingerprint(rel, 'dead-code', '疑似死代码', anchor),
      });
    }
    note = `使用 ${useKnip ? 'knip' : 'ts-prune'}`;
    return { status: 'ok', findings, note };
  }

  if (!existsSync(binTsc)) {
    return { status: 'n_a', findings: [], note: 'ts-prune/knip/tsc 均不可用（node_modules/.bin 无 tsc），dead-code 维度跳过' };
  }
  const tsconfigs = findTsconfigs(repo);
  if (tsconfigs.length === 0) {
    return { status: 'n_a', findings: [], note: '无 ts-prune/knip 且目标仓无 tsconfig.json，dead-code 维度跳过' };
  }
  note = 'ts-prune/knip 均不可用，已降级为 tsc(noUnusedLocals/noUnusedParameters)+grep 解析未使用局部变量/参数（非完整死代码检测，仅本地未用变量/参数代理指标）';
  for (const tsconfig of tsconfigs) {
    const res = runSync(binTsc, ['-p', tsconfig, '--noEmit', '--incremental', 'false'], { cwd: repo });
    if (res.error) throw new Error(`tsc 降级扫描失败(${tsconfig}): ${res.error.message}`);
    if (res.timedOut) throw new Error(`tsc 降级扫描超时(${tsconfig})`);
    const out = `${res.stdout}\n${res.stderr}`;
    const matchesThisRun = [];
    const disallowedCodes = new Set();
    for (const line of out.split('\n')) {
      // R3 修复：允许清单(TS6133/TS6196)之外的诊断码只要出现一次，就说明这次非零退出不能
      // 100% 归因于"未用变量/参数"——即便同一次输出里也真实命中了若干条 TS6133/TS6196，也
      // 不能让"至少解析到一条"掩盖"还混着别的配置/编译错误"这一事实。
      const codeMatch = line.match(/error\s+(TS\d+):/);
      if (codeMatch && codeMatch[1] !== 'TS6133' && codeMatch[1] !== 'TS6196') {
        disallowedCodes.add(codeMatch[1]);
      }
      if (!/TS6133|TS6196/.test(line)) continue;
      const m = line.match(/^(.+?)\((\d+),(\d+)\):\s*error\s+(TS\d+):\s*(.+)$/);
      if (!m) continue;
      const [, file, lineNo, , code, msg] = m;
      const abs = path.isAbsolute(file) ? file : path.resolve(repo, file);
      const rel = relFile(repo, abs);
      const evidence = `${code}: ${msg.trim()}`;
      const normalizedEvidence = normalizeContent(evidence);
      const anchor = `${normalizedEvidence}#${occ(`${rel}|${normalizedEvidence}`)}`;
      matchesThisRun.push({
        dim: 'dead-code',
        file: rel,
        line: Number(lineNo),
        category: '疑似死代码',
        evidence,
        severity: 'P3',
        verify: `sed -n '${lineNo}p' ${shellQuote(rel)}`,
        fingerprint: fingerprint(rel, 'dead-code', '疑似死代码', anchor),
      });
    }
    // 假绿修复：tsc 非零退出且(一条 TS6133/TS6196 都没匹配到 或 混杂着允许清单之外的诊断码)，
    // 说明这次失败不能完全归因于我们要找的未用变量/参数（可能是配置错误/环境问题/项目本身
    // 有其它编译错误），不能悄悄报告成"0 finding/部分 finding，dead-code 干净"。仅当非零
    // 退出完全由允许清单诊断(TS6133/TS6196)导致时才可放行产 finding。
    if (res.status !== 0 && (matchesThisRun.length === 0 || disallowedCodes.size > 0)) {
      const reason =
        disallowedCodes.size > 0
          ? `且检测到允许清单(TS6133/TS6196)之外的诊断码: ${[...disallowedCodes].join(', ')}`
          : '且未匹配到 TS6133/TS6196';
      throw new Error(
        `tsc 降级扫描非零退出(${tsconfig}, exit=${res.status})${reason}，判定为环境/配置错误而非"无死代码": ${out.trim().slice(0, 300)}`
      );
    }
    findings.push(...matchesThisRun);
  }
  return { status: 'ok', findings, note };
}

// ---------- 维度 3: todo-stale ----------

function dimTodoStale(repo) {
  const THRESHOLD_DAYS = 90;
  const scan = walkFiles(repo, ['.ts', '.tsx', '.js', '.jsx', '.mjs', '.cjs']);
  const now = new Date();
  const findings = [];
  const occ = makeOccurrenceIndexer();
  for (const abs of scan.files) {
    const content = readTextOrNull(abs);
    if (content == null) continue;
    const lines = content.split('\n');
    const rel = relFile(repo, abs);
    for (let i = 0; i < lines.length; i++) {
      if (!/\b(TODO|FIXME)\b/.test(lines[i])) continue;
      const lineNo = i + 1;
      const blame = runSync('git', ['blame', '-L', `${lineNo},${lineNo}`, '--porcelain', '--', rel], { cwd: repo });
      if (blame.error || blame.timedOut || blame.status !== 0) continue;
      const m = blame.stdout.match(/^author-time (\d+)/m);
      if (!m) continue;
      const age = daysBetween(new Date(Number(m[1]) * 1000), now);
      if (age < THRESHOLD_DAYS) continue;
      const snippet = lines[i].trim().slice(0, 160);
      const evidence = `已存在 ${age} 天 (>${THRESHOLD_DAYS}): ${snippet}`;
      const normalizedSnippet = normalizeContent(snippet);
      const anchor = `${normalizedSnippet}#${occ(`${rel}|${normalizedSnippet}`)}`;
      findings.push({
        dim: 'todo-stale',
        file: rel,
        line: lineNo,
        category: 'TODO/FIXME 过期',
        evidence,
        severity: age > 180 ? 'P2' : 'P3',
        verify: `git blame -L ${lineNo},${lineNo} -- ${shellQuote(rel)}`,
        // 锚点=规范化注释原文+文件内第几次出现：不含随天数递增的 age，行号增删也不影响
        // （只要相对出现顺序不变），避免同一条 TODO 每晚生成新指纹。
        fingerprint: fingerprint(rel, 'todo-stale', 'TODO/FIXME 过期', anchor),
      });
    }
  }
  return { status: 'ok', findings, note: scanNote(scan) };
}

// ---------- 维度 4: log-violation ----------

function dimLogViolation(repo) {
  const pkgJsonPath = path.join(repo, 'package.json');
  if (!existsSync(pkgJsonPath)) return { status: 'n_a', findings: [], note: '无 package.json' };
  let pkg;
  try {
    pkg = JSON.parse(readFileSync(pkgJsonPath, 'utf8'));
  } catch {
    return { status: 'n_a', findings: [], note: 'package.json 无法解析' };
  }
  if (!pkg.scripts || !pkg.scripts['verify:logging']) {
    return { status: 'n_a', findings: [], note: '目标仓无 verify:logging 脚本' };
  }
  const res = runSync('npm', ['run', 'verify:logging'], { cwd: repo });
  if (res.error) throw new Error(`verify:logging 执行失败: ${res.error.message}`);
  if (res.timedOut) throw new Error('verify:logging 超时');
  if (res.status === 0) return { status: 'ok', findings: [] };

  const combined = `${res.stdout}\n${res.stderr}`;
  const findings = [];
  const re = /([./][\w./-]+\.[jt]sx?):(\d+)/g;
  const seen = new Set();
  const occ = makeOccurrenceIndexer();
  let m;
  while ((m = re.exec(combined))) {
    const rel = m[1].replace(/^\.\//, '');
    const lineNo = Number(m[2]);
    const key = `${rel}:${lineNo}`;
    if (seen.has(key)) continue;
    seen.add(key);
    const evidence = 'verify:logging 报告违规位置';
    findings.push({
      dim: 'log-violation',
      file: rel,
      line: lineNo,
      category: '日志规范违反',
      evidence,
      severity: 'P2',
      verify: 'npm run verify:logging',
      // evidence 文案固定不变，真正区分同文件内多条违规的是"文件内第几次出现"序号。
      fingerprint: fingerprint(rel, 'log-violation', '日志规范违反', `log-violation#${occ(rel)}`),
    });
  }
  if (findings.length === 0) {
    const evidence = `verify:logging 退出码 ${res.status}: ${combined.trim().slice(0, 300)}`;
    findings.push({
      dim: 'log-violation',
      file: 'package.json',
      line: 0,
      category: '日志规范违反',
      evidence,
      severity: 'P2',
      verify: 'npm run verify:logging',
      fingerprint: fingerprint('package.json', 'log-violation', '日志规范违反', 'log-violation-unparsed'),
    });
  }
  return { status: 'ok', findings };
}

// ---------- 维度 5: type-escape ----------

function dimTypeEscape(repo) {
  const scan = walkFiles(repo, ['.ts', '.tsx']);
  const patterns = [
    { re: /\bas any\b/g, label: 'as any' },
    { re: /@ts-ignore\b/g, label: '@ts-ignore' },
    { re: /@ts-expect-error\b/g, label: '@ts-expect-error' },
    { re: /\bany\b/g, label: 'any' },
  ];
  const findings = [];
  for (const abs of scan.files) {
    const content = readTextOrNull(abs);
    if (content == null) continue;
    const counts = {};
    let total = 0;
    for (const { re, label } of patterns) {
      const matches = content.match(re);
      if (matches && matches.length) {
        counts[label] = matches.length;
        total += matches.length;
      }
    }
    if (total === 0) continue;
    const rel = relFile(repo, abs);
    const evidence = Object.entries(counts).map(([k, v]) => `${k}×${v}`).join(', ');
    findings.push({
      dim: 'type-escape',
      file: rel,
      line: 0,
      category: '类型逃逸',
      evidence,
      severity: total >= 10 ? 'P2' : 'P3',
      verify: `grep -noE '\\bas any\\b|@ts-ignore|@ts-expect-error|\\bany\\b' ${shellQuote(rel)} | wc -l`,
      // 文件级：每个文件最多一条聚合记录，file 本身已唯一，锚点用固定字面量，不把计数
      // 拼进种子（计数逐日变化，不该产生新指纹）。
      fingerprint: fingerprint(rel, 'type-escape', '类型逃逸', 'type-escape-summary'),
    });
  }
  return { status: 'ok', findings, note: scanNote(scan) };
}

// ---------- 维度 6: secret-pattern ----------

/**
 * 判定 repo 相对路径是否属于测试代码。
 *
 * 用途：secret-pattern 的凭据规则在测试文件上误报率极高——测试夹具本来就写假
 * key/token/password。实测 mivo-canvas-plugin 首轮 17 条 P1 命中里 16 条落在
 * `*.test.*` / `__tests__/` 下，若按 P1 走单发通道，`--send` 一开就是 16 条
 * 噪音 issue 灌进目标仓。
 *
 * 处置是**降级到 P3 而非直接排除**：真把生产密钥粘进测试文件仍然是事故，
 * 只是该由人在当日汇总里过一眼，不该独占一条 issue。
 *
 * severity 不参与指纹种子（种子只含 file|dim|category|anchor），故本降级不会
 * 改变任何已有 fingerprint，不引发重复 issue。
 */
function isTestPath(rel) {
  const segs = rel.split('/');
  const base = segs[segs.length - 1] || '';
  if (/\.(test|spec)\.[cm]?[jt]sx?$/i.test(base)) return true;
  return segs
    .slice(0, -1)
    .some((s) => s === '__tests__' || s === '__mocks__' || s === 'tests');
}

function dimSecretPattern(repo) {
  const scan = walkFiles(repo, ['.ts', '.tsx', '.js', '.jsx', '.mjs', '.cjs']);
  const rules = [
    {
      re: /\b(api[_-]?key|secret|token|password|passwd)\s*[:=]\s*['"`][^'"`]{4,}['"`]/i,
      category: '疑似硬编码密钥/密码',
      severity: 'P1',
      redact: true,
      // 含 `${` 的命中一律不算：模板串里有插值 = 值在运行时计算，按定义不可能是
      // 硬编码常量。实测 mivo-canvas-plugin 的 scripts/loops/bug-doctor/state.mjs:220
      //   const token = `${process.pid}-${Date.now().toString(36)}-...`
      // 被本规则误判为 P1，而它是生成的锁 token。不加这道判据，管道第一条真发
      // issue 就会是误报。纯反引号字面量(无 ${)仍会被捕获，不放过真问题。
      rejectInterpolated: true,
    },
    { re: /dangerouslySetInnerHTML/, category: 'dangerouslySetInnerHTML 使用', severity: 'P2', redact: false },
    { re: /\beval\s*\(/, category: 'eval() 使用', severity: 'P2', redact: false },
  ];
  const findings = [];
  const occ = makeOccurrenceIndexer();
  for (const abs of scan.files) {
    const content = readTextOrNull(abs);
    if (content == null) continue;
    const lines = content.split('\n');
    const rel = relFile(repo, abs);
    const inTest = isTestPath(rel);
    for (const rule of rules) {
      for (let i = 0; i < lines.length; i++) {
        // 用 exec 而非 test：需要拿到命中文本本身做插值判据。rule.re 未带 g 标志，
        // 故 exec 无 lastIndex 残留问题。
        const m = rule.re.exec(lines[i]);
        if (!m) continue;
        // `${` 只可能来自值那一侧（键侧是固定字面量枚举），故检查整段命中即可。
        if (rule.rejectInterpolated && m[0].includes('${')) continue;
        const lineNo = i + 1;
        // 测试文件一律压到 P3（理由见 isTestPath 的注释）。对本已是 P2 的规则
        // (dangerouslySetInnerHTML / eval) 无路由影响，P2 与 P3 都进汇总；
        // 真正被此规则挡住的是凭据规则的 P1 → 不再占用单发通道。
        const severity = inTest ? 'P3' : rule.severity;
        const testSuffix = inTest ? `（测试文件，severity 由 ${rule.severity} 降级为 P3）` : '';
        const evidence = rule.redact
          ? `${rule.category}（值已脱敏）@L${lineNo}${testSuffix}`
          : `${rule.category}: ${lines[i].trim().slice(0, 120)}${testSuffix}`;
        const normalizedLine = normalizeContent(lines[i]);
        // 锚点对实际行文本做 sha256，而不是把原文写进种子——即便是需脱敏的密钥类规则，
        // 参与锚点计算也只落一个 16 位摘要，不会把明文泄露进 fingerprint。
        const anchor = `${sha256(normalizedLine).slice(0, 16)}#${occ(`${rel}|${rule.category}|${normalizedLine}`)}`;
        findings.push({
          dim: 'secret-pattern',
          file: rel,
          line: lineNo,
          category: rule.category,
          evidence,
          severity,
          verify: `sed -n '${lineNo}p' ${shellQuote(rel)}`,
          fingerprint: fingerprint(rel, 'secret-pattern', rule.category, anchor),
        });
      }
    }
  }
  return { status: 'ok', findings, note: scanNote(scan) };
}

// ---------- 维度 7: circular-dep ----------

function dimCircularDep(repo) {
  const srcDir = path.join(repo, 'src');
  if (!existsSync(srcDir)) return { status: 'n_a', findings: [], note: '目标仓无 src 目录' };
  const madgeBin = path.join(repo, 'node_modules', '.bin', 'madge');
  if (!existsSync(madgeBin)) {
    return {
      status: 'n_a',
      findings: [],
      note: '目标仓 node_modules/.bin 无 madge 本地二进制，circular-dep 维度跳过（夜巡禁止通过 npx 联网拉取未锁定依赖；需目标仓自行把 madge 装进本地依赖）',
    };
  }
  // R3 修复(Finding #R3-3)：n_a 仅限"本地二进制不存在"这一种情况(上面的 existsSync 分支)。
  // 走到这里已确认二进制存在并已尝试启动执行，此后任何失败(启动/执行失败、执行超时)都不再
  // 算"不可用"，而算执行失败，必须计入"败"桶参与对账——否则超时会静默滑进 n_a，让对账行看
  // 起来比实际更健康，也让真实的执行故障从来不会被人发现。
  const res = runSync(madgeBin, ['--circular', '--extensions', 'ts,tsx', 'src'], { cwd: repo, timeout: MADGE_TIMEOUT_MS });
  if (res.error) {
    throw new Error(
      `madge 已确认本地二进制存在但启动/执行失败(不属于"本地二进制不存在"的 n_a 场景，判定为执行失败): ${res.error.message}`
    );
  }
  if (res.timedOut) {
    throw new Error(`madge 执行超时(>${MADGE_TIMEOUT_MS}ms)，判定为执行失败(不属于"本地二进制不存在"的 n_a 场景，需计入败)`);
  }
  const out = res.stdout || '';
  // R3 修复(Finding #R3-2)：非零退出一律判定为执行失败，不论 stdout 里是否恰好解析出循环链
  // 或恰好写着"No circular dependency found"——非零退出本身就说明这次输出不可信，不能因为
  // "碰巧解析到了点东西"就放行成 ok。这个判断必须在下面两处基于 stdout 内容的分支之前。
  if (res.status !== 0) {
    throw new Error(
      `madge 非零退出(exit=${res.status})，判定为执行失败而非"无循环依赖"或可信的已解析结果（非零退出时 stdout 里即便恰好解析出循环链或写着"No circular dependency found"，也不代表结果可信）: ${(res.stderr || out).trim().slice(0, 300)}`
    );
  }
  if (/No circular dependency found/i.test(out)) return { status: 'ok', findings: [] };

  const findings = [];
  for (const raw of out.split('\n')) {
    const line = raw.trim();
    if (!line) continue;
    const m = line.match(/^\d+\)\s*(.+)$/);
    if (!m) continue;
    const chain = m[1];
    const members = chain.split('>').map((s) => s.trim()).filter(Boolean);
    if (members.length === 0) continue;
    // 图级锚点：环成员排序后 join——同一个环无论 madge 从哪个成员开始报告、无论报告顺序
    // 是否逐日变化，都得到同一指纹；file 字段也取排序后的首个成员，保证与指纹口径一致。
    const sortedMembers = [...members].sort();
    const representative = sortedMembers[0];
    const anchor = sortedMembers.join('>');
    findings.push({
      dim: 'circular-dep',
      file: `src/${representative}`,
      line: 0,
      category: '循环依赖',
      evidence: `循环链: ${chain}`,
      severity: 'P2',
      verify: 'node_modules/.bin/madge --circular --extensions ts,tsx src',
      fingerprint: fingerprint(`src/${representative}`, 'circular-dep', '循环依赖', anchor),
    });
  }

  // 假绿修复：madge 有输出但一条循环链都没解析出来——不再伪造一条"格式未识别"的 P3
  // finding 掩盖过去。走到这里 status 必为 0(非零已在上面统一 throw)，仅需处理"正常退出但
  // 格式变了/不认识"这一种情况，判定为维度 error，交给人核实，而不是悄悄报告 ok。
  if (findings.length === 0) {
    throw new Error(
      `madge 正常退出(status=0)但输出既非 "No circular dependency found" 也未匹配到已知的循环链格式，判定为输出格式不识别: ${out.trim().slice(0, 300)}`
    );
  }
  return { status: 'ok', findings };
}

// ---------- 维度 8: test-health ----------

function dimTestHealth(repo) {
  const NEW_FILE_WINDOW_DAYS = 30;
  const findings = [];
  const occ = makeOccurrenceIndexer();

  const scan = walkFiles(repo, ['.ts', '.tsx', '.js', '.jsx']);
  for (const abs of scan.files) {
    const content = readTextOrNull(abs);
    if (content == null) continue;
    const lines = content.split('\n');
    const rel = relFile(repo, abs);
    for (let i = 0; i < lines.length; i++) {
      const m = lines[i].match(/\.(skip|only)\s*\(/);
      if (!m) continue;
      const evidence = `.${m[1]}( 残留: ${lines[i].trim().slice(0, 120)}`;
      const normalizedLine = normalizeContent(lines[i]);
      const anchor = `${sha256(normalizedLine).slice(0, 16)}#${occ(`${rel}|${normalizedLine}`)}`;
      findings.push({
        dim: 'test-health',
        file: rel,
        line: i + 1,
        category: '测试健康度',
        evidence,
        severity: m[1] === 'only' ? 'P1' : 'P2',
        verify: `grep -n '\\.${m[1]}(' ${shellQuote(rel)}`,
        fingerprint: fingerprint(rel, 'test-health', '测试健康度', anchor),
      });
    }
  }

  const srcDir = path.join(repo, 'src');
  if (existsSync(srcDir)) {
    const res = runSync('git', ['log', `--since=${NEW_FILE_WINDOW_DAYS}.days`, '--diff-filter=A', '--name-only', '--format=', '--', 'src'], { cwd: repo });
    if (!res.error && !res.timedOut && res.status === 0) {
      const added = [...new Set(res.stdout.split('\n').map((l) => l.trim()).filter(Boolean))];
      for (const relAdded of added) {
        if (!/\.(ts|tsx|js|jsx)$/.test(relAdded)) continue;
        if (/\.(test|spec)\.[jt]sx?$/.test(relAdded)) continue;
        if (isDenylisted(relAdded)) continue;
        const abs = path.join(repo, relAdded);
        if (!existsSync(abs)) continue;
        const dir = path.dirname(abs);
        const base = path.basename(relAdded).replace(/\.[jt]sx?$/, '');
        const candidates = [
          path.join(dir, `${base}.test.ts`),
          path.join(dir, `${base}.test.tsx`),
          path.join(dir, `${base}.spec.ts`),
          path.join(dir, `${base}.spec.tsx`),
          path.join(dir, '__tests__', `${base}.test.ts`),
          path.join(dir, '__tests__', `${base}.test.tsx`),
        ];
        if (candidates.some((c) => existsSync(c))) continue;
        const evidence = `新增(近${NEW_FILE_WINDOW_DAYS}天)且无同名/同目录测试文件`;
        findings.push({
          dim: 'test-health',
          file: relAdded,
          line: 0,
          category: '测试健康度',
          evidence,
          severity: 'P3',
          verify: `ls "$(dirname ${shellQuote(relAdded)})"`,
          fingerprint: fingerprint(relAdded, 'test-health', '测试健康度', 'missing-test-file'),
        });
      }
    }
  }

  return {
    status: 'ok',
    findings,
    note: `${scanNote(scan)} | "新增"窗口取近 ${NEW_FILE_WINDOW_DAYS} 天（契约未明确此参数，脚本内约定值；超窗口后未测文件不再由本维度捕获，覆盖性判断另见 G3 anchor-map）`,
  };
}

// ---------- 维度 9: debt-metric ----------

function loadTargetTypescript(repo) {
  if (!existsSync(path.join(repo, 'node_modules', 'typescript', 'package.json'))) return null;
  try {
    const req = createRequire(path.join(repo, 'package.json'));
    return req('typescript');
  } catch {
    return null;
  }
}

function findLongFunctionsTs(ts, sourceText, fileName, threshold) {
  const scriptKind = fileName.endsWith('.tsx') ? ts.ScriptKind.TSX : ts.ScriptKind.TS;
  const sf = ts.createSourceFile(fileName, sourceText, ts.ScriptTarget.Latest, true, scriptKind);
  const results = [];
  function visit(node) {
    const isFnLike =
      ts.isFunctionDeclaration(node) ||
      ts.isFunctionExpression(node) ||
      ts.isArrowFunction(node) ||
      ts.isMethodDeclaration(node) ||
      ts.isGetAccessor(node) ||
      ts.isSetAccessor(node) ||
      ts.isConstructorDeclaration(node);
    if (isFnLike && node.body) {
      const start = sf.getLineAndCharacterOfPosition(node.getStart(sf)).line + 1;
      const end = sf.getLineAndCharacterOfPosition(node.getEnd()).line + 1;
      const span = end - start + 1;
      if (span > threshold) {
        let name = null;
        if (node.name && typeof node.name.getText === 'function') {
          try {
            name = node.name.getText(sf);
          } catch {
            name = null;
          }
        }
        // 规范化函数头（从函数起点到函数体起点之间的源码片段，如 "(state) => "）。两个
        // span/结束行完全相同的嵌套匿名函数（如 `() => set((state) => {...})`），外层的
        // 函数头是 "() => "，内层是 "(state) => "——按行号无法区分，按函数头文本可以。
        const headerStart = node.getStart(sf);
        const headerEnd = node.body.getStart(sf);
        const headerRaw = headerEnd > headerStart ? sourceText.slice(headerStart, headerEnd) : '';
        results.push({ startLine: start, endLine: end, span, name, headerRaw });
      }
    }
    ts.forEachChild(node, visit);
  }
  visit(sf);
  return results;
}

function dimDebtMetric(repo) {
  const FILE_LINE_THRESHOLD = 300;
  const FUNC_LINE_THRESHOLD = 80;
  const scan = walkFiles(repo, ['.ts', '.tsx', '.js', '.jsx']);
  const findings = [];
  const occFn = makeOccurrenceIndexer();

  for (const abs of scan.files) {
    const content = readTextOrNull(abs);
    if (content == null) continue;
    const lineCount = content.split('\n').length;
    if (lineCount > FILE_LINE_THRESHOLD) {
      const rel = relFile(repo, abs);
      const evidence = `文件 ${lineCount} 行 (>${FILE_LINE_THRESHOLD})`;
      findings.push({
        dim: 'debt-metric',
        file: rel,
        // D-B：文件级 finding，line 用 0 sentinel；行数只作为 evidence 的观测字段，不占用
        // line（原实现把 lineCount 塞进 line 字段，既不符合"line=行号"的语义，也让下游
        // 展示 file+line 时把文件行数误当成"第几行"）。
        line: 0,
        category: '文件超长',
        evidence,
        severity: 'P3',
        verify: `wc -l ${shellQuote(rel)}`,
        // 文件级：固定字面量锚点，不含行数——同一文件"还是超长"这件事的身份不该随着
        // 逐日增减的具体行数而变化（否则每天都是新指纹，debt-metric 的 delta 也没法做）。
        fingerprint: fingerprint(rel, 'debt-metric', '文件超长', 'file-too-long'),
      });
    }
  }

  const ts = loadTargetTypescript(repo);
  let tsNote;
  if (!ts) {
    tsNote = '目标仓 node_modules 无 typescript，函数超长检测已跳过，仅报告文件超长指标';
  } else {
    for (const abs of scan.files.filter((f) => /\.(ts|tsx)$/.test(f))) {
      const content = readTextOrNull(abs);
      if (content == null) continue;
      const rel = relFile(repo, abs);
      let longFns;
      try {
        longFns = findLongFunctionsTs(ts, content, abs, FUNC_LINE_THRESHOLD);
      } catch {
        continue; // 单文件 AST 解析失败不阻断整维度
      }
      for (const fn of longFns) {
        const displayName = fn.name ?? '(anonymous)';
        const evidence = `函数 ${displayName} 共 ${fn.span} 行 (>${FUNC_LINE_THRESHOLD}, L${fn.startLine}-L${fn.endLine})`;
        const funcAnchorBase = fn.name
          ? `name:${normalizeContent(fn.name)}`
          : `header:${sha256(normalizeContent(fn.headerRaw)).slice(0, 16)}`;
        const anchor = `${funcAnchorBase}#${occFn(`${rel}|${funcAnchorBase}`)}`;
        findings.push({
          dim: 'debt-metric',
          file: rel,
          line: fn.startLine,
          category: '函数超长',
          evidence,
          severity: 'P3',
          verify: `sed -n '${fn.startLine},${fn.endLine}p' ${shellQuote(rel)} | wc -l`,
          fingerprint: fingerprint(rel, 'debt-metric', '函数超长', anchor),
        });
      }
    }
  }
  const note = tsNote ? `${scanNote(scan)} | ${tsNote}` : scanNote(scan);
  return { status: 'ok', findings, note };
}

// ---------- 维度分发表 ----------

const DIM_FN = {
  'deps-vuln': dimDepsVuln,
  'dead-code': dimDeadCode,
  'todo-stale': dimTodoStale,
  'log-violation': dimLogViolation,
  'type-escape': dimTypeEscape,
  'secret-pattern': dimSecretPattern,
  'circular-dep': dimCircularDep,
  'test-health': dimTestHealth,
  'debt-metric': dimDebtMetric,
};

// ---------- CLI / worker / orchestrator ----------

function parseArgs(argv) {
  const args = { _: [] };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a.startsWith('--')) {
      const key = a.slice(2);
      const next = argv[i + 1];
      if (next !== undefined && !next.startsWith('--')) {
        args[key] = next;
        i += 1;
      } else {
        args[key] = true;
      }
    } else {
      args._.push(a);
    }
  }
  return args;
}

function runWorker(args) {
  // 注意: 大 findings 数组序列化后可能超过管道单次写入的同步缓冲，process.exit() 会在
  // 写入完全 flush 前截断 stdout（父进程收到不完整 JSON）。这里只设 exitCode，让
  // Node 事件循环在 write 真正完成后自然退出，不强制 exit。
  const dim = args._worker;
  const repo = args.repo;
  const fn = DIM_FN[dim];
  if (!fn || typeof repo !== 'string') {
    process.exitCode = 1;
    process.stdout.write(JSON.stringify({ ok: false, error: `未知维度或缺少 --repo: dim=${dim}` }));
    return;
  }
  try {
    const result = fn(repo);
    process.exitCode = 0;
    process.stdout.write(JSON.stringify({ ok: true, ...result }));
  } catch (e) {
    process.exitCode = 1;
    process.stdout.write(JSON.stringify({ ok: false, error: String((e && e.message) || e) }));
  }
}

function spawnDimension(dim, repo) {
  return new Promise((resolve) => {
    const start = Date.now();
    const child = spawn(process.execPath, [__filename, '--_worker', dim, '--repo', repo], {
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    let stdout = '';
    let stderr = '';
    let timedOut = false;
    const timer = setTimeout(() => {
      timedOut = true;
      child.kill('SIGKILL');
    }, DIM_TIMEOUT_MS);

    child.stdout.on('data', (d) => {
      stdout += d;
    });
    child.stderr.on('data', (d) => {
      stderr += d;
    });

    child.on('error', (err) => {
      clearTimeout(timer);
      resolve({ dim, bucket: 'error', durationMs: Date.now() - start, note: `子进程启动失败: ${err.message}`, findings: [] });
    });

    child.on('close', (code, signal) => {
      clearTimeout(timer);
      const durationMs = Date.now() - start;
      if (timedOut) {
        resolve({ dim, bucket: 'error', durationMs, note: `超时(>${DIM_TIMEOUT_MS}ms)已强杀`, findings: [] });
        return;
      }
      let parsed;
      try {
        parsed = JSON.parse(stdout.trim());
      } catch {
        resolve({
          dim,
          bucket: 'error',
          durationMs,
          note: `子进程输出非 JSON(exit=${code},signal=${signal}): ${(stderr || stdout || '').slice(0, 300)}`,
          findings: [],
        });
        return;
      }
      if (!parsed.ok) {
        resolve({ dim, bucket: 'error', durationMs, note: parsed.error || '未知错误', findings: [] });
        return;
      }
      if (parsed.status === 'n_a') {
        resolve({ dim, bucket: 'n_a', durationMs, note: parsed.note || '', findings: [] });
        return;
      }
      resolve({ dim, bucket: 'ok', durationMs, note: parsed.note || '', findings: parsed.findings || [] });
    });
  });
}

// ---------- fingerprint 唯一性断言 ----------

function findFingerprintCollisions(findings) {
  const seen = new Map();
  const collisions = [];
  for (const f of findings) {
    if (seen.has(f.fingerprint)) {
      collisions.push({ fingerprint: f.fingerprint, first: seen.get(f.fingerprint), duplicate: f });
    } else {
      seen.set(f.fingerprint, f);
    }
  }
  return collisions;
}

// ---------- debt-metric 与上日对比 ----------

function extractLineCountFromEvidence(evidence) {
  const m = String(evidence).match(/(\d+)\s*行/);
  return m ? Number(m[1]) : null;
}

function computeDebtMetricDelta(todayFindings, yesterdayFindings) {
  const today = todayFindings.filter((f) => f.dim === 'debt-metric');
  const yesterday = yesterdayFindings.filter((f) => f.dim === 'debt-metric');
  const todayByFp = new Map(today.map((f) => [f.fingerprint, f]));
  const yesterdayByFp = new Map(yesterday.map((f) => [f.fingerprint, f]));

  const added = [];
  const worsened = [];
  const resolved = [];

  for (const [fp, f] of todayByFp) {
    const prev = yesterdayByFp.get(fp);
    if (!prev) {
      added.push(f);
      continue;
    }
    const prevCount = extractLineCountFromEvidence(prev.evidence);
    const curCount = extractLineCountFromEvidence(f.evidence);
    if (prevCount != null && curCount != null && curCount > prevCount) {
      worsened.push({ finding: f, prevCount, curCount });
    }
  }
  for (const [fp, f] of yesterdayByFp) {
    if (!todayByFp.has(fp)) resolved.push(f);
  }
  return { added, worsened, resolved };
}

// ---------- 报告渲染（Finding #6：JSON 保留全量，晨报改为紧凑结构，行数预算 ≤200 行） ----------

function renderDimensionTable(results) {
  const lines = [];
  lines.push('## 维度执行明细');
  lines.push('');
  lines.push('| 维度 | 状态 | 耗时(ms) | finding 数 | 备注 |');
  lines.push('|---|---|---|---|---|');
  for (const r of results) {
    const statusLabel = r.bucket === 'ok' ? '成功' : r.bucket === 'n_a' ? 'n/a' : '失败';
    const note = (r.note || '').replace(/\|/g, '\\|').replace(/\n/g, ' ');
    lines.push(`| ${r.dim} | ${statusLabel} | ${r.durationMs ?? 0} | ${r.findings.length} | ${note} |`);
  }
  lines.push('');
  return lines;
}

function renderSeverityDimMatrix(results) {
  const lines = [];
  lines.push('## Severity × 维度 分布');
  lines.push('');
  lines.push('| 维度 | P0 | P1 | P2 | P3 | 小计 |');
  lines.push('|---|---|---|---|---|---|');
  const totals = { P0: 0, P1: 0, P2: 0, P3: 0 };
  for (const r of results) {
    const counts = { P0: 0, P1: 0, P2: 0, P3: 0 };
    for (const f of r.findings) {
      if (counts[f.severity] !== undefined) counts[f.severity] += 1;
    }
    const subtotal = counts.P0 + counts.P1 + counts.P2 + counts.P3;
    for (const k of ['P0', 'P1', 'P2', 'P3']) totals[k] += counts[k];
    lines.push(`| ${r.dim} | ${counts.P0} | ${counts.P1} | ${counts.P2} | ${counts.P3} | ${subtotal} |`);
  }
  const grandTotal = totals.P0 + totals.P1 + totals.P2 + totals.P3;
  lines.push(`| **合计** | **${totals.P0}** | **${totals.P1}** | **${totals.P2}** | **${totals.P3}** | **${grandTotal}** |`);
  lines.push('');
  return lines;
}

function renderHighSeverityFull(allFindings) {
  const items = allFindings
    .filter((f) => f.severity === 'P0' || f.severity === 'P1')
    .sort((a, b) => (SEVERITY_ORDER[a.severity] ?? 9) - (SEVERITY_ORDER[b.severity] ?? 9) || a.fingerprint.localeCompare(b.fingerprint));
  const lines = [];
  lines.push(`## P0/P1 全列(共 ${items.length} 条，无截断)`);
  lines.push('');
  if (items.length === 0) {
    lines.push('无 P0/P1 finding。');
  } else {
    lines.push('| severity | dim | file:line | category | evidence | fingerprint |');
    lines.push('|---|---|---|---|---|---|');
    for (const f of items) {
      const evidence = String(f.evidence).replace(/\|/g, '\\|').replace(/\n/g, ' ').slice(0, 200);
      lines.push(`| ${f.severity} | ${f.dim} | ${formatFileLine(f.file, f.line)} | ${f.category} | ${evidence} | ${f.fingerprint} |`);
    }
  }
  lines.push('');
  return lines;
}

function renderLowSeverityTop5(allFindings, findingsPath) {
  const byDim = new Map();
  for (const f of allFindings) {
    if (f.severity !== 'P2' && f.severity !== 'P3') continue;
    if (!byDim.has(f.dim)) byDim.set(f.dim, []);
    byDim.get(f.dim).push(f);
  }
  const lines = [];
  lines.push(`## P2/P3 每维 Top 5(完整记录见 \`${findingsPath}\`)`);
  lines.push('');
  if (byDim.size === 0) {
    lines.push('无 P2/P3 finding。');
    lines.push('');
    return lines;
  }
  for (const [dim, items] of byDim) {
    const sorted = [...items].sort(
      (a, b) => (SEVERITY_ORDER[a.severity] ?? 9) - (SEVERITY_ORDER[b.severity] ?? 9) || a.fingerprint.localeCompare(b.fingerprint)
    );
    const top = sorted.slice(0, 5);
    const remaining = sorted.length - top.length;
    lines.push(`### ${dim}(共 ${sorted.length} 条，展示 top ${top.length}${remaining > 0 ? `，余 ${remaining} 条见 JSON` : ''})`);
    lines.push('');
    lines.push('| severity | file:line | category | evidence | fingerprint |');
    lines.push('|---|---|---|---|---|');
    for (const f of top) {
      const evidence = String(f.evidence).replace(/\|/g, '\\|').replace(/\n/g, ' ').slice(0, 200);
      lines.push(`| ${f.severity} | ${formatFileLine(f.file, f.line)} | ${f.category} | ${evidence} | ${f.fingerprint} |`);
    }
    lines.push('');
  }
  return lines;
}

function renderDebtMetricDelta({ allFindings, yesterdayFindings, yesterdayDate }) {
  const lines = [];
  lines.push(`## debt-metric 与上日(${yesterdayDate})对比`);
  lines.push('');
  if (yesterdayFindings == null) {
    lines.push(`未找到上日产物(\`state/findings-${yesterdayDate}.json\`)，本次判定为首日基线，不计算 delta。`);
    lines.push('');
    return lines;
  }
  const { added, worsened, resolved } = computeDebtMetricDelta(allFindings, yesterdayFindings);
  lines.push(`新增 ${added.length} / 恶化 ${worsened.length} / 消失 ${resolved.length}`);
  lines.push('');
  const cap = 10;
  if (added.length > 0) {
    lines.push(`### 新增(展示前 ${Math.min(cap, added.length)}/${added.length})`);
    lines.push('');
    for (const f of added.slice(0, cap)) lines.push(`- ${formatFileLine(f.file, f.line)} — ${f.evidence}`);
    lines.push('');
  }
  if (worsened.length > 0) {
    lines.push(`### 恶化(展示前 ${Math.min(cap, worsened.length)}/${worsened.length})`);
    lines.push('');
    for (const { finding: f, prevCount, curCount } of worsened.slice(0, cap)) {
      lines.push(`- ${formatFileLine(f.file, f.line)} — ${prevCount} 行 → ${curCount} 行`);
    }
    lines.push('');
  }
  if (resolved.length > 0) {
    lines.push(`### 消失(展示前 ${Math.min(cap, resolved.length)}/${resolved.length})`);
    lines.push('');
    for (const f of resolved.slice(0, cap)) lines.push(`- ${formatFileLine(f.file, f.line)} — ${f.evidence}`);
    lines.push('');
  }
  if (added.length === 0 && worsened.length === 0 && resolved.length === 0) {
    lines.push('与上日相比无变化。');
    lines.push('');
  }
  return lines;
}

function renderCollisionFailure(collisions) {
  const lines = [];
  lines.push('## 致命错误：fingerprint 唯一性断言失败');
  lines.push('');
  lines.push(`检测到 ${collisions.length} 组指纹碰撞，判定为本工具身份种子生成逻辑自身的 bug；`);
  lines.push('本轮 **不写** `state/findings-<date>.json`（避免把不可信的去重身份交给 G2），exit(3)。');
  lines.push('');
  lines.push('| fingerprint | 记录 A | 记录 B |');
  lines.push('|---|---|---|');
  for (const c of collisions) {
    const a = `${c.first.dim}/${c.first.file}:${c.first.line}`;
    const b = `${c.duplicate.dim}/${c.duplicate.file}:${c.duplicate.line}`;
    lines.push(`| ${c.fingerprint} | ${a} | ${b} |`);
  }
  lines.push('');
  return lines;
}

// R3 修复(Finding #R3-1)：pre/post 两次 git status 快照都必须"真取到"才算数——spawnSync 的
// error!=null、timedOut、或非零退出任一命中，都说明这次没拿到可信的 porcelain 输出。原判定
// 只比较两侧 stdout 字符串，"拿不到快照"时 stdout 通常也是空串，会和另一侧真实的空 diff
// 误判为相等——把"这一轮判断不出有没有变化"当成了"确认没有变化"，是本自检机制里最该避免
// 的假绿。
function isValidGitStatusSnapshot(res) {
  return res.error == null && !res.timedOut && res.status === 0;
}

function evaluateReadOnly(preStatusOut, postStatus) {
  const postValid = isValidGitStatusSnapshot(postStatus);
  return { ok: postValid && preStatusOut === postStatus.stdout, postValid };
}

function buildReadOnlyLine({ preStatusOut, postStatus }) {
  const { ok, postValid } = evaluateReadOnly(preStatusOut, postStatus);
  if (ok) {
    return `**PASS**`;
  }
  if (!postValid) {
    return [
      '**FAIL-快照不可得**',
      '',
      `跑后 \`git status --porcelain\` 未能返回有效结果(error=${postStatus.error ? postStatus.error.message : 'null'}, ` +
        `timedOut=${postStatus.timedOut}, status=${postStatus.status})——"拿不到快照"不等于"没有变化"，判定为只读自检失败。`,
      '',
      '```diff',
      '# 跑前 status',
      preStatusOut || '(空)',
      '# 跑后 status(原始 stdout，可能不完整/不可信)',
      postStatus.stdout || '(空)',
      '```',
    ].join('\n');
  }
  return [
    '**FAIL**',
    '',
    '```diff',
    '# 跑前 status',
    preStatusOut || '(空)',
    '# 跑后 status',
    postStatus.stdout || '(空)',
    '```',
  ].join('\n');
}

function renderReport({ date, repo, results, allFindings, readOnlyLine, findingsPath, yesterdayFindings, yesterdayDate, collisions }) {
  const succeeded = results.filter((r) => r.bucket === 'ok').length;
  const failed = results.filter((r) => r.bucket === 'error').length;
  const na = results.filter((r) => r.bucket === 'n_a').length;

  const lines = [];
  lines.push(`派 ${results.length} 维度 / 成 ${succeeded} / 败 ${failed} / n_a ${na}`);
  lines.push('');
  lines.push(`# MivoSentry 夜间机械审计报告 — ${date}`);
  lines.push('');
  lines.push(`- 目标仓: \`${repo}\``);
  lines.push(`- 只读自检(跑前后 \`git status --porcelain\` 一致): ${readOnlyLine}`);
  lines.push('');

  if (collisions && collisions.length > 0) {
    lines.push(...renderCollisionFailure(collisions));
  }

  lines.push(...renderDimensionTable(results));
  lines.push(...renderSeverityDimMatrix(results));
  lines.push(...renderHighSeverityFull(allFindings));
  lines.push(...renderLowSeverityTop5(allFindings, findingsPath));
  lines.push(...renderDebtMetricDelta({ allFindings, yesterdayFindings, yesterdayDate }));

  return lines.join('\n');
}

// ---------- orchestrator ----------

async function runOrchestrator(args) {
  const repoArg = args.repo;
  if (typeof repoArg !== 'string' || !repoArg) {
    process.stderr.write('用法错误: 必须提供 --repo <目标仓绝对路径>\n');
    process.exit(1);
  }
  const repoAbs = path.resolve(repoArg);
  if (!existsSync(repoAbs)) {
    process.stderr.write(`环境错误: --repo 路径不存在: ${repoAbs}\n`);
    process.exit(2);
  }
  const gitCheck = runSync('git', ['-C', repoAbs, 'rev-parse', '--is-inside-work-tree']);
  if (gitCheck.error || gitCheck.status !== 0 || gitCheck.stdout.trim() !== 'true') {
    process.stderr.write(`环境错误: --repo 不是 git 仓: ${repoAbs}\n`);
    process.exit(2);
  }
  const repoReal = realpathSync(repoAbs);

  let requestedDims;
  if (typeof args.dims === 'string' && args.dims.trim()) {
    requestedDims = args.dims.split(',').map((s) => s.trim()).filter(Boolean);
    if (requestedDims.length === 0) {
      process.stderr.write('用法错误: --dims 解析为空列表\n');
      process.exit(1);
    }
    // Finding #9：未知/重复维度名在起 worker 前一次性校验拒绝，不再"未知维度=当场记一条
    // dim-level error 但整轮仍 exit 0"——那样会让"拼错维度名=整晚零扫描"看起来像正常完成。
    const unknown = requestedDims.filter((d) => !KNOWN_DIMS.has(d));
    if (unknown.length > 0) {
      process.stderr.write(`用法错误: --dims 含未知维度名: ${unknown.join(', ')}（合法维度: ${DIMENSIONS.join(', ')}）\n`);
      process.exit(1);
    }
    const dupSeen = new Set();
    const dupes = new Set();
    for (const d of requestedDims) {
      if (dupSeen.has(d)) dupes.add(d);
      dupSeen.add(d);
    }
    if (dupes.size > 0) {
      process.stderr.write(`用法错误: --dims 含重复维度名: ${[...dupes].join(', ')}\n`);
      process.exit(1);
    }
  } else {
    requestedDims = [...DIMENSIONS];
  }

  const outDir = path.resolve(typeof args['out-dir'] === 'string' ? args['out-dir'] : path.join(SCRIPT_REPO_ROOT, 'reports'));
  const stateDir = path.resolve(typeof args['state-dir'] === 'string' ? args['state-dir'] : path.join(SCRIPT_REPO_ROOT, 'state'));

  if (isPathInsideRepo(repoReal, outDir)) {
    process.stderr.write(
      `用法错误: --out-dir 解析后位于 --repo 内（含 symlink 穿透），拒绝执行: --out-dir=${outDir} → --repo realpath=${repoReal}\n`
    );
    process.exit(1);
  }
  if (isPathInsideRepo(repoReal, stateDir)) {
    process.stderr.write(
      `用法错误: --state-dir 解析后位于 --repo 内（含 symlink 穿透），拒绝执行: --state-dir=${stateDir} → --repo realpath=${repoReal}\n`
    );
    process.exit(1);
  }

  // Finding #1：pre 快照必须在任何 mkdir/写入之前拍下——否则一旦 out/state 目录意外落在
  // repo 内，mkdir 造成的新增内容会在"跑前"快照里就已经存在，自检永远看不出问题。
  //
  // R3 修复(Finding #R3-1)：pre 快照必须是"真取到的"才算数——只比较 stdout 会把"git 本身
  // 跑失败(非零退出/超时/spawn 错误)"和"repo 确实没有变化"混为一谈(两者常常都是空 stdout，
  // 会被误判为一致)。pre 拿不到快照时，这一轮的只读判断从起点就不可信，必须在任何 mkdir 之
  // 前直接终止(环境错误)，不能带着不可信的基线继续跑、更不能让它在 post 也拿不到时凭空拼出
  // 一个"PASS"。
  const preStatus = runSync('git', ['-C', repoAbs, 'status', '--porcelain']);
  if (!isValidGitStatusSnapshot(preStatus)) {
    process.stderr.write(
      `环境错误: 只读自检跑前 git status 快照拿不到(error=${preStatus.error ? preStatus.error.message : 'null'}, ` +
        `timedOut=${preStatus.timedOut}, status=${preStatus.status})，"拿不到快照"不等于"没有变化"，在任何写入前终止\n`
    );
    process.exit(2);
  }
  const preStatusOut = preStatus.stdout;

  mkdirSync(outDir, { recursive: true });
  mkdirSync(stateDir, { recursive: true });

  const results = [];
  for (const dim of requestedDims) {
    // eslint-disable-next-line no-await-in-loop
    const r = await spawnDimension(dim, repoAbs);
    results.push(r);
  }

  const allFindings = [];
  for (const r of results) {
    for (const f of r.findings) allFindings.push(f);
  }

  const now = new Date();
  const date = todayStr(now);
  const yesterdayDate = todayStr(addDays(now, -1));
  const findingsPath = path.join(stateDir, `findings-${date}.json`);
  const reportPath = path.join(outDir, `nightly-${date}.md`);
  const yesterdayFindingsPath = path.join(stateDir, `findings-${yesterdayDate}.json`);
  let yesterdayFindings = null;
  if (existsSync(yesterdayFindingsPath)) {
    try {
      const parsed = JSON.parse(readFileSync(yesterdayFindingsPath, 'utf8'));
      yesterdayFindings = Array.isArray(parsed) ? parsed : null;
    } catch {
      yesterdayFindings = null;
    }
  }

  // Finding #2/#3：产物写出前强制 fingerprint 唯一性断言。碰撞即判定为本工具自身 bug，
  // 不写 findings.json，不静默把不可信的去重身份交给 G2。
  const collisions = findFingerprintCollisions(allFindings);
  if (collisions.length > 0) {
    const provisional = renderReport({
      date,
      repo: repoAbs,
      results,
      allFindings,
      readOnlyLine: 'pending（写入后复检中，若看到这行说明复检未覆盖本文件，请重跑）',
      findingsPath,
      yesterdayFindings,
      yesterdayDate,
      collisions,
    });
    writeFileSync(reportPath, provisional, 'utf8');
    const postStatusCol = runSync('git', ['-C', repoAbs, 'status', '--porcelain']);
    const finalCol = renderReport({
      date,
      repo: repoAbs,
      results,
      allFindings,
      readOnlyLine: buildReadOnlyLine({ preStatusOut, postStatus: postStatusCol }),
      findingsPath,
      yesterdayFindings,
      yesterdayDate,
      collisions,
    });
    writeFileSync(reportPath, finalCol, 'utf8');

    process.stderr.write(`致命错误: 检测到 ${collisions.length} 组 fingerprint 碰撞，判定为身份种子生成逻辑 bug，不写 ${findingsPath}\n`);
    for (const c of collisions) {
      process.stderr.write(`  fp=${c.fingerprint}: ${c.first.dim}/${c.first.file}:${c.first.line} <-> ${c.duplicate.dim}/${c.duplicate.file}:${c.duplicate.line}\n`);
    }
    process.stdout.write(`报告(含碰撞诊断): ${reportPath}\n`);
    process.exit(3);
  }

  writeFileSync(findingsPath, `${JSON.stringify(allFindings, null, 2)}\n`, 'utf8');

  // Finding #1：先用占位自检文案写一次报告——真实自检结果必须来自"写完全部产物后"的
  // post 快照，两阶段写入镜像 scripts/anchor/anchor-map.mjs 已验证过的模式。
  const provisionalReport = renderReport({
    date,
    repo: repoAbs,
    results,
    allFindings,
    readOnlyLine: 'pending（写入后复检中，若看到这行说明复检未覆盖本文件，请重跑）',
    findingsPath,
    yesterdayFindings,
    yesterdayDate,
    collisions: null,
  });
  writeFileSync(reportPath, provisionalReport, 'utf8');

  // post 快照必须在全部产物（findings.json + 本报告首次写入）写完之后。
  const postStatus = runSync('git', ['-C', repoAbs, 'status', '--porcelain']);
  const { ok: readOnlyOk, postValid: postSnapshotValid } = evaluateReadOnly(preStatusOut, postStatus);

  const finalReport = renderReport({
    date,
    repo: repoAbs,
    results,
    allFindings,
    readOnlyLine: buildReadOnlyLine({ preStatusOut, postStatus }),
    findingsPath,
    yesterdayFindings,
    yesterdayDate,
    collisions: null,
  });
  writeFileSync(reportPath, finalReport, 'utf8');

  const succeeded = results.filter((r) => r.bucket === 'ok').length;
  const failed = results.filter((r) => r.bucket === 'error').length;
  const na = results.filter((r) => r.bucket === 'n_a').length;
  process.stdout.write(`派 ${results.length} 维度 / 成 ${succeeded} / 败 ${failed} / n_a ${na}\n`);
  process.stdout.write(`报告: ${reportPath}\n`);
  process.stdout.write(`findings: ${findingsPath}\n`);
  process.stdout.write(`只读自检: ${readOnlyOk ? 'PASS' : postSnapshotValid ? 'FAIL' : 'FAIL-快照不可得'}\n`);

  // Finding #1：目标仓状态在本轮运行期间发生变化——或跑后快照本身拿不到、判不出"到底有没有
  // 变化"——都必须显式失败，不能 exit 0。"拿不到快照"不是"没有变化"的证据（R3 修复）。
  if (!readOnlyOk) {
    process.stderr.write(
      `致命错误: 目标仓 git status 在运行前后发生变化或跑后快照不可得，判定为只读契约被破坏\n跑前:\n${preStatusOut}\n` +
        `跑后(原始 stdout，若快照不可得则不代表 repo 真实状态):\n${postStatus.stdout}\n`
    );
    process.exit(4);
  }
  process.exit(0);
}

// ---------- --sample 模式（Finding #10：样例文档从真实 findings JSON 自动抽选渲染，禁手改） ----------

function buildSampleDoc({ findings, reportText, generatedAt, perGroup, maxSample }) {
  const tallyLine = (reportText.split('\n')[0] || '').trim();
  const dimTableMatch = reportText.match(/## 维度执行明细\n\n([\s\S]*?)\n\n##/);
  const dimTable = dimTableMatch ? dimTableMatch[1] : '(未能从报告提取维度执行明细表)';
  const repoLineMatch = reportText.match(/^- 目标仓:.*$/m);
  const readonlyLineMatch = reportText.match(/^- 只读自检.*$/m);

  const bySeverityThenDim = new Map();
  for (const f of findings) {
    if (!bySeverityThenDim.has(f.severity)) bySeverityThenDim.set(f.severity, new Map());
    const byDim = bySeverityThenDim.get(f.severity);
    if (!byDim.has(f.dim)) byDim.set(f.dim, []);
    byDim.get(f.dim).push(f);
  }

  const sample = [];
  outer: for (const sev of ['P0', 'P1', 'P2', 'P3']) {
    const byDim = bySeverityThenDim.get(sev);
    if (!byDim) continue;
    for (const [, items] of byDim) {
      const sorted = [...items].sort((a, b) => a.fingerprint.localeCompare(b.fingerprint));
      for (const item of sorted.slice(0, perGroup)) {
        if (sample.length >= maxSample) continue outer;
        sample.push(item);
      }
    }
  }

  const lines = [];
  lines.push('# G1 夜间机械审计 — 样例晨报');
  lines.push('');
  lines.push(`> 本文件由 \`node scripts/audit/nightly-audit.mjs --sample\` 于 ${generatedAt} 自动生成，`);
  lines.push('> 严禁手工编辑（手改会在下次重新生成时被覆盖，且违反"样例必须可复现、条数如实"的要求）。');
  lines.push(
    `> 完整 finding 数 = ${findings.length}，本文件展示按 severity×dim 分层抽样的 ${sample.length} 条` +
      `（每个 severity×dim 组合至多 ${perGroup} 条，样例总量上限 ${maxSample} 条；完整产物见运行时生成的` +
      ' state/findings-<date>.json + reports/nightly-<date>.md，均为运行产物，不入库）。'
  );
  lines.push('');
  lines.push(tallyLine);
  lines.push('');
  lines.push('# MivoSentry 夜间机械审计报告（样例节选）');
  lines.push('');
  if (repoLineMatch) lines.push(repoLineMatch[0]);
  if (readonlyLineMatch) lines.push(readonlyLineMatch[0]);
  lines.push('');
  lines.push('## 维度执行明细');
  lines.push('');
  lines.push(dimTable);
  lines.push('');
  lines.push(`## Findings 抽样(完整 ${findings.length} 条，本样例 ${sample.length} 条)`);
  lines.push('');
  if (sample.length === 0) {
    lines.push('（本次运行无 finding，样例为空。）');
  } else {
    lines.push('| severity | dim | file | line | category | evidence | fingerprint |');
    lines.push('|---|---|---|---|---|---|---|');
    for (const f of sample) {
      const evidence = String(f.evidence).replace(/\|/g, '\\|').replace(/\n/g, ' ').slice(0, 200);
      lines.push(`| ${f.severity} | ${f.dim} | ${f.file} | ${f.line} | ${f.category} | ${evidence} | ${f.fingerprint} |`);
    }
  }
  lines.push('');
  return lines.join('\n');
}

function runSampleMode(args) {
  const findingsArg = args.findings;
  const reportArg = args.report;
  const outArg = args.out;
  if (typeof findingsArg !== 'string' || typeof reportArg !== 'string' || typeof outArg !== 'string') {
    process.stderr.write('用法错误: --sample 需要 --findings <path> --report <path> --out <path>\n');
    process.exit(1);
  }
  const findingsPath = path.resolve(findingsArg);
  const reportPath = path.resolve(reportArg);
  const outPath = path.resolve(outArg);

  let findings;
  try {
    findings = JSON.parse(readFileSync(findingsPath, 'utf8'));
  } catch (e) {
    process.stderr.write(`环境错误: --findings 读取/解析失败(${findingsPath}): ${e.message}\n`);
    process.exit(2);
  }
  if (!Array.isArray(findings)) {
    process.stderr.write(`环境错误: --findings 内容必须是数组: ${findingsPath}\n`);
    process.exit(2);
  }

  let reportText;
  try {
    reportText = readFileSync(reportPath, 'utf8');
  } catch (e) {
    process.stderr.write(`环境错误: --report 读取失败(${reportPath}): ${e.message}\n`);
    process.exit(2);
  }

  const perGroup = typeof args['per-group'] === 'string' ? Number(args['per-group']) : 3;
  const maxSample = typeof args['max-sample'] === 'string' ? Number(args['max-sample']) : 30;

  const doc = buildSampleDoc({ findings, reportText, generatedAt: new Date().toISOString(), perGroup, maxSample });
  writeFileSync(outPath, doc, 'utf8');
  process.stdout.write(`已生成样例: ${outPath}（完整 ${findings.length} 条）\n`);
  process.exit(0);
}

async function main() {
  const args = parseArgs(process.argv.slice(2));
  if (args._worker) {
    runWorker(args);
    return;
  }
  if (args.sample) {
    runSampleMode(args);
    return;
  }
  await runOrchestrator(args);
}

// 仅在本文件作为脚本直接执行（含被 spawnDimension fork 出的 --_worker 子进程，两者的
// process.argv[1] 都指向本文件）时才自动跑；被测试代码 `import` 时不应有任何副作用，
// 否则单测无法安全引入下面导出的纯函数做单元覆盖。
// 用 pathToFileURL 而非手拼 `file://${...}`——本仓路径含空格（"Project MivoSentry"），
// import.meta.url 会把空格等字符 URL 编码成 %20，手拼字符串不会，直接比较永远不等。
const isMainModule = process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href;
if (isMainModule) {
  main().catch((e) => {
    process.stderr.write(`未捕获错误: ${(e && e.stack) || e}\n`);
    process.exit(2);
  });
}

export {
  fingerprint,
  findFingerprintCollisions,
  shellQuote,
  normalizeContent,
  isDenylisted,
  isTestPath,
  formatFileLine,
  resolveRealWithMissingTail,
  isPathInsideRepo,
};
