// P0#2 回归：render.mjs 对不可信输入（file/evidence/category/dim/verify 来自被审计仓库内容）的
// Markdown 上下文转义。恶意样例覆盖：换行注入新标题、@mention 骚扰、``` 提前闭合围栏、
// 危险控制字符、疑似密钥值独立脱敏。
import { test } from 'node:test';
import assert from 'node:assert/strict';

import { renderSingleIssue, renderSummaryIssue } from '../../scripts/issues/render.mjs';

const ctx = { repo: 'xindong/mivo-canvas', scanDate: '2026-08-01', commit: 'deadbeef' };

function baseFinding(overrides = {}) {
  return {
    dim: 'secret-pattern',
    file: 'server/lib/config.ts',
    line: 18,
    category: '疑似密钥硬编码',
    evidence: "const apiKey = 'sk-xxxx'",
    severity: 'P0',
    verify: "grep -n \"apiKey = '\" server/lib/config.ts",
    fingerprint: '4af81119d7a72749',
    ...overrides,
  };
}

test('renderSingleIssue：evidence 里嵌换行+伪造标题不会在正文里变成真实新章节', () => {
  const finding = baseFinding({ evidence: "evil\n\n## PWNED 被劫持的标题\n\n更多内容" });
  const { body } = renderSingleIssue(finding, ctx);
  // 内容仍应可见（不是被静默删除，而是被中性化：换行折叠为空格，不再是"行首"）
  assert.ok(body.includes('PWNED'));
  // 但不能作为独立一行出现——否则会被渲染成真实的 Markdown 二级标题
  const lines = body.split('\n');
  assert.ok(!lines.some((l) => l.trim() === '## PWNED 被劫持的标题'));
});

test('renderSingleIssue：category 里嵌换行+新段落同样被折叠，不产生游离段落', () => {
  const finding = baseFinding({ category: "正常类别\n\n## 另一个伪造标题" });
  const { title, body } = renderSingleIssue(finding, ctx);
  const lines = body.split('\n');
  assert.ok(!lines.some((l) => l.trim() === '## 另一个伪造标题'));
  // title 本身必须是单行
  assert.ok(!title.includes('\n'));
});

test('renderSingleIssue：@mention 被中性化（插入零宽空格），肉眼文本仍保留', () => {
  const finding = baseFinding({ evidence: '请 @someone-review 看一下这个密钥' });
  const { body } = renderSingleIssue(finding, ctx);
  assert.ok(!body.includes('@someone-review'), '不应包含未中性化的原始 @mention');
  assert.ok(body.includes('@​someone-review'), '应包含插入零宽空格后的中性化版本');
});

test('renderSingleIssue：verify 含超长连续反引号时围栏动态加长，不会被内容提前闭合', () => {
  const malicious = 'echo done\n````\n之后追加的伪造内容，如果围栏被提前闭合就会跑到代码块外面';
  const finding = baseFinding({ verify: malicious });
  const { body } = renderSingleIssue(finding, ctx);
  // 恶意内容必须完整、连续地出现在正文里（没有被截断或拆散）
  assert.ok(body.includes(malicious));
  // 围栏长度必须比内容里最长的反引号连续串（4个）更长，即至少 5 个反引号
  assert.ok(body.includes('`````'), '应使用至少 5 个反引号的围栏包裹');
});

test('renderSingleIssue：危险控制字符（非 \\t\\n\\r）被清除', () => {
  const finding = baseFinding({ evidence: 'evil\x07bell\x1Bescape' });
  const { body } = renderSingleIssue(finding, ctx);
  assert.ok(!/[\x00-\x08\x0B\x0C\x0E-\x1F\x7F]/.test(body));
  // 正常字符仍保留
  assert.ok(body.includes('evilbell') || body.includes('evil') );
});

test('renderSingleIssue：疑似密钥值在 evidence/verify 里被独立脱敏（不依赖 G1 是否已脱敏）', () => {
  const finding = baseFinding({
    evidence: "token=ghp_1234567890abcdef1234",
    verify: "grep -n 'token=ghp_1234567890abcdef1234' server/lib/config.ts",
  });
  const { body } = renderSingleIssue(finding, ctx);
  assert.ok(!body.includes('ghp_1234567890abcdef1234'), '疑似真实凭证值不应原样出现在发出的正文里');
  assert.ok(body.includes('[已脱敏]'));
});

test('renderSingleIssue：title 超长时按上限截断且仍单行', () => {
  const finding = baseFinding({ category: 'x'.repeat(500) });
  const { title } = renderSingleIssue(finding, ctx);
  assert.ok(title.length <= 201); // 200 + 省略号
  assert.ok(!title.includes('\n'));
});

test('renderSingleIssue：正文四段结构与指纹仍完整（回归基线行为不丢失）', () => {
  const finding = baseFinding();
  const { title, labels, body } = renderSingleIssue(finding, ctx);
  assert.equal(title, 'audit: 疑似密钥硬编码 — server/lib/config.ts:18');
  assert.deepEqual(labels, ['trae-audit', 'P0']);
  for (const heading of ['## 问题描述', '## 环境', '## 复现步骤', '## 日志与证据']) {
    assert.ok(body.includes(heading));
  }
  assert.ok(body.includes('指纹: 4af81119d7a72749'));
});

test('renderSummaryIssue：表格单元格里的恶意换行/竖线/mention 均被中性化，不破坏表结构', () => {
  const classified = {
    summaryNormal: [
      baseFinding({
        severity: 'P2',
        fingerprint: 'aaaaaaaaaaaaaaaa',
        evidence: '含 | 竖线\n和换行 @mention-someone',
        file: 'src/x.ts',
        category: '类型逃逸',
        verify: 'grep -n x',
      }),
    ],
    summaryLowConfidence: [],
  };
  const { body } = renderSummaryIssue(classified, { scanDate: '2026-08-01', reckoningLine: '派 9 维度 / 成 7 / 败 1 / n_a 1' });
  // 表格行数不应因为内容里的换行被意外拆成多行
  const tableRows = body.split('\n').filter((l) => l.startsWith('| src/x.ts'));
  assert.equal(tableRows.length, 1);
  assert.ok(tableRows[0].includes('\\|'), '竖线应被转义为 \\|');
  assert.ok(!tableRows[0].includes('@mention-someone'));
  assert.ok(tableRows[0].includes('@​mention-someone'));
});

test('renderSummaryIssue：L1 —— summaryLowConfidence 里有 P0/P1 时顶部插入醒目提示', () => {
  const classified = {
    summaryNormal: [],
    summaryLowConfidence: [
      { finding: baseFinding({ severity: 'P1', fingerprint: 'bbbbbbbbbbbbbbbb', line: undefined }), missing: ['line'] },
    ],
  };
  const { body } = renderSummaryIssue(classified, { scanDate: '2026-08-01', reckoningLine: '派 9 维度 / 成 7 / 败 1 / n_a 1' });
  assert.match(body, /⚠️.*P0\/P1.*低置信区/);
  assert.match(body, /bbbbbbbbbbbbbbbb/);
  // 首行必须仍是原始对账行（不能被提示插到最前面覆盖掉透传的 G1 对账行）
  assert.equal(body.split('\n')[0], '派 9 维度 / 成 7 / 败 1 / n_a 1');
});

test('renderSummaryIssue：summaryLowConfidence 全是 P2/P3 时不触发醒目提示', () => {
  const classified = {
    summaryNormal: [],
    summaryLowConfidence: [
      { finding: baseFinding({ severity: 'P3', fingerprint: 'cccccccccccccccc', line: undefined }), missing: ['line'] },
    ],
  };
  const { body } = renderSummaryIssue(classified, { scanDate: '2026-08-01', reckoningLine: '对账行' });
  assert.ok(!body.includes('⚠️'));
});

// --- round-3 delta 复核：三个已实证的穿透向量回归 ---

test('renderSingleIssue：裸 \\r（无 \\n 跟随）同样被折叠，不会被渲染器当作行分隔符伪造标题（round-3 向量 a）', () => {
  const finding = baseFinding({ evidence: 'before\r## PWNED' });
  const { body } = renderSingleIssue(finding, ctx);
  assert.ok(!body.includes('\r'), '裸 \\r 应被折叠为空格，不应原样残留');
  const lines = body.split('\n');
  assert.ok(!lines.some((l) => l.trim() === '## PWNED'), '不应作为独立一行出现，否则会被渲染成真实标题');
  assert.ok(body.includes('PWNED'), '内容本身仍应可见（只是中性化，不是删除）');
});

test('renderSummaryIssue：verify 表格列里的反引号无法提前闭合外层 code span 导致链接逃逸（round-3 向量 b）', () => {
  const classified = {
    summaryNormal: [
      baseFinding({
        severity: 'P2',
        fingerprint: 'dddddddddddddddd',
        file: 'src/y.ts',
        category: '类型逃逸',
        verify: 'echo `[PWN](https://evil.example/x)`',
      }),
    ],
    summaryLowConfidence: [],
  };
  const { body } = renderSummaryIssue(classified, { scanDate: '2026-08-01', reckoningLine: '对账行' });
  const row = body.split('\n').find((l) => l.startsWith('| src/y.ts'));
  assert.ok(row, '应能找到该 finding 所在行');
  // 内容应完整出现（未被截断/删除）——链接语法本身会被 neutralizeLinks 插入零宽空格失活，
  // 所以按"去掉零宽空格后"比较，而不是要求精确原样的可点击链接语法存在。
  assert.ok(row.replace(/​/g, '').includes('[PWN](https://evil.example/x)'), '恶意内容应完整出现在同一行内（忽略零宽空格）');
  assert.ok(!row.includes('[PWN](https://evil.example/x)'), '链接语法本身应已被失活，不应原样可点击');
  const fenceRuns = row.match(/`+/g) ?? [];
  const maxFence = fenceRuns.reduce((max, r) => Math.max(max, r.length), 0);
  assert.ok(maxFence >= 2, `围栏长度必须比内容里最长的反引号连续串（1个）更长，实际行: ${row}`);
});

test('renderSingleIssue：evidence 里的内联链接/图片 Markdown 语法失活，不会渲染成可点击链接/图片（round-3 向量 c）', () => {
  const finding = baseFinding({
    evidence: '看这里 ![伪造图片](https://evil.example/x.png) 和 [钓鱼链接](https://evil.example/y)',
  });
  const { body } = renderSingleIssue(finding, ctx);
  assert.ok(!body.includes('](https://evil.example/x.png)'), '图片语法的 ](  必须被拆开失活');
  assert.ok(!body.includes('](https://evil.example/y)'), '链接语法的 ](  必须被拆开失活');
  assert.ok(body.includes('伪造图片'), '文本内容仍应可见');
  assert.ok(body.includes('钓鱼链接'), '文本内容仍应可见');
});

// --- round-3 修复项 #3：line===0（文件级 finding）不应显示误导性的 ":0" ---

test('renderSingleIssue：line=0（文件级 finding）时标题只显示文件名，不出现 ":0"', () => {
  const finding = baseFinding({ line: 0 });
  const { title } = renderSingleIssue(finding, ctx);
  assert.ok(!title.includes(':0'), `标题不应包含 ":0"，实际: ${title}`);
  assert.ok(title.endsWith('server/lib/config.ts'), `标题应以纯文件名结尾，实际: ${title}`);
});

test('renderSummaryIssue：line=0 时汇总表格行只显示文件名，不出现 ":0"', () => {
  const classified = {
    summaryNormal: [
      baseFinding({ severity: 'P2', fingerprint: 'eeeeeeeeeeeeeeee', line: 0, file: 'package.json' }),
    ],
    summaryLowConfidence: [],
  };
  const { body } = renderSummaryIssue(classified, { scanDate: '2026-08-01', reckoningLine: '对账行' });
  const row = body.split('\n').find((l) => l.startsWith('| package.json'));
  assert.ok(row, '应能找到该 finding 所在行');
  assert.ok(!row.includes(':0'), `不应出现 ":0"，实际行: ${row}`);
  assert.ok(row.startsWith('| package.json |'), '文件级 finding 的文件列应只有文件名，紧跟下一个单元格分隔符');
});

// --- round-3 D-D：汇总正文体量保险（fail-safe 截断，非分片方案） ---

test('renderSummaryIssue：正文超过安全预算时按行截断，顶部对账区与正文尾部均标注省略行数与路径', () => {
  const many = Array.from({ length: 2000 }, (_, i) =>
    baseFinding({
      severity: 'P2',
      fingerprint: i.toString(16).padStart(16, '0'),
      file: `src/gen-${i}.ts`,
      dim: 'secret-pattern',
      category: '超长文件',
      evidence: 'x'.repeat(100),
      verify: 'wc -l',
    }),
  );
  const classified = { summaryNormal: many, summaryLowConfidence: [] };
  const { body } = renderSummaryIssue(classified, {
    scanDate: '2026-08-01',
    reckoningLine: '对账行',
    findingsPath: 'state/findings-2026-08-01.json',
  });
  assert.ok(body.length < 65_000, `截断后正文应控制在安全上限附近，实际 ${body.length}`);
  assert.match(body, /因体量限制省略 \d+ 行/);
  assert.match(body, /state\/findings-2026-08-01\.json/);
  const summaryIdx = body.indexOf('## 汇总');
  const topPart = body.slice(0, summaryIdx);
  assert.match(topPart, /因体量限制省略/, '顶部对账区（"## 汇总" 之前）也应出现省略提示，不能只在尾部');
  assert.equal(body.split('\n')[0], '对账行', '首行仍应是原始对账行，不能被顶部插入的省略提示顶掉');
});

test('renderSummaryIssue：正文在预算内时不出现省略提示（回归：不误触发截断）', () => {
  const classified = {
    summaryNormal: [baseFinding({ severity: 'P2', fingerprint: 'ffffffffffffffff' })],
    summaryLowConfidence: [],
  };
  const { body } = renderSummaryIssue(classified, { scanDate: '2026-08-01', reckoningLine: '对账行' });
  assert.ok(!body.includes('因体量限制省略'));
});
