// G1/G2 run as real child processes on a disposable repository, without package.json.
// Only remote synchronization and launchd are replaced; no model is involved.
import { spawnSync } from 'node:child_process';
import { runNightly } from '../../../scripts/audit/nightly-runner.mjs';
const config = JSON.parse(process.argv[2]);
const result = runNightly(config.options, {
  sentryRoot: config.sentryRoot, now: () => new Date(config.now),
  command(cmd, args) {
    if (cmd === 'git' && args.includes('pull')) return { exitCode: 0, stdout: 'fixture sync', stderr: '' };
    if (cmd === 'launchctl') return { exitCode: 0, stdout: config.patrol || '', stderr: '' };
    const r = spawnSync(cmd, args, { encoding: 'utf8', timeout: 30_000 });
    return { exitCode: r.status ?? 2, stdout: r.stdout, stderr: r.stderr, error: r.error?.message };
  },
});
console.log(JSON.stringify(result));
process.exitCode = result.exitCode;
