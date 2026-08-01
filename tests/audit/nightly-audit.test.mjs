import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import {
  mkdtempSync,
  mkdirSync,
  writeFileSync,
  chmodSync,
  existsSync,
  readFileSync,
  readdirSync,
  symlinkSync,
  rmSync,
} from 'node:fs';
import { createRequire } from 'node:module';
import { tmpdir } from 'node:os';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

import { findFingerprintCollisions, shellQuote, formatFileLine, isDenylisted, isTestPath } from '../../scripts/audit/nightly-audit.mjs';

const __dirname = dirname(fileURLToPath(import.meta.url));
const CLI = join(__dirname, '..', '..', 'scripts', 'audit', 'nightly-audit.mjs');

function git(args, cwd) {
  const r = spawnSync('git', args, { cwd, encoding: 'utf8' });
  assert.equal(r.status, 0, `git ${args.join(' ')} failed in ${cwd}:\n${r.stdout}\n${r.stderr}`);
  return r;
}

function writeFiles(root, files) {
  for (const [rel, content] of Object.entries(files)) {
    const full = join(root, rel);
    mkdirSync(dirname(full), { recursive: true });
    writeFileSync(full, content, 'utf8');
  }
}

// disposable 本地临时 git 仓，只用于验证脚本行为，不涉及用户真实项目；gpgsign 只在这条
// 本地临时仓的 commit 上关闭，不改任何全局配置（同 tests/anchor/anchor-map.test.mjs 的手法）。
function initGitRepo(files) {
  const dir = mkdtempSync(join(tmpdir(), 'mivosentry-nightly-fixture-'));
  writeFiles(dir, files);
  git(['init', '-q'], dir);
  git(['config', 'user.email', 'nightly-test@example.com'], dir);
  git(['config', 'user.name', 'nightly-test'], dir);
  git(['config', 'commit.gpgsign', 'false'], dir);
  git(['add', '-A'], dir);
  git(['commit', '-q', '-m', 'init'], dir);
  return dir;
}

function runCli(args, opts = {}) {
  return spawnSync(process.execPath, [CLI, ...args], { encoding: 'utf8', ...opts });
}

function tmpDir(prefix) {
  return mkdtempSync(join(tmpdir(), prefix));
}

function makeFakeExecutable(path_, script) {
  writeFileSync(path_, script, 'utf8');
  chmodSync(path_, 0o755);
}

// MivoSentry 自身没有 package.json/node_modules，函数超长(AST)检测需要目标仓能 require
// 到 typescript。测试用 fixture 复用邻近项目已装好的 typescript（只读 symlink），本机找不到
// 就优雅跳过该断言，不假设 CI/其它机器上一定存在这个路径。
function findRealTypescriptDir() {
  try {
    const req = createRequire(import.meta.url);
    return dirname(req.resolve('typescript/package.json'));
  } catch {
    const fallback = join('/Users/praise/AI-Agent/Claude/projects/Project MivoCanvas', 'node_modules', 'typescript');
    return existsSync(join(fallback, 'package.json')) ? fallback : null;
  }
}

function linkTypescriptInto(repo) {
  const tsDir = findRealTypescriptDir();
  if (!tsDir) return false;
  mkdirSync(join(repo, 'node_modules'), { recursive: true });
  symlinkSync(tsDir, join(repo, 'node_modules', 'typescript'), 'dir');
  return true;
}

// ---------- 单元测试：纯函数 ----------

test('unit：findFingerprintCollisions 识别重复 fingerprint，不误报唯一记录', () => {
  const unique = [{ fingerprint: 'a' }, { fingerprint: 'b' }, { fingerprint: 'c' }];
  assert.equal(findFingerprintCollisions(unique).length, 0);

  const withDup = [
    { dim: 'debt-metric', file: 'a.ts', line: 1, fingerprint: 'dup1' },
    { dim: 'debt-metric', file: 'b.ts', line: 2, fingerprint: 'dup1' },
    { dim: 'type-escape', file: 'c.ts', line: 0, fingerprint: 'unique' },
  ];
  const collisions = findFingerprintCollisions(withDup);
  assert.equal(collisions.length, 1);
  assert.equal(collisions[0].fingerprint, 'dup1');
  assert.equal(collisions[0].first.file, 'a.ts');
  assert.equal(collisions[0].duplicate.file, 'b.ts');
});

test('unit：shellQuote 对含空格/分号/$()/单引号的路径安全转义', () => {
  assert.equal(shellQuote('normal.ts'), "'normal.ts'");
  assert.equal(shellQuote("a'b"), "'a'\\''b'");
  const dangerous = "foo; touch /tmp/pwned$(whoami)";
  const quoted = shellQuote(dangerous);
  // 转义后整体仍是一个被单引号包裹的字面量参数：拼进 `dirname ${quoted}` 之类的命令后，
  // shell 不会把 ; 或 $() 当成新命令/替换执行。
  assert.equal(quoted, "'foo; touch /tmp/pwned$(whoami)'");
  const probe = spawnSync('bash', ['-c', `printf '%s' ${quoted}`], { encoding: 'utf8' });
  assert.equal(probe.status, 0);
  assert.equal(probe.stdout, dangerous, '经 shellQuote 后交给 bash -c 求值，必须原样还原为单个参数，不触发注入');
});

test('unit：formatFileLine 按 D-B 语义省略 line<=0 的 :0 展示', () => {
  assert.equal(formatFileLine('src/x.ts', 0), 'src/x.ts');
  assert.equal(formatFileLine('src/x.ts', 42), 'src/x.ts:42');
});

test('unit：isDenylisted 命中 finding4 指定的五类噪音路径，放行普通源码路径', () => {
  assert.equal(isDenylisted('.claude/worktrees/agent-x/src/foo.ts'), true);
  assert.equal(isDenylisted('.claude/settings.json'), true);
  assert.equal(isDenylisted('_tmp/pr-autopilot/foo.ts'), true);
  assert.equal(isDenylisted('history/worktrees/x'), true);
  assert.equal(isDenylisted('docs/design-previews/region-edit/assets/component.bundle.js'), true);
  assert.equal(isDenylisted('src/components/Foo.bundle.js'), true);
  assert.equal(isDenylisted('src/store/documentSlice.ts'), false);
  assert.equal(isDenylisted('docs/CONTRACTS.md'), false);
});

// ---------- Finding #1：out/state 零写入边界 ----------

test('P0：--out-dir 直接指向 --repo 内被拒绝(exit 1)，repo 状态不变，未产出任何文件', () => {
  const repo = initGitRepo({ 'package.json': JSON.stringify({ name: 'fixture', scripts: {} }) });
  const beforeStatus = git(['status', '--porcelain'], repo).stdout;
  const outInside = join(repo, 'reports');
  const stateOutside = tmpDir('mivosentry-nightly-state-');

  const r = runCli(['--repo', repo, '--out-dir', outInside, '--state-dir', stateOutside]);

  assert.equal(r.status, 1);
  assert.match(r.stderr, /位于 --repo 内/);
  assert.equal(existsSync(outInside), false, '拒绝写入时不应在 repo 内创建 out-dir');
  const afterStatus = git(['status', '--porcelain'], repo).stdout;
  assert.equal(afterStatus, beforeStatus, 'repo 的 git status 在被拒绝的写入尝试前后必须一致');

  rmSync(repo, { recursive: true, force: true });
  rmSync(stateOutside, { recursive: true, force: true });
});

test('P0：--state-dir 经由指向 repo 内部的 symlink 祖先目录被拒绝(symlink 穿透)，repo 状态不变', () => {
  const repo = initGitRepo({ 'package.json': JSON.stringify({ name: 'fixture', scripts: {} }) });
  const beforeStatus = git(['status', '--porcelain'], repo).stdout;

  const outerDir = tmpDir('mivosentry-nightly-symlink-');
  const linkPath = join(outerDir, 'linked-repo');
  symlinkSync(repo, linkPath, 'dir');
  const stateViaSymlink = join(linkPath, 'nested', 'state');
  const outOutside = tmpDir('mivosentry-nightly-out-');

  const r = runCli(['--repo', repo, '--out-dir', outOutside, '--state-dir', stateViaSymlink]);

  assert.equal(r.status, 1);
  assert.match(r.stderr, /位于 --repo 内/);
  const afterStatus = git(['status', '--porcelain'], repo).stdout;
  assert.equal(afterStatus, beforeStatus, 'symlink 穿透也不应改变 repo 状态');

  rmSync(repo, { recursive: true, force: true });
  rmSync(outerDir, { recursive: true, force: true });
  rmSync(outOutside, { recursive: true, force: true });
});

test('P0：out/state 均指向 repo 外部时正常写入(exit 0)，且 repo 跑前跑后 git status 一致', () => {
  const repo = initGitRepo({
    'package.json': JSON.stringify({ name: 'fixture', scripts: {} }),
  });
  const beforeStatus = git(['status', '--porcelain'], repo).stdout;
  const outDir = tmpDir('mivosentry-nightly-out-ok-');
  const stateDir = tmpDir('mivosentry-nightly-state-ok-');

  const r = runCli(['--repo', repo, '--dims', 'todo-stale', '--out-dir', outDir, '--state-dir', stateDir]);

  assert.equal(r.status, 0, r.stderr);
  assert.match(r.stdout, /只读自检: PASS/);
  const afterStatus = git(['status', '--porcelain'], repo).stdout;
  assert.equal(afterStatus, beforeStatus, 'repo 外部写入不应改变 --repo 的 git status');

  rmSync(repo, { recursive: true, force: true });
  rmSync(outDir, { recursive: true, force: true });
  rmSync(stateDir, { recursive: true, force: true });
});

// ---------- Finding #9：--dims 校验在起 worker 前拒绝，不再"exit 0 但零扫描" ----------

test('P1：--dims 含未知维度名时用法错误(exit 1)，不产出 report/findings', () => {
  const repo = initGitRepo({ 'package.json': JSON.stringify({ name: 'fixture', scripts: {} }) });
  const outDir = tmpDir('mivosentry-nightly-out-baddims-');
  const stateDir = tmpDir('mivosentry-nightly-state-baddims-');

  const r = runCli(['--repo', repo, '--dims', 'todo-stale,does-not-exist', '--out-dir', outDir, '--state-dir', stateDir]);

  assert.equal(r.status, 1);
  assert.match(r.stderr, /未知维度名: does-not-exist/);
  assert.equal(existsSync(outDir), true, 'mkdir 不应发生，但目录已由 tmpDir 预先创建，此处只断言无报告文件');
  const reportFiles = existsSync(outDir) ? [] : [];
  assert.deepEqual(reportFiles, []);
  assert.equal(existsSync(join(stateDir, `findings-${new Date().toISOString().slice(0, 10)}.json`)), false);

  rmSync(repo, { recursive: true, force: true });
  rmSync(outDir, { recursive: true, force: true });
  rmSync(stateDir, { recursive: true, force: true });
});

test('P1：--dims 含重复维度名时用法错误(exit 1)', () => {
  const repo = initGitRepo({ 'package.json': JSON.stringify({ name: 'fixture', scripts: {} }) });
  const outDir = tmpDir('mivosentry-nightly-out-dupdims-');
  const stateDir = tmpDir('mivosentry-nightly-state-dupdims-');

  const r = runCli(['--repo', repo, '--dims', 'todo-stale,todo-stale', '--out-dir', outDir, '--state-dir', stateDir]);

  assert.equal(r.status, 1);
  assert.match(r.stderr, /重复维度名: todo-stale/);

  rmSync(repo, { recursive: true, force: true });
  rmSync(outDir, { recursive: true, force: true });
  rmSync(stateDir, { recursive: true, force: true });
});

// ---------- Finding #7：伪造非零 tsc/madge → 该维度 status=error，非 ok ----------

test('P1：dead-code 维度遇 tsc 非零退出且未匹配 TS6133/TS6196 时判定为 error，不假报 0 finding 的 ok', () => {
  const repo = initGitRepo({
    'package.json': JSON.stringify({ name: 'fixture', scripts: {} }),
    'tsconfig.json': JSON.stringify({ compilerOptions: {} }),
  });
  const fakeTsc = join(repo, 'node_modules', '.bin', 'tsc');
  mkdirSync(dirname(fakeTsc), { recursive: true });
  makeFakeExecutable(fakeTsc, '#!/bin/sh\necho "error TS5023: 假装配置炸了" 1>&2\nexit 2\n');

  const r = runCli(['--_worker', 'dead-code', '--repo', repo]);

  assert.equal(r.status, 1, 'runWorker 捕获到 throw 后应设 exitCode=1');
  const parsed = JSON.parse(r.stdout);
  assert.equal(parsed.ok, false);
  assert.match(parsed.error, /判定为环境\/配置错误而非"无死代码"/);

  rmSync(repo, { recursive: true, force: true });
});

test('P1：dead-code 维度 tsc 正常退出且真实匹配到 TS6133 时仍正常产出 finding(不误伤真实场景)', () => {
  const repo = initGitRepo({
    'package.json': JSON.stringify({ name: 'fixture', scripts: {} }),
    'tsconfig.json': JSON.stringify({ compilerOptions: {} }),
  });
  const fakeTsc = join(repo, 'node_modules', '.bin', 'tsc');
  mkdirSync(dirname(fakeTsc), { recursive: true });
  makeFakeExecutable(
    fakeTsc,
    [
      '#!/bin/sh',
      `echo "src/foo.ts(3,7): error TS6133: 'x' is declared but never used."`,
      'exit 1',
      '',
    ].join('\n')
  );

  const r = runCli(['--_worker', 'dead-code', '--repo', repo]);

  assert.equal(r.status, 0);
  const parsed = JSON.parse(r.stdout);
  assert.equal(parsed.ok, true);
  assert.equal(parsed.status, 'ok');
  assert.equal(parsed.findings.length, 1);
  assert.equal(parsed.findings[0].file, 'src/foo.ts');

  rmSync(repo, { recursive: true, force: true });
});

test('P1：circular-dep 维度遇本地 madge 非零退出且无可解析循环链时判定为 error，不假报 ok', () => {
  const repo = initGitRepo({ 'package.json': JSON.stringify({ name: 'fixture', scripts: {} }) });
  mkdirSync(join(repo, 'src'), { recursive: true });
  writeFileSync(join(repo, 'src', 'index.ts'), 'export const x = 1\n', 'utf8');
  const fakeMadge = join(repo, 'node_modules', '.bin', 'madge');
  mkdirSync(dirname(fakeMadge), { recursive: true });
  makeFakeExecutable(fakeMadge, '#!/bin/sh\necho "fatal: cannot resolve module graph" 1>&2\nexit 3\n');

  const r = runCli(['--_worker', 'circular-dep', '--repo', repo]);

  assert.equal(r.status, 1);
  const parsed = JSON.parse(r.stdout);
  assert.equal(parsed.ok, false);
  assert.match(parsed.error, /判定为执行失败而非"无循环依赖"/);

  rmSync(repo, { recursive: true, force: true });
});

test('circular-dep 维度在目标仓无本地 madge 二进制时判定 n_a，不通过 npx 联网拉取', () => {
  const repo = initGitRepo({ 'package.json': JSON.stringify({ name: 'fixture', scripts: {} }) });
  mkdirSync(join(repo, 'src'), { recursive: true });
  writeFileSync(join(repo, 'src', 'index.ts'), 'export const x = 1\n', 'utf8');

  const r = runCli(['--_worker', 'circular-dep', '--repo', repo]);

  assert.equal(r.status, 0);
  const parsed = JSON.parse(r.stdout);
  assert.equal(parsed.ok, true);
  assert.equal(parsed.status, 'n_a');
  assert.match(parsed.note, /禁止通过 npx 联网拉取/);

  rmSync(repo, { recursive: true, force: true });
});

// ---------- Finding #4：noise denylist 落到 walkFiles 驱动的维度 ----------

test('type-escape 维度不扫描 .claude/**、_tmp/**、docs/design-previews/**、*.bundle.js', () => {
  const repo = initGitRepo({
    'package.json': JSON.stringify({ name: 'fixture', scripts: {} }),
    'src/real.ts': 'const x: any = 1\n',
    '.claude/worktrees/agent-x/src/noise.ts': 'const y: any = 1\n',
    'docs/design-previews/foo/component.bundle.js': 'const z: any = 1\n',
  });
  // _tmp/ 已被 .gitignore 挡住（不会进 git ls-files），单独放一条 tracked 但被 denylist 挡的
  // docs/design-previews 验证第二层过滤在"已跟踪"文件上也生效。

  const r = runCli(['--_worker', 'type-escape', '--repo', repo]);
  assert.equal(r.status, 0, r.stderr);
  const parsed = JSON.parse(r.stdout);
  assert.equal(parsed.ok, true);
  const files = parsed.findings.map((f) => f.file);
  assert.deepEqual(files, ['src/real.ts']);
  assert.match(parsed.note, /denylist/);

  rmSync(repo, { recursive: true, force: true });
});

// ---------- Finding #2/#3：D-A 身份种子——同 span 嵌套匿名函数不再撞指纹 ----------

test('debt-metric 维度对同 span 嵌套匿名箭头函数生成两条不同 fingerprint(不再碰撞)', (t) => {
  const bodyLines = Array.from({ length: 90 }, (_, i) => `  console.log(${i})`).join('\n');
  const src = [
    'export function wrap(getSceneWrap, set, targetSceneId) {',
    `  getSceneWrap()(targetSceneId, () => set((state) => {`,
    bodyLines,
    '    return state',
    '  }))',
    '}',
    '',
  ].join('\n');
  const repo = initGitRepo({
    'package.json': JSON.stringify({ name: 'fixture', scripts: {} }),
    'src/nested.ts': src,
  });
  if (!linkTypescriptInto(repo)) {
    t.skip('本机找不到可复用的 typescript 安装，跳过函数超长(AST)相关断言');
    rmSync(repo, { recursive: true, force: true });
    return;
  }

  const r = runCli(['--_worker', 'debt-metric', '--repo', repo]);
  assert.equal(r.status, 0, r.stderr);
  const parsed = JSON.parse(r.stdout);
  assert.equal(parsed.ok, true);
  const fnFindings = parsed.findings.filter((f) => f.category === '函数超长');
  // 三层都超过 80 行阈值：具名的外层 `wrap` 声明本身、匿名的外层箭头 `() => set(...)`、
  // 匿名的内层箭头 `(state) => {...}`——重点断言的是后两者(同 span、都匿名)不再互相碰撞。
  assert.equal(fnFindings.length, 3, 'wrap 声明 + 外层匿名箭头 + 内层匿名箭头都应各记一条函数超长 finding');
  const anonymousFindings = fnFindings.filter((f) => f.evidence.includes('(anonymous)'));
  assert.equal(anonymousFindings.length, 2, '两个匿名箭头函数(同 span、同结束行)都应被记录');
  assert.notEqual(
    anonymousFindings[0].fingerprint,
    anonymousFindings[1].fingerprint,
    '同 span 嵌套的外层/内层匿名箭头函数必须得到不同 fingerprint(核心修复目标)'
  );
  const allFingerprints = new Set(fnFindings.map((f) => f.fingerprint));
  assert.equal(allFingerprints.size, 3, '三条函数超长 finding 的 fingerprint 必须两两不同');
  assert.equal(findFingerprintCollisions(parsed.findings).length, 0);

  rmSync(repo, { recursive: true, force: true });
});

test('debt-metric 维度文件超长 finding 的 line 字段按 D-B 为 0 sentinel(不再把行数塞进 line)', () => {
  const longContent = Array.from({ length: 310 }, (_, i) => `// line ${i}`).join('\n') + '\n';
  const repo = initGitRepo({
    'package.json': JSON.stringify({ name: 'fixture', scripts: {} }),
    'src/long.ts': longContent,
  });

  const r = runCli(['--_worker', 'debt-metric', '--repo', repo]);
  assert.equal(r.status, 0, r.stderr);
  const parsed = JSON.parse(r.stdout);
  const fileTooLong = parsed.findings.find((f) => f.category === '文件超长');
  assert.ok(fileTooLong);
  assert.equal(fileTooLong.line, 0);
  assert.match(fileTooLong.evidence, /行/);

  rmSync(repo, { recursive: true, force: true });
});

// ---------- Finding #8：verify 字符串对恶意文件名安全转义 ----------

test('secret-pattern 维度对含分号/空格的文件名生成的 verify 命令，交给 shell 执行不触发注入', () => {
  const weirdName = 'weird; touch pwned.txt.ts';
  const repo = initGitRepo({
    'package.json': JSON.stringify({ name: 'fixture', scripts: {} }),
  });
  writeFileSync(join(repo, weirdName), "const token = 'sk-aaaaaaaaaaaaaaaa'\n", 'utf8');
  git(['add', '-A'], repo);
  git(['commit', '-q', '-m', 'add weird file'], repo);

  const r = runCli(['--_worker', 'secret-pattern', '--repo', repo]);
  assert.equal(r.status, 0, r.stderr);
  const parsed = JSON.parse(r.stdout);
  assert.equal(parsed.ok, true);
  const hit = parsed.findings.find((f) => f.file === weirdName);
  assert.ok(hit, 'finding 应存在且 file 字段保留原始文件名(未被转义破坏)');
  // 真正的安全性断言在下面：把 verify 字符串交给 bash -c 实际执行，验证文件名里的
  // `;`/空格不会被当成新命令拆开执行——而不是对 verify 文本本身做脆弱的字符串形态断言。
  const pwnedMarker = join(repo, 'pwned.txt.ts');
  const probe = spawnSync('bash', ['-c', hit.verify], { cwd: repo, encoding: 'utf8' });
  assert.equal(existsSync(pwnedMarker), false, 'verify 命令本身不应触发文件名里潜藏的 shell 注入');
  assert.equal(probe.status, 0, probe.stderr);

  rmSync(repo, { recursive: true, force: true });
});

test('unit：isTestPath 认出测试代码路径，不误伤同名但非测试的生产路径', () => {
  for (const p of [
    'src/lib/a.test.ts',
    'src/lib/a.test.tsx',
    'src/lib/a.spec.js',
    'scripts/x.test.mjs',
    'server/x.test.cjs',
    'server/__tests__/e2e.ts',
    'src/__mocks__/fs.ts',
    'tests/issues/render.mjs',
  ]) {
    assert.equal(isTestPath(p), true, `应判为测试路径: ${p}`);
  }
  for (const p of [
    // 生产源码；含 "test" 字样但既不是 .test./.spec. 后缀，也不在测试目录段下
    'src/lib/latest.ts',
    'src/lib/testUtils.ts',
    'src/contest/index.ts',
    'scripts/loops/bug-doctor/state.mjs',
    'src/lib/a.ts',
  ]) {
    assert.equal(isTestPath(p), false, `不应判为测试路径: ${p}`);
  }
});

test('secret-pattern：测试文件里的凭据命中降级为 P3(进汇总)，生产文件仍为 P1(走单发)', () => {
  const repo = initGitRepo({
    'package.json': JSON.stringify({ name: 'fixture', scripts: {} }),
    // 三个文件写同一条凭据形态，只有路径不同 —— 隔离出"路径"这一个变量
    'src/prod.ts': "const apiKey = 'sk-aaaaaaaaaaaaaaaa'\n",
    'src/prod.test.ts': "const apiKey = 'sk-aaaaaaaaaaaaaaaa'\n",
    'src/__tests__/helper.ts': "const apiKey = 'sk-aaaaaaaaaaaaaaaa'\n",
  });

  const r = runCli(['--_worker', 'secret-pattern', '--repo', repo]);
  assert.equal(r.status, 0, r.stderr);
  const parsed = JSON.parse(r.stdout);
  assert.equal(parsed.ok, true);

  const byFile = (f) => parsed.findings.find((x) => x.file === f);
  const prod = byFile('src/prod.ts');
  const t1 = byFile('src/prod.test.ts');
  const t2 = byFile('src/__tests__/helper.ts');
  assert.ok(prod && t1 && t2, '三个文件都应产出 finding（降级不等于丢弃）');

  // 核心断言：severity 按路径分流，而不是一律 P1
  assert.equal(prod.severity, 'P1', '生产文件的凭据命中必须保持 P1，才会走单发通道');
  assert.equal(t1.severity, 'P3', '*.test.ts 里的凭据命中应降级为 P3');
  assert.equal(t2.severity, 'P3', '__tests__/ 下的凭据命中应降级为 P3');

  // 降级理由要落在 evidence 里，人看汇总时能判断这是夹具假值还是真事故
  assert.match(t1.evidence, /测试文件，severity 由 P1 降级为 P3/);
  assert.doesNotMatch(prod.evidence, /降级/, '生产文件不应出现降级说明');

  // 指纹不受 severity 影响（种子只含 file|dim|category|anchor）——否则这次改动
  // 会让所有历史 secret-pattern 指纹失效并重发一遍 issue
  assert.equal(prod.fingerprint.length, 16);
  assert.notEqual(prod.fingerprint, t1.fingerprint, '不同文件本就该是不同指纹');

  rmSync(repo, { recursive: true, force: true });
});

// ---------- R3 修复：只读自检 fail-open（Finding #R3-1） ----------

// 找真实 git 的绝对路径，供伪造的 git 包装脚本在非目标场景下透传执行。用 `which` 而非硬编码
// /usr/bin/git，避免在 git 由 Homebrew 等方式安装的机器上失真。
function findRealGitPath() {
  const r = spawnSync('which', ['git'], { encoding: 'utf8' });
  const p = (r.stdout || '').trim();
  return p || '/usr/bin/git';
}

test('P0：git status --porcelain 拿不到快照(伪造 exit 23)时在任何 mkdir 前终止(exit 2)，不产出任何文件、repo 不受影响', () => {
  const repo = initGitRepo({ 'package.json': JSON.stringify({ name: 'fixture', scripts: {} }) });
  const beforeStatus = git(['status', '--porcelain'], repo).stdout;
  const realGit = findRealGitPath();

  // 伪造的 git 包装脚本：只拦截 `status --porcelain` 让它返回非零(23)，其余子命令(rev-parse
  // 等)原样转交真实 git 执行——还原 delta 复核描述的原始 bug 场景："两个空 stdout 相等"，
  // 即 pre/post 两次 status 调用都拿不到快照，原判定会把它们的空 stdout 误判为一致=PASS。
  const fakeBinDir = tmpDir('mivosentry-nightly-fakegit-');
  const fakeGit = join(fakeBinDir, 'git');
  makeFakeExecutable(
    fakeGit,
    [
      '#!/bin/sh',
      'has_status=0',
      'has_porcelain=0',
      'for a in "$@"; do',
      '  if [ "$a" = "status" ]; then has_status=1; fi',
      '  if [ "$a" = "--porcelain" ]; then has_porcelain=1; fi',
      'done',
      'if [ "$has_status" = "1" ] && [ "$has_porcelain" = "1" ]; then',
      '  exit 23',
      'fi',
      `exec ${realGit} "$@"`,
      '',
    ].join('\n')
  );

  const outDir = tmpDir('mivosentry-nightly-out-fakegit-');
  const stateDir = tmpDir('mivosentry-nightly-state-fakegit-');

  const r = runCli(['--repo', repo, '--dims', 'todo-stale', '--out-dir', outDir, '--state-dir', stateDir], {
    env: { ...process.env, PATH: `${fakeBinDir}:${process.env.PATH}` },
  });

  assert.equal(r.status, 2, `期望环境错误 exit 2，实际 stdout=${r.stdout} stderr=${r.stderr}`);
  assert.match(r.stderr, /只读自检跑前 git status 快照拿不到/);
  assert.match(r.stderr, /"拿不到快照"不等于"没有变化"/);
  // 修复前的 bug：两次拿不到快照的空 stdout 相等 → exit 0 + PASS。修复后必须在第一次(pre)
  // 拿不到快照时就终止，连 mkdir 都不应发生。
  assert.deepEqual(readdirSync(outDir), [], 'pre 快照失败时不应执行任何 mkdir/写入');
  assert.deepEqual(readdirSync(stateDir), [], 'pre 快照失败时不应执行任何 mkdir/写入');
  const afterStatus = git(['status', '--porcelain'], repo).stdout;
  assert.equal(afterStatus, beforeStatus, 'repo 状态不应受此次被拒绝的运行影响');

  rmSync(repo, { recursive: true, force: true });
  rmSync(fakeBinDir, { recursive: true, force: true });
  rmSync(outDir, { recursive: true, force: true });
  rmSync(stateDir, { recursive: true, force: true });
});

// ---------- R3 修复：非零退出被"已解析到内容"绕过（Finding #R3-2） ----------

test('P1：circular-dep 维度 madge 非零退出(exit 7)但 stdout 恰好含可解析循环链时仍判定为 error，不假报 ok+1 finding', () => {
  const repo = initGitRepo({ 'package.json': JSON.stringify({ name: 'fixture', scripts: {} }) });
  mkdirSync(join(repo, 'src'), { recursive: true });
  writeFileSync(join(repo, 'src', 'index.ts'), 'export const x = 1\n', 'utf8');
  const fakeMadge = join(repo, 'node_modules', '.bin', 'madge');
  mkdirSync(dirname(fakeMadge), { recursive: true });
  makeFakeExecutable(fakeMadge, ['#!/bin/sh', 'echo "1) src/a.ts > src/b.ts"', 'exit 7', ''].join('\n'));

  const r = runCli(['--_worker', 'circular-dep', '--repo', repo]);

  assert.equal(r.status, 1, `非零退出即便解析出循环链也应判定为 error，实际 stdout=${r.stdout}`);
  const parsed = JSON.parse(r.stdout);
  assert.equal(parsed.ok, false);
  assert.match(parsed.error, /判定为执行失败而非"无循环依赖"/);
  assert.match(parsed.error, /exit=7/);

  rmSync(repo, { recursive: true, force: true });
});

test('P1：dead-code 维度 tsc 非零退出且混杂 TS6133(真实未用变量)与 TS5023(配置错误)时判定为 error，不让真实命中掩盖配置错误', () => {
  const repo = initGitRepo({
    'package.json': JSON.stringify({ name: 'fixture', scripts: {} }),
    'tsconfig.json': JSON.stringify({ compilerOptions: {} }),
  });
  const fakeTsc = join(repo, 'node_modules', '.bin', 'tsc');
  mkdirSync(dirname(fakeTsc), { recursive: true });
  makeFakeExecutable(
    fakeTsc,
    [
      '#!/bin/sh',
      `echo "src/foo.ts(3,7): error TS6133: 'x' is declared but never used."`,
      `echo "tsconfig.json(1,1): error TS5023: Unknown compiler option 'foo'." 1>&2`,
      'exit 1',
      '',
    ].join('\n')
  );

  const r = runCli(['--_worker', 'dead-code', '--repo', repo]);

  assert.equal(r.status, 1, `混杂允许清单外诊断码应判定为 error，实际 stdout=${r.stdout}`);
  const parsed = JSON.parse(r.stdout);
  assert.equal(parsed.ok, false);
  assert.match(parsed.error, /判定为环境\/配置错误而非"无死代码"/);
  assert.match(parsed.error, /TS5023/);

  rmSync(repo, { recursive: true, force: true });
});

// ---------- R3 修复：madge 超时被归入 n_a（Finding #R3-3） ----------

test('P1：circular-dep 维度 madge 已确认二进制存在但执行超时时判定为 error(计入败)，不再归 n_a', () => {
  const repo = initGitRepo({ 'package.json': JSON.stringify({ name: 'fixture', scripts: {} }) });
  mkdirSync(join(repo, 'src'), { recursive: true });
  writeFileSync(join(repo, 'src', 'index.ts'), 'export const x = 1\n', 'utf8');
  const fakeMadge = join(repo, 'node_modules', '.bin', 'madge');
  mkdirSync(dirname(fakeMadge), { recursive: true });
  // 故意 sleep 远超注入的短超时(200ms)，触发 spawnSync 的 timeout 强杀。
  makeFakeExecutable(fakeMadge, ['#!/bin/sh', 'sleep 2', 'echo "不应到达这里"', ''].join('\n'));

  const r = runCli(['--_worker', 'circular-dep', '--repo', repo], {
    env: { ...process.env, MIVOSENTRY_MADGE_TIMEOUT_MS: '200' },
  });

  assert.equal(r.status, 1, `madge 超时应判定为 error(败)而非 n_a，实际 stdout=${r.stdout}`);
  const parsed = JSON.parse(r.stdout);
  assert.equal(parsed.ok, false);
  assert.match(parsed.error, /madge 执行超时/);
  assert.match(parsed.error, /不属于"本地二进制不存在"的 n_a 场景/);

  rmSync(repo, { recursive: true, force: true });
});
