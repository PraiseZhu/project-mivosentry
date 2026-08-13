import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdtempSync, copyFileSync, readFileSync, writeFileSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

import { run } from '../../scripts/issues/issue-gate.mjs';

const __dirname = dirname(fileURLToPath(import.meta.url));
const CLI = join(__dirname, '..', '..', 'scripts', 'issues', 'issue-gate.mjs');
const FIXTURES = join(__dirname, 'fixtures');
const FINDINGS = join(FIXTURES, 'findings-2026-08-01.json');
const SEED_STORE = join(FIXTURES, 'seed-fingerprints.json');
const REPORT_STUB = join(FIXTURES, 'reports', 'nightly-2026-08-01.md');
const REPO = 'xindong/mivo-canvas-plugin';

function tmpFile(name) {
  const dir = mkdtempSync(join(tmpdir(), 'mivosentry-gate-'));
  return join(dir, name);
}

function tmpFindingsFile(findings) {
  const p = tmpFile('findings.json');
  writeFileSync(p, JSON.stringify(findings), 'utf8');
  return p;
}

/** 直接调用 run() 并捕获 log/error 输出，代替 spawn 子进程——这样才能给 execGh 做依赖注入。 */
function makeCapture() {
  const logs = [];
  const errors = [];
  return {
    opts: {
      log: (...a) => logs.push(a.map(String).join(' ')),
      error: (...a) => errors.push(a.map(String).join(' ')),
    },
    get stdout() {
      return logs.join('\n');
    },
    get stderr() {
      return errors.join('\n');
    },
  };
}

/** 伪造 gh 执行器：不触网，按调用序号决定成功/失败，记录每次调用的 args/env 供断言。 */
function makeFakeExecGh({ failOn = new Set(), urlPrefix = 'https://github.com/xindong/mivo-canvas-plugin/issues/' } = {}) {
  let n = 0;
  const calls = [];
  const fn = async (args, env) => {
    n += 1;
    calls.push({ n, args, env });
    if (failOn.has(n)) {
      throw new Error(`模拟第 ${n} 次 gh 调用失败`);
    }
    return `${urlPrefix}${1000 + n}\n`;
  };
  Object.defineProperty(fn, 'calls', { get: () => calls });
  Object.defineProperty(fn, 'callCount', { get: () => calls.length });
  return fn;
}

function parseCounts(stdout) {
  const m = stdout.match(/将单发 (\d+) 条 \/ 汇总 (\d+) 条 \/ 跳过已知 (\d+) 条/);
  assert.ok(m, `stdout 中未找到分流计数行:\n${stdout}`);
  const dup = stdout.match(/同批重复 (\d+) 条/);
  return { single: Number(m[1]), summary: Number(m[2]), skipped: Number(m[3]), duplicate: dup ? Number(dup[1]) : 0 };
}

const P0_A = {
  dim: 'secret-pattern',
  file: 'a.ts',
  line: 1,
  category: '疑似密钥硬编码',
  evidence: 'evidence-a',
  severity: 'P0',
  verify: 'grep a',
  fingerprint: '1111111111111111',
};
const P0_B = {
  dim: 'secret-pattern',
  file: 'b.ts',
  line: 2,
  category: '疑似密钥硬编码',
  evidence: 'evidence-b',
  severity: 'P0',
  verify: 'grep b',
  fingerprint: '2222222222222222',
};

test('SC-2a: dry-run 对 8 条夹具正确分流 —— 跳过2/单发1/汇总5(其中1条落低置信区)', async () => {
  const storePath = tmpFile('fingerprints.json');
  copyFileSync(SEED_STORE, storePath);
  const cap = makeCapture();

  const code = await run(
    ['--findings', FINDINGS, '--repo', REPO, '--store', storePath, '--report', REPORT_STUB],
    cap.opts,
  );

  assert.equal(code, 0, `期望 exit 0，stderr:\n${cap.stderr}`);
  const counts = parseCounts(cap.stdout);
  assert.deepEqual(counts, { single: 1, summary: 1, skipped: 2, duplicate: 0 });

  assert.match(cap.stdout, /## 低置信区/);
  assert.match(cap.stdout, /f3a5289629d79238/);
  assert.match(cap.stdout, /line/);

  assert.match(cap.stdout, /单发 #1/);
  assert.match(cap.stdout, /audit: 疑似密钥硬编码 — server\/lib\/config\.ts:18/);
  assert.match(cap.stdout, /labels: trae-audit, P0/);

  assert.match(cap.stdout, /派 9 维度 \/ 成 7 \/ 败 1 \/ n_a 1/);

  // store 未被 dry-run 触碰：与 seed 内容完全一致（P0#1 回归）
  assert.deepEqual(JSON.parse(readFileSync(storePath, 'utf8')), JSON.parse(readFileSync(SEED_STORE, 'utf8')));
});

test('SC-2b: dry-run 对 store 零写；随后 --send（伪造成功）才真正持久化；再 dry-run 全部已知跳过（P0#1 回归）', async () => {
  const storePath = tmpFile('fingerprints.json');

  // 第一次：dry-run，全新空 store（此路径此时甚至不存在）
  const dryCap1 = makeCapture();
  const dryCode1 = await run(['--findings', FINDINGS, '--repo', REPO, '--store', storePath], dryCap1.opts);
  assert.equal(dryCode1, 0);
  const dryCounts1 = parseCounts(dryCap1.stdout);
  assert.deepEqual(dryCounts1, { single: 1, summary: 1, skipped: 0, duplicate: 0 });
  assert.equal(existsSync(storePath), false, 'dry-run 不应创建/写入 store 文件');

  // 再跑一次 dry-run：结果应完全一致（幂等，因为 store 真的没被动过）
  const dryCap2 = makeCapture();
  const dryCode2 = await run(['--findings', FINDINGS, '--repo', REPO, '--store', storePath], dryCap2.opts);
  assert.equal(dryCode2, 0);
  assert.deepEqual(parseCounts(dryCap2.stdout), dryCounts1);
  assert.equal(existsSync(storePath), false);

  // 真正发送（伪造 gh 全部成功）：这才应该产生持久化
  const execGh = makeFakeExecGh();
  const sendCap = makeCapture();
  const tokenFile = tmpFile('token');
  writeFileSync(tokenFile, 'ghp_faketoken\n', 'utf8');
  const sendCode = await run(
    [
      '--findings', FINDINGS,
      '--repo', REPO,
      '--store', storePath,
      '--report', REPORT_STUB,
      '--commit', 'deadbeef',
      '--send',
      '--token-file', tokenFile,
    ],
    { ...sendCap.opts, execGh },
  );
  assert.equal(sendCode, 0, `stderr:\n${sendCap.stderr}`);
  // 1 条单发 + 1 次汇总调用（汇总打包 7 条），dry-run 阶段从未调用过 execGh
  assert.equal(execGh.callCount, 2);
  assert.equal(existsSync(storePath), true);
  const storeAfterSend = JSON.parse(readFileSync(storePath, 'utf8'));
  assert.equal(Object.keys(storeAfterSend.fingerprints).length, 8, 'dry-run 没吃掉任何指纹，send 应看到完整 8 条并全部落盘');

  // 现在再 dry-run：应全部已知跳过
  const dryCap3 = makeCapture();
  const dryCode3 = await run(['--findings', FINDINGS, '--repo', REPO, '--store', storePath], dryCap3.opts);
  assert.equal(dryCode3, 0);
  assert.deepEqual(parseCounts(dryCap3.stdout), { single: 0, summary: 0, skipped: 8, duplicate: 0 });
});

test('SC-2c: dry-run 全程零网络调用 —— execGh 依赖注入下从未被调用；结构守卫确认 gh 只在 send 分支可达', async () => {
  const storePath = tmpFile('fingerprints.json');
  const execGh = makeFakeExecGh();
  const cap = makeCapture();

  const code = await run(['--findings', FINDINGS, '--repo', REPO, '--store', storePath], { ...cap.opts, execGh });
  assert.equal(code, 0, `dry-run 应成功，stderr:\n${cap.stderr}`);
  assert.equal(execGh.callCount, 0, 'dry-run 不应调用注入的 execGh 一次');

  const src = readFileSync(CLI, 'utf8');
  const execFileCalls = src.match(/execFileAsync\(/g) ?? [];
  assert.equal(execFileCalls.length, 1, 'execFileAsync 调用点应恰好一处（defaultExecGh 内）');
  const defaultExecGhBody = src.slice(src.indexOf('async function defaultExecGh'), src.indexOf('function buildIsolatedGhEnv'));
  assert.match(defaultExecGhBody, /execFileAsync\(/);

  const sendAllInvocations = (src.match(/await sendAll\(/g) ?? []).length;
  assert.equal(sendAllInvocations, 1, 'sendAll 应只被调用一次');
  const invokeIdx = src.indexOf('await sendAll(');
  const guardWindow = src.slice(Math.max(0, invokeIdx - 300), invokeIdx);
  assert.match(guardWindow, /if \(args\.send\)/, 'sendAll 调用必须在 if (args.send) 守卫内');

  // --gh-bin 曾允许把 token 交给任意可执行文件，已彻底移除（P0#5）——parseArgs 不应再有对应 case
  // 分支（文档注释里提及其历史存在没问题，故只断言不存在 case 分支，不断言字符串全文零出现）
  assert.doesNotMatch(src, /case '--gh-bin'/);
});

test('SC-2c(回归): 显式传 --gh-bin 现在被当未知参数拒绝（exit 1），而不是被静默接受', async () => {
  const cap = makeCapture();
  const code = await run(['--findings', FINDINGS, '--repo', REPO, '--gh-bin', '/whatever'], cap.opts);
  assert.equal(code, 1);
  assert.match(cap.stderr, /\[用法错误\]/);
  assert.match(cap.stderr, /--gh-bin/);
});

test('SC-2d: 单发正文含 cindy 四段结构 + 指纹码 + 可执行 verify；汇总首行为对账行', async () => {
  const storePath = tmpFile('fingerprints.json');
  copyFileSync(SEED_STORE, storePath);
  const cap = makeCapture();

  const code = await run(
    ['--findings', FINDINGS, '--repo', REPO, '--store', storePath, '--report', REPORT_STUB, '--commit', 'deadbeef'],
    cap.opts,
  );
  assert.equal(code, 0);

  for (const heading of ['## 问题描述', '## 环境', '## 复现步骤', '## 日志与证据']) {
    assert.ok(cap.stdout.includes(heading), `单发正文缺少章节: ${heading}`);
  }
  assert.match(cap.stdout, /指纹: 4af81119d7a72749/);
  assert.match(cap.stdout, /grep -n "apiKey = '" server\/lib\/config\.ts/);
  assert.match(cap.stdout, /commit: deadbeef/);

  const summaryIdx = cap.stdout.indexOf('--- 汇总 ---');
  assert.notEqual(summaryIdx, -1);
  const afterSummary = cap.stdout.slice(summaryIdx);
  const bodyIdx = afterSummary.indexOf('body:');
  const firstBodyLine = afterSummary.slice(bodyIdx + 'body:\n'.length).split('\n')[0];
  assert.equal(firstBodyLine.trim(), '派 9 维度 / 成 7 / 败 1 / n_a 1');

  // L1：该夹具的低置信区里恰有一条 P1（circular-dep），顶部应出现醒目提示
  assert.match(cap.stdout, /⚠️.*P0\/P1.*低置信区/);
});

test('SC-2d(回退): 未提供 --report 且找不到对应 G1 报告时，dry-run 汇总首行如实标注回退，不编造对账数字', async () => {
  const storePath = tmpFile('fingerprints.json');
  copyFileSync(SEED_STORE, storePath);
  const cap = makeCapture();

  const code = await run(['--findings', FINDINGS, '--repo', REPO, '--store', storePath], cap.opts);
  assert.equal(code, 0);
  assert.match(cap.stdout, /\[回退\] G1 对账行缺失/);
});

test('SC-2e: 退出码 0（正常 dry-run）/ 1（用法错：缺 --findings）/ 1（findings 格式错）/ 2（store 损坏）', async () => {
  const storePathOk = tmpFile('fingerprints.json');
  const okCap = makeCapture();
  assert.equal(await run(['--findings', FINDINGS, '--repo', REPO, '--store', storePathOk], okCap.opts), 0);

  const missingArgCap = makeCapture();
  assert.equal(await run(['--repo', REPO], missingArgCap.opts), 1);
  assert.match(missingArgCap.stderr, /\[用法错误\]/);

  const badFindingsPath = tmpFile('bad-findings.json');
  writeFileSync(badFindingsPath, JSON.stringify({ not: 'an array' }), 'utf8');
  const storePathBad = tmpFile('fingerprints.json');
  const badFormatCap = makeCapture();
  assert.equal(await run(['--findings', badFindingsPath, '--repo', REPO, '--store', storePathBad], badFormatCap.opts), 1);
  assert.match(badFormatCap.stderr, /\[findings 格式错\]/);

  const corruptStorePath = tmpFile('fingerprints.json');
  writeFileSync(corruptStorePath, '{ not valid json', 'utf8');
  const corruptCap = makeCapture();
  assert.equal(await run(['--findings', FINDINGS, '--repo', REPO, '--store', corruptStorePath], corruptCap.opts), 2);
  assert.match(corruptCap.stderr, /\[store 损坏\]/);

  const storePathSend = tmpFile('fingerprints.json');
  const missingTokenCap = makeCapture();
  assert.equal(
    await run(
      ['--findings', FINDINGS, '--repo', REPO, '--store', storePathSend, '--send', '--token-file', '/nonexistent/token/path'],
      missingTokenCap.opts,
    ),
    2,
  );
  assert.match(missingTokenCap.stderr, /\[token 缺失\]/);
});

// --- P0#4 回归（CLI 层）：store 文件存在但为空字节，exit 2，不当作空库放行 ---
test('零字节 store：exit 2，报 [store 损坏]，不当作合法空库（P0#4 回归）', async () => {
  const corruptStorePath = tmpFile('fingerprints.json');
  writeFileSync(corruptStorePath, '', 'utf8');
  const cap = makeCapture();
  const code = await run(['--findings', FINDINGS, '--repo', REPO, '--store', corruptStorePath], cap.opts);
  assert.equal(code, 2);
  assert.match(cap.stderr, /\[store 损坏\]/);
});

// --- P0#5 回归：token 文件存在但内容为空/纯空白 → 拒发，且从未触发任何 gh 调用 ---
test('空 token（文件存在但内容为空白）：exit 2，[token 缺失]，execGh 从未被调用（P0#5 回归）', async () => {
  const storePath = tmpFile('fingerprints.json');
  const tokenFile = tmpFile('token');
  writeFileSync(tokenFile, '   \n\t', 'utf8');
  const execGh = makeFakeExecGh();
  const cap = makeCapture();

  const code = await run(
    ['--findings', FINDINGS, '--repo', REPO, '--store', storePath, '--send', '--token-file', tokenFile, '--commit', 'x', '--report', REPORT_STUB],
    { ...cap.opts, execGh },
  );
  assert.equal(code, 2);
  assert.match(cap.stderr, /\[token 缺失\]/);
  assert.equal(execGh.callCount, 0);
});

// --- P0#5 回归：gh 子进程环境隔离——继承的 GITHUB_TOKEN/GH_HOST 不传入，注入独立 GH_CONFIG_DIR ---
test('gh 子进程环境隔离：清除继承的 GITHUB_TOKEN/GH_* 变量，注入独立 GH_CONFIG_DIR 与本次 token（P0#5 回归）', async (t) => {
  const storePath = tmpFile('fingerprints.json');
  const tokenFile = tmpFile('token');
  writeFileSync(tokenFile, 'ghp_realtoken\n', 'utf8');
  const execGh = makeFakeExecGh();

  t.before?.(() => {});
  const prevGithubToken = process.env.GITHUB_TOKEN;
  const prevGhHost = process.env.GH_HOST;
  process.env.GITHUB_TOKEN = 'inherited-should-never-leak';
  process.env.GH_HOST = 'inherited-should-never-leak.example.com';
  try {
    const cap = makeCapture();
    const code = await run(
      ['--findings', FINDINGS, '--repo', REPO, '--store', storePath, '--send', '--token-file', tokenFile, '--commit', 'x', '--report', REPORT_STUB],
      { ...cap.opts, execGh },
    );
    assert.equal(code, 0, `stderr:\n${cap.stderr}`);
    assert.ok(execGh.callCount >= 1);
    for (const call of execGh.calls) {
      assert.equal(call.env.GH_TOKEN, 'ghp_realtoken');
      assert.notEqual(call.env.GITHUB_TOKEN, 'inherited-should-never-leak');
      assert.equal(call.env.GITHUB_TOKEN, undefined);
      assert.notEqual(call.env.GH_HOST, 'inherited-should-never-leak.example.com');
      assert.equal(call.env.GH_HOST, undefined);
      assert.equal(call.env.GH_PROMPT_DISABLED, '1');
      assert.ok(call.env.GH_CONFIG_DIR && call.env.GH_CONFIG_DIR.length > 0);
    }
  } finally {
    if (prevGithubToken === undefined) delete process.env.GITHUB_TOKEN;
    else process.env.GITHUB_TOKEN = prevGithubToken;
    if (prevGhHost === undefined) delete process.env.GH_HOST;
    else process.env.GH_HOST = prevGhHost;
  }
});

// --- P0#3 回归：同批重复指纹只单发一条；对账信息缺失时 fail-closed ---
test('同批出现两次同一指纹：dry-run 只单发 1 条，另 1 条计入同批重复（P0#3 回归）', async () => {
  const dupFindingsPath = tmpFindingsFile([
    { ...P0_A, fingerprint: 'dddddddddddddddd' },
    { ...P0_B, fingerprint: 'dddddddddddddddd' },
  ]);
  const storePath = tmpFile('fingerprints.json');
  const cap = makeCapture();
  const code = await run(['--findings', dupFindingsPath, '--repo', REPO, '--store', storePath], cap.opts);
  assert.equal(code, 0);
  const counts = parseCounts(cap.stdout);
  assert.deepEqual(counts, { single: 1, summary: 0, skipped: 0, duplicate: 1 });
});

// --- P0#3 回归：部分发送失败后重跑，已成功的不重发，失败的会重试 ---
// round-3 D-C 更新：部分发送失败的退出码从 0 改为 3（已成功持久化的行为不变，只是退出码语义变化）。
test('第 N 条失败后重跑：已成功持久化的不重发，失败的下次运行会重试（P0#3 回归 / round-3 D-C：部分失败 exit 3）', async () => {
  const findingsPath = tmpFindingsFile([P0_A, P0_B]);
  const storePath = tmpFile('fingerprints.json');
  const tokenFile = tmpFile('token');
  writeFileSync(tokenFile, 'ghp_faketoken\n', 'utf8');

  // 第一次：第 2 条（P0_B）失败
  const execGh1 = makeFakeExecGh({ failOn: new Set([2]) });
  const cap1 = makeCapture();
  const code1 = await run(
    ['--findings', findingsPath, '--repo', REPO, '--store', storePath, '--send', '--token-file', tokenFile, '--commit', 'x'],
    { ...cap1.opts, execGh: execGh1 },
  );
  assert.equal(code1, 3, `部分失败应 exit 3（round-3 D-C），stderr:\n${cap1.stderr}`);
  assert.equal(execGh1.callCount, 2);
  assert.match(cap1.stderr, /单发失败/);

  const storeAfterFirst = JSON.parse(readFileSync(storePath, 'utf8'));
  assert.ok(storeAfterFirst.fingerprints['1111111111111111'], 'P0_A 成功，应已持久化');
  assert.ok(!storeAfterFirst.fingerprints['2222222222222222'], 'P0_B 失败，不应被标记为已上报');

  // 第二次：全部成功。此时 P0_A 已知会被跳过，只应重试 P0_B
  const execGh2 = makeFakeExecGh();
  const cap2 = makeCapture();
  const code2 = await run(
    ['--findings', findingsPath, '--repo', REPO, '--store', storePath, '--send', '--token-file', tokenFile, '--commit', 'x'],
    { ...cap2.opts, execGh: execGh2 },
  );
  assert.equal(code2, 0, '全部发送成功应恢复 exit 0');
  assert.equal(execGh2.callCount, 1, '已成功的 P0_A 不应被重新发送，只应重试失败的 P0_B');

  const storeAfterSecond = JSON.parse(readFileSync(storePath, 'utf8'));
  assert.ok(storeAfterSecond.fingerprints['1111111111111111']);
  assert.ok(storeAfterSecond.fingerprints['2222222222222222']);
});

// --- round-3 修复项 #5：固化精确的三条时序（delta 席实证参数：firstRun ghCalls=3 stored=2 failures=1；
//     retry ghCalls=1 跳过已知 2） ---
test('三条时序：前2条成功→第3条失败→重跑只发第3条（P0#3 回归，delta 席实证参数）', async () => {
  const P0_C = {
    dim: 'secret-pattern',
    file: 'c.ts',
    line: 3,
    category: '疑似密钥硬编码',
    evidence: 'evidence-c',
    severity: 'P0',
    verify: 'grep c',
    fingerprint: '3333333333333333',
  };
  const findingsPath = tmpFindingsFile([P0_A, P0_B, P0_C]);
  const storePath = tmpFile('fingerprints.json');
  const tokenFile = tmpFile('token');
  writeFileSync(tokenFile, 'ghp_faketoken\n', 'utf8');

  // 第一次：前 2 条成功，第 3 条（P0_C）失败
  const execGh1 = makeFakeExecGh({ failOn: new Set([3]) });
  const cap1 = makeCapture();
  const code1 = await run(
    ['--findings', findingsPath, '--repo', REPO, '--store', storePath, '--send', '--token-file', tokenFile, '--commit', 'x'],
    { ...cap1.opts, execGh: execGh1 },
  );
  assert.equal(code1, 3, `部分失败应 exit 3，stderr:\n${cap1.stderr}`);
  assert.equal(execGh1.callCount, 3, 'firstRun 应调用 gh 3 次（P0_A/P0_B/P0_C 各一次）');

  const storeAfterFirst = JSON.parse(readFileSync(storePath, 'utf8'));
  assert.equal(Object.keys(storeAfterFirst.fingerprints).length, 2, 'firstRun 应成功落盘 2 条');
  assert.ok(storeAfterFirst.fingerprints['1111111111111111']);
  assert.ok(storeAfterFirst.fingerprints['2222222222222222']);
  assert.ok(!storeAfterFirst.fingerprints['3333333333333333']);
  assert.match(cap1.stderr, /单发失败/);

  // 第二次：全部成功；前 2 条已知应跳过，只补发第 3 条
  const execGh2 = makeFakeExecGh();
  const cap2 = makeCapture();
  const code2 = await run(
    ['--findings', findingsPath, '--repo', REPO, '--store', storePath, '--send', '--token-file', tokenFile, '--commit', 'x'],
    { ...cap2.opts, execGh: execGh2 },
  );
  assert.equal(code2, 0);
  assert.equal(execGh2.callCount, 1, 'retry 应只调用 gh 1 次（跳过已知的 2 条，只补发第 3 条）');

  const storeAfterSecond = JSON.parse(readFileSync(storePath, 'utf8'));
  assert.equal(Object.keys(storeAfterSecond.fingerprints).length, 3);
});

// --- round-3 D-C：全部发送失败（成功数 0）同样是 exit 3，不是单独的"全失败"码 ---
test('全部单发均失败：成功数 0 也是部分失败的极端，同样 exit 3，且全部指纹均未被标记为已上报', async () => {
  const findingsPath = tmpFindingsFile([P0_A, P0_B]);
  const storePath = tmpFile('fingerprints.json');
  const tokenFile = tmpFile('token');
  writeFileSync(tokenFile, 'ghp_faketoken\n', 'utf8');

  const execGh = makeFakeExecGh({ failOn: new Set([1, 2]) });
  const cap = makeCapture();
  const code = await run(
    ['--findings', findingsPath, '--repo', REPO, '--store', storePath, '--send', '--token-file', tokenFile, '--commit', 'x'],
    { ...cap.opts, execGh },
  );
  assert.equal(code, 3, `全部失败也应 exit 3（不是单独的全失败码），stderr:\n${cap.stderr}`);
  assert.equal(execGh.callCount, 2);

  // 全部失败时 save() 从未被成功调用过一次（每条都是先 markSeen 再 save，失败的那条两者都不会发生），
  // store 文件甚至不会被创建——不存在本身就是"零指纹被标记为已上报"最直接的证明。
  assert.equal(existsSync(storePath), false, '全部失败时不应有任何指纹被标记为已上报，store 文件不应被创建');
});

// --- P1#7 回归：--send 时若必需的对账信息缺失，fail-closed 拒绝发送 ---
test('--send 但存在待单发内容却未提供 --commit：exit 2，fail-closed，从不触网（P1#7 回归）', async () => {
  const storePath = tmpFile('fingerprints.json');
  const tokenFile = tmpFile('token');
  writeFileSync(tokenFile, 'ghp_faketoken\n', 'utf8');
  const execGh = makeFakeExecGh();
  const cap = makeCapture();

  const code = await run(
    ['--findings', FINDINGS, '--repo', REPO, '--store', storePath, '--send', '--token-file', tokenFile, '--report', REPORT_STUB],
    { ...cap.opts, execGh },
  );
  assert.equal(code, 2);
  assert.match(cap.stderr, /\[对账信息缺失\]/);
  assert.equal(execGh.callCount, 0);
});

test('--send 但存在待汇总内容却找不到真实 G1 对账行：exit 2，fail-closed，从不触网（P1#7 回归）', async () => {
  const storePath = tmpFile('fingerprints.json');
  const tokenFile = tmpFile('token');
  writeFileSync(tokenFile, 'ghp_faketoken\n', 'utf8');
  const execGh = makeFakeExecGh();
  const cap = makeCapture();

  const code = await run(
    ['--findings', FINDINGS, '--repo', REPO, '--store', storePath, '--send', '--token-file', tokenFile, '--commit', 'deadbeef'],
    { ...cap.opts, execGh },
  );
  assert.equal(code, 2);
  assert.match(cap.stderr, /\[对账信息缺失\]/);
  assert.equal(execGh.callCount, 0);
});

// --- CLI 入口烟雾测试：真实子进程调用（不带 --send），确认 isMain 引导仍然可用 ---
test('CLI 子进程烟雾测试：真实 `node issue-gate.mjs` dry-run 仍可正常运行并退出 0', () => {
  const storePath = tmpFile('fingerprints.json');
  const res = spawnSync(process.execPath, [
    CLI,
    '--findings', FINDINGS,
    '--repo', REPO,
    '--store', storePath,
    '--report', REPORT_STUB,
  ], { encoding: 'utf8' });
  assert.equal(res.status, 0, `stderr:\n${res.stderr}`);
  assert.match(res.stdout, /dry-run 预览/);
});

// --- round-3 修复项 #4 回归：真实子进程 + 大量 finding（>100KB 预览），确认 process.exitCode
//     （而非 process.exit()）不会在 stdout 完整落盘前提前终止进程导致输出被截断 ---
test('大量单发 issue（>100KB 预览）：真实子进程 dry-run 完整落地 stdout，不因提前退出被截断', () => {
  const N = 300;
  const bigFindings = Array.from({ length: N }, (_, i) => ({
    dim: 'secret-pattern',
    file: `src/generated/file-${i}.ts`,
    line: i + 1,
    category: '疑似密钥硬编码',
    evidence: `evidence-padding-${'x'.repeat(200)}-${i}`,
    severity: 'P0',
    verify: `grep -n 'x' src/generated/file-${i}.ts`,
    fingerprint: i.toString(16).padStart(16, '0'),
  }));
  const findingsPath = tmpFindingsFile(bigFindings);
  const storePath = tmpFile('fingerprints.json');

  const res = spawnSync(
    process.execPath,
    [CLI, '--findings', findingsPath, '--repo', REPO, '--store', storePath],
    { encoding: 'utf8', maxBuffer: 10 * 1024 * 1024 },
  );
  assert.equal(res.status, 0, `stderr:\n${res.stderr}`);
  assert.ok(res.stdout.length > 100_000, `stdout 应超过 100KB，实际 ${res.stdout.length}`);

  const previewCount = (res.stdout.match(/--- 单发 #/g) ?? []).length;
  assert.equal(previewCount, N, '全部单发预览都应完整出现，不因截断而缺失');

  const lastFp = (N - 1).toString(16).padStart(16, '0');
  assert.ok(res.stdout.trimEnd().endsWith(`指纹: ${lastFp}`), 'stdout 应完整落地到最后一条预览，不被截断');
});
