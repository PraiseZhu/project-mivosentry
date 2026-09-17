// Local host acceptance harness: all writable fixtures stay in this checkout.
import fs from 'node:fs';
import path from 'node:path';
import {fileURLToPath} from 'node:url';
import {spawnSync} from 'node:child_process';
import {createHash} from 'node:crypto';
const root = fileURLToPath(new URL('../../../', import.meta.url));
if (!process.env.CINDY_SOURCE_ROOT) throw Error('CINDY_SOURCE_ROOT required');
const base = path.join(root, 'state/test-tmp');
fs.mkdirSync(base, {recursive:true});
const task = fs.mkdtempSync(path.join(base, 'adapter-'));
try {
  const release = path.join(task, 'releases/fixture');
  const source = path.join(release, 'source');
  const target = path.join(task, 'plugin-runtime');
  for (const p of [source, target]) {
    fs.mkdirSync(p, {recursive:true});
    const r = spawnSync('git', ['init', '-q', '-b', 'main', p]);
    if (r.status !== 0) throw Error('fixture git init failed');
  }
  fs.mkdirSync(path.join(target, 'node_modules'));
  fs.symlinkSync(path.join(root, 'node_modules/typescript'), path.join(target, 'node_modules/typescript'));
  fs.writeFileSync(path.join(target, 'package-lock.json'), '{}');
  const hash = createHash('sha256').update('[]').digest('hex');
  const config = path.join(task, 'config.json');
  const dependency = path.join(task, 'dependency.json');
  fs.writeFileSync(config, JSON.stringify({accepted:true, release, target, revision:'a'.repeat(40), contentSha256:hash}));
  fs.writeFileSync(path.join(release, 'release-manifest.json'), JSON.stringify({files:[], contentSha256:hash}));
  const result = spawnSync(process.execPath, ['--test', 'tests/scheduler/adapter.test.mjs'], {cwd:root, stdio:'inherit', env:{...process.env,TMPDIR:task,MIVO_NIGHTLY_TASK_ROOT:task,MIVO_NIGHTLY_CONFIG:config,MIVO_NIGHTLY_DEPENDENCY_STATE:dependency}});
  process.exitCode = result.status ?? 1;
} finally { fs.rmSync(task, {recursive:true, force:true}); }
