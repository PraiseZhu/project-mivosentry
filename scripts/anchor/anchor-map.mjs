#!/usr/bin/env node
// G3 锚点盘点。按 docs/CONTRACTS.md § G3 实现。
//
// 用法：
//   node scripts/anchor/anchor-map.mjs --repo <目标仓绝对路径> --out <输出md路径>
//
// 只读保证：全程仅 readdirSync/readFileSync/statSync 目标仓，不写、不跑测试、
// 不执行任何子进程改动目标仓状态。--out 必须解析（含 symlink 穿透）到 --repo 之外，
// 否则拒绝执行（见 assertOutOutsideRepo）。跑前状态与「输出写完后」的状态做
// `git status --porcelain` 对比，不一致视为自检失败并非 0 退出（见 main() 末尾）。
//
// 探测优先级（实测，不假设）：
//   1) coverage 能力 = package.json scripts 命中 --coverage/nyc 关键词，或
//      .github/workflows/*.yml 中命中 --coverage/nyc/coverage-summary.json 关键词
//      （任一命中即视为「有 coverage 能力」——CI 里跑 coverage 不写进 package.json
//      scripts 是常见形态，只查 scripts 会漏判）。有能力时进一步核验既有产物
//      coverage/coverage-summary.json 是否可用：产物必须覆盖至少一个 src/ 模块文件，
//      且 mtime 不早于当前 HEAD 提交时间，否则判定 stale/partial，不采信。
//   2) 没有 coverage 能力 → 降级为存在性判据：模块（src 一级目录）×
//      {test 文件数, expect() 断言计数, .skip()/.only() 残留}。
//
// 判定（机械，见 computeVerdict()，禁形容词）：
//   无测试(testFileCount===0)      → danger
//   有测试但 expectCount < testFileCount*3 → weak
//   否则                            → safe-candidate（终审权在 owner）
//
// expect()/.skip()/.only() 计数在计数前先剥离注释与字符串字面量（见
// stripCommentsAndStrings()），避免把注释/字符串里出现的 "expect(" 文本误计入。
// 该剥离是轻量词法级别的，非完整 AST：模板字符串内 `${...}` 插值中的真实代码会被
// 当作字符串内容一并剥离（可能轻微低估），正则字面量不做专门识别；但 '/" 字符串
// 的扫描以行为界（JS 单/双引号字符串不能跨行），避免被形如 /['"]/ 的字符类正则
// 误判成未闭合字符串而吞掉后续大段代码——已用 MivoCanvas src/lib、src/store 的
// AST 复核结果验证（2814/1703）。
//
// bench 测试排除：只排除 `.bench.test.ts` 这一字面量后缀（.tsx/.js/.mjs 等变体
// 永不在排除之列，会被计入正常测试统计）。是否排除还取决于运行时对目标仓
// vitest.config.ts 的实测（见 detectBenchExcludeGlob + decideBenchExclusion）：
// 只有确认目标配置仍把 ts 变体纳入 bench exclude 时才排除（exact 完全一致 /
// drift 字面漂移但仍含 ts 变体两种情形）；未找到该配置项、读取或解析失败、或
// 配置已漂移到不含 ts 变体——三种情况统一 fail-closed：不排除，`.bench.test.ts`
// 计入统计并在报告中 WARNING，避免在无法确认目标配置的情况下静默丢弃可见性。
//
// 退出码：0=完成；1=用法错；2=环境错（--repo 不存在/不是目录，或无 src/）；
//   3=--out 解析后位于 --repo 内（含 symlink 穿透），拒绝写入；
//   4=输出写完后 git status 与跑前不一致（自检失败，需人工核查是否有意外写入）。

import { readFileSync, readdirSync, statSync, lstatSync, writeFileSync, existsSync, realpathSync, readlinkSync } from 'node:fs'
import { join, resolve, sep, isAbsolute } from 'node:path'
import { execFileSync } from 'node:child_process'

const TEST_FILE_RE = /\.(test|spec)\.[cm]?[jt]sx?$/
// 只匹配该字面量后缀；是否真的排除由 walkTestFiles 的 excludeBenchTs 参数决定
// （见 decideBenchExclusion）。.tsx/.js/.mjs 等 bench 变体永不匹配本正则，始终
// 计入正常测试统计。
const BENCH_TEST_RE = /\.bench\.test\.ts$/
const KNOWN_BENCH_GLOB = '**/*.bench.test.ts'
const EXCLUDE_DIR_RE = /(^|\/)(node_modules|dist|_tmp|\.claude|\.cindy-worktrees|\.xdt-worktrees|coverage|test-artifacts)(\/|$)/

function parseArgs(argv) {
  const args = { repo: null, out: null }
  for (let i = 0; i < argv.length; i++) {
    if (argv[i] === '--repo') args.repo = argv[++i]
    else if (argv[i] === '--out') args.out = argv[++i]
  }
  return args
}

function fail(code, msg) {
  console.error(`[anchor-map] ${msg}`)
  process.exit(code)
}

function gitStatusPorcelain(repo) {
  try {
    return execFileSync('git', ['-C', repo, 'status', '--porcelain'], { encoding: 'utf8' })
  } catch {
    return null // 非 git 仓或 git 不可用——不阻断只读探测，如实标注
  }
}

function gitHeadCommitTime(repo) {
  try {
    const out = execFileSync('git', ['-C', repo, 'log', '-1', '--format=%cI'], { encoding: 'utf8' }).trim()
    return out || null
  } catch {
    return null
  }
}

const MAX_SYMLINK_RESOLVE_DEPTH = 40 // 纯防环兜底（量级对齐常见 OS ELOOP），非契约值

// 逐路径分量解析 targetPath，正确区分「该分量本身不存在」与「该分量是 symlink，
// 但目标已被删除（悬空 symlink）」。旧实现用 existsSync 判断是否需要继续向上找
// 已存在的祖先目录——但 existsSync 会追随 symlink，对悬空 symlink 直接返回
// false，与「路径分量根本不存在」无法区分：--out 若是一个已存在、指向 --repo 内
// 某路径的悬空 symlink，旧实现会把它整体当作「尚未创建的字面路径」，只对它的上级
// 目录 realpath，再把 symlink 自身的名字原样拼回去——但 writeFileSync 实际会追随
// 这个 symlink，写入它真正指向的（--repo 内的）目标，从而绕过边界校验、在目标仓
// 内产生零 git-status 可见的写入（若目标恰好被 .gitignore 覆盖）。
//
// 本函数改用 lstatSync 判断路径分量自身是否存在——symlink 本身的 lstat 不会因为
// 目标缺失而失败，只有「这个名字压根不存在」才会 ENOENT。分量是 symlink 时用
// readlinkSync 读出真实指向（可能是相对路径、可能仍是另一层 symlink、也可能仍
// 不存在）并递归解析该指向，解析结果替换当前位置后再继续处理 targetPath 里剩余
// 未处理的分量。真正遇到「该分量不存在且不是 symlink」时才停止递归、把剩余路径
// 原样字面拼接（不存在的路径不可能是 symlink，也不需要 realpath）。depth 上限
// 防止 symlink 自环（a→b→a）导致无限递归。
function resolveRealAllowingDanglingSymlinkTail(targetPath, depth = 0) {
  if (depth > MAX_SYMLINK_RESOLVE_DEPTH) {
    fail(
      3,
      `--out 路径解析时 symlink 链过深（>${MAX_SYMLINK_RESOLVE_DEPTH} 层），疑似存在循环 symlink：${targetPath}`
    )
  }
  const abs = resolve(targetPath)
  const parts = abs.split(sep).filter(Boolean)
  let cur = sep
  for (let idx = 0; idx < parts.length; idx++) {
    const next = join(cur, parts[idx])
    let lst
    try {
      lst = lstatSync(next)
    } catch {
      return join(cur, ...parts.slice(idx))
    }
    if (lst.isSymbolicLink()) {
      const linkTarget = readlinkSync(next)
      const resolvedTarget = isAbsolute(linkTarget) ? linkTarget : join(cur, linkTarget)
      cur = resolveRealAllowingDanglingSymlinkTail(resolvedTarget, depth + 1)
    } else {
      cur = next
    }
  }
  return cur
}

function assertOutOutsideRepo(repo, out) {
  const repoReal = realpathSync(repo)
  const outReal = resolveRealAllowingDanglingSymlinkTail(out)
  const withinRepo = outReal === repoReal || outReal.startsWith(repoReal + sep)
  if (withinRepo) {
    fail(
      3,
      `--out 解析后位于 --repo 内（含 symlink 穿透，含悬空 symlink 指向解析），拒绝写入：--out=${out} → 解析路径=${outReal}；--repo realpath=${repoReal}`
    )
  }
}

// excludeBenchTs：是否排除 .bench.test.ts。只有在探测阶段（见 decideBenchExclusion）
// 确认目标仓 vitest.config.ts 仍把 ts 变体纳入 bench exclude 时才为 true；未找到该
// 配置项、解析失败、或配置已漂移到不含 ts 变体时为 false——此时 .bench.test.ts 按
// 普通测试文件计入统计（fail-closed，不静默丢弃可见性）。
function walkTestFiles(dir, excludeBenchTs, files = []) {
  let entries
  try {
    entries = readdirSync(dir, { withFileTypes: true })
  } catch {
    return files
  }
  for (const entry of entries) {
    const full = join(dir, entry.name)
    if (EXCLUDE_DIR_RE.test(full)) continue
    if (entry.isDirectory()) {
      walkTestFiles(full, excludeBenchTs, files)
    } else if (
      entry.isFile() &&
      TEST_FILE_RE.test(entry.name) &&
      !(excludeBenchTs && BENCH_TEST_RE.test(entry.name))
    ) {
      files.push(full)
    }
  }
  return files
}

function countMatches(text, re) {
  const m = text.match(re)
  return m ? m.length : 0
}

// 轻量词法剥离：把注释与字符串字面量替换为单个空格，避免 expect()/.skip()/.only()
// 计数把注释、字符串里的同名文本算进去。非完整 AST，精度边界见文件头注释。
function stripCommentsAndStrings(text) {
  let out = ''
  let i = 0
  const n = text.length
  while (i < n) {
    const c = text[i]
    const c2 = i + 1 < n ? text[i + 1] : ''
    if (c === '/' && c2 === '/') {
      i += 2
      while (i < n && text[i] !== '\n') i++
      out += ' '
      continue
    }
    if (c === '/' && c2 === '*') {
      i += 2
      while (i < n && !(text[i] === '*' && text[i + 1] === '/')) i++
      i = Math.min(i + 2, n)
      out += ' '
      continue
    }
    if (c === '`') {
      // 模板字符串可跨行；`${...}` 插值内的真实代码会被一并当作字符串剥离
      // （精度边界：可能轻微低估插值内的 expect() 调用，测试文件里极罕见）。
      let j = i + 1
      while (j < n && text[j] !== '`') {
        if (text[j] === '\\') j++
        j++
      }
      out += ' '
      i = j + 1
      continue
    }
    if (c === "'" || c === '"') {
      // 单/双引号字符串在合法 JS/TS 中不能跨未转义的换行；扫描以行为界，
      // 找不到闭合引号就判定这不是字符串（常见于形如 /['"]/ 的字符类正则），
      // 把该引号当普通字符放行，避免误吞后续大段真实代码。
      const quote = c
      let j = i + 1
      let found = false
      while (j < n) {
        if (text[j] === '\\') {
          j += 2
          continue
        }
        if (text[j] === '\n') break
        if (text[j] === quote) {
          found = true
          break
        }
        j++
      }
      if (found) {
        out += ' '
        i = j + 1
      } else {
        out += c
        i++
      }
      continue
    }
    out += c
    i++
  }
  return out
}

function detectCoverageInPackageScripts(repo) {
  const pkgPath = join(repo, 'package.json')
  if (!existsSync(pkgPath)) return { found: false, scriptCount: 0, hits: [] }
  const pkg = JSON.parse(readFileSync(pkgPath, 'utf8'))
  const scripts = pkg.scripts || {}
  const hits = Object.entries(scripts).filter(
    ([name, cmd]) => /coverage/i.test(name) || /--coverage\b/.test(cmd) || /\bnyc\b/.test(cmd)
  )
  return {
    found: hits.length > 0,
    scriptCount: Object.keys(scripts).length,
    hits: hits.map(([name, cmd]) => `${name}: ${cmd}`),
  }
}

function detectCoverageInCIWorkflows(repo) {
  const dir = join(repo, '.github', 'workflows')
  if (!existsSync(dir)) return { found: false, fileCount: 0, hits: [] }
  let entries
  try {
    entries = readdirSync(dir).filter((f) => /\.ya?ml$/i.test(f))
  } catch {
    return { found: false, fileCount: 0, hits: [] }
  }
  const hits = []
  for (const file of entries) {
    let text
    try {
      text = readFileSync(join(dir, file), 'utf8')
    } catch {
      continue
    }
    if (/--coverage(\.\w+)?\b/.test(text) || /\bnyc\b/.test(text) || /coverage-summary\.json/.test(text)) {
      hits.push(file)
    }
  }
  return { found: hits.length > 0, fileCount: entries.length, hits }
}

function tryReadCoverageSummary(repo) {
  const p = join(repo, 'coverage', 'coverage-summary.json')
  if (!existsSync(p)) return { present: false }
  try {
    const data = JSON.parse(readFileSync(p, 'utf8'))
    return { present: true, mtime: statSync(p).mtime.toISOString(), data }
  } catch (err) {
    return { present: true, parseError: String(err) }
  }
}

// 判定既有 coverage/coverage-summary.json 产物是否可采信：必须至少覆盖一个
// src/ 下的文件，且 mtime 不早于当前 HEAD 提交时间；否则判定 stale/partial。
function assessCoverageArtifact(repo, artifact) {
  if (!artifact.present) return { usable: false, reason: '产物缺失' }
  if (artifact.parseError || !artifact.data) {
    return { usable: false, reason: `解析失败（${artifact.parseError ?? '未知错误'}）` }
  }
  const files = Object.keys(artifact.data).filter((k) => k !== 'total')
  const srcPrefix = join(repo, 'src') + sep
  const srcFiles = files.filter((f) => f.startsWith(srcPrefix))
  const headTime = gitHeadCommitTime(repo)
  const staleVsHead = headTime ? new Date(artifact.mtime).getTime() < new Date(headTime).getTime() : null
  const coversSrc = srcFiles.length > 0
  const usable = coversSrc && staleVsHead !== true
  const reasons = []
  if (!coversSrc) {
    const sample = files.slice(0, 5).map((f) => (f.startsWith(repo + sep) ? f.slice(repo.length + 1) : f))
    reasons.push(
      `产物含 ${files.length} 个文件、0 个位于 src/ 下（示例：${sample.join(', ')}），与本工具模块判据（src 一级目录）无交集`
    )
  }
  if (staleVsHead === true) {
    reasons.push(`产物 mtime（${artifact.mtime}）早于当前 HEAD 提交时间（${headTime}）`)
  }
  return {
    usable,
    fileCount: files.length,
    srcFileCount: srcFiles.length,
    staleVsHead,
    headTime,
    reason: reasons.join('；'),
  }
}

function coveragePctForModule(summaryData, repo, mod) {
  if (!summaryData) return null
  const modPrefix = join(repo, 'src', mod) + '/'
  let coveredLines = 0
  let totalLines = 0
  let matchedFiles = 0
  for (const [file, stats] of Object.entries(summaryData)) {
    if (file === 'total') continue
    if (!file.startsWith(modPrefix)) continue
    matchedFiles++
    totalLines += stats.lines?.total || 0
    coveredLines += stats.lines?.covered || 0
  }
  if (matchedFiles === 0 || totalLines === 0) return null
  return `${((coveredLines / totalLines) * 100).toFixed(1)}%`
}

// 从目标仓 vitest.config.ts 机械读取实际的 bench.test exclude glob，用于核对
// 本工具硬编码的 KNOWN_BENCH_GLOB 是否与目标仓配置漂移。
function detectBenchExcludeGlob(repo) {
  const p = join(repo, 'vitest.config.ts')
  if (!existsSync(p)) return { found: false, reason: 'vitest.config.ts 不存在' }
  let text
  try {
    text = readFileSync(p, 'utf8')
  } catch (err) {
    return { found: false, reason: `读取失败（${err})` }
  }
  // 同时接受单一后缀（**/*.bench.test.ts）与 brace 展开多后缀
  // （**/*.bench.test.{ts,tsx}）两种常见 glob 写法。
  const m = text.match(/\*\*\/\*\.bench\.test\.(?:\{[\w,.]+\}|[\w.]+)/)
  if (!m) return { found: false, reason: 'vitest.config.ts 中未找到 bench.test exclude 项' }
  return { found: true, glob: m[0] }
}

// 从探测到的 glob 里抽出它覆盖的扩展名集合（单一后缀或 brace 展开均支持），用于
// 判断该 glob 是否仍把 "ts" 变体纳入排除范围。
function extractBenchGlobExtensions(glob) {
  const m = glob.match(/\.bench\.test\.(?:\{([\w,.]+)\}|([\w.]+))$/)
  if (!m) return []
  const raw = m[1] ?? m[2] ?? ''
  return raw
    .split(',')
    .map((s) => s.trim())
    .filter(Boolean)
}

// 把 detectBenchExcludeGlob 的探测结果转成本次运行的排除决策，三分支：
//   exact   —— 目标配置的 bench exclude glob 与本工具硬编码值逐字一致
//   drift   —— 目标配置存在且已确认仍含 ts 变体，但字面 glob 与硬编码值不同
//   missing —— 未找到该配置项 / 读取或解析失败 / 目标配置存在但不含 ts 变体
// 只有 exact 与 drift 会排除 .bench.test.ts；missing 一律不排除（fail-closed，
// 计入正常测试统计），避免在无法确认目标配置的情况下静默丢弃可见性。
function decideBenchExclusion(benchExclude) {
  if (!benchExclude.found) {
    return {
      state: 'missing',
      excludeBenchTs: false,
      detail: `未能在 vitest.config.ts 核实 bench exclude 项（${benchExclude.reason}）`,
    }
  }
  const exts = extractBenchGlobExtensions(benchExclude.glob)
  if (!exts.includes('ts')) {
    return {
      state: 'missing',
      excludeBenchTs: false,
      detail: `目标仓 vitest.config.ts 的 bench exclude 项为 \`${benchExclude.glob}\`，不含 ts 变体`,
    }
  }
  if (benchExclude.glob === KNOWN_BENCH_GLOB) {
    return { state: 'exact', excludeBenchTs: true, glob: benchExclude.glob, detail: null }
  }
  return {
    state: 'drift',
    excludeBenchTs: true,
    glob: benchExclude.glob,
    detail: `目标仓 vitest.config.ts 的 bench exclude 项为 \`${benchExclude.glob}\`，与本工具硬编码的 \`${KNOWN_BENCH_GLOB}\` 不一致（配置漂移，但已确认仍含 ts 变体）`,
  }
}

function computeVerdict(testFileCount, expectCount) {
  if (testFileCount === 0) return 'danger'
  if (expectCount < testFileCount * 3) return 'weak'
  return 'safe-candidate'
}

function buildReportLines({ repo, readonlyLine, coverageNote, benchNote, benchFootnote, rows, tally }) {
  const total = rows.length
  const pct = (n) => (total === 0 ? '0.0%' : `${((n / total) * 100).toFixed(1)}%`)

  const lines = []
  lines.push('# MivoCanvas 锚点盘点（G3）')
  lines.push('')
  lines.push(`- 生成时间：${new Date().toISOString()}`)
  lines.push(`- 目标仓：\`${repo}\``)
  lines.push(`- 只读自检：${readonlyLine}`)
  lines.push(`- coverage 探测：${coverageNote}`)
  lines.push(`- bench exclude 校验：${benchNote}`)
  lines.push('')
  lines.push('## 判定逻辑（机械，源码原样取自本脚本 computeVerdict.toString()，不手抄，不会与实际逻辑漂移）')
  lines.push('')
  lines.push('```js')
  lines.push(computeVerdict.toString())
  lines.push('```')
  lines.push('')
  lines.push(benchFootnote)
  lines.push('')
  lines.push('## 模块表')
  lines.push('')
  lines.push('| 模块 | 测试文件数 | 断言数(expect) | coverage%(有则填) | skip/only残留 | 判定 |')
  lines.push('|------|-----------|---------------|-------------------|---------------|------|')
  for (const r of rows) {
    const verdictLabel = r.verdict === 'safe-candidate' ? `${r.verdict}（待终审）` : r.verdict
    lines.push(
      `| \`${r.mod}\` | ${r.testFileCount} | ${r.expectCount} | ${r.coveragePct} | ${r.skipOnlyCount} | ${verdictLabel} |`
    )
  }
  lines.push('')
  lines.push('## 三区占比汇总')
  lines.push('')
  lines.push('| danger | weak | safe-candidate（待终审） | 模块总数 |')
  lines.push('|--------|------|--------------------------|----------|')
  lines.push(
    `| ${tally.danger} (${pct(tally.danger)}) | ${tally.weak} (${pct(tally.weak)}) | ${tally['safe-candidate']} (${pct(tally['safe-candidate'])}) | ${total} |`
  )
  lines.push('')
  return lines
}

function main() {
  const { repo, out } = parseArgs(process.argv.slice(2))
  if (!repo || !out) {
    fail(1, '用法：node scripts/anchor/anchor-map.mjs --repo <路径> --out <输出md路径>')
  }
  if (!existsSync(repo) || !statSync(repo).isDirectory()) {
    fail(2, `--repo 路径不存在或不是目录：${repo}`)
  }
  assertOutOutsideRepo(repo, out)
  const srcDir = join(repo, 'src')
  if (!existsSync(srcDir) || !statSync(srcDir).isDirectory()) {
    fail(2, `目标仓无 src/ 目录，本工具的模块判据（模块=src 一级目录）不适用：${srcDir}`)
  }

  const preStatus = gitStatusPorcelain(repo)

  const pkgCoverage = detectCoverageInPackageScripts(repo)
  const ciCoverage = detectCoverageInCIWorkflows(repo)
  const coverageArtifact = tryReadCoverageSummary(repo)
  const coverageCapabilityFound = pkgCoverage.found || ciCoverage.found

  let coverageNote
  let summaryDataForModules = null
  if (coverageCapabilityFound) {
    const sources = []
    if (pkgCoverage.found) sources.push(`package.json scripts（${pkgCoverage.hits.join('; ')}）`)
    if (ciCoverage.found) sources.push(`CI workflow（${ciCoverage.hits.join(', ')}）`)
    const capabilityDesc = `检测到 coverage 能力：${sources.join('；')}`

    if (coverageArtifact.present && coverageArtifact.data) {
      const assessment = assessCoverageArtifact(repo, coverageArtifact)
      if (assessment.usable) {
        coverageNote = `${capabilityDesc}；既有产物 coverage/coverage-summary.json 校验通过（覆盖 ${assessment.srcFileCount} 个 src/ 文件，mtime=${coverageArtifact.mtime}）→ 按模块聚合 lines.pct`
        summaryDataForModules = coverageArtifact.data
      } else {
        coverageNote = `${capabilityDesc}；但既有产物 coverage/coverage-summary.json 判定为 stale/partial，不采信（${assessment.reason}）→ 本次仍按存在性判据计算，pct 列填 n/a（需先手动跑一次 coverage 脚本/CI job 再重跑本工具）`
      }
    } else {
      const artifactIssue = coverageArtifact.present ? `解析失败（${coverageArtifact.parseError}）` : '产物缺失'
      coverageNote = `${capabilityDesc}；coverage/coverage-summary.json ${artifactIssue} → 本次仍按存在性判据计算，pct 列填 n/a（需先手动跑一次 coverage 脚本/CI job 再重跑本工具）`
    }
  } else {
    let artifactNote = ''
    if (coverageArtifact.present) {
      if (coverageArtifact.parseError) {
        artifactNote = `；另探测到 coverage/coverage-summary.json 但解析失败（${coverageArtifact.parseError}），不采信`
      } else {
        const assessment = assessCoverageArtifact(repo, coverageArtifact)
        artifactNote = `；另探测到 coverage/coverage-summary.json（mtime=${coverageArtifact.mtime}），但 package.json 与 CI workflow 均无 coverage 能力来源 → 判定为孤立产物，不采信${assessment.reason ? `（${assessment.reason}）` : ''}`
      }
    }
    coverageNote = `未发现 coverage 能力（package.json scripts 共 ${pkgCoverage.scriptCount} 个均无 --coverage/nyc；.github/workflows 共 ${ciCoverage.fileCount} 个文件均无 coverage 迹象）→ 降级为存在性判据（模块×test文件数×expect断言计数×skip/only残留）${artifactNote}`
  }

  const benchExclude = detectBenchExcludeGlob(repo)
  const benchDecision = decideBenchExclusion(benchExclude)
  let benchNote
  let benchFootnote
  if (benchDecision.state === 'exact') {
    benchNote = `已核实 vitest.config.ts 的 bench exclude 项与本工具一致：\`${benchDecision.glob}\``
    benchFootnote = `注：\`${KNOWN_BENCH_GLOB}\` 不计入 test 文件数/断言数——已核实与目标仓 \`vitest.config.ts\` 的 exclude 规则完全一致，bench 已被移出 \`test:unit\` / required gate，破坏 bench 覆盖的逻辑不触发合并阻断报警。`
  } else if (benchDecision.state === 'drift') {
    benchNote = `WARNING：${benchDecision.detail} → 本工具仍只排除 \`${KNOWN_BENCH_GLOB}\`，未覆盖的 bench 变体会被计入正常测试统计（fail-closed，不静默丢弃）`
    benchFootnote = `注：\`${KNOWN_BENCH_GLOB}\` 不计入 test 文件数/断言数——目标仓 \`vitest.config.ts\` 的 exclude 规则已漂移（见上方 WARNING），本工具仍只按硬编码窄口径排除该字面量后缀，未覆盖的 bench 变体计入统计；bench 已被移出 \`test:unit\` / required gate，破坏 bench 覆盖的逻辑不触发合并阻断报警。`
  } else {
    benchNote = `WARNING：${benchDecision.detail} → 本次判定为不排除，\`${KNOWN_BENCH_GLOB}\` 已计入正常测试统计（fail-closed，避免在未确认目标配置的情况下静默丢弃可见性），请人工核对目标仓 vitest.config.ts`
    benchFootnote = `注：本次未能确认目标仓 \`vitest.config.ts\` 仍将 \`${KNOWN_BENCH_GLOB}\` 纳入 exclude（见上方 WARNING），该 glob 本次**未被排除**，\`.bench.test.ts\` 已计入下表的 test 文件数/断言数统计。`
  }

  const moduleDirs = readdirSync(srcDir, { withFileTypes: true })
    .filter((e) => e.isDirectory())
    .map((e) => e.name)
    .sort()

  const rows = []
  const tally = { danger: 0, weak: 0, 'safe-candidate': 0 }

  for (const mod of moduleDirs) {
    const modPath = join(srcDir, mod)
    const testFiles = walkTestFiles(modPath, benchDecision.excludeBenchTs)
    const testFileCount = testFiles.length

    let expectCount = 0
    let skipOnlyCount = 0
    for (const f of testFiles) {
      const text = readFileSync(f, 'utf8')
      const stripped = stripCommentsAndStrings(text)
      expectCount += countMatches(stripped, /\bexpect\s*\(/g)
      skipOnlyCount += countMatches(stripped, /\.(skip|only)\s*\(/g)
    }

    const verdict = computeVerdict(testFileCount, expectCount)
    tally[verdict]++

    const coveragePct = summaryDataForModules
      ? coveragePctForModule(summaryDataForModules, repo, mod) ?? 'n/a'
      : 'n/a'

    rows.push({ mod: `src/${mod}`, testFileCount, expectCount, coveragePct, skipOnlyCount, verdict })
  }

  // 第一次写入：自检文案先占位，因为「写完后再取 postStatus」是本工具对
  // --repo 零写入的最终证据，取值动作本身必须发生在这次写入之后（见下）。
  const provisionalLines = buildReportLines({
    repo,
    readonlyLine: 'pending（写入后复检中，见退出码；若看到这行说明复检未覆盖本文件，请重跑）',
    coverageNote,
    benchNote,
    benchFootnote,
    rows,
    tally,
  })
  writeFileSync(out, provisionalLines.join('\n') + '\n', 'utf8')

  const postStatus = gitStatusPorcelain(repo)
  let readonlyLine
  let readonlyOk = true
  if (preStatus === null || postStatus === null) {
    readonlyLine = 'n/a（非 git 仓或 git 不可用，跳过对比）'
  } else if (preStatus === postStatus) {
    readonlyLine = `ok（本工具输出写入后，对比跑前/跑后 \`git -C <repo> status --porcelain\` 一致，长度 ${preStatus.length} 字符）`
  } else {
    readonlyLine = 'FAIL：跑前与输出写入后的 git status 不一致，请人工核查是否有意外写入'
    readonlyOk = false
  }

  // 第二次写入：用「写入后」拿到的真实自检结果覆盖占位文案。out 由本工具
  // （MivoSentry）自己拥有，二次写入不违反「对 --repo 只读」的契约。
  const finalLines = buildReportLines({ repo, readonlyLine, coverageNote, benchNote, benchFootnote, rows, tally })
  writeFileSync(out, finalLines.join('\n') + '\n', 'utf8')

  const total = rows.length
  console.log(
    `[anchor-map] 已生成 ${out}（${total} 模块，danger=${tally.danger} weak=${tally.weak} safe-candidate=${tally['safe-candidate']}）`
  )

  if (!readonlyOk) {
    console.error('[anchor-map] FAIL：目标仓 git status 在运行前后发生变化，请核查是否意外写入')
    process.exit(4)
  }
}

main()
