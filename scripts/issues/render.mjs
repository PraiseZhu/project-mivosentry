// 渲染单发 / 汇总 issue 的 title/labels/body。
// 单发正文对齐 Project CINDY .github/ISSUE_TEMPLATE/bug_report.yml 的四段字段结构：
// 问题描述 / 环境 / 复现步骤 / 日志与证据。
//
// 安全设计（2026-08-01 修复 P0#2；round-3 delta 复核追加三个穿透向量修复）：
// finding.file/evidence/category/dim/verify 均来自被审计仓库内容
// （文件名、grep 出的代码片段等），必须视为不可信输入。按渲染上下文分层转义：
//   - sanitizeParagraph：段落内联文本——折叠换行（防止注入新 Markdown 段落/标题，round-3 修复：
//     裸 \r（无 \n 跟随）此前未被折叠，某些渲染器把裸 \r 当行分隔符处理，可借此伪造标题）、
//     剔除危险控制字符、使 @mention 失活、使内联链接/图片语法失活（round-3 修复：`[x](url)` /
//     `![x](url)` 此前原样保留，会渲染成可点击的链接/图片；插入零宽空格破坏 `](` 的紧邻性）。
//   - sanitizeTitle：单行、限长、mention 失活，用于 issue 标题。
//   - escapeCell：表格单元格——在段落级清洗之上再转义竖线。
//   - inlineCodeCell：表格内联代码列（如 verify）——动态选取比内容里最长连续反引号更长的围栏，
//     防止内容里的反引号提前闭合外层单反引号 code span（round-3 修复：此前手写单反引号包裹，
//     verify 含反引号时会闭合外层 span，让后续 `[PWN](url)` 之类内容以正常 Markdown 解析逃逸）。
//   - codeFence：动态选取比内容里最长连续反引号更长的围栏长度，防止内容提前闭合 ``` 围栏；
//     保留内部换行（verify 命令本身允许多行），但仍剔除危险控制字符。
//   - scrubSecrets：独立于 G1 自身脱敏的兜底扫描，对 evidence/verify 里形似「密钥=值」的片段发出前再脱敏一次。
//
// verify 命令来自审计脚本对仓库内容的自动提取，不保证已做 shell 转义；正文中会附一句提醒，
// 不再无条件宣称「可直接粘贴执行」（对应契约升级建议见 worker 交卷 notes）。
//
// 体量保险（round-3 D-D）：renderSummaryIssue 按 MAX_SUMMARY_BODY_CHARS 安全预算截断表格行，
// 而非无限增长（真实 1800+ 条 finding 一夜产出会撑出 30+ 万字符的汇总正文，远超 GitHub issue
// 正文上限）。截断只影响「表格行」本身，顶部对账区与正文尾部都会标注省略行数与完整清单路径，
// 不静默丢弃。这是 fail-safe，不是完整分片方案——真正的按维度/按数量分片留待后续契约升级。

const FORBIDDEN_CONTROL_CHAR_RE = /[\x00-\x08\x0B\x0C\x0E-\x1F\x7F]/g;
const MAX_TITLE_LEN = 200;
// 汇总正文安全预算（round-3 D-D fail-safe）：超出后停止追加表格行，改追加"省略 N 行"提示，
// 不再无限增长。65000 附近才是 GitHub issue 正文实测上限，60000 留出顶部/尾部提示文字的余量。
const MAX_SUMMARY_BODY_CHARS = 60_000;
// 独立于 G1 的脱敏兜底：G1 的 secret-pattern 维度已自行脱敏，但万一某个维度或未来新增维度忘记脱敏，
// G2 发出前仍做一层通用「疑似密钥/口令赋值」扫描替换，只保留字段名，隐去可能是真实凭证的值。
const SECRET_LIKE_RE = /\b((?:api[_-]?key|secret|token|password|passwd|access[_-]?key|bearer)\s*[:=]\s*)['"]?[A-Za-z0-9_\-/+]{8,}['"]?/gi;

function stripControlChars(text) {
  return String(text ?? '').replace(FORBIDDEN_CONTROL_CHAR_RE, '');
}

function scrubSecrets(text) {
  return String(text ?? '').replace(SECRET_LIKE_RE, (_m, label) => `${label}[已脱敏]`);
}

/** GitHub 的 @mention 触发条件是 @ 紧跟字母/数字/连字符；插入零宽空格使其失活但不改变人眼可读性。 */
function neutralizeMentions(text) {
  return text.replace(/@(?=[\w-])/g, '@\u200B');
}

/** Markdown 内联链接/图片语法要求 `]` 与 `(` 紧邻；插入零宽空格破坏紧邻性使其失活，不改变人眼可读性。 */
function neutralizeLinks(text) {
  return text.replace(/\]\(/g, ']​(');
}

/** 段落内联文本：折叠任意换行组合（\r\n / 裸 \r / 裸 \n）为空格（防止注入新标题/新段落——
 * 裸 \r 不跟 \n 也必须折叠，部分渲染器把裸 \r 当行分隔符），清除危险控制字符，
 * @mention 与内联链接/图片语法失活。 */
function sanitizeParagraph(value) {
  const collapsed = stripControlChars(value).replace(/(?:\r\n|\r|\n)+/g, ' ');
  return neutralizeLinks(neutralizeMentions(collapsed));
}

/** Issue 标题：单行、压缩多余空白、限长、@mention 失活。 */
function sanitizeTitle(value) {
  const oneLine = sanitizeParagraph(value).replace(/\s+/g, ' ').trim();
  if (oneLine.length <= MAX_TITLE_LEN) return oneLine;
  return `${oneLine.slice(0, MAX_TITLE_LEN - 1)}…`;
}

function escapeCell(text) {
  return sanitizeParagraph(String(text ?? '')).replace(/\|/g, '\\|');
}

/** 动态选取比内容里最长连续反引号更长的围栏，防止内容提前闭合代码块（CommonMark 规则：闭合围栏长度须 ≥ 开启围栏）。 */
function codeFence(value) {
  const safe = stripControlChars(String(value ?? ''));
  const backtickRuns = safe.match(/`+/g) ?? [];
  const longestRun = backtickRuns.reduce((max, run) => Math.max(max, run.length), 0);
  const fenceLen = Math.max(3, longestRun + 1);
  const fence = '`'.repeat(fenceLen);
  return `${fence}\n${safe}\n${fence}`;
}

/** 文件:行 表格列（round-3 修复：line 严格等于 0 表示文件级 finding，不应显示误导性的 ":0"）。
 * file/line 缺失时分别回退成 '?'（低置信区场景）。 */
function fileLineCell(file, line) {
  const fileCell = escapeCell(file ?? '?');
  if (line === 0) return fileCell;
  return `${fileCell}:${escapeCell(line ?? '?')}`;
}

/** 表格内联代码列（如 verify）：动态选取比内容里最长连续反引号更长的围栏，防止内容里的反引号
 * 提前闭合外层单反引号 code span（round-3 修复：原先手写单反引号包裹，content 含反引号即可闭合，
 * 让紧随其后的 `[PWN](url)` 之类 Markdown 语法逃出 code span 被正常解析为可点击链接）。 */
function inlineCodeCell(text) {
  const safe = escapeCell(text);
  const backtickRuns = safe.match(/`+/g) ?? [];
  const longestRun = backtickRuns.reduce((max, run) => Math.max(max, run.length), 0);
  const fence = '`'.repeat(longestRun + 1);
  return `${fence}${safe}${fence}`;
}

function groupByDim(findings) {
  const map = new Map();
  for (const f of findings) {
    if (!map.has(f.dim)) map.set(f.dim, []);
    map.get(f.dim).push(f);
  }
  return map;
}

/**
 * @param {object} finding G1 findings 记录（含 file/line/category/evidence/severity/verify/fingerprint/dim）
 * @param {{repo: string, scanDate: string, commit: string}} ctx
 */
export function renderSingleIssue(finding, ctx) {
  const { repo, scanDate, commit } = ctx;
  const category = sanitizeParagraph(String(finding.category));
  const file = sanitizeParagraph(String(finding.file));
  const evidence = sanitizeParagraph(scrubSecrets(finding.evidence));
  const dim = sanitizeParagraph(String(finding.dim));
  // severity/fingerprint 已在 classify.mjs 结构校验中被约束为固定枚举/16位十六进制，无需再转义。
  // round-3 修复：line 严格等于 0 表示文件级 finding（无具体行号），标题只显示文件名，不显示误导性的 ":0"。
  const location = finding.line === 0 ? file : `${file}:${finding.line}`;
  const title = sanitizeTitle(`audit: ${category} — ${location}`);
  const labels = ['trae-audit', finding.severity];
  const body = [
    '## 问题描述',
    `实际: ${category} — ${evidence}`,
    '期望: 按下方复现步骤验证问题不再出现，再关闭本 issue。',
    '',
    '## 环境',
    `- 仓库: ${sanitizeParagraph(String(repo))}`,
    `- commit: ${sanitizeParagraph(String(commit))}`,
    `- 扫描日期: ${sanitizeParagraph(String(scanDate))}`,
    `- 维度: ${dim}`,
    '',
    '## 复现步骤',
    codeFence(scrubSecrets(finding.verify)),
    '',
    '_以上命令来自审计脚本对仓库内容的自动提取，粘贴执行前请自行确认内容——不可信输入未做 shell 转义保证。_',
    '',
    '## 日志与证据',
    `- 证据: ${evidence}`,
    `- 指纹: ${finding.fingerprint}`,
    '',
  ].join('\n');
  return { title, labels, body };
}

/**
 * @param {{summaryNormal: object[], summaryLowConfidence: {finding: object, missing: string[]}[]}} classified
 * @param {{scanDate: string, reckoningLine: string, findingsPath?: string}} ctx
 */
export function renderSummaryIssue(classified, ctx) {
  const { scanDate, reckoningLine, findingsPath } = ctx;
  const lines = [reckoningLine];
  let runningLength = reckoningLine.length + 1;
  const push = (text) => {
    lines.push(text);
    runningLength += text.length + 1;
  };

  // L1: P0/P1 因缺字段被降级到低置信区时，容易被表格淹没——顶部加醒目提示，指引人工核实。
  const highSeverityLowConfidence = classified.summaryLowConfidence.filter(({ finding }) =>
    finding.severity === 'P0' || finding.severity === 'P1',
  );
  if (highSeverityLowConfidence.length > 0) {
    const fps = highSeverityLowConfidence.map(({ finding }) => finding.fingerprint).join(', ');
    push('');
    push(`> ⚠️ **注意**：本次汇总中有 ${highSeverityLowConfidence.length} 条 P0/P1 因字段不全被降级到低置信区（未走单发通道），请人工核实——指纹: ${fps}`);
  }

  // round-3 D-D：顶部对账区插入点先记下位置——省略行数要等下面表格全部处理完才知道，
  // 但仍希望它出现在"## 汇总"之前的顶部区域，所以先记 index，最后用 splice 插入。
  const topInsertIndex = lines.length;

  push('');
  push('## 汇总');

  const byDim = groupByDim(classified.summaryNormal);
  let omittedRows = 0;
  let budgetExceeded = false;

  if (byDim.size === 0) {
    push('');
    push('（本轮无字段齐全的汇总项）');
  }
  for (const [dim, items] of byDim) {
    if (budgetExceeded) {
      omittedRows += items.length;
      continue;
    }
    push('');
    push(`### ${escapeCell(dim)}`);
    push('| 文件:行 | 类别 | 严重度 | 证据 | 验证 | 指纹 |');
    push('|---|---|---|---|---|---|');
    for (const f of items) {
      if (budgetExceeded) {
        omittedRows += 1;
        continue;
      }
      const row = `| ${fileLineCell(f.file, f.line)} | ${escapeCell(f.category)} | ${escapeCell(f.severity)} | ${escapeCell(scrubSecrets(f.evidence))} | ${inlineCodeCell(scrubSecrets(f.verify))} | ${escapeCell(f.fingerprint)} |`;
      if (runningLength + row.length + 1 > MAX_SUMMARY_BODY_CHARS) {
        budgetExceeded = true;
        omittedRows += 1;
        continue;
      }
      push(row);
    }
  }

  if (classified.summaryLowConfidence.length > 0) {
    if (budgetExceeded) {
      omittedRows += classified.summaryLowConfidence.length;
    } else {
      push('');
      push('## 低置信区（字段不全，需人工补全后再判断是否升级为单发 issue）');
      push('| 文件:行 | 类别 | 严重度 | 缺失字段 | 证据 | 指纹 |');
      push('|---|---|---|---|---|---|');
      for (const { finding: f, missing } of classified.summaryLowConfidence) {
        const row = `| ${fileLineCell(f.file, f.line)} | ${escapeCell(f.category ?? '?')} | ${escapeCell(f.severity ?? '?')} | ${missing.map((m) => escapeCell(m)).join(',')} | ${escapeCell(scrubSecrets(f.evidence ?? ''))} | ${escapeCell(f.fingerprint ?? '?')} |`;
        if (budgetExceeded || runningLength + row.length + 1 > MAX_SUMMARY_BODY_CHARS) {
          budgetExceeded = true;
          omittedRows += 1;
          continue;
        }
        push(row);
      }
    }
  }

  // round-3 D-D：截断不是分片方案，只是 fail-safe——省略了多少行、去哪找完整清单，
  // 顶部（对账区旁）和正文尾部都要看得到，不许静默丢弃。
  if (omittedRows > 0) {
    const path = findingsPath ?? `state/findings-${scanDate}.json`;
    const omissionNote = `> 因体量限制省略 ${omittedRows} 行，完整清单见当日 findings JSON（${path}）`;
    lines.splice(topInsertIndex, 0, '', omissionNote);
    push('');
    push(omissionNote);
  }

  const title = `audit: 夜巡汇总 ${scanDate}`;
  return { title, labels: ['trae-audit'], body: lines.join('\n') + '\n' };
}
