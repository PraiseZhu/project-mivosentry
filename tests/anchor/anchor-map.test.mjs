import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import {
  mkdtempSync,
  mkdirSync,
  writeFileSync,
  existsSync,
  readFileSync,
  symlinkSync,
  rmSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = dirname(fileURLToPath(import.meta.url));
const CLI = join(__dirname, '..', '..', 'scripts', 'anchor', 'anchor-map.mjs');

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

// 只在最后 commit 前调用：把 files 写入临时目录并初始化为一个干净的本地 git 仓
// （仅用于测试 anchor-map.mjs 的 `git status --porcelain` 自检逻辑，disposable，
// 不涉及用户真实项目；gpgsign 只在这条本地临时仓的 commit 上关闭，不改任何全局配置）。
function initGitRepo(files) {
  const dir = mkdtempSync(join(tmpdir(), 'mivosentry-anchor-fixture-'));
  writeFiles(dir, files);
  git(['init', '-q'], dir);
  git(['config', 'user.email', 'anchor-test@example.com'], dir);
  git(['config', 'user.name', 'anchor-test'], dir);
  git(['config', 'commit.gpgsign', 'false'], dir);
  git(['add', '-A'], dir);
  git(['commit', '-q', '-m', 'init'], dir);
  return dir;
}

function runCli(args) {
  return spawnSync(process.execPath, [CLI, ...args], { encoding: 'utf8' });
}

function tmpOutPath(name) {
  const dir = mkdtempSync(join(tmpdir(), 'mivosentry-anchor-out-'));
  return join(dir, name);
}

function parseModuleRow(mdText, modPath) {
  const re = new RegExp(
    '\\|\\s*`' + modPath.replace('/', '\\/') + '`\\s*\\|\\s*(\\d+)\\s*\\|\\s*(\\d+)\\s*\\|\\s*([^|]+?)\\s*\\|\\s*(\\d+)\\s*\\|\\s*([^|]+?)\\s*\\|'
  );
  const m = mdText.match(re);
  assert.ok(m, `未在报告中找到模块行 ${modPath}:\n${mdText}`);
  return {
    testFileCount: Number(m[1]),
    expectCount: Number(m[2]),
    coveragePct: m[3].trim(),
    skipOnlyCount: Number(m[4]),
    verdict: m[5].trim(),
  };
}

// ---------- Finding 1 (P0)：--out 边界校验 + 写入后自检 ----------

test('P0：--out 直接指向 --repo 内被拒绝，repo 状态不变，退出码非 0', () => {
  const repo = initGitRepo({
    'package.json': JSON.stringify({ name: 'fixture', scripts: {} }),
    'src/modA/foo.test.ts': "import { test } from 'node:test'\n",
  });
  const beforeStatus = git(['status', '--porcelain'], repo).stdout;
  const outInside = join(repo, 'docs', 'anchor-map.md');

  const r = runCli(['--repo', repo, '--out', outInside]);

  assert.notEqual(r.status, 0);
  assert.equal(existsSync(outInside), false, '拒绝写入时不应在 repo 内创建任何文件');
  const afterStatus = git(['status', '--porcelain'], repo).stdout;
  assert.equal(afterStatus, beforeStatus, 'repo 的 git status 在被拒绝的写入尝试前后必须一致');
  assert.match(r.stderr, /位于 --repo 内/);

  rmSync(repo, { recursive: true, force: true });
});

test('P0：--out 经由指向 repo 内部的 symlink 祖先目录被拒绝（symlink 穿透）', () => {
  const repo = initGitRepo({
    'package.json': JSON.stringify({ name: 'fixture', scripts: {} }),
    'src/modA/foo.test.ts': "import { test } from 'node:test'\n",
  });
  const beforeStatus = git(['status', '--porcelain'], repo).stdout;

  const outerDir = mkdtempSync(join(tmpdir(), 'mivosentry-anchor-symlink-'));
  const linkPath = join(outerDir, 'linked-repo');
  symlinkSync(repo, linkPath, 'dir');
  const outViaSymlink = join(linkPath, 'nested', 'anchor-map.md');

  const r = runCli(['--repo', repo, '--out', outViaSymlink]);

  assert.notEqual(r.status, 0);
  assert.match(r.stderr, /位于 --repo 内/);
  const afterStatus = git(['status', '--porcelain'], repo).stdout;
  assert.equal(afterStatus, beforeStatus, 'symlink 穿透也不应改变 repo 状态');

  rmSync(repo, { recursive: true, force: true });
  rmSync(outerDir, { recursive: true, force: true });
});

test('P0：--out 指向 repo 外部时正常写入，且 repo 跑前跑后 git status 一致', () => {
  const repo = initGitRepo({
    'package.json': JSON.stringify({ name: 'fixture', scripts: {} }),
    'src/modA/foo.test.ts': "import { test } from 'node:test'\n",
  });
  const beforeStatus = git(['status', '--porcelain'], repo).stdout;
  const out = tmpOutPath('anchor-map.md');

  const r = runCli(['--repo', repo, '--out', out]);

  assert.equal(r.status, 0, r.stderr);
  assert.equal(existsSync(out), true);
  const afterStatus = git(['status', '--porcelain'], repo).stdout;
  assert.equal(afterStatus, beforeStatus, 'repo 外部写入不应改变 --repo 的 git status');
  const md = readFileSync(out, 'utf8');
  assert.match(md, /只读自检：ok（本工具输出写入后/);

  rmSync(repo, { recursive: true, force: true });
});

// ---------- Round 2 P0（delta 复核实证的击穿点）：--out 为已存在但目标已删的悬空 symlink ----------
// existsSync 对悬空 symlink 直接返回 false，旧实现会把它误判为"字面上还不存在的
// 路径"，只对 --out 的上级目录做 realpath 再原样拼回 symlink 自身的名字——但
// writeFileSync 实际会追随这个 symlink，写入它真正指向的 --repo 内目标，从而绕过
// 边界校验。以下两个场景都必须在 assertOutOutsideRepo 阶段就被拒绝（exit=3，零写
// 入），而不是靠写入后的 git status 对比自检来"事后"发现。

test('P0（击穿点回归）：--out 为已存在但指向 --repo 内的悬空 symlink（目标不受 .gitignore 覆盖）时被拒绝，零写入', () => {
  const repo = initGitRepo({
    'package.json': JSON.stringify({ name: 'fixture', scripts: {} }),
    'src/modA/foo.test.ts': "import { test } from 'node:test'\n",
  });
  const beforeStatus = git(['status', '--porcelain'], repo).stdout;

  const targetInRepo = join(repo, 'notes', 'anchor-map.md');
  const outerDir = mkdtempSync(join(tmpdir(), 'mivosentry-anchor-dangling-'));
  const linkPath = join(outerDir, 'dangling-link.md');
  symlinkSync(targetInRepo, linkPath);

  const r = runCli(['--repo', repo, '--out', linkPath]);

  assert.notEqual(r.status, 0);
  assert.match(r.stderr, /位于 --repo 内/);
  assert.equal(existsSync(targetInRepo), false, '悬空 symlink 指向的 repo 内目标不应被创建');
  const afterStatus = git(['status', '--porcelain'], repo).stdout;
  assert.equal(afterStatus, beforeStatus, 'repo 的 git status 在被拒绝的写入尝试前后必须一致');

  rmSync(repo, { recursive: true, force: true });
  rmSync(outerDir, { recursive: true, force: true });
});

test('P0（击穿点回归，delta 席实证场景）：--out 为已存在但指向 --repo 内 .gitignore 覆盖路径的悬空 symlink 时依然被拒绝——用 ls 等价检查验证零写入', () => {
  const repo = initGitRepo({
    'package.json': JSON.stringify({ name: 'fixture', scripts: {} }),
    'src/modA/foo.test.ts': "import { test } from 'node:test'\n",
    '.gitignore': 'ignored-dir/\n',
  });
  mkdirSync(join(repo, 'ignored-dir'), { recursive: true });
  const beforeStatus = git(['status', '--porcelain'], repo).stdout;

  // 目标路径位于 .gitignore 覆盖的 ignored-dir/ 下且当前不存在（模拟"曾存在、已被
  // 删除"的悬空 symlink）。这正是本轮 delta 复核实证的击穿点：若真的发生了写入，
  // `git status --porcelain` 对 ignored 路径不可见，前后对比会显示"一致"、自检
  // 误报 ok、exit=0——所以这里改用 existsSync（等价于 ls）直接核验该文件是否被
  // 创建，而不是只依赖 git status。
  const ignoredTargetInRepo = join(repo, 'ignored-dir', 'anchor-map.md');
  const outerDir = mkdtempSync(join(tmpdir(), 'mivosentry-anchor-dangling-ignored-'));
  const linkPath = join(outerDir, 'dangling-link-ignored.md');
  symlinkSync(ignoredTargetInRepo, linkPath);

  const r = runCli(['--repo', repo, '--out', linkPath]);

  assert.notEqual(r.status, 0);
  assert.match(r.stderr, /位于 --repo 内/);
  assert.equal(
    existsSync(ignoredTargetInRepo),
    false,
    '悬空 symlink 指向 .gitignore 覆盖路径时也不应被创建（用 ls 等价的 existsSync 验证，git status 对 ignored 路径不可见，不能作为唯一证据）'
  );
  const afterStatus = git(['status', '--porcelain'], repo).stdout;
  assert.equal(afterStatus, beforeStatus, 'repo 的 git status 在被拒绝的写入尝试前后必须一致');

  rmSync(repo, { recursive: true, force: true });
  rmSync(outerDir, { recursive: true, force: true });
});

// ---------- Finding 3 + Finding 4：expect/skip/only 计数剥离注释字符串；bench 变体计入 ----------

test('计数：expect()/.skip()/.only() 剥离注释与字符串噪声；.bench.test.tsx 被计入而 .bench.test.ts 被排除', () => {
  const fooTest = [
    "// noise line comment: expect( should not be counted",
    "/* noise block comment: expect( should not be counted either */",
    "const singleQuoteNoise = 'expect( inside single-quoted string, not counted'",
    'const doubleQuoteNoise = "expect( inside double-quoted string, not counted"',
    'const templateNoise = `expect( inside template string, not counted`',
    "const regexCharClass = /['\"]/g // must not swallow following real code as an unterminated string",
    'function expect(value) { return { toBe: () => {} } }',
    'function realTestA() { expect(1).toBe(1) }',
    'function realTestB() { expect(2).toBe(2); expect(3).toBe(3) }',
    'function realSkipCase() { expect(4).toBe(4) }',
    "const describeStub = { skip: (n, f) => f(), only: (n, f) => f() }",
    "describeStub.skip('real skip call', () => {})",
    "describeStub.only('real only call', () => {})",
    "// noise: .skip( and .only( inside comment should not be counted",
    "const skipOnlyNoise = '.skip( and .only( inside string, not counted'",
    '',
  ].join('\n');

  const benchTs = [
    'function expect(value) { return { toBe: () => {} } }',
    'expect(999).toBe(999) // bench.test.ts must be excluded entirely, this must not be counted',
    '',
  ].join('\n');

  const benchTsx = [
    'function expect(value) { return { toBe: () => {} } }',
    'expect(10).toBe(10)',
    'expect(11).toBe(11)',
    '',
  ].join('\n');

  const repo = initGitRepo({
    'package.json': JSON.stringify({ name: 'fixture', scripts: {} }),
    'vitest.config.ts':
      "export default { test: { exclude: ['**/node_modules/**', '**/*.bench.test.ts'] } }\n",
    'src/modA/foo.test.ts': fooTest,
    'src/modA/foo.bench.test.ts': benchTs,
    'src/modA/foo.bench.test.tsx': benchTsx,
  });
  const out = tmpOutPath('anchor-map.md');

  const r = runCli(['--repo', repo, '--out', out]);
  assert.equal(r.status, 0, r.stderr);
  const md = readFileSync(out, 'utf8');

  const row = parseModuleRow(md, 'src/modA');
  // 只有 foo.test.ts（1 个文件）+ foo.bench.test.tsx（1 个文件）计入，foo.bench.test.ts 被排除
  assert.equal(row.testFileCount, 2, 'bench.test.ts 应被排除，bench.test.tsx 应被计入');
  // 真实 expect( 次数：foo.test.ts 里 5 个（1 个函数声明 + 4 个调用）+ foo.bench.test.tsx 里 3 个（1 declare + 2 calls）
  assert.equal(row.expectCount, 8, '注释/字符串里的 expect( 噪声不应被计入');
  // 真实 .skip(/.only( 次数：仅 foo.test.ts 里的 2 个真实调用，字符串/注释里的噪声不计入
  assert.equal(row.skipOnlyCount, 2, '注释/字符串里的 .skip(/.only( 噪声不应被计入');

  assert.match(md, /已核实 vitest\.config\.ts 的 bench exclude 项与本工具一致/);

  rmSync(repo, { recursive: true, force: true });
});

test('bench exclude 漂移：vitest.config.ts 与工具硬编码不一致时报 WARNING，且仍按硬编码窄口径 fail-closed（不静默扩大排除）', () => {
  const repo = initGitRepo({
    'package.json': JSON.stringify({ name: 'fixture', scripts: {} }),
    // 目标仓把 bench exclude 写宽成了 {ts,tsx} —— 与本工具硬编码的 **/*.bench.test.ts 不一致
    'vitest.config.ts':
      "export default { test: { exclude: ['**/*.bench.test.{ts,tsx}'] } }\n",
    'src/modB/bar.test.ts': "function expect(v){return{toBe:()=>{}}}\nexpect(1).toBe(1)\n",
    'src/modB/bar.bench.test.tsx': "function expect(v){return{toBe:()=>{}}}\nexpect(2).toBe(2)\n",
  });
  const out = tmpOutPath('anchor-map.md');

  const r = runCli(['--repo', repo, '--out', out]);
  assert.equal(r.status, 0, r.stderr);
  const md = readFileSync(out, 'utf8');

  assert.match(md, /WARNING.*配置漂移/);
  const row = parseModuleRow(md, 'src/modB');
  // 即便目标仓自己的配置已经把 tsx 变体也排除了，本工具仍只信任硬编码窄口径，
  // 该 tsx 文件依然被计入（fail-closed：宁可多算，不静默丢弃可见性）
  assert.equal(row.testFileCount, 2);

  rmSync(repo, { recursive: true, force: true });
});

test('bench exclude 缺失：vitest.config.ts 删掉 bench exclude 项后 fail-closed——不排除 .bench.test.ts，计入统计并报 WARNING，且不与"已核实一致"的静态脚注矛盾', () => {
  const repo = initGitRepo({
    'package.json': JSON.stringify({ name: 'fixture', scripts: {} }),
    // 目标仓的 bench exclude 项已被整段删除，只剩 node_modules 排除
    'vitest.config.ts': "export default { test: { exclude: ['**/node_modules/**'] } }\n",
    'src/modE/qux.test.ts': "function expect(v){return{toBe:()=>{}}}\nexpect(1).toBe(1)\n",
    'src/modE/qux.bench.test.ts': "function expect(v){return{toBe:()=>{}}}\nexpect(2).toBe(2)\n",
  });
  const out = tmpOutPath('anchor-map.md');

  const r = runCli(['--repo', repo, '--out', out]);
  assert.equal(r.status, 0, r.stderr);
  const md = readFileSync(out, 'utf8');

  assert.match(md, /WARNING.*未能在 vitest\.config\.ts 核实 bench exclude 项/);
  // 缺失分支与"已核实一致"分支互斥，报告里不应同时出现两者的措辞
  assert.doesNotMatch(md, /已核实 vitest\.config\.ts 的 bench exclude 项与本工具一致/);
  assert.doesNotMatch(md, /已核实.*exclude 规则完全一致/);

  const row = parseModuleRow(md, 'src/modE');
  // bench exclude 项缺失（未能确认目标配置仍排除 ts 变体）时，.bench.test.ts 不再
  // 被排除，按普通测试文件计入统计（fail-closed，不静默丢弃可见性）
  assert.equal(row.testFileCount, 2, 'bench exclude 缺失分支下 .bench.test.ts 应被计入正常测试统计');
  // 两个文件各含 1 个 `function expect(v)` 声明 + 1 个 `expect(N).toBe(N)` 调用 = 4
  assert.equal(row.expectCount, 4);

  rmSync(repo, { recursive: true, force: true });
});

// ---------- Finding 2：coverage 能力探测拆分 package.json / CI workflow；产物 stale/partial 判定 ----------

test('coverage：仅 CI workflow 命中 coverage 能力，且既有产物不覆盖 src/ 时判定 stale/partial 不采信', () => {
  const dir = mkdtempSync(join(tmpdir(), 'mivosentry-anchor-cov-'));
  writeFiles(dir, {
    'package.json': JSON.stringify({ name: 'fixture', scripts: { build: 'vite build' } }),
    '.github/workflows/ci.yml':
      'name: CI\non: push\njobs:\n  coverage:\n    runs-on: ubuntu-latest\n    steps:\n      - run: npx vitest run --coverage.enabled --coverage.reporter=json-summary\n',
    'src/modC/baz.test.ts': "function expect(v){return{toBe:()=>{}}}\nexpect(1).toBe(1)\n",
  });
  // 产物先写、commit 后置：确保 mtime 早于 HEAD 提交时间（stale）；且只覆盖 src/ 之外的文件（partial）
  mkdirSync(join(dir, 'coverage'), { recursive: true });
  writeFileSync(
    join(dir, 'coverage', 'coverage-summary.json'),
    JSON.stringify({
      total: { lines: { total: 10, covered: 0, pct: 0 } },
      [join(dir, 'server', 'persist', 'backend.ts')]: { lines: { total: 10, covered: 0, pct: 0 } },
    }),
    'utf8'
  );
  spawnSync('sleep', ['1.1']);
  git(['init', '-q'], dir);
  git(['config', 'user.email', 'anchor-test@example.com'], dir);
  git(['config', 'user.name', 'anchor-test'], dir);
  git(['config', 'commit.gpgsign', 'false'], dir);
  git(['add', '-A'], dir);
  git(['commit', '-q', '-m', 'init'], dir);

  const out = tmpOutPath('anchor-map.md');
  const r = runCli(['--repo', dir, '--out', out]);
  assert.equal(r.status, 0, r.stderr);
  const md = readFileSync(out, 'utf8');

  assert.match(md, /检测到 coverage 能力.*CI workflow/);
  assert.match(md, /stale\/partial，不采信/);
  const row = parseModuleRow(md, 'src/modC');
  assert.equal(row.coveragePct, 'n/a');

  rmSync(dir, { recursive: true, force: true });
});

test('coverage：package.json 脚本命中 coverage 能力，且产物覆盖 src/ 且比 HEAD 新时被采信用于 coverage% 列', () => {
  const dir = mkdtempSync(join(tmpdir(), 'mivosentry-anchor-cov-ok-'));
  writeFiles(dir, {
    'package.json': JSON.stringify({
      name: 'fixture',
      scripts: { coverage: 'vitest run --coverage' },
    }),
    'src/modD/qux.test.ts': "function expect(v){return{toBe:()=>{}}}\nexpect(1).toBe(1)\n",
    'src/modD/qux.ts': 'export const x = 1\n',
  });
  git(['init', '-q'], dir);
  git(['config', 'user.email', 'anchor-test@example.com'], dir);
  git(['config', 'user.name', 'anchor-test'], dir);
  git(['config', 'commit.gpgsign', 'false'], dir);
  git(['add', '-A'], dir);
  git(['commit', '-q', '-m', 'init'], dir);
  spawnSync('sleep', ['1.1']);

  // 产物在 commit 之后写入：mtime 晚于 HEAD，且覆盖 src/modD 下的文件
  mkdirSync(join(dir, 'coverage'), { recursive: true });
  writeFileSync(
    join(dir, 'coverage', 'coverage-summary.json'),
    JSON.stringify({
      total: { lines: { total: 20, covered: 15, pct: 75 } },
      [join(dir, 'src', 'modD', 'qux.ts')]: { lines: { total: 20, covered: 15, pct: 75 } },
    }),
    'utf8'
  );

  const out = tmpOutPath('anchor-map.md');
  const r = runCli(['--repo', dir, '--out', out]);
  assert.equal(r.status, 0, r.stderr);
  const md = readFileSync(out, 'utf8');

  assert.match(md, /检测到 coverage 能力.*package\.json scripts/);
  assert.match(md, /校验通过/);
  const row = parseModuleRow(md, 'src/modD');
  assert.equal(row.coveragePct, '75.0%');

  rmSync(dir, { recursive: true, force: true });
});
