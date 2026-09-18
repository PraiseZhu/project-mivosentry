import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, writeFileSync, readFileSync, chmodSync, rmSync, symlinkSync } from 'node:fs';
import { join, resolve, dirname } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { validateManifest, scanDateAt, gitEnv, hashFile } from '../../scripts/audit/run-contract.mjs';
import { blockingChanges, parseRunnerArgs } from '../../scripts/audit/nightly-runner.mjs';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '../..');
const audit = join(root, 'scripts/audit/nightly-audit.mjs');
function fixture(t) {
  const base = join(root, 'state/test-tmp');
  mkdirSync(base, { recursive: true });
  const dir = mkdtempSync(join(base, 'chain-'));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  const repo = join(dir, 'repo');
  mkdirSync(repo);
  const git = (...args) => {
    const r = spawnSync('git', ['-C', repo, ...args], { encoding: 'utf8' });
    assert.equal(r.status, 0, r.stderr);
    return r.stdout.trim();
  };
  git('init', '-q', '-b', 'main');
  git('config', 'user.name', 'fixture');
  git('config', 'user.email', 'fixture@example.invalid');
  writeFileSync(join(repo, 'x.ts'), 'const x = 1 as any;\n');
  git('add', '.');
  git('-c', 'commit.gpgsign=false', 'commit', '-qm', 'fixture');
  const run = (args, opts = {}) => spawnSync(process.execPath, [audit, ...args], { encoding: 'utf8', ...opts });
  const bin = (name, body) => {
    const p = join(repo, 'node_modules/.bin', name);
    mkdirSync(dirname(p), { recursive: true });
    writeFileSync(p, '#!/bin/sh\n' + body + '\n');
    chmodSync(p, 0o755);
  };
  return { dir, repo, git, run, bin };
}

test('repo subdirectory is refused instead of auditing its parent', t => {
  const f = fixture(t);
  const sub = join(f.repo, '_ops');
  mkdirSync(sub);
  const r = f.run(['--repo', sub, '--dims', 'type-escape', '--out-dir', join(f.dir, 'reports'), '--state-dir', join(f.dir, 'state')]);
  assert.equal(r.status, 2, r.stderr);
  assert.match(r.stderr, /根目录|root/);
});

test('as any counts once', t => {
  const f = fixture(t);
  const r = f.run(['--_worker', 'type-escape', '--repo', f.repo]);
  assert.equal(r.status, 0, r.stderr);
  assert.equal(JSON.parse(r.stdout).findings[0].evidence, 'as any×1');
});

test('ts-prune nonzero cannot produce success', t => {
  const f = fixture(t);
  f.bin('ts-prune', 'echo "x.ts:1 - x"; exit 7');
  const r = f.run(['--_worker', 'dead-code', '--repo', f.repo]);
  assert.equal(r.status, 1);
});

test('missing AST tool preserves file metrics but reports incomplete coverage', t => {
  const f = fixture(t);
  const r = f.run(['--_worker', 'debt-metric', '--repo', f.repo]);
  const p = JSON.parse(r.stdout);
  assert.equal(p.status, 'partial');
});

test('fixed scan date publishes matching valid manifest with hashes', t => {
  const f = fixture(t);
  const r = f.run(['--repo', f.repo, '--dims', 'type-escape', '--scan-date', '2026-09-17', '--run-id', 'fixture-run', '--out-dir', join(f.dir, 'reports'), '--state-dir', join(f.dir, 'state')]);
  assert.equal(r.status, 0, r.stderr);
  const m = JSON.parse(readFileSync(join(f.dir, 'state/manifest-2026-09-17.json')));
  assert.equal(m.valid, true);
  assert.equal(m.runId, 'fixture-run');
  assert.equal(m.commit, f.git('rev-parse', 'HEAD'));
  assert.equal(m.status, 'completed');
  for (const a of Object.values(m.artifacts)) {
    assert.equal(hashFile(resolve(f.dir, 'state', a.path)), a.sha256);
  }
});

function publication(f, dims = 'type-escape') {
  const state = join(f.dir, 'state');
  const reports = join(f.dir, 'reports');
  const r = f.run(['--repo', f.repo, '--dims', dims, '--scan-date', '2026-09-17', '--run-id', 'integration', '--out-dir', reports, '--state-dir', state]);
  assert.equal(r.status, 0, r.stderr);
  const file = join(state, 'manifest-2026-09-17.json');
  const expected = { scanDate: '2026-09-17', runId: 'integration', commit: f.git('rev-parse', 'HEAD'), repo: f.repo, outputRoots: [state, reports], dimensions: dims.split(',') };
  const receipt = join(state, 'receipt.json');
  writeFileSync(receipt, JSON.stringify({ schemaVersion: 1, ...expected, manifest: file, status: 'partial', steps: [{ name: 'g1', exitCode: 0 }] }));
  return { file, state, reports, receipt, expected, manifest: validateManifest(file, expected) };
}

function gate(f, p, extra = []) {
  return spawnSync(process.execPath, [join(root, 'scripts/issues/issue-gate.mjs'),
    '--findings', join(p.state, 'findings-2026-09-17.json'), '--report', join(p.reports, 'nightly-2026-09-17.md'),
    '--manifest', p.file, '--scan-date', '2026-09-17', '--run-id', 'integration', '--target-repo', f.repo,
    '--producer-receipt', p.receipt, '--expected-dims', p.expected.dimensions.join(','),
    '--commit', p.expected.commit, '--state-dir', p.state, '--out-dir', p.reports,
    '--store', join(p.state, 'fingerprints.json'), '--repo', 'fixture/repo', ...extra], { encoding: 'utf8' });
}

test('manifest rejects missing/old round, wrong date, tampering, failed and changed HEAD', t => {
  const f = fixture(t);
  const p = publication(f);
  for (const mismatch of [{ scanDate: '2026-09-18' }, { runId: 'other' }, { runId: undefined }, { commit: '0'.repeat(40) }]) {
    assert.throws(() => validateManifest(p.file, { ...p.expected, ...mismatch }));
  }
  assert.equal(gate(f, p, ['--run-id', 'old-run']).status, 1);
  const findings = resolve(dirname(p.file), p.manifest.artifacts.findings.path);
  const original = readFileSync(findings);
  writeFileSync(findings, '[]');
  assert.equal(gate(f, p).status, 1);
  writeFileSync(findings, original);
  writeFileSync(p.file, JSON.stringify({ ...p.manifest, valid: false, status: 'failed' }));
  assert.equal(gate(f, p).status, 1);
  writeFileSync(p.file, JSON.stringify(p.manifest));
  f.git('-c', 'commit.gpgsign=false', 'commit', '--allow-empty', '-qm', 'new HEAD');
  assert.equal(gate(f, p).status, 1);
});

test('manifest rejects artifact symlink escaping output roots even with matching hash', t => {
  const f = fixture(t);
  const p = publication(f);
  const artifact = resolve(dirname(p.file), p.manifest.artifacts.findings.path);
  const outside = join(f.dir, 'outside.json');
  writeFileSync(outside, readFileSync(artifact));
  rmSync(artifact);
  symlinkSync(outside, artifact);
  assert.equal(gate(f, p).status, 1);
});

test('manifest rejects malformed dimensions, empty set and unexpected scanning set', t => {
  const f = fixture(t);
  const p = publication(f);
  for (const dimensions of [[], [{ dim: '', bucket: 'ok', note: '' }], [{ dim: 'type-escape', bucket: 'ok', note: null }], [{ dim: 'unexpected', bucket: 'ok', note: '' }]]) {
    writeFileSync(p.file, JSON.stringify({ ...p.manifest, dimensions }));
    assert.throws(() => validateManifest(p.file, p.expected));
  }
});

test('trusted partial remains consumable and empty findings legitimately preview summary zero', t => {
  const f = fixture(t);
  const p = publication(f, 'circular-dep');
  assert.equal(p.manifest.status, 'partial');
  const r = gate(f, p);
  assert.equal(r.status, 0, r.stderr);
  assert.match(r.stdout, /部分完成/);
  assert.match(r.stdout, /将单发 0 条 \/ 汇总 0 条/);
});

test('HEAD changing clean-to-clean during G1 prevents trusted publication', t => {
  const f = fixture(t);
  // Deliberately mutating tool exists ONLY in this disposable test repository.
  f.bin('ts-prune', 'git -c commit.gpgsign=false commit --allow-empty -qm race');
  writeFileSync(join(f.repo, '.gitignore'), 'node_modules/\n');
  f.git('add', '.gitignore');
  f.git('-c', 'commit.gpgsign=false', 'commit', '-qm', 'ignore fixture tools');
  const state = join(f.dir, 'state');
  const r = f.run(['--repo', f.repo, '--dims', 'dead-code', '--scan-date', '2026-09-17', '--run-id', 'race', '--state-dir', state, '--out-dir', join(f.dir, 'reports')]);
  assert.equal(r.status, 4, r.stderr);
  assert.equal(f.git('status', '--porcelain'), '');
  const m = JSON.parse(readFileSync(join(state, 'manifest-2026-09-17.json')));
  assert.equal(m.valid, false);
  assert.equal(m.reason, 'read-only-or-head-changed');
});

test('publication interrupted before report write invalidates previous same-day manifest', t => {
  const f = fixture(t);
  const p = publication(f);
  rmSync(join(p.reports, 'runs'), { recursive: true });
  writeFileSync(join(p.reports, 'runs'), 'simulate unusable publication directory');
  const r = f.run(['--repo', f.repo, '--dims', 'type-escape', '--scan-date', '2026-09-17', '--run-id', 'interrupted', '--state-dir', p.state, '--out-dir', p.reports]);
  assert.notEqual(r.status, 0);
  assert.equal(JSON.parse(readFileSync(p.file)).valid, false);
  assert.equal(gate(f, p).status, 1);
});

for (const code of [0, 1, 2]) {
  test('cycle-guard protocol exit ' + code, t => {
    const f = fixture(t);
    const ring = ['src/a.ts', 'src/b.ts'];
    const data = { allCycleCount: 1, valueCycleCount: 1, valueCycles: [ring],
      whitelistedCycles: code === 0 ? [{ nodes: ring, kind: 'baseline' }] : [],
      nonWhitelistedCycles: code === 0 ? [] : [ring], staleWhitelistEntries: [] };
    mkdirSync(join(f.repo, 'scripts/ci'), { recursive: true });
    writeFileSync(join(f.repo, 'scripts/ci/cycle-guard.mjs'),
      'if (process.argv.slice(2).join() !== "--json") process.exit(99);\n' +
      'console.log(' + JSON.stringify(JSON.stringify(data)) + '); process.exit(' + code + ');');
    const r = f.run(['--_worker', 'circular-dep', '--repo', f.repo]);
    const result = JSON.parse(r.stdout);
    assert.equal(result.ok, code !== 2);
    if (code !== 2) assert.equal(result.findings.length, code);
  });
}

test('only precise untracked worktrees container is exempt, never tracked or unknown changes', () => {
  assert.deepEqual(blockingChanges('?? .worktrees/a/file\0'), []);
  for (const s of [' M .worktrees/a/file\0', '?? mystery/file\0', ' M src/a.ts\0', 'R  src/b.ts\0src/a.ts\0']) {
    assert.equal(blockingChanges(s).length, 1);
  }
  assert.throws(() => parseRunnerArgs(['--repo', '/repo', '--issue-repo', 'a/b', '--send']));
  assert.equal(scanDateAt(new Date('2026-09-17T16:00:00Z')), '2026-09-18');
  assert.equal(gitEnv({ GIT_DIR: '/wrong', GIT_CONFIG_COUNT: '1' }).GIT_DIR, undefined);
});

function runner(t) {
  const f = fixture(t);
  const sentry = fixture(t);
  const state = join(f.dir, 'state');
  const config = { sentryRoot: sentry.repo, now: '2026-09-17T18:30:00+08:00',
    options: { repo: f.repo, 'issue-repo': 'fixture/repo', 'state-dir': state, 'out-dir': join(f.dir, 'reports') } };
  const run = (extra = {}) => {
    const r = spawnSync(process.execPath, [join(root, 'tests/audit/fixtures/runner-process.mjs'), JSON.stringify({ ...config, ...extra })], { encoding: 'utf8' });
    assert.ok(r.stdout, r.stderr);
    const result = JSON.parse(r.stdout);
    assert.equal(result.exitCode, r.status);
    assert.equal(JSON.parse(readFileSync(result.receiptPath)).runId, result.runId);
    return result;
  };
  return { f, state, run };
}

test('runner across processes/days retains last valid partial and accumulates two skips', t => {
  const { f, run } = runner(t);
  const partial = run();
  assert.equal(partial.exitCode, 5);
  assert.equal(partial.lastValidDate, '2026-09-17');
  assert.equal(partial.lastCompleteDate, null);
  assert.equal(partial.steps.some(s => s.name === 'g2-dry-run'), true);
  writeFileSync(join(f.repo, 'unknown.txt'), 'real blocker');
  const first = run({ now: '2026-09-18T02:30:00+08:00' });
  const second = run({ now: '2026-09-19T02:30:00+08:00' });
  assert.equal(first.exitCode, 6);
  assert.equal(first.consecutiveIncomplete, 2);
  assert.equal(second.consecutiveIncomplete, 3);
  assert.equal(second.lastValidDate, '2026-09-17');
  assert.equal(second.attentionRequired, true);
  assert.equal(second.steps.some(s => s.name === 'g1'), false);
});

test('runner preserves corrupted health instead of silently resetting history', t => {
  const { state, run } = runner(t);
  mkdirSync(state);
  const file = join(state, 'nightly-health.json');
  writeFileSync(file, '{broken ledger');
  const r = run();
  assert.equal(r.exitCode, 2);
  assert.equal(readFileSync(file, 'utf8'), '{broken ledger');
  assert.equal(r.steps.length, 0);
});

test('runner detects live patrol PID and skips G1', t => {
  const { run } = runner(t);
  const r = run({ patrol: '1234 0 com.mivo.bug-doctor.patrol\n' });
  assert.equal(r.exitCode, 6);
  assert.equal(r.occupancy.patrolPid, '1234');
  assert.equal(r.steps.some(s => s.name === 'g1'), false);
});

test('final runner receipt binds the validated manifest artifacts and identity', t => {
  const { run } = runner(t);
  const result = run();
  const receipt = JSON.parse(readFileSync(result.receiptPath));
  const manifest = JSON.parse(readFileSync(receipt.manifest));
  assert.equal(receipt.status, 'partial');
  assert.ok(receipt.finishedAt);
  for (const key of ['runId', 'scanDate', 'repo', 'commit', 'status']) assert.equal(receipt[key], manifest[key]);
  assert.deepEqual(receipt.artifacts, manifest.artifacts);
  for (const artifact of Object.values(receipt.artifacts)) assert.equal(hashFile(resolve(dirname(receipt.manifest), artifact.path)), artifact.sha256);
});

test('real doctor consumer accepts runner publication and rejects missing receipt hash', { skip: !process.env.SENTRY_CONSUMER_MODULE }, async t => {
  const { f, state, run } = runner(t);
  f.git('remote', 'add', 'origin', 'https://github.com/xindong/mivo-canvas-plugin.git');
  const result = run();
  const { readSentryPublication } = await import(pathToFileURL(process.env.SENTRY_CONSUMER_MODULE));
  const args = { findingsDir: state, dateStr: result.scanDate, expectedRepo: f.repo };
  const publication = readSentryPublication(args);
  assert.equal(publication.manifest.runId, result.runId);
  assert.equal(publication.manifest.status, 'partial');
  const receipt = JSON.parse(readFileSync(result.receiptPath));
  delete receipt.artifacts;
  writeFileSync(result.receiptPath, JSON.stringify(receipt));
  assert.throws(() => readSentryPublication(args), /receipt-findings-hash-mismatch/);
});
