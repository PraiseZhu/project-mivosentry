// G2 分流规则（纯函数，无 IO）：
//   1. 同批内重复指纹 → 只保留首条，其余计入 duplicateInBatch（同一批 findings 里出现两次同一指纹时，
//      避免为同一个问题重复建两条单发 issue）
//   2. 指纹已知（已成功上报过）→ 跳过
//   3. severity=P0/P1 且五字段齐（文件:行/类别/证据/验证方式/指纹） → 单发
//   4. 其余 → 汇总（字段不全的落低置信区，字段齐的落正常表格）
//
// 校验分两层（2026-08-01 修复 P1#6）：
//   - 结构层（validateFindingsShape）：dim/severity/fingerprint 的形状错误直接判「findings 格式错」，
//     整批拒绝（batch fail-fast）——这三个字段是路由与去重的地基，值不对会让分流/去重整体不可信，
//     不能只隔离单条。
//   - 字段完整性层（missingFields）：file/line/category/evidence/verify 的类型或内容不合规只影响
//     该条自身的「五字段是否齐」，逐条隔离降级到低置信区，不拖累整批（batch 内其它条目照常路由）。

export class FindingsFormatError extends Error {}

const STRUCTURAL_REQUIRED = ['dim', 'severity', 'fingerprint'];
const HIGH_SEVERITIES = new Set(['P0', 'P1']);
const KNOWN_SEVERITIES = new Set(['P0', 'P1', 'P2', 'P3']);
// G1 契约固定的 9 个机械维度（docs/CONTRACTS.md G1 节）；未知 dim 说明 findings.json 与契约不一致，宁可拒绝也不要静默路由。
const KNOWN_DIMS = new Set([
  'deps-vuln',
  'dead-code',
  'todo-stale',
  'log-violation',
  'type-escape',
  'secret-pattern',
  'circular-dep',
  'test-health',
  'debt-metric',
]);
const FINGERPRINT_RE = /^[0-9a-f]{16}$/;
const MAX_TEXT_FIELD_LEN = 4000;
// 允许 \t\n\r，拒绝其它 C0 控制符与 DEL（可能是注入/损坏数据的信号，不是合法文本内容）。
const FORBIDDEN_CONTROL_CHAR_RE = /[\x00-\x08\x0B\x0C\x0E-\x1F\x7F]/;

function isNonEmpty(v) {
  if (v === undefined || v === null) return false;
  if (typeof v === 'string') return v.trim() !== '';
  if (typeof v === 'number') return Number.isFinite(v);
  return true;
}

/** 字符串型字段的内容校验：必须是 string，非空，长度有上限，且不含危险控制字符。 */
function isValidTextField(v) {
  if (typeof v !== 'string') return false;
  if (v.trim() === '') return false;
  if (v.length > MAX_TEXT_FIELD_LEN) return false;
  if (FORBIDDEN_CONTROL_CHAR_RE.test(v)) return false;
  return true;
}

/** line 允许 0（表示文件级 finding，无具体行号），但必须是非负整数——不接受字符串/浮点/对象。 */
function isValidLine(v) {
  return typeof v === 'number' && Number.isInteger(v) && v >= 0;
}

/** 结构性校验：findings 必须是对象数组，且每条 dim/severity/fingerprint 形状合法（去重与分流的最小前提）。 */
export function validateFindingsShape(findings) {
  if (!Array.isArray(findings)) {
    throw new FindingsFormatError('findings 必须是数组');
  }
  findings.forEach((f, i) => {
    if (typeof f !== 'object' || f === null || Array.isArray(f)) {
      throw new FindingsFormatError(`findings[${i}] 不是对象`);
    }
    for (const key of STRUCTURAL_REQUIRED) {
      if (!isNonEmpty(f[key])) {
        throw new FindingsFormatError(`findings[${i}] 缺少必需字段: ${key}`);
      }
    }
    if (typeof f.dim !== 'string' || !KNOWN_DIMS.has(f.dim)) {
      throw new FindingsFormatError(`findings[${i}].dim 不在 G1 契约的 9 个维度枚举内: ${JSON.stringify(f.dim)}`);
    }
    if (typeof f.severity !== 'string' || !KNOWN_SEVERITIES.has(f.severity)) {
      throw new FindingsFormatError(`findings[${i}].severity 必须是 P0/P1/P2/P3 之一: ${JSON.stringify(f.severity)}`);
    }
    if (typeof f.fingerprint !== 'string' || !FINGERPRINT_RE.test(f.fingerprint)) {
      throw new FindingsFormatError(`findings[${i}].fingerprint 必须是 16 位小写十六进制: ${JSON.stringify(f.fingerprint)}`);
    }
  });
}

/** 五字段齐检查（文件:行 拆成 file/line 两项校验，另加 category/evidence/verify/fingerprint）。返回缺失字段名列表。 */
export function missingFields(finding) {
  const missing = [];
  if (!isValidTextField(finding.file)) missing.push('file');
  if (!isValidLine(finding.line)) missing.push('line');
  if (!isValidTextField(finding.category)) missing.push('category');
  if (!isValidTextField(finding.evidence)) missing.push('evidence');
  if (!isValidTextField(finding.verify)) missing.push('verify');
  if (!isNonEmpty(finding.fingerprint)) missing.push('fingerprint');
  return missing;
}

export function isFiveFieldsComplete(finding) {
  return missingFields(finding).length === 0;
}

export function isHighSeverity(finding) {
  return HIGH_SEVERITIES.has(finding.severity);
}

/**
 * 对已通过结构校验的 findings 执行分流。
 * @param {object[]} findings
 * @param {{isKnown: (fp: string) => boolean}} deps
 */
export function classify(findings, { isKnown }) {
  const result = {
    duplicateInBatch: [],
    skipped: [],
    single: [],
    summaryNormal: [],
    summaryLowConfidence: [],
  };
  const seenThisBatch = new Set();
  for (const finding of findings) {
    if (seenThisBatch.has(finding.fingerprint)) {
      // 同一批 findings.json 内出现了两次同一指纹（真实数据已复现）：只按首条路由，其余记为同批重复，
      // 避免同一个问题在一次运行里被单发两条 issue。
      result.duplicateInBatch.push(finding);
      continue;
    }
    seenThisBatch.add(finding.fingerprint);

    if (isKnown(finding.fingerprint)) {
      result.skipped.push(finding);
      continue;
    }
    const missing = missingFields(finding);
    const complete = missing.length === 0;
    if (isHighSeverity(finding) && complete) {
      result.single.push(finding);
    } else if (!complete) {
      result.summaryLowConfidence.push({ finding, missing });
    } else {
      result.summaryNormal.push(finding);
    }
  }
  return result;
}
