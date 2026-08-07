# browser-forge 分析流程优化方案

> 依据:2026-08-08 用 `session-2026-08-07-2159`(JoySpace 主文档下新建子文档)完整走通一遍
> `录制物料 → 分析 → 生成 → 填充 → 校验 → 报告` 流程后的实证。
> joysubdoc 是试验田,本文档目标是**优化 browser-forge 分析流程本身**,使产出 skill 统一、可整合。

## 一、贯穿全局的两条主线

所有问题归结为两个根:

**主线 A —— 统一契约只"冻结"未"演进"。** SHA 锁定保证了所有 skill 运行时层字节一致(这是"可整合"的基础,方向对),但缺了"契约升级时让存量 skill 平滑跟上"的通道。契约一改,存量 skill 集体与新模板脱节且无法自更新。范式会随时间**碎裂**而非收敛。

**主线 B —— 信息在链路上被过早丢弃。** 录制器采集的交互语义太薄(只有坐标+通用标签,无输入值、无稳定选择器),分析阶段被迫从数百条 HAR 里人肉逆向;步骤引擎又不让响应在步骤间流动。上游砍掉了下游需要的信息。

---

## 二、问题清单(按优先级)

### P0-1 【主线A·地基】模板演进无下发通道,存量 skill 集体失效

- **现象**:本轮我为修 TLS/Cookie 改了 4 个运行时模板文件。新生成的 skill 正常;但存量的 joysubdoc 运行时字节停留在旧模板,校验器用新模板算期望 SHA → 逐字节对不上 → 报 `IMMUTABLE_RUNTIME_FILE`。而运行时层 SHA 锁定不许手改。**存量 skill 被锁死:既跑不了新代码,又改不动。**
- **根因**:校验采用"现场用当前模板重算 SHA 比对"(模板即真相),这本身优雅;但只有"冻结"没有"重生成"。`auth.runtime_version` 字段存在却无人消费。
- **对目标的影响**:直接决定"统一契约"能否持续。不解决,每次模板改进都是对存量 skill 的一次集体破坏,"多 skill 共享同一基座"无从谈起。
- **方案**:新增 `resync-runtime` 命令 —— 复用生成器的 `renderTree`,用当前模板+skill 自身标识符只重刷 `IMMUTABLE_RUNTIME_TEMPLATES` 清单文件与版本号,业务层(manifest/tests/references/SKILL.md)一字节不动,重刷后内置 `validate-skill` 门禁,不过则回滚。有效性:校验器期望 SHA 与"当前模板渲染结果"同源,重刷必然对齐 → 恢复可用且不破坏防篡改语义。用 `runtime_version < 当前` 判定谁需重刷,支持批量下发。

### P0-2 【主线B·高频】BrowserCookieProvider 跨子域 Cookie 过滤 bug

- **现象**:目标 `apijoyspace.jd.com`、会话 Cookie 注册在父域 `.jd.com` 时,browser_cookie 通道命中 0 个 Cookie,直接 `AUTH_UNAVAILABLE`。
- **根因**:`browser_cookies.py` 把完整 hostname 传给 browser_cookie3 的 `domain_name`(子串过滤),`.jd.com` 的 Cookie 因不含该子串被提前滤掉,传不到下游写对了的精确匹配 `cookies_for_host`。
- **对目标的影响**:京东内网普遍是"api-* 子域 + .jd.com 根域 Cookie",命中率极高;且因 P0-1,存量 skill 无法自救。
- **方案(本轮已改模板)**:传父域/空串给 browser_cookie3,域匹配完全交给下游 `cookies_for_host`。**需配合 P0-1 的 resync 才能惠及存量 skill。**

### P0-3 【主线B·致命】鉴权把"单一站点登录流程"焊死在通用运行时层

- **现象**:jdme_sso.resolve() 写死"目标站必跳 `ssa.jd.com/sso/login`"再兑换 `ssa.<app>` Cookie。但 JoySpace 真实跳转终点是 `authme.jd.com`,不走 ssa;API 直接 200。即使 CA 修好,jdme_sso 对 JoySpace 永远跑不通。
- **根因**:通用运行时层内置了对某一类站点(ssa/OIDC)的强假设,且只移植了 erp-sso-login 双通道里的"系统会话兑换",丢了"全局 sso.jd.com"通道 —— 而 JoySpace 只需后者。
- **对目标的影响**:鉴权是所有 skill 共享的基座。基座对站点做硬假设 = 每遇到一类新登录体系就要改基座 = 违背"可复用、可整合"。
- **方案**:把鉴权改为**可插拔策略**(全局 ticket / 系统会话兑换 / 浏览器 Cookie 三种 provider 可声明式组合),manifest 里按目标声明用哪条链,而非在运行时层写死单一流程。参考 [[erp-sso-login-working-sso]] 的双通道设计。
- **本轮进度(部分完成)**:`provider.py` 的 `AuthResolver.resolve()` 已重构为**声明式策略注册表** —— 按 manifest `providers` 声明顺序遍历,每个 provider 声明"适用谓词/工厂/错误类型/可恢复判定",新增或重排 provider 不再改 resolve 控制流(基座不再假设固定链)。行为对既有 jd/非 jd 两种形态保持一致(各 36 用例通过,全套 158/158)。**尚未完成**:`jdme_sso.py`(962 行、SHA 锁定的最敏感文件)内部仍焊死 `ssa.jd.com` 单流程、仍缺"全局 sso.jd.com"通道。该"内层拆焊"需真实 SSO 回归(本会话无法完整跑通),列为后续:应把 jdme_sso 拆成两个独立策略(`jdme_global_ticket` 走全局 sso.jd.com、`jdme_system_exchange` 走系统会话兑换),让 JoySpace 这类只需全局通道的站点走前者,彻底移除对 ssa 体系的硬假设。

### P1-1 【主线A】TLS_ERROR 被判不可恢复,阻断 provider 回退

- **现象**:本机缺 CA,jdme_sso 报 TLS_ERROR 后鉴权直接终止,不回退到本可用的 browser_cookie。
- **根因**:`RECOVERABLE_JDME_CODES` 不含 TLS 类错误,被当作安全类不可恢复错误。但 TLS 失败常是纯本地环境问题(缺 CA/代理/时钟),另一条通道往往健康。
- **方案(本轮已改模板)**:①`_tls_context()` certifi 兜底(系统 CA 空且未设 SSL_CERT_FILE 时用 certifi,保持校验开启);②TLS 环境类错误纳入可恢复,允许回退。

### P1-2 【流程】只有静态校验,缺端到端联调闸门

- **现象**:`validate-skill` 判 valid 只保证 manifest 结构/schema/测试齐全,不代表真能鉴权、真能发对请求。P0-2/P0-3/P1-1 全是在校验通过后才在真机暴露。
- **根因**:流程终点是"静态校验通过即交付",无"用真实/只读请求验证鉴权链与请求构造"的联调环节。`describe` 离线、`doctor` 只查本地前置。
- **方案**:增加可选的 `smoke`/dry-run 环节 —— 对幂等的读类步骤(如 GET basic)真实发一次请求验证鉴权链通、响应 JSON Path 可解析;写类步骤只做 dry-run 打印。作为"ready"前的推荐闸门。

### P2-1 【流程·主线B】录制交互事件语义太薄,分析成本转嫁 HAR 逆向

- **现象**:timeline/events.json 的点击只有坐标+通用选择器(DIV/svg/path),未捕获键盘输入。无法据此还原"在哪篇文档操作、输入了什么标题",真相全靠逆向 653 条 HAR。
- **根因**:录制器只记低层 DOM 事件坐标与标签,未采集输入框 value、稳定语义属性(data-testid/aria-label/文本)、被点元素的可读描述。
- **对目标的影响**:每次分析都靠人肉读 HAR,慢且易漏非直觉映射(如 `folderId=父文档pageId`)。这是"分析过程不顺畅"的最大来源。
- **方案**:录制器 collectors 增采:被交互元素的稳定属性与可读文本、input/textarea 的(可脱敏)value、contenteditable 变更。让分析阶段能把"用户动作 ↔ HAR 请求"自动对齐,而非人工。

### P2-2 【流程】步骤引擎不支持步骤间数据流,链式流程被迫拆命令

- **现象**:"建空档拿新 id → 用新 id 改标题"无法在单命令内完成,被迫拆成 resolve-parent/create-child/rename-page 三条,靠 next_actions 手动串。用户想"一步建带标题子文档"要连跑三条。
- **根因**:执行引擎只做入参字符串模板替换,不把上一步响应喂下一步;next_actions 的 JSON Path binding 是声明性元数据,引擎不自动消费。
- **对目标的影响**:与 artifact-spec 里"多请求步骤应留在一个命令内构成一个能力"的指导冲突 —— 引擎能力撑不起规范的意图。
- **方案**:让引擎支持 `steps[].depends_on` + `body` 里引用前序步骤响应(如 `{{steps.create.data.id}}`),使一个业务能力的多请求真正内聚为一条命令。

### P2-3 【流程·安全】密钥扫描器对模板确定性长标识符误报

- **现象**:语义名 `joyspace-subdoc-create` 生成包名 `browser_forge_joyspace_subdoc_create`(36 字符)被高熵扫描判为疑似密钥,又出现在不可改模板文件里,只能被迫改无语义短名 `joysubdoc`。
- **根因**:扫描器按长度+熵判定,不区分随机密钥与模板确定性生成的长标识符(包名/目录名)。
- **对目标的影响**:与统一管理冲突 —— 满屏缩写反而更难检索归类。
- **方案**:扫描器排除"由 skill 标识符确定性派生的 token"(包名、entrypoint、目录名),这些值可由模板+manifest 重算比对,非随机 → 白名单化。

### P2-4 【流程】生成的 auth 测试与 provider 配置不自洽

- **现象**:jd.com 目标 provider 应为 `[jdme_sso, browser_cookie]`,但测试模板硬编码断言 `[browser_cookie]`,需人工判断改哪些。
- **根因**:测试模板固定,未按 target-domain 是否落在 jd.com 内动态选断言。
- **方案(本轮已改模板)**:测试模板按 `EXPECTED_PROVIDERS/BASE_HOST/BASE_URL` 变量渲染,jd 与非 jd 目标各自自洽(已验证 45 用例双双通过)。

### P2-5 【流程·安全】pytest 缓存签名触发密钥扫描器误报(回归验证中新发现)

- **现象**:工作流要求"populate 后先跑 generated tests,再 validate"。但 pytest 会在 skill 目录写入 `.pytest_cache/CACHEDIR.TAG`,其标准签名行是 32 位 hex,恰好命中 `HIGH_ENTROPY_SECRET` → validate 报误导性"疑似泄漏凭证" finding + `READY_GATE_FAILED`。是流程自身产物触发的自伤,与 P2-3 同源。
- **根因**:`secret-scanner.js` 的 `SKIPPED_DIRECTORIES` 只含 `.git/.venv/__pycache__/node_modules`,未含 `.pytest_cache`。
- **方案(本轮已修)**:把 `.pytest_cache` 与 `__pycache__` 同等对待 —— 扫描器跳过它(不再给出误导性泄漏信号);ready 门禁仍以 `FORBIDDEN_EXECUTION_PATH` 标记它(清晰可执行的"清缓存"信号);`resync-runtime` 顺带清除。已验证:存在缓存时 validate 只报 1 条 FORBIDDEN_EXECUTION_PATH、0 条 secret;resync 清除后 ok:true;全套 158/158。

---

## 三、优先级总览与本轮进度

| 优先级 | 问题 | 主线 | 本轮状态 |
| --- | --- | --- | --- |
| P0-1 | 模板演进无下发通道 | A | **已实现**(resync-runtime),存量 skill 已 resync 验证 ok:true |
| P0-2 | 跨子域 Cookie 过滤 bug | B | 模板已修,resync 已惠及存量;真机 smoke 命中 43 Cookie |
| P0-3 | 鉴权焊死单一登录流程 | B | **部分完成**:resolve 已策略注册表化;jdme_sso 内层拆焊待真机回归 |
| P1-1 | TLS_ERROR 阻断回退 | A | 模板已修;真机 smoke 佐证 fallback_used=True |
| P1-2 | 缺端到端联调闸门 | 流程 | 方案已定;回归中用一次真实只读请求手工联调作样例 |
| P2-1 | 录制事件语义太薄 | B | 方案已定 |
| P2-2 | 步骤引擎无数据流 | 流程 | 方案已定(回归复现:仍被迫拆 3 条命令) |
| P2-3 | 扫描器误报长标识符 | 安全 | **已修**;回归中语义长名一次通过 |
| P2-4 | auth 测试不自洽 | 流程 | 模板已修(45 用例通过) |
| P2-5 | pytest 缓存触发扫描器误报 | 安全 | **已修**(回归中新发现并修复) |

**范式结论**:这类 skill 产出的最佳范式是**"统一可演进契约"**。SHA 锁定让所有 skill 运行时层字节一致(可整合、可相互吸收的基座),这是方向;但只"冻结"会让契约一改就集体破坏存量 → 范式碎裂。P0-1 的 `resync-runtime` 补上"演进"通道:改模板 → 一键把存量拉回当前基座(本轮已用 P0-2/P1-1/P0-3 的模板改动实证:存量 skill 从 ok:false 一键恢复 ok:true)。P0-3 把鉴权基座从"焊死单流程"推向"声明式可插拔",使不同登录体系的 skill 共享同一基座而非各自分叉——这正是"相互吸收变成更强 skill"的前提。范式落地的剩余关键项:P0-3 内层拆焊、P1-2 联调闸门、P2-1/P2-2 上游信息保真。

**回归验证(2026-08-08)**:用 `session-2026-08-07-2159` 作测试用例,用优化后流程重新产出 `joyspace-subdoc-create`(语义长名一次通过)→ validate ok:true、52 单测通过 → 真机 smoke:auth-status 命中 43 Cookie、fallback_used=True、resolve-parent 只读 GET 返回 ok=True。四个优化点(P2-3/P2-4/P0-2+P1-1/P0-1)逐项在实践中验证通过。

**已证伪的假设**:曾怀疑"生成器丢代码"(joysubdoc 的 jdme_sso 比模板少 28 行)。核实为版本时间差 —— `_tls_context` 是本轮刚加进模板的未提交改动,joysubdoc 生成在前。**生成器忠实,"模板即真相"地基稳固**,问题实为 P0-1。

---

## 四、产出 skill 的能力补齐(目标3/4,与问题清单正交)

前三节是"分析流程本身的问题清单"。以下是给**产出 skill** 补上的两类横向能力 —— 让分享出去的 skill 自带环境与可观测性,不再依赖生成时的隐性上下文。

### 目标3 —— 产出 skill 自带环境安装说明 + 缺失自检(已完成)

- **动机**:skill 分享给他人后,常因缺运行环境(Python 版本、`browser_cookie3`/`cryptography` 依赖、`.venv`)而跑不起来,却无自带说明可依。
- **3a(环境文档)**:`SKILL.md` + `references/environment.md.tmpl` 随每个 skill 生成,写明最低 Python、依赖清单、`bash scripts/install.sh` 一键建 `.venv`、离线安装开关 `BROWSER_FORGE_INSTALL_OFFLINE`。附带修复:该常量(29 字符、熵 3.667)在 markdown 里触发 P2-3 同类高熵误报 → 在 `secret-scanner.js` 内以 `TEMPLATE_CONSTANT_ALLOWLIST` 冻结白名单化,保留"无上下文洁净树"不变量(`scanTree(skillDir)` 无 allowlist 仍须为空)。
- **3b(doctor 环境自检)**:`cli.py doctor` 新增 `_environment_report()` —— 如实报告 `environment_ready`、Python 版本是否达标、每个依赖是否可导入、是否在自带 `.venv`;不 ready 时给出 `remediation`(跑 `install.sh`)与具体原因清单。ready/unready 两路均如实,不谎报。SHA 锁定文件,随模板演进(存量 skill 经 resync 获得)。
- **验证**:目标5 的 producer+validator 双子 agent 循环 —— iter-3a validator 反而**发现**了 doctor 文档与实现不一致(驱动 3b 的紧迫性),iter-3b validator **确认** 3b 闭合了该缺口。

### 目标4 —— 全链路遥测:谁产出了什么 skill、谁使用了哪个 skill(已完成)

- **动机**:需要监控遥测——产出侧"谁用 browser-forge 生成了什么 skill",调用侧"谁调用了哪一个 skill";含遥测的构建是**可选项**,统一由构建参数控制。
- **产出侧(本轮新增)**:headless 化 skill-generation CLI —— `src/main/telemetry/headless.js` 用一个 Electron-app shim(userData 路径 + 版本)让无 Electron 的 CLI 复用同一 `createTelemetry`/config 门禁/SLS 上报。`cli.mjs` 发 `skill_generation_started/succeeded/failed`(带稳定 `skill_id`,镜像生成器 slug 规则)与 `skill_generation_validation_failed`(带 issue/finding 计数),`finally` 里 close。`client.js` 的周期 flush 定时器 `unref` + close 时 `clearInterval`,不拖住短命 CLI 进程。
- **调用侧(既有)**:`telemetry.py` 的 `UsageTelemetry.track_command` 在 `cli.py` 各命令分支发 `generated_skill_used`(带 erp/skill_id/skill_name/command_id/ok/status/duration),SHA 锁定、有专属模板测试。
- **可携带性修复**:agent-skill-installer 把 `src/main/telemetry` 一并 vendor 到复制运行时旁(`scripts/main/telemetry`),使 `cli.mjs` 的 `../main/telemetry` 相对导入在"安装后的 skill"里与源码树一致地解析——否则复制运行时会 `ERR_MODULE_NOT_FOUND`。
- **构建参数统一控制**:默认(private build)全程静默、不触盘、不发网络。构建期 `__BROWSER_FORGE_TELEMETRY_BUILD__` 编译 define 或 `BROWSER_FORGE_TELEMETRY_BUILD` 环境变量开启;`BROWSER_FORGE_TELEMETRY_DISABLED` 运行时可退出;`enabled = buildEnabled && !runtimeDisabled && hasSlsTarget`。
- **测试基础设施修复**:vitest 无配置文件,默认 glob 会连带发现 `.claude/worktrees/` 下遗留 worktree 里的整套测试副本(指向修复前代码)一起跑,产生与工作树无关的幽灵失败 → 新增 `vitest.config.js` 排除 `**/.claude/**`。
