// 双进程并发测试用的独立子进程脚本：加载 store，(可选延迟模拟工作耗时)，markSeen 一个指纹，落盘。
// 由 fingerprint.test.mjs 的「双进程」测试用 spawn 并发拉起两份，验证 save() 的锁+合并语义不丢数据。
import { loadStore, markSeen, save } from '../../../scripts/issues/fingerprint.mjs';

const [storePath, fp, delayMs] = process.argv.slice(2);

loadStore(storePath);

const delay = Number(delayMs ?? 0);
if (delay > 0) {
  const sab = new SharedArrayBuffer(4);
  Atomics.wait(new Int32Array(sab), 0, 0, delay);
}

markSeen(fp, { seenAt: new Date().toISOString(), severity: 'P0', dim: 'test' });
save();
