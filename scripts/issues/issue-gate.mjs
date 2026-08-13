#!/usr/bin/env node
// G2 issue 闸门 CLI。
//
//   node scripts/issues/issue-gate.mjs --findings state/findings-<date>.json \
//     --repo xindong/mivo-canvas-plugin [--send] [--token-file ~/.config/trae-secrets/mivo-issues-token]
//
// 可选（契约未列，附加低风险扩展，缺省即等价于契约给出的最小调用形态）：
//   --store <path>    指纹 store 路径，默认 state/fingerprints.json（相对当前工作目录）
//                      生产可用；主要面向测试传入隔离临时路径。
//   --report <path>   G1 报告路径（用于读汇总首行对账行），默认按 findings 路径推断
//                      <findings 所在目录的上一级>/reports/nightly-<date>.md
//   --commit <sha>     写入单发 issue「环境」段的 commit sha；未提供则写 "unknown"
//                      （G1 findings 契约本身不含 commit 字段，此处不编造，如实标注缺口）
//
// 安全设计（2026-08-01 修复 P0#1/#3/#5，P1#7；round-3 delta 复核追加 D-C/D-D）：
//   - dry-run 对 store 零写：只有 --send 且某条 issue 确认创建成功后，才 markSeen+save 该条指纹
//     （单条原子持久化，见 sendAll）。isKnown 只认「已成功上报」，不认「曾经预览过」。
//   - --send 时对 token 做非空校验；调用 gh 时清除继承的 GH_*/GITHUB_* 环境变量，注入独立空
//     GH_CONFIG_DIR，绝不落全局 gh 身份。
//   - 已移除 --gh-bin：该参数曾允许把 token 交给任意可执行文件，攻击面过大。测试改用进程内依赖注入
//     （run() 的 execGh 选项），不经 CLI 参数暴露。
//   - --send 时若待发内容依赖的对账信息缺失（单发需要 commit、汇总需要真实 G1 对账行）而只能写
//     "unknown"/回退占位，则拒绝发送（fail-closed）；dry-run 不受此限制，仍可预览。
//   - round-3 D-C：--send 时只要存在任何发送失败（单发或汇总，包含全部失败——成功数 0 也算部分
//     失败的极端），退出码改为 3（此前一律 0）；已成功创建的 issue 已逐条落盘去重，重跑本命令
//     只会补发失败项，不会重复创建。dry-run 不受影响，仍恒为 0（或 1/2 的格式/环境错误）。
//   - round-3 D-D：汇总正文由 render.mjs 按字符预算截断（fail-safe，非分片方案）；--send 时若
//     截断后仍超过 MAX_SEND_SUMMARY_BODY_CHARS，视为异常，直接拒发（exit 2）——理论上不会触发。
//
// 退出码：0=完成且（dry-run 或）--send 全部发送成功；
//        1=用法/findings 格式错；
//        2=store 损坏、token 缺失、--send 缺失必需对账信息，或汇总正文超限（见 D-D）；
//        3=--send 时存在发送失败（部分或全部）——已成功创建的 issue 已逐条落盘去重，重跑本命令
//          只会补发失败项，不会重复创建。
import { readFileSync, existsSync, mkdtempSync, rmSync } from 'node:fs';
import { execFile } from 'node:child_process';
import { basename, dirname, join, resolve } from 'node:path';
import { tmpdir } from 'node:os';
import { promisify } from 'node:util';
import { fileURLToPath } from 'node:url';

import { loadStore, isKnown, markSeen, save, StoreCorruptError } from './fingerprint.mjs';
import { classify, validateFindingsShape, FindingsFormatError } from './classify.mjs';
import { renderSingleIssue, renderSummaryIssue } from './render.mjs';

const execFileAsync = promisify(execFile);

// round-3 D-D 防御性硬上限：render.mjs 的 MAX_SUMMARY_BODY_CHARS(60000) 截断后正常不会触达此值；
// 若仍触达，视为渲染层截断逻辑异常，宁可拒发也不要把超限正文推给 GitHub API。
const MAX_SEND_SUMMARY_BODY_CHARS = 65_000;

class UsageError extends Error {}

export function parseArgs(argv) {
  const args = { send: false };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    switch (a) {
      case '--findings':
        args.findings = argv[++i];
        break;
      case '--repo':
        args.repo = argv[++i];
        break;
      case '--send':
        args.send = true;
        break;
      case '--token-file':
        args.tokenFile = argv[++i];
        break;
      case '--store':
        args.store = argv[++i];
        break;
      case '--report':
        args.report = argv[++i];
        break;
      case '--commit':
        args.commit = argv[++i];
        break;
      default:
        throw new UsageError(`未知参数: ${a}`);
    }
  }
  if (!args.findings) throw new UsageError('缺少必需参数 --findings');
  if (!args.repo) throw new UsageError('缺少必需参数 --repo');
  return args;
}

export function deriveScanDate(findingsPath) {
  const base = basename(findingsPath);
  const m = base.match(/findings-(\d{4}-\d{2}-\d{2})\.json$/);
  return m ? m[1] : 'unknown-date';
}

export function resolveReckoningLine(findingsPath, explicitReportPath) {
  const scanDate = deriveScanDate(findingsPath);
  const reportPath = explicitReportPath
    ? resolve(explicitReportPath)
    : join(dirname(dirname(resolve(findingsPath))), 'reports', `nightly-${scanDate}.md`);
  if (existsSync(reportPath)) {
    const firstLine = readFileSync(reportPath, 'utf8').split('\n')[0].trim();
    return { line: firstLine, source: reportPath };
  }
  return {
    line: `[回退] G1 对账行缺失（未找到 ${reportPath}），本汇总仅基于 findings.json 的记录`,
    source: null,
  };
}

function formatPreview({ mode, classified, singlePreviews, summaryPreview, reportSource }) {
  const out = [];
  const modeLabel = mode === 'send' ? '发送预览（即将真实创建 issue）' : 'dry-run 预览（仅预览，不会发送，store 零写）';
  out.push(`[issue-gate] ${modeLabel}` + (reportSource ? '' : '（对账行来源：回退，未找到 G1 报告）'));
  out.push(
    `将单发 ${classified.single.length} 条 / 汇总 ${summaryPreview ? 1 : 0} 条 / 跳过已知 ${classified.skipped.length} 条` +
      (classified.duplicateInBatch.length > 0 ? ` / 同批重复 ${classified.duplicateInBatch.length} 条` : ''),
  );
  singlePreviews.forEach((p, i) => {
    out.push('');
    out.push(`--- 单发 #${i + 1} ---`);
    out.push(`title: ${p.title}`);
    out.push(`labels: ${p.labels.join(', ')}`);
    out.push('body:');
    out.push(p.body);
  });
  if (summaryPreview) {
    out.push('');
    out.push('--- 汇总 ---');
    out.push(`title: ${summaryPreview.title}`);
    out.push(`labels: ${summaryPreview.labels.join(', ')}`);
    out.push('body:');
    out.push(summaryPreview.body);
  }
  return out.join('\n');
}

/** 生产环境唯一真实调用 gh 的地方。测试通过 run() 的 execGh 选项整体替换，不经 CLI 参数暴露。 */
async function defaultExecGh(args, env) {
  const { stdout } = await execFileAsync('gh', args, { env });
  return stdout;
}

/** 隔离 gh 子进程环境：清除继承的 GH_ 与 GITHUB_ 前缀变量，注入独立空 GH_CONFIG_DIR，绝不落全局 gh 身份。 */
function buildIsolatedGhEnv(token, ghConfigDir) {
  const env = {};
  for (const [k, v] of Object.entries(process.env)) {
    if (/^(GH|GITHUB)_/i.test(k)) continue;
    env[k] = v;
  }
  env.GH_TOKEN = token;
  env.GH_CONFIG_DIR = ghConfigDir;
  env.GH_PROMPT_DISABLED = '1';
  env.GH_NO_UPDATE_NOTIFIER = '1';
  return env;
}

async function ghIssueCreate({ repo, title, body, labels, token, ghConfigDir, execGh }) {
  const args = ['issue', 'create', '-R', repo, '--title', title, '--body', body];
  for (const label of labels) {
    args.push('--label', label);
  }
  const env = buildIsolatedGhEnv(token, ghConfigDir);
  const stdout = await execGh(args, env);
  return String(stdout ?? '').trim();
}

/**
 * 逐条/逐单元发送并按成功粒度立即持久化，避免部分失败后重跑重复建 issue（P0#3）。
 * 单发按条：每条成功即 markSeen+save；某条失败不阻断后续，失败会被记录并可见地打印。
 * 汇总按单元：一次 gh 调用打包了 summaryNormal+summaryLowConfidence，成功则整批 markSeen+save，
 * 失败则整批不标记（下次重跑会整批重试，因为汇总本身就是一次不可再拆的原子调用）。
 */
async function sendAll({ singlePreviews, summaryPreview, summaryFindings, repo, token, ghConfigDir, execGh, log, error }) {
  const outcome = { singleSent: [], singleFailed: [], summarySent: false, summaryFailed: null };
  for (const preview of singlePreviews) {
    try {
      const issueUrl = await ghIssueCreate({
        repo,
        title: preview.title,
        body: preview.body,
        labels: preview.labels,
        token,
        ghConfigDir,
        execGh,
      });
      const seenAt = new Date().toISOString();
      markSeen(preview.finding.fingerprint, {
        seenAt,
        severity: preview.finding.severity,
        dim: preview.finding.dim,
        route: 'single',
        issueUrl: issueUrl || null,
      });
      save();
      outcome.singleSent.push(preview);
      log(`[issue-gate] 单发已创建: ${preview.title}${issueUrl ? ` -> ${issueUrl}` : ''}`);
    } catch (err) {
      outcome.singleFailed.push({ preview, err });
      error(`[issue-gate] 单发失败（未标记为已上报，下次运行会重试）: ${preview.title} — ${err.message}`);
    }
  }
  if (summaryPreview) {
    try {
      const issueUrl = await ghIssueCreate({
        repo,
        title: summaryPreview.title,
        body: summaryPreview.body,
        labels: summaryPreview.labels,
        token,
        ghConfigDir,
        execGh,
      });
      const seenAt = new Date().toISOString();
      for (const f of summaryFindings) {
        markSeen(f.fingerprint, { seenAt, severity: f.severity, dim: f.dim, route: 'summary', issueUrl: issueUrl || null });
      }
      save();
      outcome.summarySent = true;
      log(`[issue-gate] 汇总已创建${issueUrl ? `: ${issueUrl}` : ''}`);
    } catch (err) {
      outcome.summaryFailed = err;
      error(`[issue-gate] 汇总失败（未标记为已上报，下次运行会重试）: ${err.message}`);
    }
  }
  return outcome;
}

export async function run(argv, { log = console.log, error = console.error, execGh = defaultExecGh } = {}) {
  let args;
  try {
    args = parseArgs(argv);
  } catch (err) {
    if (err instanceof UsageError) {
      error(`[用法错误] ${err.message}`);
      return 1;
    }
    throw err;
  }

  let findingsRaw;
  try {
    findingsRaw = JSON.parse(readFileSync(resolve(args.findings), 'utf8'));
  } catch (err) {
    error(`[findings 格式错] 读取或解析失败: ${args.findings}: ${err.message}`);
    return 1;
  }

  try {
    validateFindingsShape(findingsRaw);
  } catch (err) {
    if (err instanceof FindingsFormatError) {
      error(`[findings 格式错] ${err.message}`);
      return 1;
    }
    throw err;
  }

  const storePath = args.store ?? join(process.cwd(), 'state', 'fingerprints.json');
  try {
    loadStore(storePath);
  } catch (err) {
    if (err instanceof StoreCorruptError) {
      error(`[store 损坏] ${err.message}`);
      return 2;
    }
    throw err;
  }

  let token = null;
  if (args.send) {
    if (!args.tokenFile || !existsSync(args.tokenFile)) {
      error(`[token 缺失] --send 需要有效的 --token-file: ${args.tokenFile ?? '(未提供)'}`);
      return 2;
    }
    token = readFileSync(args.tokenFile, 'utf8').trim();
    if (token === '') {
      error(`[token 缺失] --token-file 内容为空: ${args.tokenFile}`);
      return 2;
    }
  }

  // classify() 内部对 isKnown 只做只读判断；dry-run 与 send 走到这里之前都不产生任何 store 写入。
  const classified = classify(findingsRaw, { isKnown });

  const scanDate = deriveScanDate(args.findings);
  const { line: reckoningLine, source: reportSource } = resolveReckoningLine(args.findings, args.report);
  const commit = args.commit ?? 'unknown';

  const summaryFindings = [...classified.summaryNormal, ...classified.summaryLowConfidence.map((x) => x.finding)];
  const hasSummaryContent = summaryFindings.length > 0;

  if (args.send) {
    if (classified.single.length > 0 && !args.commit) {
      error('[对账信息缺失] --send 时存在待单发 issue 但未提供 --commit（会写成 "unknown"，拒绝发送）');
      return 2;
    }
    if (hasSummaryContent && reportSource === null) {
      error('[对账信息缺失] --send 时存在待汇总内容但找不到真实 G1 对账行（会写成回退占位，拒绝发送）');
      return 2;
    }
  }

  const singlePreviews = classified.single.map((f) => ({
    finding: f,
    ...renderSingleIssue(f, { repo: args.repo, scanDate, commit }),
  }));
  const summaryPreview = hasSummaryContent
    ? renderSummaryIssue(classified, { scanDate, reckoningLine, findingsPath: resolve(args.findings) })
    : null;

  // round-3 D-D 防御性硬上限：render.mjs 自身已按字符预算截断，此处只是不信任单一防线的兜底。
  if (args.send && summaryPreview && summaryPreview.body.length > MAX_SEND_SUMMARY_BODY_CHARS) {
    error(
      `[正文超限] 汇总正文长度 ${summaryPreview.body.length} 超过 ${MAX_SEND_SUMMARY_BODY_CHARS} 字符安全上限，拒绝发送` +
        '（render.mjs 的截断保险理论上不应让正文到达这里，如实际触发请人工核查渲染逻辑）',
    );
    return 2;
  }

  log(formatPreview({ mode: args.send ? 'send' : 'dry-run', classified, singlePreviews, summaryPreview, reportSource }));

  if (args.send) {
    const ghConfigDir = mkdtempSync(join(tmpdir(), 'mivosentry-gh-config-'));
    let outcome;
    try {
      outcome = await sendAll({
        singlePreviews,
        summaryPreview,
        summaryFindings,
        repo: args.repo,
        token,
        ghConfigDir,
        execGh,
        log,
        error,
      });
      log(
        `[issue-gate] 发送完成：单发成功 ${outcome.singleSent.length}/${singlePreviews.length}` +
          `，汇总: ${summaryPreview ? (outcome.summarySent ? '成功' : '失败') : '无'}`,
      );
    } finally {
      rmSync(ghConfigDir, { recursive: true, force: true });
    }

    // round-3 D-C：只要有任何发送失败（单发或汇总，全部失败也算——成功数 0 是部分失败的极端），
    // 退出码改为 3。已成功的那部分已经在 sendAll 内逐条 markSeen+save，重跑只会补发失败项。
    const hasFailure = outcome.singleFailed.length > 0 || (summaryPreview !== null && !outcome.summarySent);
    if (hasFailure) {
      log('[issue-gate] 部分发送失败：已成功创建的 issue 已逐条落盘去重，重跑本命令只会补发失败项，不会重复创建。');
      return 3;
    }
  }

  return 0;
}

const isMain = process.argv[1] && resolve(process.argv[1]) === resolve(fileURLToPath(import.meta.url));
if (isMain) {
  // round-3 修复：process.exit(code) 会立即终止进程，管道场景下可能在缓冲的 stdout 完整落盘前
  // 就把进程杀掉，导致大量输出（真实一夜产出的预览可轻松超过 100KB）被截断。改用 process.exitCode
  // 只设置退出码、让事件循环自然耗尽后再退出，stdout 才能保证写完。
  run(process.argv.slice(2)).then(
    (code) => {
      process.exitCode = code;
    },
    (err) => {
      console.error('[issue-gate] 未捕获异常:', err);
      process.exitCode = 2;
    },
  );
}
