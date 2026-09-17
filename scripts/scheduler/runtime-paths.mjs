import fs from 'node:fs';
import path from 'node:path';
import {spawnSync} from 'node:child_process';

function inside(root, candidate) {
  const rel = path.relative(root, candidate);
  return rel === '' || (!rel.startsWith('..' + path.sep) && rel !== '..' && !path.isAbsolute(rel));
}

// Resolve the nearest existing ancestor as well as the final component. lstat
// deliberately notices dangling links; those fail realpath rather than passing.
export function containedPath(root, candidate) {
  if (typeof candidate !== 'string' || !path.isAbsolute(candidate) || candidate.split(path.sep).includes('..')) throw Error('unapproved runtime path');
  root = fs.realpathSync(root);
  if (!inside(root, candidate)) throw Error('runtime path escapes approved root');
  let ancestor = candidate;
  const suffix = [];
  while (true) {
    try { fs.lstatSync(ancestor); break; } catch (e) {
      if (e.code !== 'ENOENT') throw e;
      suffix.unshift(path.basename(ancestor));
      ancestor = path.dirname(ancestor);
    }
  }
  const resolved = path.join(fs.realpathSync(ancestor), ...suffix);
  if (!inside(root, resolved)) throw Error('runtime path symlink escapes approved root');
  return resolved;
}

export function isolatedGitEnv(base = process.env) {
  const env = {...base};
  for (const key of Object.keys(env)) if (key.startsWith('GIT_')) delete env[key];
  return {...env, GIT_OPTIONAL_LOCKS:'0', GIT_CONFIG_NOSYSTEM:'1', GIT_CONFIG_GLOBAL:'/dev/null'};
}

export function independentClone(root, repo) {
  const canonical = containedPath(root, repo);
  const metadata = path.join(canonical, '.git');
  const st = fs.lstatSync(metadata);
  if (!st.isDirectory() || st.isSymbolicLink()) throw Error('independent clone requires local .git directory');
  // No linked metadata, worktree common directory or alternate object store.
  const visit = dir => {
    for (const entry of fs.readdirSync(dir, {withFileTypes:true})) {
      const p = path.join(dir, entry.name);
      if (entry.isSymbolicLink()) throw Error('linked git metadata forbidden');
      if (entry.isDirectory()) visit(p);
    }
  };
  visit(metadata);
  for (const file of ['commondir', 'objects/info/alternates', 'objects/info/http-alternates']) {
    if (fs.existsSync(path.join(metadata, file))) throw Error('shared git metadata/alternates forbidden');
  }
  for (const [flag, expected] of [['--show-toplevel', canonical], ['--absolute-git-dir', metadata], ['--git-common-dir', metadata]]) {
    const r = spawnSync('git', ['-C', canonical, 'rev-parse', '--path-format=absolute', flag], {env:isolatedGitEnv(), encoding:'utf8'});
    if (r.status !== 0 || fs.realpathSync(r.stdout.trim()) !== expected) throw Error('independent git root/metadata mismatch');
  }
  return canonical;
}

export function validateRuntimePaths(root, config, configPath, dependencyStatePath) {
  containedPath(root, configPath);
  containedPath(root, dependencyStatePath);
  const release = containedPath(root, config.release);
  if (!inside(path.join(root, 'releases'), release) || release === path.join(root, 'releases') || config.target !== path.join(root, 'plugin-runtime')) throw Error('unapproved runtime path');
  for (const p of ['source', 'state', 'reports', 'managed-runs', 'frozen-origin.git', 'release-manifest.json']) containedPath(root, path.join(release, p));
  for (const p of ['npm-cache', 'install-tmp', '.managed-nightly.lock']) containedPath(root, path.join(root, p));
  // Existing nested output entries can be symlinks too (e.g. health.json).
  const outputs = dir => {
    containedPath(root, dir);
    if (!fs.existsSync(dir)) return;
    if (fs.lstatSync(dir).isSymbolicLink()) throw Error('linked runtime output forbidden');
    if (fs.statSync(dir).isDirectory()) for (const entry of fs.readdirSync(dir)) outputs(path.join(dir, entry));
  };
  for (const p of ['state', 'reports', 'managed-runs']) outputs(path.join(release, p));
  independentClone(root, path.join(release, 'source'));
  independentClone(root, config.target);
}
