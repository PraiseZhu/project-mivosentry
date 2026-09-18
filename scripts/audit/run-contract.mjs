import { spawnSync } from 'node:child_process';
import { createHash, randomUUID } from 'node:crypto';
import { existsSync, readFileSync, realpathSync, renameSync, writeFileSync, rmSync } from 'node:fs';
import path from 'node:path';

export const NIGHTLY_DIMENSIONS = ['deps-vuln', 'dead-code', 'todo-stale', 'log-violation',
  'type-escape', 'secret-pattern', 'circular-dep', 'test-health', 'debt-metric'];

export function validateProducerReceipt(file, expected) {
  if (!file) throw new Error('自动消费必须提供 producer receipt');
  const receipt = JSON.parse(readFileSync(file, 'utf8'));
  if (receipt.schemaVersion !== 1) throw new Error('producer receipt schema 无效');
  for (const key of ['runId', 'scanDate', 'repo', 'commit']) {
    if (!expected[key] || receipt[key] !== expected[key]) throw new Error('producer receipt ' + key + ' 不匹配');
  }
  if (!receipt.manifest || realpathSync(receipt.manifest) !== realpathSync(expected.manifest)) throw new Error('producer receipt manifest 不匹配');
  const g1 = receipt.steps?.filter(s => s.name === 'g1' || s.name === 'g1-retry').at(-1);
  if (!g1 || g1.exitCode !== 0 || !['completed', 'partial'].includes(receipt.status) &&
      !(receipt.status === 'failed' && receipt.finishedAt === null)) throw new Error('producer receipt 没有本轮成功 G1');
  return receipt;
}

export function gitEnv(env = process.env) {
  const clean = { ...env, GIT_OPTIONAL_LOCKS: '0', GIT_TERMINAL_PROMPT: '0' };
  for (const key of Object.keys(clean)) {
    if (/^GIT_(DIR|WORK_TREE|INDEX_FILE|COMMON_DIR|OBJECT_DIRECTORY|ALTERNATE_OBJECT_DIRECTORIES|CONFIG.*)$/.test(key)) delete clean[key];
  }
  return clean;
}

export function gitRead(repo, args) {
  const r = spawnSync('git', ['-C', repo, ...args], {
    encoding: 'utf8', env: gitEnv(), timeout: 30_000, maxBuffer: 16 * 1024 * 1024,
  });
  if (r.error || r.status !== 0) throw new Error('git ' + args[0] + ' failed: ' + (r.error?.message || r.stderr || r.status));
  return r.stdout;
}

export function assertRepoRoot(repo) {
  const real = realpathSync(repo);
  const top = gitRead(real, ['rev-parse', '--show-toplevel']).trim();
  if (realpathSync(top) !== real) throw new Error('目标 Git 根目录不匹配: ' + real + ' -> ' + top);
  return real;
}

export function validScanDate(date) {
  return typeof date === 'string' && /^\d{4}-\d{2}-\d{2}$/.test(date) &&
    !Number.isNaN(Date.parse(date)) && new Date(date).toISOString().slice(0, 10) === date;
}

export function scanDateAt(now = new Date()) {
  return new Intl.DateTimeFormat('en-CA', {
    timeZone: 'Asia/Shanghai', year: 'numeric', month: '2-digit', day: '2-digit',
  }).format(now);
}

export function atomicWrite(file, text) {
  const temp = file + '.' + randomUUID() + '.tmp';
  writeFileSync(temp, text, { encoding: 'utf8', flag: 'wx', mode: 0o600 });
  try { renameSync(temp, file); }
  finally { rmSync(temp, { force: true }); }
}

export function writeJson(file, value) {
  atomicWrite(file, JSON.stringify(value, null, 2) + '\n');
}

export function hashFile(file) {
  return createHash('sha256').update(readFileSync(file)).digest('hex');
}

export function within(root, file) {
  const rel = path.relative(realpathSync(root), realpathSync(file));
  return rel === '' || (!rel.startsWith('..' + path.sep) && rel !== '..' && !path.isAbsolute(rel));
}

export function artifactPaths(file, manifest, outputRoots) {
  if (!Array.isArray(outputRoots) || outputRoots.length === 0) throw new Error('必须显式指定批准输出树 outputRoots');
  const paths = {};
  for (const key of ['findings', 'report']) {
    const a = manifest.artifacts?.[key];
    if (!a || typeof a.path !== 'string' || path.isAbsolute(a.path)) throw new Error('manifest artifact 必须为相对路径');
    const resolved = path.resolve(path.dirname(file), a.path);
    if (!existsSync(resolved) || !outputRoots.some(root => within(root, resolved))) throw new Error('manifest artifact 越出批准输出树或不存在');
    paths[key] = resolved;
  }
  return paths;
}

// The manifest is the publication pointer. Consumers must not infer validity from file existence.
export function validateManifest(file, expected = {}) {
  if (!validScanDate(expected.scanDate) || !expected.repo) throw new Error('必须显式提供期望 scanDate 和 repo');
  if (typeof expected.runId !== 'string' || !/^[a-zA-Z0-9_-]{1,100}$/.test(expected.runId)) throw new Error('必须绑定生产者本轮 receipt 的 runId');
  const m = JSON.parse(readFileSync(file, 'utf8'));
  if (m.schemaVersion !== 1 || m.valid !== true || !['completed', 'partial'].includes(m.status) ||
      !validScanDate(m.scanDate) || !/^[a-f0-9]{40,64}$/.test(m.commit || '') ||
      !/^[a-zA-Z0-9_-]+$/.test(m.runId || '') || !path.isAbsolute(m.repo || '')) {
    throw new Error('manifest 无效或尚未发布');
  }
  for (const key of ['scanDate', 'runId', 'commit', 'repo']) {
    if (expected[key] !== undefined && m[key] !== expected[key]) throw new Error('manifest ' + key + ' 不匹配');
  }
  if (assertRepoRoot(expected.repo) !== m.repo || gitRead(m.repo, ['rev-parse', 'HEAD']).trim() !== m.commit) {
    throw new Error('manifest Git 身份或 HEAD 不匹配');
  }
  const paths = artifactPaths(file, m, expected.outputRoots);
  for (const key of ['findings', 'report']) {
    const a = m.artifacts?.[key];
    if (hashFile(paths[key]) !== a.sha256) {
      throw new Error('manifest ' + key + ' 文件或 hash 不匹配');
    }
    if (expected[key] && (!expected.outputRoots.some(root => within(root, expected[key])) || hashFile(expected[key]) !== a.sha256)) {
      throw new Error('manifest ' + key + ' 输入不匹配');
    }
  }
  const findings = JSON.parse(readFileSync(paths.findings, 'utf8'));
  if (!Array.isArray(findings)) throw new Error('manifest findings 顶层不是数组');
  const firstLine = readFileSync(paths.report, 'utf8').split('\n')[0];
  const counts = firstLine.match(/^派 (\d+) 维度 \/ 成 (\d+) \/ 败 (\d+) \/ n_a (\d+)$/);
  if (!counts || !Array.isArray(m.dimensions) || m.dimensions.length === 0 || m.dimensions.length !== Number(counts[1])) throw new Error('manifest 对账行无效');
  const buckets = ['ok', 'error', 'n_a'];
  if (m.dimensions.some(d => !d || typeof d.dim !== 'string' || !d.dim.trim() || typeof d.note !== 'string' || !buckets.includes(d.bucket)) ||
      new Set(m.dimensions.map(d => d.dim)).size !== m.dimensions.length ||
      buckets.some((b, i) => m.dimensions.filter(d => d.bucket === b).length !== Number(counts[i + 2])) ||
      (m.status === 'completed') !== m.dimensions.every(d => d.bucket === 'ok')) throw new Error('manifest 维度状态不一致');
  const expectedDimensions = expected.dimensions ?? NIGHTLY_DIMENSIONS;
  if (!Array.isArray(expectedDimensions) || expectedDimensions.length === 0 ||
      new Set(expectedDimensions).size !== expectedDimensions.length ||
      expectedDimensions.length !== m.dimensions.length ||
      expectedDimensions.some(dim => !m.dimensions.some(d => d.dim === dim))) throw new Error('manifest 扫描集合不匹配');
  return m;
}
