# browser-forge 迭代 SOP:从多物料录制到回归驱动优化

> 本文件是**给 agent 执行的操作手册**,不是背景说明。新会话中,主 agent 应逐节按此 SOP 推进。
> 依据:2026-08-08 用 `session-2026-08-07-2159` 跑通"录制→分析→生成→填充→校验→报告"全流程、并完成目标3/4 迭代后的实证。
> 定位:**被分析的业务 skill(joysubdoc 等)是试验田(测试集),真正的交付物是更好的 browser-forge 分析流程本身。** 见 [analysis-flow-optimization.md](analysis-flow-optimization.md)。

---

## 0. 术语与不可动摇的原则

| 术语 | 含义 |
|---|---|
| **物料 (material)** | 一次浏览器录制的产物目录 `session-YYYY-MM-DD-HHMM/`(含 `recording.har` / `timeline.json` / `tabs` / `metadata.json` / `RECORDING.md`) |
| **物料规格 (spec)** | 人给出的三要素:①**操作描述** ②**产出 skill 目标** ③**复现目标(验收用例)** |
| **产出 agent (producer)** | 黑盒子 agent,只拿"物料 + 操作描述 + 产出目标",分析并产出 skill,不知道复现目标细节、不看验证代码 |
| **验证 agent (validator)** | 另一个黑盒子 agent,只拿"产出的 skill + 复现目标",独立验证,不知道 producer 的思路 |
| **测试集 (corpus)** | 全部跑通的物料集合,作为后续每轮优化的回归基线 |

**五条铁律(任何一步都不得违反):**
1. **先归档防抄**:每次让 producer 产出前,先把该物料上一版产出 skill 归档到 `skills/_archive/<tag>/`,并从工作区移走,防止 producer 抄旧答案。
2. **双黑盒隔离**:producer 与 validator 是两次独立的 `Agent` 调用,互不传递对方的中间推理。validator 绝不能看到复现目标之外的"标准答案"。
3. **一改一提交**:每个独立功能迭代或问题修复,单独一次 git commit(browser-forge 仓库 `/Users/zhukai.129/AiWorkspace/browser-forge` 是 git 仓库;dongdev-op 工作区不是)。
4. **凭据零落地**:任何 Cookie / token / me_token / 签名 / 密码 / session id 不得进入产出 skill、示例、fixture、测试、日志、提交。鉴权一律走运行时 provider。录制文件不得拷入产出。
5. **如实报告**:验证失败就贴失败输出说失败;跳过就说跳过;通过且复核过才说通过。不美化。

---

## 1. 目录与命名约定

```
/Users/zhukai.129/CodeSpace/dongdev-op/          # 工作区(试验田,非 git)
├─ session-YYYY-MM-DD-HHMM/                       # 录制物料
├─ materials/                                     # ★ 新增:测试集清单与规格
│  └─ corpus.md                                   #   全部物料的 spec 与跑通状态台账
├─ skills/
│  ├─ <skill-name>/                               # 当前产出(工作区)
│  └─ _archive/<tag>/<skill-name>/                # 归档:tag 形如 iter-5 / mat-joysubdoc-r2
└─ ...

/Users/zhukai.129/AiWorkspace/browser-forge/     # ★ 交付物:分析工具本体(git)
├─ src/ skills/browser-forge/ tests/ docs/
```

- 归档 tag 规约:按物料首跑用 `mat-<slug>-r1`;某物料因优化重跑用 `mat-<slug>-r2`…;整轮工具优化后的全量回归用 `iter-<n>`。
- 每个物料的 spec 存进 `materials/corpus.md`(见 §2 模板),这是测试集的唯一台账。

---

## 2. 阶段一:建立测试集(逐物料跑通)

目标:把 N 个物料各自**独立跑通一次端到端**,沉淀为回归基线。对**每一个**物料执行 §2.1–§2.6。

### 2.1 登记物料规格
人(或你代人整理)把三要素写入 `materials/corpus.md`,一物料一节:

```markdown
## <slug>  (session-YYYY-MM-DD-HHMM)
- 操作描述:<用户在浏览器里做了什么,业务语言>
- 产出目标:<希望这个 skill 对外提供什么能力>
- 复现目标:<一条可判定成败的验收用例。形如"给定 X,调用 skill 应产生 Y / 返回 Z / 走到某守卫">
- 目标域:<target-domain,如 joyspace.jd.com>
- 状态:未跑通 | 已跑通(基线 commit/归档 tag) | 需重跑
```

**复现目标必须可判定**——是"给定输入 → 期望可观察结果",不是"大概能用"。这是 validator 的唯一评判依据。

### 2.2 归档旧产出(防抄)
若该物料此前产出过 skill:
```bash
mkdir -p skills/_archive/mat-<slug>-r1
mv skills/<skill-name> skills/_archive/mat-<slug>-r1/   # 移走,不是复制
```
确认工作区 `skills/` 下已无该 skill,producer 无从抄起。

### 2.3 产出 agent(黑盒·仅给物料+操作描述+产出目标)
用 `Agent`(建议 `general-purpose`,后台并行可选)派发,**prompt 只含**:物料绝对路径、操作描述、产出目标、目标域;并明确要求:
- 用 browser-forge skill 完成 `分析→generate→populate→validate`,直到 `validate-skill` 返回 `{"ok":true}`。
- 跑生成的 pytest 必须在**外部临时 venv**里跑(`PYTHONDONTWRITEBYTECODE=1` + `PYTHONPYCACHEPREFIX=/tmp/...` + `-p no:cacheprovider`),严禁在 skill 目录内产生 `.venv`/`__pycache__`/`.pytest_cache`(否则 `forbiddenExecutionPathIssues` 校验会失败)。
- 回报:产出 skill 路径、两次 `validate` 原始 JSON、测试结果、以及**工具使用摩擦点**(哪一步 browser-forge 别扭/文档与实现不符/踩坑)。
- **禁止**修改 browser-forge 工具源码;**禁止**把任何凭据或录制文件写入产出。

**producer 的"摩擦点"回报是第 7 步复盘的一等输入,务必要求它结构化列出。**

### 2.4 验证 agent(黑盒·仅给产出 skill+复现目标)
producer 完成后,**另起**一个 `Agent`,prompt 只含:产出 skill 的路径、该物料的**复现目标**。要求:
- 以复现目标为唯一验收标准,黑盒调用 skill 的命令验证(离线/网络守卫下也要能判定命令注册、参数解析、步骤构建是否符合预期)。
- 同样在外部临时 venv 跑,验证后确认 skill 目录**零污染**。
- 若涉及默认遥测,顺带黑盒核验:默认静默(缺 SLS 变量即 noop)、事件不夹带凭据。
- 明确给出 **PASS / FAIL** 与依据;FAIL 时给出**最小复现**和**期望 vs 实际**。

### 2.5 失败→补信息→复盘(第 5 步)
若 validator 判 FAIL:
1. 先判断根因归属:**是物料/规格不足**(操作描述漏了关键上下文、复现目标不可判定),**还是 browser-forge 工具缺陷**。
2. 若规格不足 → 补充操作描述/澄清复现目标,回 §2.2 重跑(新 tag `-r2`)。
3. 若工具缺陷 → 记入 `analysis-flow-optimization.md` 问题清单(带物料实证),**但本阶段先不修工具**;可临时以人工补信息让该物料跑通,把工具缺陷留到阶段三统一优化。
4. 每次 FAIL 都在 `corpus.md` 该物料下追加一条"复盘:为什么没达预期"。

### 2.6 跑通登记
validator 判 PASS 后:
- `corpus.md` 该物料状态改为"已跑通",记基线归档 tag。
- 把这一版产出 skill 归档一份作为该物料的**回归基线**(`skills/_archive/mat-<slug>-r<k>/`)。

**阶段一完成判据:`corpus.md` 中全部物料状态 = 已跑通。** 此时测试集建立完毕(第 6 步:完整走通录制到可用 skill)。

---

## 3. 阶段二:回归驱动的工具优化(第 7–8 步)

有了测试集后,每一轮 browser-forge 优化都用**整个测试集**回归,用双指标衡量效果。

### 3.1 复盘选题(第 7 步)
汇总所有物料 producer/validator 回报的摩擦点 + `analysis-flow-optimization.md` 未闭环问题,按"实证信号强度 × 与两条主线(A 契约演进 / B 信息不丢失)的相关性"排序,选出**本轮 1 个**优化项。选题写入本轮迭代记录。

### 3.2 记录优化前基线
对测试集**每个物料**跑一次当前 §2.3+§2.4 双黑盒(可并行多个 producer),记录:
- 通过率(PASS 数 / 总数)
- 每个物料 validator 报告的摩擦点数量与清单
这是 optimization 的 before 快照。

### 3.3 在 browser-forge 实施优化(第 8 步)
在 `/Users/zhukai.129/AiWorkspace/browser-forge` 改工具本体:
- 遵守 SHA 锁定契约(改运行时需同步 resync-runtime;改模板要能被存量 skill 平滑跟上)。
- 跑全套 JS 测试 `npm run test` + 相关 Python 模板测试,全绿。
- **一改一提交**(铁律3)。
- 若改了随 app 分发的 skill/runtime,提醒:app 启动会按 contentHash 自动 `updated`,存量安装会自愈(见 [telemetry-operations.md] 与 index.js 安装逻辑)。

### 3.4 回归验证(before/after 对比)
优化后,对测试集**每个物料重跑双黑盒**(务必先按 §2.2 归档并移走上一版产出,防抄)。判定效果:
- **不回归**:优化前已 PASS 的物料必须仍 PASS(硬门槛,任何回归都要修复或回滚)。
- **有改善**:目标摩擦点在相关物料的 validator 报告中消失/减轻;或此前需人工补信息才跑通的物料,现在能自动跑通。
- 结果写入本轮迭代记录:before/after 通过率、摩擦点增减、结论。

### 3.5 沉淀
- 更新 `analysis-flow-optimization.md`(问题状态、进度总览)。
- 值得跨会话记住的非显然结论 → 写入记忆(memory)。
- `corpus.md` 若因优化产生新基线,更新各物料的基线 tag。

---

## 4. 每轮迭代的最小检查清单(agent 自检)

- [ ] 本轮选题有物料实证支撑,且对齐主线 A/B
- [ ] 优化前基线已记录(通过率 + 摩擦点快照)
- [ ] producer 与 validator 是两次独立 Agent 调用,且产出前已归档移走旧 skill
- [ ] browser-forge 全套测试绿;每个独立改动单独 commit
- [ ] 回归:优化前 PASS 的物料无一回归
- [ ] before/after 对比结论已写入迭代记录
- [ ] 凭据零落地、录制文件未入产出(抽查 producer 产物)
- [ ] 文档/记忆已更新

---

## 5. 一句话流程图

```
建集(每物料):  归档旧→[producer 黑盒:物料+描述+目标]→[validator 黑盒:skill+复现目标]→PASS?→登记基线
              └── FAIL → 补规格 or 记工具缺陷 → 重跑
优化(每轮):    复盘选题 → 记 before → 改 browser-forge(测试绿·单独提交) → 归档旧→双黑盒重跑全集 → before/after 对比 → 沉淀
```
