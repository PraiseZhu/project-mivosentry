import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync, writeFileSync, readFileSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { spawn } from 'node:child_process';

import { loadStore, isKnown, markSeen, save, StoreCorruptError, __testing__ } from '../../scripts/issues/fingerprint.mjs';

const __dirname = dirname(fileURLToPath(import.meta.url));
const DUAL_PROCESS_WORKER = join(__dirname, 'fixtures', 'dual-process-worker.mjs');

function runWorker(storePath, fp, delayMs = 0) {
  return new Promise((resolvePromise, reject) => {
    const child = spawn(process.execPath, [DUAL_PROCESS_WORKER, storePath, fp, String(delayMs)], {
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    let stderr = '';
    child.stderr.on('data', (d) => {
      stderr += d.toString();
    });
    child.on('exit', (code) => {
      if (code !== 0) reject(new Error(`worker exited ${code}: ${stderr}`));
      else resolvePromise();
    });
    child.on('error', reject);
  });
}

function tmpStorePath() {
  const dir = mkdtempSync(join(tmpdir(), 'mivosentry-fp-'));
  return join(dir, 'fingerprints.json');
}

test('loadStore：文件不存在时返回空 store，不报错', () => {
  const p = tmpStorePath();
  const store = loadStore(p);
  assert.deepEqual(store, { fingerprints: {} });
  assert.equal(isKnown('anything'), false);
});

test('markSeen + save + 重新 loadStore：数据可回读，firstSeen 不被覆盖', () => {
  const p = tmpStorePath();
  loadStore(p);
  markSeen('fp1', { seenAt: '2026-08-01T00:00:00.000Z', severity: 'P0' });
  save();
  assert.equal(existsSync(p), true);

  // 重新加载，模拟第二次运行
  loadStore(p);
  assert.equal(isKnown('fp1'), true);
  assert.equal(isKnown('fp2'), false);

  // 同一指纹再次 markSeen，firstSeen 应保留原值，lastSeen 更新
  markSeen('fp1', { seenAt: '2026-08-02T00:00:00.000Z', severity: 'P0' });
  save();

  const raw = JSON.parse(readFileSync(p, 'utf8'));
  assert.equal(raw.fingerprints.fp1.firstSeen, '2026-08-01T00:00:00.000Z');
  assert.equal(raw.fingerprints.fp1.lastSeen, '2026-08-02T00:00:00.000Z');
});

test('loadStore：文件存在但 JSON 损坏时抛 StoreCorruptError', () => {
  const p = tmpStorePath();
  writeFileSync(p, '{ this is not json', 'utf8');
  assert.throws(() => loadStore(p), StoreCorruptError);
});

test('loadStore：JSON 合法但缺 fingerprints 字段时抛 StoreCorruptError', () => {
  const p = tmpStorePath();
  writeFileSync(p, JSON.stringify({ notFingerprints: {} }), 'utf8');
  assert.throws(() => loadStore(p), StoreCorruptError);
});

test('save：目录不存在时自动创建', () => {
  const dir = mkdtempSync(join(tmpdir(), 'mivosentry-fp-'));
  const nestedPath = join(dir, 'nested', 'sub', 'fingerprints.json');
  loadStore(nestedPath);
  markSeen('fpX', { seenAt: '2026-08-01T00:00:00.000Z' });
  save();
  assert.equal(existsSync(nestedPath), true);
  rmSync(dir, { recursive: true, force: true });
});

// --- P0#4 回归：零字节文件曾被当合法空 store 静默放行，会让历史 finding 全部当新项重复上报 ---
test('loadStore：文件存在但内容为空字节时抛 StoreCorruptError（不当作合法空库）', () => {
  const p = tmpStorePath();
  writeFileSync(p, '', 'utf8');
  assert.throws(() => loadStore(p), StoreCorruptError);
});

test('loadStore：文件只含空白字符（疑似截断）时同样抛 StoreCorruptError', () => {
  const p = tmpStorePath();
  writeFileSync(p, '   \n\t', 'utf8');
  assert.throws(() => loadStore(p), StoreCorruptError);
});

// --- P0#4 回归：save() 无锁非原子导致并发进程 last-writer-wins，互相覆盖对方新写入的指纹 ---
test('双进程并发 markSeen 不同指纹并各自 save：锁+落盘前重新合并磁盘状态，两者都不丢失', async () => {
  const p = tmpStorePath();
  await Promise.all([runWorker(p, 'fp-from-process-a', 30), runWorker(p, 'fp-from-process-b', 5)]);

  const raw = JSON.parse(readFileSync(p, 'utf8'));
  assert.ok(Object.prototype.hasOwnProperty.call(raw.fingerprints, 'fp-from-process-a'), '进程 A 的指纹应保留');
  assert.ok(Object.prototype.hasOwnProperty.call(raw.fingerprints, 'fp-from-process-b'), '进程 B 的指纹应保留');
  assert.equal(Object.keys(raw.fingerprints).length, 2);
});

test('双进程串行运行（无并发窗口）也不丢失：save() 合并磁盘最新内容而非直接覆盖', async () => {
  const p = tmpStorePath();
  await runWorker(p, 'fp-first', 0);
  await runWorker(p, 'fp-second', 0);

  const raw = JSON.parse(readFileSync(p, 'utf8'));
  assert.equal(Object.keys(raw.fingerprints).length, 2);
  assert.ok(raw.fingerprints['fp-first']);
  assert.ok(raw.fingerprints['fp-second']);
});

// --- round-3 delta 复核回归：陈旧回收无 owner 校验，会误删已被另一进程夺取的新锁（split-brain） ---
test('release：锁内容的 owner 与本次持有者不匹配时不删除，只警告（round-3 回归：陈旧回收无 owner 校验会误删他人新锁）', () => {
  const p = tmpStorePath();
  const { lockPath, owner } = __testing__.acquireLock(p);

  // 模拟：该锁已被另一进程判定陈旧并夺取，磁盘上现在是别人的锁内容（owner 不同、时间也更新）
  const foreignOwner = 'someone-else-owner';
  writeFileSync(
    lockPath,
    JSON.stringify({ pid: 999999, nonce: 'someone-else', owner: foreignOwner, acquiredAt: Date.now() }),
    'utf8',
  );

  __testing__.releaseLock(lockPath, owner); // 用自己（旧）的 owner 释放，不应删除别人的新锁

  assert.equal(existsSync(lockPath), true, '不应删除属于其他持有者的锁');
  const held = JSON.parse(readFileSync(lockPath, 'utf8'));
  assert.equal(held.owner, foreignOwner, '磁盘上的锁内容应保持不变（仍是别人的）');

  rmSync(lockPath, { force: true });
});

// --- round-3 delta 复核回归：锁文件写入未完成时曾被判 malformed→立即视为陈旧→被并发误删（split-brain） ---
test('acquireLock：malformed 锁文件若仍在陈旧窗口内（mtime 新鲜），不会被立即当作陈旧夺取（round-3 回归）', () => {
  const p = tmpStorePath();
  const lockPath = `${p}.lock`;
  const malformed = '{ not valid json, still fresh';
  writeFileSync(lockPath, malformed, 'utf8');

  assert.throws(() => __testing__.acquireLock(p), /获取 store 锁超时/, '锁内容新鲜时不应被立即夺取，应等到超时报错');
  assert.equal(readFileSync(lockPath, 'utf8'), malformed, '陈旧窗口内的 malformed 锁不应被删除/篡改');

  rmSync(lockPath, { force: true });
});
