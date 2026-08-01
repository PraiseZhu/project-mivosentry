# 锚点盘点提示词（G3，给 Trae / GLM-5.2）

## 你要回答的问题

MivoCanvas 仓（路径：`/Users/praise/AI-Agent/Claude/projects/Project MivoCanvas`）里，哪些模块如果被改坏，现有测试会真的报警；哪些模块改坏了也不会有任何测试失败提醒任何人。

你不需要自己判断"这段代码写得好不好"。你要做的是：跑一个只读脚本拿到机械判定结果，然后把结果转述成人话证据，最后交给 owner 做终审决定。**判定结论（danger / weak / safe-candidate）由脚本产出，你不得自行更改或用主观印象覆盖它。**

## 前置事实（无需查证，直接使用）

- MivoSentry 仓路径：`/Users/praise/AI-Agent/Claude/projects/Project MivoSentry`
- MivoCanvas 仓路径：`/Users/praise/AI-Agent/Claude/projects/Project MivoCanvas`
- 盘点脚本：`/Users/praise/AI-Agent/Claude/projects/Project MivoSentry/scripts/anchor/anchor-map.mjs`
- 本次盘点范围仅 MivoCanvas 的 `src/` 一级目录（例如 `src/canvas`、`src/lib`），不含 `server/`。这是脚本的固定行为，不是本次临时决定。
- 你对 MivoCanvas 仓**只读**：不修改、不新建、不删除该仓内任何文件，不执行该仓的 `npm install` / `npm run test:*` / 任何会改变该仓状态的命令。你需要的所有信息，脚本会以只读方式帮你收集好。
- 你不 commit、不 push、不发任何 issue 或消息。本次产出只是一份给 owner 看的盘点报告草稿。

## 第一步：跑脚本

在终端里执行（工作目录设为 MivoSentry 仓根目录，或使用绝对路径均可）：

```bash
node "/Users/praise/AI-Agent/Claude/projects/Project MivoSentry/scripts/anchor/anchor-map.mjs" \
  --repo "/Users/praise/AI-Agent/Claude/projects/Project MivoCanvas" \
  --out "/Users/praise/AI-Agent/Claude/projects/Project MivoSentry/docs/anchor-map.md"
```

跑完检查两件事：

1. 命令退出码是 `0`。非 0 说明脚本自己拦住了：用法错误（1）、环境错误（2，比如 `--repo` 路径不对、目标仓没有 `src/` 目录）、`--out` 解析后落在 `--repo` 内被拒绝写入（3，这种情况报告文件根本没生成）、或输出写完后复检发现 `--repo` 的 `git status` 跑前跑后不一致（4，这种情况报告文件已生成但内容不可信）——按它打印的错误信息处理，不要猜。
2. 终端打印的 `[anchor-map] 已生成 ...` 一行里 danger/weak/safe-candidate 的数字。记下来，第三步要用。

## 第二步：读输出文件

打开 `/Users/praise/AI-Agent/Claude/projects/Project MivoSentry/docs/anchor-map.md`，里面有：

- 一行只读自检结果（`ok` 或 `FAIL`）——正常情况下退出码 0 时这里必为 `ok`；如果你看到 `FAIL`（同时退出码也会是 4，第一步应该已经拦住你），立刻停下，不要继续做后面的步骤，直接把这行原文报给 owner，因为这意味着 MivoCanvas 仓在跑盘点期间被意外改动了，需要先排查原因。
- 一行 coverage 探测说明——告诉你这次判定是用真实覆盖率还是降级成"有没有测试文件+断言数"的存在性判据，以及具体原因（没有 coverage 脚本/CI job；或有能力但既有产物 stale/partial 不采信）。这行文字是每次跑出来的实时结论，不要凭本提示词记忆的旧状态判断——请直接读当次报告里的这一行。
- 一行 bench exclude 校验说明——告诉你本工具排除 bench 测试用的 glob 是否与目标仓 `vitest.config.ts` 的实际配置一致；出现 `WARNING`（配置漂移）时如实转述给 owner，不要自己判断谁对谁错。
- 判定逻辑的源码片段——这就是 danger/weak/safe-candidate 三个值的**唯一**产生方式，不接受任何脚本外的重新判定。
- 模块表：每行是一个 `src/` 一级目录，含测试文件数、expect 断言数、coverage%（有可用产物时是百分数，否则是 `n/a`，具体看上面 coverage 探测那一行的说明）、skip/only 残留数、判定结果。
- 三区占比汇总行。

## 第三步：逐模块写证据行

对模块表里的**每一行**（不是只挑 danger 的），写一行证据陈述，格式固定为：

```
- <模块路径>：<判定> —— 测试文件数=<N>，expect断言数=<N>[，skip/only残留=<N>（若>0）]
```

例：

```
- src/types：danger —— 测试文件数=0，expect断言数=0
- src/model：safe-candidate（待终审） —— 测试文件数=7，expect断言数=188
```

规则：

- 只写表里已有的数字，不新增形容词（禁止"看起来不错""比较薄弱"这类词），不做超出数字本身的解读。
- `skip/only残留 > 0` 的模块，即使判定是 `safe-candidate`，也要在证据行里把这个数字带出来并单独提一句：这类模块存在被跳过/单独运行的测试，数字上的"安全"可能被这些残留掩盖了真实覆盖情况，需要 owner 额外看一眼这些具体的 `.skip(`/`.only(` 调用点。
- `danger` 的模块要额外说明：这不代表模块本身有问题，只代表"如果这个模块的代码被改坏，当前不会有任何测试失败去报警"——这是本次盘点唯一要回答的问题，不要引申成代码质量评价。

## 第四步：整理成一份给 owner 的清单

把第三步的所有证据行，按 danger → weak → safe-candidate 的顺序分组罗列（如果某组一行都没有，直接跳过整组，不写"无"）。清单开头附一句总述，直接引用第一步终端打印或文件里的三区占比数字，不要重新计算或改写措辞。

清单结尾必须包含这一整句，一字不改：

> 以上判定结论均由脚本机械产出，本清单只是转述证据，最终是否需要为 danger/weak 模块补测试、或对 safe-candidate 的终审确认，由 owner 决定。

## 你不能做的事（重复强调，防止跳步）

- 不改 `/Users/praise/AI-Agent/Claude/projects/Project MivoSentry/scripts/anchor/anchor-map.mjs` 的判定逻辑来"修正"你觉得不对的结果——如果你觉得判定逻辑本身有问题，把具体哪一条、为什么，写进给 owner 的清单里，不要自己动手改。
- 不对 MivoCanvas 仓做任何写操作，包括不装依赖、不跑测试、不生成任何该仓的构建产物。
- 不擅自把某个模块从 danger 挪到 safe-candidate（或反过来），哪怕你读了那个模块的代码觉得判定不准——脚本的数字是唯一依据，你的角色是转述证据，不是复核算法。
- 不 commit、不 push、不发消息、不建 issue。

## 复跑（模块结构变化后需要重新盘点时）

MivoCanvas 的 `src/` 一级目录结构变化（新增/删除模块目录）或测试文件大量增减后，重复第一步到第三步即可得到新结果，脚本本身不用改。每次重跑前先确认 MivoCanvas 仓路径没变：`/Users/praise/AI-Agent/Claude/projects/Project MivoCanvas`。
