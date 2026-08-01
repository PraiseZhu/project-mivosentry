// G2 指纹去重库。store = state/fingerprints.json：{ fingerprints: { <fp>: {firstSeen,lastSeen,...meta} } }
// 契约：loadStore(path) / isKnown(fp) / markSeen(fp, meta) / save() —— 四个模块级导出，内部维护单例状态。
// （文件底部另有 __testing__ 命名空间，仅供本模块自己的白盒测试访问内部锁实现，不属于上述操作契约，
// 消费方——issue-gate.mjs——不应也不会引用它。）
//
// 并发与崩溃安全设计（2026-08-01 修复 P0#4；round-3 delta 复核追加锁的 owner 校验与原子创建）：
// - save() 落盘前重新读取磁盘最新内容并与内存态合并（而非直接覆盖），避免两个并发进程互相覆盖对方新写入的指纹。
// - 落盘用「同目录临时文件 + fsync + rename」，防止进程崩溃导致 store 文件被截断成半成品。
// - save() 前后持有一个简单的跨进程文件锁（带过期时间，防止崩溃进程遗留死锁）。
// - 文件存在但内容为空视为损坏（崩溃截断的典型特征），不再当作合法空 store 静默放行。
// - round-3 修复：锁文件内容携带 owner（pid+随机 nonce）。release 前校验磁盘上锁文件的 owner 是否仍是
//   自己持有的那份，不匹配则不删（只警告）——此前 release 无条件 rmSync，若本进程因暂停（GC/IO）超过
//   陈旧窗口被另一进程判定陈旧并夺取，本进程恢复后的 release 会把「别人刚创建的新锁」误删，造成
//   split-brain（两个进程都以为自己持锁）。
// - round-3 修复：锁创建改为「先把完整内容写入临时文件，再用 linkSync 原子性地创建到锁路径」——
//   linkSync 与 open(..., 'wx') 一样，目标已存在时会失败（EEXIST，保持互斥语义），但不会像
//   「先 open 创建空文件、再 write 内容」那样存在一个名字已可见但内容为空的窗口。此前若在那个窗口
//   被并发读取，会被判定为「JSON 解析失败→视为陈旧」并被误删，即便原持有者其实仍存活、只是刚创建
//   还没写完——这正是「写入未完成时被误判 malformed stale 删除 → split-brain」的根因。
// - round-3 修复：陈旧判定不再对「解析失败」直接判陈旧——改用锁文件的 mtime 兜底：解析失败但 mtime
//   仍在陈旧窗口内，不夺取（等到真正超过 LOCK_STALE_MS 才夺取）。只有这样「内容一时不可解析」与
//   「确实是陈旧遗留」才不会被混为一谈。
import {
  readFileSync,
  writeFileSync,
  existsSync,
  mkdirSync,
  openSync,
  writeSync,
  fsyncSync,
  closeSync,
  renameSync,
  rmSync,
  linkSync,
  statSync,
} from 'node:fs';
import { dirname, basename, join } from 'node:path';
import { randomBytes } from 'node:crypto';

export class StoreCorruptError extends Error {}
export class LockTimeoutError extends Error {}

const LOCK_STALE_MS = 30_000; // 锁文件超过 30s 视为陈旧（持有者崩溃遗留），允许被夺取
const LOCK_RETRY_MS = 20;
const LOCK_MAX_WAIT_MS = 5_000; // 简单退避重试，5s 内拿不到锁则报错，不无限等待

let currentPath = null;
let currentStore = { fingerprints: {} };

function sleepSync(ms) {
  const sab = new SharedArrayBuffer(4);
  Atomics.wait(new Int32Array(sab), 0, 0, ms);
}

function lockPathFor(path) {
  return `${path}.lock`;
}

function ensureDir(path) {
  const dir = dirname(path);
  if (!existsSync(dir)) {
    mkdirSync(dir, { recursive: true });
  }
}

/** 把完整内容写到临时文件后再 linkSync 到目标路径：目标已存在则 EEXIST（保持互斥语义），
 * 且目标名字一旦可见，内容必然已完整——不存在「名字已存在但内容为空」的窗口。 */
function createLockAtomically(lockPath, payload) {
  const dir = dirname(lockPath);
  const tmpPath = join(dir, `.${basename(lockPath)}.tmp.${process.pid}.${Date.now()}.${randomBytes(4).toString('hex')}`);
  writeFileSync(tmpPath, payload);
  try {
    linkSync(tmpPath, lockPath);
  } finally {
    try {
      rmSync(tmpPath, { force: true });
    } catch {
      // 忽略：tmp 只是中间产物，清不掉不影响锁本身的正确性
    }
  }
}

/** 陈旧判定：优先信内容里的 acquiredAt；内容不可解析（结构损坏）时不再立即判陈旧，
 * 改用文件系统 mtime 兜底，仍在陈旧窗口内就不夺取。 */
function isLockStale(lockPath) {
  let stat;
  try {
    stat = statSync(lockPath);
  } catch {
    return true; // 文件已不存在（已被释放），可以再次尝试创建
  }
  try {
    const held = JSON.parse(readFileSync(lockPath, 'utf8'));
    if (typeof held.acquiredAt === 'number') {
      return Date.now() - held.acquiredAt > LOCK_STALE_MS;
    }
  } catch {
    // 解析失败：不直接判陈旧，落到下面按 mtime 兜底判断
  }
  return Date.now() - stat.mtimeMs > LOCK_STALE_MS;
}

function acquireLock(path) {
  ensureDir(path);
  const lockPath = lockPathFor(path);
  const deadline = Date.now() + LOCK_MAX_WAIT_MS;
  for (;;) {
    const nonce = randomBytes(8).toString('hex');
    const owner = `${process.pid}-${nonce}`;
    const payload = JSON.stringify({ pid: process.pid, nonce, owner, acquiredAt: Date.now() });
    try {
      createLockAtomically(lockPath, payload);
      return { lockPath, owner };
    } catch (err) {
      if (err.code !== 'EEXIST') throw err;
      if (isLockStale(lockPath)) {
        try {
          rmSync(lockPath, { force: true });
        } catch {
          // 竞态下可能已被别的进程清理，忽略
        }
        continue;
      }
      if (Date.now() > deadline) {
        throw new LockTimeoutError(`获取 store 锁超时（>${LOCK_MAX_WAIT_MS}ms）: ${lockPath}`);
      }
      sleepSync(LOCK_RETRY_MS);
    }
  }
}

/** 释放前校验磁盘上锁文件的 owner 是否仍是自己：不匹配则不删，只警告——避免误删已被
 * 判定陈旧并被其它进程夺取的新锁（split-brain 防护）。 */
function releaseLock(lockPath, owner) {
  let held;
  try {
    held = JSON.parse(readFileSync(lockPath, 'utf8'));
  } catch {
    return; // 已不存在或不可读：无需再删
  }
  if (held.owner !== owner) {
    console.warn(`[fingerprint] 锁已不属于当前持有者，跳过删除（可能已被判定陈旧并被其它进程接管）: ${lockPath}`);
    return;
  }
  try {
    rmSync(lockPath, { force: true });
  } catch {
    // 已被清理或从未成功创建，忽略
  }
}

function readStoreFile(path) {
  if (!existsSync(path)) {
    return { fingerprints: {} };
  }
  const raw = readFileSync(path, 'utf8');
  if (raw.trim() === '') {
    // 文件存在但为空：不是合法的空 store，是崩溃截断的典型特征——静默当空库会让历史 finding 全部被当新项重复上报。
    throw new StoreCorruptError(`store 文件存在但内容为空（疑似崩溃截断，判定为损坏而非空库）: ${path}`);
  }
  let parsed;
  try {
    parsed = JSON.parse(raw);
  } catch (err) {
    throw new StoreCorruptError(`JSON 解析失败: ${path}: ${err.message}`);
  }
  if (
    parsed === null ||
    typeof parsed !== 'object' ||
    Array.isArray(parsed) ||
    typeof parsed.fingerprints !== 'object' ||
    parsed.fingerprints === null ||
    Array.isArray(parsed.fingerprints)
  ) {
    throw new StoreCorruptError(`结构不合法（缺 fingerprints 对象）: ${path}`);
  }
  return parsed;
}

/** 加载 store（找不到文件视为空 store，不报错；文件存在但内容损坏/为空则抛 StoreCorruptError）。 */
export function loadStore(path) {
  currentPath = path;
  currentStore = readStoreFile(path);
  return currentStore;
}

/** 指纹是否已记录过。 */
export function isKnown(fp) {
  return Object.prototype.hasOwnProperty.call(currentStore.fingerprints, fp);
}

/** 记录指纹已见过；保留首次出现时间，更新最近一次时间与附带 meta。仅改内存，不落盘（落盘由 save() 负责）。 */
export function markSeen(fp, meta = {}) {
  const prev = currentStore.fingerprints[fp];
  const seenAt = meta.seenAt ?? new Date().toISOString();
  currentStore.fingerprints[fp] = {
    ...meta,
    firstSeen: prev?.firstSeen ?? seenAt,
    lastSeen: seenAt,
  };
}

function mergeFingerprintMaps(base, overlay) {
  const merged = { ...base };
  for (const [fp, rec] of Object.entries(overlay)) {
    const existing = merged[fp];
    if (!existing) {
      merged[fp] = rec;
      continue;
    }
    merged[fp] = {
      ...existing,
      ...rec,
      firstSeen:
        existing.firstSeen && rec.firstSeen
          ? existing.firstSeen < rec.firstSeen
            ? existing.firstSeen
            : rec.firstSeen
          : existing.firstSeen ?? rec.firstSeen,
      lastSeen:
        existing.lastSeen && rec.lastSeen
          ? existing.lastSeen > rec.lastSeen
            ? existing.lastSeen
            : rec.lastSeen
          : existing.lastSeen ?? rec.lastSeen,
    };
  }
  return merged;
}

function atomicWriteJson(path, payload) {
  ensureDir(path);
  const dir = dirname(path);
  const tmp = join(dir, `.${basename(path)}.tmp.${process.pid}.${Date.now()}`);
  const fd = openSync(tmp, 'w');
  try {
    writeSync(fd, JSON.stringify(payload, null, 2) + '\n');
    fsyncSync(fd);
  } finally {
    closeSync(fd);
  }
  renameSync(tmp, path);
}

/**
 * 落盘当前 store 到 loadStore 传入的路径；目录不存在则先建。
 * 持锁期间重新读取磁盘最新内容并与内存态合并后再写，避免并发进程互相覆盖对方的新增指纹。
 */
export function save() {
  if (!currentPath) {
    throw new Error('save() 必须在 loadStore(path) 之后调用');
  }
  const { lockPath, owner } = acquireLock(currentPath);
  try {
    let onDisk = { fingerprints: {} };
    if (existsSync(currentPath)) {
      try {
        onDisk = readStoreFile(currentPath);
      } catch (err) {
        if (!(err instanceof StoreCorruptError)) throw err;
        // 落盘前发现磁盘已损坏：以内存态为准写回，相当于从损坏中恢复。
        onDisk = { fingerprints: {} };
      }
    }
    const merged = { fingerprints: mergeFingerprintMaps(onDisk.fingerprints, currentStore.fingerprints) };
    atomicWriteJson(currentPath, merged);
    currentStore = merged;
  } finally {
    releaseLock(lockPath, owner);
  }
}

// 仅供本模块的白盒测试访问内部锁实现（owner 校验、原子创建、陈旧判定），
// 不是 fingerprint.mjs 对外操作契约的一部分——见文件顶部注释。
export const __testing__ = { acquireLock, releaseLock, isLockStale };
