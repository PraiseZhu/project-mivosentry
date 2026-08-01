import { test } from 'node:test';
import assert from 'node:assert/strict';

import {
  classify,
  validateFindingsShape,
  missingFields,
  isFiveFieldsComplete,
  isHighSeverity,
  FindingsFormatError,
} from '../../scripts/issues/classify.mjs';

const baseFinding = {
  dim: 'type-escape',
  file: 'src/x.ts',
  line: 12,
  category: '类型逃逸',
  evidence: 'as any ×3',
  severity: 'P2',
  verify: "grep -n 'as any' src/x.ts",
  fingerprint: 'abc1234567890abc',
};

test('validateFindingsShape：非数组直接抛 FindingsFormatError', () => {
  assert.throws(() => validateFindingsShape({}), FindingsFormatError);
});

test('validateFindingsShape：缺 dim/severity/fingerprint 任一字段即抛错', () => {
  assert.throws(() => validateFindingsShape([{ ...baseFinding, fingerprint: '' }]), FindingsFormatError);
  assert.throws(() => validateFindingsShape([{ ...baseFinding, severity: undefined }]), FindingsFormatError);
});

test('validateFindingsShape：结构合法时不抛错', () => {
  assert.doesNotThrow(() => validateFindingsShape([baseFinding]));
});

test('missingFields / isFiveFieldsComplete：完整记录无缺失', () => {
  assert.deepEqual(missingFields(baseFinding), []);
  assert.equal(isFiveFieldsComplete(baseFinding), true);
});

test('missingFields：缺 line 时报告 line 缺失', () => {
  const f = { ...baseFinding, line: undefined };
  assert.deepEqual(missingFields(f), ['line']);
  assert.equal(isFiveFieldsComplete(f), false);
});

test('isHighSeverity：仅 P0/P1 为高严重度', () => {
  assert.equal(isHighSeverity({ severity: 'P0' }), true);
  assert.equal(isHighSeverity({ severity: 'P1' }), true);
  assert.equal(isHighSeverity({ severity: 'P2' }), false);
  assert.equal(isHighSeverity({ severity: 'P3' }), false);
});

test('classify：已知指纹跳过，不再进入任何分流桶', () => {
  const known = new Set([baseFinding.fingerprint]);
  const result = classify([baseFinding], { isKnown: (fp) => known.has(fp) });
  assert.equal(result.skipped.length, 1);
  assert.equal(result.single.length, 0);
  assert.equal(result.summaryNormal.length, 0);
  assert.equal(result.summaryLowConfidence.length, 0);
});

test('classify：P0/P1 且五字段齐 → 单发', () => {
  const p0 = { ...baseFinding, fingerprint: 'p0fp', severity: 'P0' };
  const result = classify([p0], { isKnown: () => false });
  assert.equal(result.single.length, 1);
  assert.equal(result.single[0].fingerprint, 'p0fp');
});

test('classify：P1 但缺字段 → 落入低置信区，不进入单发', () => {
  const p1Incomplete = { ...baseFinding, fingerprint: 'p1fp', severity: 'P1', line: undefined };
  const result = classify([p1Incomplete], { isKnown: () => false });
  assert.equal(result.single.length, 0);
  assert.equal(result.summaryLowConfidence.length, 1);
  assert.deepEqual(result.summaryLowConfidence[0].missing, ['line']);
});

test('classify：P2 且字段齐 → 汇总正常表格', () => {
  const p2 = { ...baseFinding, fingerprint: 'p2fp', severity: 'P2' };
  const result = classify([p2], { isKnown: () => false });
  assert.equal(result.summaryNormal.length, 1);
  assert.equal(result.summaryLowConfidence.length, 0);
  assert.equal(result.single.length, 0);
});

// --- P0#3 回归：同一批 findings.json 内出现两次同一指纹（真实数据已复现：1812 条里有 2 条重复） ---
test('classify：同批出现两次同一指纹 → 只路由首条，其余计入 duplicateInBatch，不产生两条单发', () => {
  const p0 = { ...baseFinding, fingerprint: 'dupfp', severity: 'P0' };
  const result = classify([p0, { ...p0 }, { ...p0 }], { isKnown: () => false });
  assert.equal(result.single.length, 1);
  assert.equal(result.duplicateInBatch.length, 2);
  assert.equal(result.skipped.length, 0);
});

test('classify：同批重复但指纹已上报过 → 首条计入 skipped，其余仍计入 duplicateInBatch（不重复计入 skipped）', () => {
  const known = new Set(['dupfp']);
  const result = classify(
    [{ ...baseFinding, fingerprint: 'dupfp' }, { ...baseFinding, fingerprint: 'dupfp' }],
    { isKnown: (fp) => known.has(fp) },
  );
  assert.equal(result.skipped.length, 1);
  assert.equal(result.duplicateInBatch.length, 1);
});

// --- P1#6 回归：schema 校验必须验类型，不能只验"非空" ---
test('validateFindingsShape：dim 不在 G1 九维度枚举内 → 抛错（而不是静默放行未知维度）', () => {
  assert.throws(() => validateFindingsShape([{ ...baseFinding, dim: 'not-a-real-dim' }]), FindingsFormatError);
});

test('validateFindingsShape：severity 值非法（小写/超出枚举）→ 抛错', () => {
  assert.throws(() => validateFindingsShape([{ ...baseFinding, severity: 'p0' }]), FindingsFormatError);
  assert.throws(() => validateFindingsShape([{ ...baseFinding, severity: 'P9' }]), FindingsFormatError);
});

test('validateFindingsShape：fingerprint 不是 16 位小写十六进制 → 抛错', () => {
  assert.throws(() => validateFindingsShape([{ ...baseFinding, fingerprint: 'ABC123' }]), FindingsFormatError);
  assert.throws(() => validateFindingsShape([{ ...baseFinding, fingerprint: 'short' }]), FindingsFormatError);
});

test('missingFields：字段是对象/数组而非字符串时不再被当作"齐"（原 bug：isNonEmpty 对非 string/number 类型无条件返回 true）', () => {
  const objCategory = { ...baseFinding, category: { nested: 'value' } };
  assert.deepEqual(missingFields(objCategory), ['category']);

  const arrEvidence = { ...baseFinding, evidence: ['a', 'b'] };
  assert.deepEqual(missingFields(arrEvidence), ['evidence']);

  const objFile = { ...baseFinding, file: { path: 'x' } };
  assert.deepEqual(missingFields(objFile), ['file']);
});

test('missingFields：line=0 视为文件级 finding，五字段齐（G1 真实数据存在此形态）', () => {
  const fileLevel = { ...baseFinding, line: 0 };
  assert.deepEqual(missingFields(fileLevel), []);
  assert.equal(isFiveFieldsComplete(fileLevel), true);
});

test('missingFields：line 为负数/浮点/字符串均判缺失（不是合法行号）', () => {
  assert.deepEqual(missingFields({ ...baseFinding, line: -1 }), ['line']);
  assert.deepEqual(missingFields({ ...baseFinding, line: 1.5 }), ['line']);
  assert.deepEqual(missingFields({ ...baseFinding, line: '12' }), ['line']);
});

test('missingFields：文本字段含危险控制字符（非 \\t\\n\\r）判缺失', () => {
  const withControlChar = { ...baseFinding, evidence: 'evil\x07bell' };
  assert.deepEqual(missingFields(withControlChar), ['evidence']);
});
