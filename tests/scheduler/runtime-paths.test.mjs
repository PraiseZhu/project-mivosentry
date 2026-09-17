import {test} from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import {spawnSync} from 'node:child_process';
import {fileURLToPath} from 'node:url';
import {containedPath, validateRuntimePaths, isolatedGitEnv} from '../../scripts/scheduler/runtime-paths.mjs';

const repoRoot = fileURLToPath(new URL('../../', import.meta.url));
function fixture(t) {
  const base = path.join(repoRoot, 'state/test-tmp');
  fs.mkdirSync(base, {recursive:true});
  const dir = fs.mkdtempSync(path.join(base, 'runtime-path-'));
  t.after(() => fs.rmSync(dir, {recursive:true, force:true}));
  const root = path.join(dir, 'approved');
  const outside = path.join(dir, 'outside');
  const release = path.join(root, 'releases/v1');
  const source = path.join(release, 'source');
  const target = path.join(root, 'plugin-runtime');
  for (const p of [source, target, outside]) {
    fs.mkdirSync(p, {recursive:true});
    const r = spawnSync('git', ['init', '-q', '-b', 'main', p], {env:isolatedGitEnv(), encoding:'utf8'});
    assert.equal(r.status, 0, r.stderr);
  }
  const config = {accepted:true, release, target};
  const configPath = path.join(root, 'config.json');
  const dependencyStatePath = path.join(root, 'dependency.json');
  return {dir,root,outside,release,source,target,config,configPath,dependencyStatePath};
}

test('independent local clones and nonexistent outputs pass canonical preflight', t => {
  const f = fixture(t);
  assert.doesNotThrow(() => validateRuntimePaths(f.root, f.config, f.configPath, f.dependencyStatePath));
  assert.equal(fs.existsSync(path.join(f.release, 'state')), false);
});

for (const kind of ['target-symlink', 'release-ancestor', 'dotdot', 'state-symlink', 'report-symlink', 'source-symlink', 'external-git-file', 'git-symlink', 'common-dir', 'alternates', 'metadata-symlink', 'dependency-ancestor']) {
  test('reject before any command or output: ' + kind, t => {
    const f = fixture(t);
    const replaceWithLink = (p, dest) => {fs.rmSync(p, {recursive:true, force:true});fs.symlinkSync(dest, p);};
    if (kind === 'target-symlink') replaceWithLink(f.target, f.outside);
    if (kind === 'source-symlink') replaceWithLink(f.source, f.outside);
    if (kind === 'release-ancestor') {
      fs.symlinkSync(f.outside, path.join(f.root, 'releases/escape'));
      f.config.release = path.join(f.root, 'releases/escape/not-created');
    }
    if (kind === 'dotdot') f.config.release = f.root + '/releases/../../outside';
    if (kind === 'state-symlink') fs.symlinkSync(f.outside, path.join(f.release, 'state'));
    if (kind === 'report-symlink') fs.symlinkSync(f.outside, path.join(f.release, 'reports'));
    if (kind === 'external-git-file') {fs.rmSync(path.join(f.target, '.git'), {recursive:true});fs.writeFileSync(path.join(f.target, '.git'), 'gitdir: ' + path.join(f.outside, '.git'));}
    if (kind === 'git-symlink') replaceWithLink(path.join(f.target, '.git'), path.join(f.outside, '.git'));
    if (kind === 'common-dir') fs.writeFileSync(path.join(f.source, '.git/commondir'), path.join(f.outside, '.git'));
    if (kind === 'alternates') fs.writeFileSync(path.join(f.target, '.git/objects/info/alternates'), path.join(f.outside, '.git/objects'));
    if (kind === 'metadata-symlink') replaceWithLink(path.join(f.target, '.git/objects'), path.join(f.outside, '.git/objects'));
    if (kind === 'dependency-ancestor') {fs.symlinkSync(f.outside, path.join(f.root, 'dep'));f.dependencyStatePath = path.join(f.root, 'dep/new/receipt.json');}
    fs.writeFileSync(f.configPath, JSON.stringify(f.config));
    const before = fs.readdirSync(f.outside).sort();
    const script = `import {managedNightly} from ${JSON.stringify(new URL('../../scripts/scheduler/managed-nightly.mjs', import.meta.url).href)};
      let calls=0;
      try {await managedNightly({runId:'boundary'}, {run:()=>{calls++;throw Error('COMMAND_REACHED')}});process.exitCode=10;}
      catch(e){if(calls || !/unapproved runtime path|escapes approved root|independent clone|linked git metadata|shared git metadata/.test(e.message)) {console.error(e);process.exitCode=11;}}
    `;
    const r = spawnSync(process.execPath, ['--input-type=module', '-e', script], {encoding:'utf8', env:{...isolatedGitEnv(), MIVO_NIGHTLY_TASK_ROOT:f.root,MIVO_NIGHTLY_CONFIG:f.configPath,MIVO_NIGHTLY_DEPENDENCY_STATE:f.dependencyStatePath}});
    assert.equal(r.status, 0, r.stderr);
    assert.equal(fs.existsSync(path.join(f.release, 'managed-runs')), false);
    assert.equal(fs.existsSync(path.join(f.root, '.managed-nightly.lock')), false);
    assert.deepEqual(fs.readdirSync(f.outside).sort(), before);
  });
}

test('nonexistent path cannot traverse a linked ancestor', t => {
  const f = fixture(t);
  fs.symlinkSync(f.outside, path.join(f.root, 'escape'));
  assert.throws(() => containedPath(f.root, path.join(f.root, 'escape/new/file')), /escapes/);
});

test('git environment cannot redirect metadata or inject config', () => {
  const env = isolatedGitEnv({PATH:process.env.PATH,GIT_DIR:'/external',GIT_COMMON_DIR:'/external',GIT_CONFIG_COUNT:'1',GIT_ALTERNATE_OBJECT_DIRECTORIES:'/external'});
  for (const key of ['GIT_DIR','GIT_COMMON_DIR','GIT_CONFIG_COUNT','GIT_ALTERNATE_OBJECT_DIRECTORIES']) assert.equal(env[key], undefined);
});
