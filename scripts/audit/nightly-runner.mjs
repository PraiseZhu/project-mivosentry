#!/usr/bin/env node
import { spawnSync } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { existsSync, mkdirSync, readFileSync, realpathSync, rmSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { assertRepoRoot, gitEnv, gitRead, scanDateAt, validateManifest, artifactPaths, atomicWrite, writeJson } from './run-contract.mjs';
import { isPathInsideRepo, resolveRealWithMissingTail } from './nightly-audit.mjs';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');
const EXITS = { completed: 0, partial: 5, blocked: 6, failed: 2 };

// Only this owner-approved untracked container is ignored; tracked changes never are.
export function blockingChanges(porcelainZ) {
  const records = porcelainZ.split('\0').filter(Boolean);
  const blocked = [];
  for (let i = 0; i < records.length; i++) {
    const record = records[i];
    const status = record.slice(0, 2);
    const file = record.slice(3);
    if (record.length < 4) throw new Error('无法解析 Git status');
    if (!(status === '??' && (file === '.worktrees/' || file.startsWith('.worktrees/')))) blocked.push(record);
    if (/[RC]/.test(status)) i += 1; // porcelain -z rename/copy includes the original path next.
  }
  return blocked;
}

function execute(cmd, args, opts = {}) {
  const r = spawnSync(cmd, args, { cwd: ROOT, encoding: 'utf8', timeout: 22 * 60_000,
    maxBuffer: 64 * 1024 * 1024, ...opts, env: gitEnv(opts.env) });
  return { exitCode: r.status ?? 2, stdout: r.stdout || '', stderr: r.stderr || '', error: r.error?.message || null };
}

export function parseRunnerArgs(argv) {
  const args = {};
  const allowed = new Set(['repo', 'issue-repo', 'state-dir', 'out-dir']);
  for (let i = 0; i < argv.length; i++) {
    const key = argv[i].slice(2);
    if (!argv[i].startsWith('--') || !allowed.has(key) || args[key] || !argv[i + 1] || argv[i + 1].startsWith('--')) {
      throw new Error('参数无效（夜巡永久 dry-run）: ' + argv[i]);
    }
    args[key] = argv[++i];
  }
  if (!args.repo || !/^[\w.-]+\/[\w.-]+$/.test(args['issue-repo'] || '')) throw new Error('必须指定 --repo 和 --issue-repo owner/repo');
  return args;
}

export function runNightly(options, { command = execute, now = () => new Date(), sentryRoot = ROOT } = {}) {
  process.env.PATH = '/opt/homebrew/bin:/usr/local/bin:/usr/bin:/bin';
  process.env.TZ = 'Asia/Shanghai';
  process.env.GIT_OPTIONAL_LOCKS = '0';
  const startedAt = now().toISOString();
  const scanDate = scanDateAt(new Date(startedAt));
  const runId = scanDate + '-' + randomUUID();
  const target = path.resolve(options.repo);
  const stateDir = path.resolve(options['state-dir'] || path.join(sentryRoot, 'state'));
  const outDir = path.resolve(options['out-dir'] || path.join(sentryRoot, 'reports'));
  const targetReal = resolveRealWithMissingTail(target);
  for (const dir of [stateDir, outDir]) {
    if (isPathInsideRepo(targetReal, dir)) throw new Error('输出目录不能位于目标仓');
  }
  mkdirSync(stateDir, { recursive: true });
  mkdirSync(outDir, { recursive: true });
  const lock = path.join(stateDir, '.nightly-runner.lock');
  try { mkdirSync(lock); } catch { throw new Error('夜巡已有运行者或遗留锁，需核对运行状态'); }
  try {
    const runsDir = path.join(stateDir, 'nightly-runs');
    if (!resolveRealWithMissingTail(runsDir).startsWith(realpathSync(stateDir) + path.sep)) throw new Error('回执目录越界');
    mkdirSync(runsDir, { recursive: true });
    const runDir = path.join(runsDir, runId);
    mkdirSync(runDir);
    const receiptPath = path.join(runDir, 'receipt.json');
    const healthPath = path.join(stateDir, 'nightly-health.json');
    const manifestPath = path.join(stateDir, 'manifest-' + scanDate + '.json');
    let health = { schemaVersion: 1, lastValidDate: null, lastCompleteDate: null, consecutiveIncomplete: 0 };
    let healthWritable = true;
    const receipt = { schemaVersion: 1, runId, scanDate, startedAt, finishedAt: null, status: 'failed',
      reason: '运行未完成（中断时保持失败）', manifest: manifestPath, steps: [], ...health };
    const persist = () => writeJson(receiptPath, { ...receipt, lastValidDate: health.lastValidDate,
      lastCompleteDate: health.lastCompleteDate, consecutiveIncomplete: health.consecutiveIncomplete });
    persist();
    function finish(status, reason) {
      receipt.status = status;
      receipt.reason = reason;
      receipt.finishedAt = now().toISOString();
      if (status === 'completed' || status === 'partial') health.lastValidDate = scanDate;
      if (status === 'completed') { health.lastCompleteDate = scanDate; health.consecutiveIncomplete = 0; }
      health.lastRunId = runId;
      health.status = status;
      health.reason = reason;
      health.attentionRequired = status !== 'completed';
      if (healthWritable) writeJson(healthPath, health);
      persist();
      return { exitCode: EXITS[status], receiptPath, ...receipt, ...health };
    }
    function step(name, cmd, args, opts) {
      const result = command(cmd, args, opts);
      const n = receipt.steps.length + 1;
      const stdoutPath = path.join(runDir, n + '-' + name + '.stdout.txt');
      const stderrPath = path.join(runDir, n + '-' + name + '.stderr.txt');
      atomicWrite(stdoutPath, result.stdout || '');
      atomicWrite(stderrPath, (result.stderr || '') + (result.error ? '\n' + result.error : ''));
      receipt.steps.push({ name, exitCode: result.exitCode, stdoutPath, stderrPath });
      persist();
      return result;
    }
    try {
      if (existsSync(healthPath)) {
        // A corrupt ledger is evidence, not an invitation to silently start over.
        healthWritable = false;
        const previous = JSON.parse(readFileSync(healthPath, 'utf8'));
        if (!previous || previous.schemaVersion !== 1 || !Number.isInteger(previous.consecutiveIncomplete) || previous.consecutiveIncomplete < 0) throw new Error('nightly-health 损坏，不能重置历史计数');
        health = previous;
        healthWritable = true;
      }
      health.consecutiveIncomplete += 1;
      health.lastRunId = runId;
      health.status = 'failed';
      health.reason = receipt.reason;
      health.attentionRequired = true;
      writeJson(healthPath, health);
      persist();
      // Even blocked/preflight failures invalidate today's old publication pointer.
      writeJson(manifestPath, { schemaVersion: 1, runId, scanDate, repo: targetReal, valid: false, status: 'failed', dimensions: [], artifacts: {} });
      const node = step('node', process.execPath, ['--version']);
      if (node.exitCode !== 0 || !/^v\d+\./.test(node.stdout.trim())) return finish('failed', 'Node 不可用');
      const sentry = assertRepoRoot(sentryRoot);
      if (gitRead(sentry, ['status', '--porcelain']).trim()) return finish('failed', '哨兵仓存在本地改动，未同步');
      const pull = step('sync-sentry', 'git', ['-C', sentry, 'pull', '--ff-only']);
      if (pull.exitCode !== 0) return finish('failed', '哨兵仓同步失败');
      if (gitRead(sentry, ['status', '--porcelain']).trim()) return finish('failed', '同步后哨兵仓不干净');
      const repo = assertRepoRoot(target);
      const patrol = step('patrol', 'launchctl', ['list']);
      // Empty output reflects launchd domain visibility. Branch/worktree remain hard evidence.
      const pid = (patrol.stdout || '').split('\n').map(l => l.trim().split(/\s+/)).find(parts => parts[2] === 'com.mivo.bug-doctor.patrol')?.[0] || '';
      const branch = gitRead(repo, ['branch', '--show-current']).trim();
      const rawStatus = gitRead(repo, ['status', '--porcelain', '-z', '--untracked-files=all']);
      const changes = blockingChanges(rawStatus);
      receipt.occupancy = { patrolPid: pid, branch, rawChangeCount: rawStatus.split('\0').filter(Boolean).length, blockingChanges: changes };
      persist();
      if (/^\d+$/.test(pid) || branch !== 'main' || changes.length) return finish('blocked', '目标仓有写者、非 main 或未批准改动');
      const commit = gitRead(repo, ['rev-parse', 'HEAD']).trim();
      receipt.repo = repo;
      receipt.commit = commit;
      const auditArgs = [path.join(ROOT, 'scripts/audit/nightly-audit.mjs'), '--repo', repo,
        '--scan-date', scanDate, '--run-id', runId, '--out-dir', outDir, '--state-dir', stateDir];
      let audit = step('g1', process.execPath, auditArgs);
      if (audit.exitCode !== 0) audit = step('g1-retry', process.execPath, auditArgs);
      if (audit.exitCode !== 0) return finish('failed', 'G1 失败: ' + audit.exitCode + (audit.exitCode === 4 ? '；可能检查后出现争用，产物不可信' : ''));
      const manifest = validateManifest(manifestPath, { scanDate, runId, repo, commit, outputRoots: [stateDir, outDir] });
      const paths = artifactPaths(manifestPath, manifest, [stateDir, outDir]);
      receipt.dimensions = manifest.dimensions;
      const gateArgs = [path.join(ROOT, 'scripts/issues/issue-gate.mjs'), '--findings', paths.findings,
        '--report', paths.report, '--repo', options['issue-repo'], '--manifest', manifestPath,
        '--scan-date', scanDate, '--run-id', runId, '--commit', commit, '--target-repo', repo,
        '--producer-receipt', receiptPath,
        '--state-dir', stateDir, '--out-dir', outDir, '--store', path.join(stateDir, 'fingerprints.json')];
      let gate = step('g2-dry-run', process.execPath, gateArgs);
      if (gate.exitCode !== 0) gate = step('g2-dry-run-retry', process.execPath, gateArgs);
      if (gate.exitCode !== 0 || !/将单发 \d+ 条 \/ 汇总 [01] 条/.test(gate.stdout)) return finish('failed', 'G2 dry-run 失败或缺预览');
      const finalManifest = validateManifest(manifestPath, { scanDate, runId, repo, commit, outputRoots: [stateDir, outDir] });
      // Only the final verified publication is consumable. Paths remain relative
      // to receipt.manifest, exactly as declared by the producer manifest.
      receipt.artifacts = finalManifest.artifacts;
      return finish(finalManifest.status, finalManifest.status === 'partial' ? '部分维度失败或缺测；可信结果已完成 dry-run' : 'G1/G2 完成');
    } catch (err) {
      return finish('failed', err.message);
    }
  } finally {
    rmSync(lock, { recursive: true, force: true });
  }
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  try {
    const result = runNightly(parseRunnerArgs(process.argv.slice(2)));
    console.log(JSON.stringify(result));
    process.exitCode = result.exitCode;
  } catch (err) {
    console.error('夜巡失败: ' + err.message);
    process.exitCode = 2;
  }
}
