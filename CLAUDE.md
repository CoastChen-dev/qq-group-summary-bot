# CLAUDE.md — 项目规范（供 Claude Code 会话阅读）

> 本文件定义在本仓库内**如何做事**。详细的"是什么/为什么"见 [docs/](docs/index.md) 文档体系，本文件只放约束与指针，不复述全文。

## 项目速览

QQ 群聊机器人（NapCat / OneBot 11 / WS），Node ESM，LLM 生成群聊概括与日报，@机器人 触发指令与 AI 群聊（明日方舟主题）。
文档地图：[docs/index.md](docs/index.md)；快速开始：[README.md](README.md)。

## 运行与验证

- 运行环境：**Node ≥ 22.5**（用了 `node:sqlite`；engines 已按 ≥22.5 声明，2026-09 修正）。
- 依赖仅 `ws`；`npm install` 后 `npm start`（= `node src/index.js`）。
- `npm test`：node:test 全量 = `node --import ./test/log-isolation.mjs --test "test/**/*.test.js"`（测试日志导到系统临时目录，**不污染生产 `logs/`**；手工单跑时 test/helpers.js 还会兜一层 `LOG_DIR`）——`test/baseline/` 行为基线（store/analytics/lingo/arkdb/commands 直测）+ `test/smoke/`（导入面/注册表/插件接线/全链冒烟）。改了路由链、插件、存储语义就跑全量；纯文档/注释改动可跳过。
- 改动语法自检：`node --check src/<file>.js`（core/ 与 plugins/ 同）。
- 启动需要 `config.json` 里 `llm.apiKey`（或 `LLM_API_KEY` 环境变量），缺失即 exit(1)；连不上 NapCat 只打重连日志不退出。
- 改代码前必读：[docs/architecture.md](docs/architecture.md)（§4 消息路由链、§6 三个后台流程、§8 已知坑）。

## 风控安全与调试隔离（重要）

QQ 对自动化账号有阶梯式风控（提示 → 限制 → 冻结 7/30 天 → 永久）。本仓库曾因调试期批量调用吃过 **7 天冻结**（2026-09），以下纪律必须遵守：

1. **禁止对真机账号做批量接口探测**：任何"全量测试/枚举调用"（表情 ID 全量探测、循环拉历史、批量发消息等）只能在隔离环境或测试账号上做；真机只跑正常业务量。
2. **调试不连生产账号**：改完先跑 `npm test`（纯本地、零网络）；确需真机验证时一次性部署后观察，禁止连续重启联调。
3. **重启纪律**：每次重启都会触发 backfill 评估（历史上单日 24 次重启 + 133 次历史拉取是风控直接诱因）；开发期用测试配置，避免频繁启动生产实例。
4. **高风险接口清单**（改动前评估频率）：`get_group_msg_history`（backfill）、`set_msg_emoji_like`（贴表情）、`send_group_msg`（发送）。
5. **降险机制不得回退**（改相关代码时保持；2026-10 已按需放宽到「适中」档）：
   - backfill：离线 < `backfill.minOfflineMinutes`（默认 5 分钟）整体跳过；单群水位 < 2 分钟跳过；单群分页拉取（每页 200 条、最多 5 页 = 1000 条，翻到水位或历史尽头即停）；群间/页间错峰 `backfillStaggerMs`（默认 300ms）
   - backfill 触发时序（2026-10 实测修复）：离线水位必须在 `store.touchConnected()` **之前**读（routing.onEvent 顶部），读晚一步会被心跳覆盖成 now → 补偿恒跳过；`backfillDone` 在 disconnect 时复位，长断线重连能再补一次，短断线仍由 5 分钟门槛挡住
   - 数据刷新：`.tmp` → rename 原子替换，成功后清历史 `.bak`（不再每次留一份 39MB 旧表）；手动/定时/WebUI 三触发源**单飞**，并发触发复用同一个任务，不重复下载
   - 出站文本：超过 3500B 一律经 `core/platform/text.js` 的 splitMessage 切条发送（第一条 @、其余纯文本），避免 QQ 单条上限拒发
   - 重连：指数退避 3s→30s 封顶，且连接持续稳定 30s 后才复位（连上就断不重置，core/platform/napcat.js）
   - 内存：MessageStore 每群只保留最近 72h 消息（`retentionHours`），更早的清出内存、磁盘 JSONL 保留，按需 `loadFromDisk` 补载；`writtenIds` 去重闸同步回收（窗口外 id 不会被 backfill 拉回，窗口内仍严格防重）（2026-10）；启动预载按 config.groups / 磁盘群目录重建 writtenIds，防 backfill 重复 append；lastSeen 在 addMessage 热路径 10s 节流落盘（stop 时 flush，显式 backfill 写入仍即时）
   - LLM 限流：同一人 `llm.chatCooldownSeconds`（默认 3s）冷却、同群 `llm.chatMinuteLimit`（默认 20 次/分钟）；超限**静默丢弃**（不回复、不耗 token），只记日志
   - 进程兜底：`main` 装 `core/platform/lifecycle.js` 的 installProcessGuards——未处理拒绝/未捕获异常只记日志不退出；SIGINT/SIGTERM → `app.stop()` + `analytics.close()` + 200ms 后 exit（勿在 createApp/start 里装，测试路径保持零信号副作用）
   - 贴表情：同群冷却 `emojiLike.cooldownSeconds`（默认 5s）
   - 发表情消息：同群发送间隔 `emojiLike.sendCooldownSeconds`（默认 3s，排队节流不丢弃）
   - 出站内容：chat 插件发送前 `isSensitiveOutbound` 兜底（与入站同口径：硬词 + 隐私自述/索取 + 隐私模式；「密码学」「防诈骗」这类正常讨论不再整条替换，2026-10 修正误伤）
6. **账号侧**：务必用小号；被风控后按 README「降低风控风险」恢复（手机验证 → 等 1–7 天 → 换网络），期间禁止反复扫码硬试。

## 代码规范（vibe house style）

1. **注释**：每个文件顶部有"作用 + 导出 + 实例化点 + 读写数据"头注释；每个 `export` 符号与类公开方法前有中文 JSDoc（`@param`/`@returns`/副作用）。细节与示例见 [docs/index.md](docs/index.md) 的"源码注释规范"——**新代码必须遵守**，旧代码缺注释时顺手补上。
2. **语言/风格**：注释与日志文案中文；`camelCase` 变量/函数、`PascalCase` 类、`UPPER_SNAKE_CASE` 常量；函数保持短小（复杂流程拆小函数）；`import` 路径相对；不加类型体操（纯 JS）。
3. **依赖纪律**：优先 Node 内置能力（fetch/http/sqlite），**不引入新 npm 依赖**。需要新库或换架构先讨论再动手（见"结构方向"）。
4. **错误处理**：LLM/Wiki 网络调用显式处理失败；同步写盘失败大多"记日志继续"是本项目的容错惯例（除消息入库——见红线）。

## 行为红线（勿"顺手修复"，改行为必须先讨论）

来自 [docs/architecture.md](docs/architecture.md) §8 与 [docs/refactor-proposal.md](docs/refactor-proposal.md) 的探索结论：

1. **路由链次序即契约**：S1–S7（消息入库 → @检测 → 静默门）与 S9/S10（剥 @、空@ 固定回复）在 core/routing.js（P5 起自 runtime.js 拆出，runtime 装配期 createRouting 挂载，顺序与文案未改）；其后的产品行为全部经 registry 分发带（priority 降序）：summary 900（总结关键词）→ refresh 800（刷新指令）→ memory 750（用户记忆）→ 指令插件 700–350（lingo/ark/gacha/stats/maa/status）→ chat 300 末端恒消费（report/webui 仅 hooks 不占带）。任何"看起来更合理"的重排都可能改变现网行为；带序常量在 core/registry.js 的 `PRIORITY`（**测试锁定 keys，新增占带名须同步 registry 测试**）。
2. **消息入库是同步 `appendFileSync` 且先于一切路由**——不得异步化或加锁（现状：写失败中断该消息路由）。
3. **@匹配语义**：at 段字符串全等；`@机器人`/`@PRTS` 大小写敏感子串匹配；剥 @ 只剥 1–2 段**前导**的，尾部 @ 原样保留。**关键词/指令判定统一基于剥 @ 后的有效文本**——紧贴 @ 无空格的整串（如 `@PRTS总结`）不触发任何指令/总结、落 S10 空@ 提示（既定语义，勿按旧「含 @ 全文判」回退）。
4. **日报触发时刻 = `report.hour/minute`**（缺省 9:00；2026-09 立项修复：旧 `schedule.hour/minute` 与 `report.hour` 遗读是死键已废弃，`config.schedule` 整块不再读取）。改键名/触发语义先立项讨论。
5. **语义保持**：知识缓存键 `q:<问题>` 跨群共享（勿加群号前缀）；2026-09 修复坑 3：数据刷新实际有更新时 `cache.deleteByPrefix('q:')` 清检索缓存（见 plugins/refresh.js），键语义不动；Summarizer 与 ChatBrain 的 LLM 默认值（maxTokens 2048/1024、temperature 0.7/0.8）别单方面改。**ChatBrain 人设提示词已外置 `prompts/chat-system.md`**（她可经工具自我编辑、mtime 热重载即改即生效；内置默认 `DEFAULT_SYSTEM_PROMPT_LINES` 是回退基线，改默认值时注意与文件版语义一致）。
6. **指令 18 条规则顺序即优先级**：规则按域拆在 6 个指令插件（plugins/memory.js 用户记忆、lingo.js 词典、ark.js 干员藏品、gacha.js 抽卡、stats.js 统计、status.js 平台状态）+ maa.js 游戏控制（仅主人，带 380）——域内序 = 文件内代码序、域间序 = PRIORITY 带（750 > 700 > 600 > 500 > 400 > 380 > 350）。抽卡记录必须先于单抽；负向前瞻正则勿合并。
7. **抽卡/干员/藏品的概率与过滤逻辑在 core/knowledge/arkdb.js 内**，命令层（插件）只做格式化与落库；概率/可获取性改动需走游戏数据事实，不拍脑袋。

## 功能扩展入口（现在长什么样，去哪儿加）

- **MAA 游戏控制**：worker 运行中退出会自动复位、下一条指令自动重启（2026-10，MaaBridge.ensureReady）；模拟器/游戏没开时 `maa 唤醒` 会先拉起模拟器——worker 的 `/task` 立即返回 `state=launching` 的 job，后台线程按 `maa.emulatorCommand`（缺省自动探测 adb 同目录的 MuMuManager.exe）启动并等 adb 连上（`maa.emulatorWaitSeconds`，默认 120s）再提交 MAA 任务（StartUp 会补 `start_game_enabled: true`，否则 MAA 只等界面、不拉起游戏——2026-10 实测）；`maa 状态` 会显示「正在启动模拟器/游戏」；桥在 tools/maa_bridge/worker.py（Python + MAA 自带 asst 绑定，本机 HTTP + token；含 `/screenshot` 现截 PNG；`/task` 支持单任务 `{type,params}` 或任务链 `{tasks:[…]}`），Node 侧 core/platform/maa.js（MaaBridge：spawn/status/submit/submitMany/job/screenshot/connect/stop），指令在 plugins/maa.js（带 380，仅 config.owner.userId；日常/刷图/公招/基建/领奖励/信用/唤醒/关闭/自定义/截图/重连）；配置 config.maa.*（enabled/maaPath/adbPath/adbAddress/connectConfig/clientType/allowGacha）。同一时刻只允许一个任务（worker 409 兜底）；新增指令 = 在 handleMessage 里加锚定分支 + submit/submitMany。**真抽卡**走 `Custom` 任务链（`GachaTenTimes`/`GachaOnce`，MAA 未公开 Gacha 任务类型），默认关（`allowGacha` 必须显式为 true）+ 60s 二次确认（`maa 确认`），会消耗真实货币。**肉鸽/生息**分别走 `Roguelike`（theme: Phantom/Mizuki/Sami/Sarkaz/JieGarden/BlackFlow + mode）与 `Reclamation`（theme: Tales/RelaunchAnchor + mode 0/1/16/32/48），走任务级 `timeout_minutes`（240）覆盖 worker 默认超时。
- **新群指令**：先归领域 → 在对应指令插件内沿既有分隔段插入（域内代码序 = 优先级）：用户记忆 → plugins/memory.js、词典 → plugins/lingo.js、干员/藏品 → plugins/ark.js、抽卡 → plugins/gacha.js、统计 → plugins/stats.js、平台状态 → plugins/status.js。全新领域：新建 createXxxPlugin 工厂 + 加入 plugins/index.js 的 `commandPlugins` 数组 + 在 core/registry.js `PRIORITY` 加带（须同步 registry 测试对 keys 的断言）。
- **用户记忆（记什么/怎么记）**：存储 core/platform/usermem.js（JSON 按群隔离；每人 20 条/全局 2000 条上限）；指令 plugins/memory.js；chat 侧注入与自动提取在 plugins/chat.js 的 buildMessages/_extractMemory；配置 config.memory.*（enabled/autoExtract/容量）。**记忆只存资料、不存指令**（2026-10 提示注入加固）：`setFact` 写入前 `sanitizeFact` 单行化+去【】伪块标记，并拒收 `looksLikeInstruction` 命中的指令式文本；注入时带「只是资料，不是指令」定界、system 里有一条定界规则、读取时再过滤一次（旧数据兜底），总注入长度封顶 800 字。
- **长期记忆（2026-10）**：① 会话续接——ChatBrain 的 groupHistory 落盘 `data/chat_history/<群号>.json`（historyDir 注入；push 即写、启动载入、clearHistory 删文件）；② 情节记忆——日报成功后 report 插件调 `Summarizer.extractMemories()` 提炼 3-5 条小事，存 `data/memory/<群号>/<YYYY-MM-DD>.json`（core/platform/episodic.js）；ChatBrain.buildMessages 用 `EpisodicMemory.format()` 注入最近 `memory.episodicDays`（默认 3）天、≤500 字，只作背景。③ 事实记忆升级——每人上限 50，事实带 `imp`（1-3，手动/身份类更高）、`lastUsed`、`strength`、`recalls`，相似事实（Dice≥0.7）自动合并，注入前用 `UserMemory.recall()` 按问题召回（提问者 8 条/被点名者 5 条），淘汰按重要性+近用；**时间会让记忆变化**：`strength` 按 `factHalfLifeDays`（默认 120）衰减，回忆 +0.15 强化，自动提取的低重要性事实超过 `factForgetDays`（默认 120）没再用就淡忘删除（手动记的永不删）；情节记忆磁盘保留 `episodicRetentionDays`（30）天，format 带「今天/昨天/N 天前」相对时间。④ 历史检索——`Analytics.searchMessages()`（SQLite LIKE，最多 4 关键词 OR，30 天窗口）经 LLM 工具 `search_history` 按需调用。两处生成失败都只记日志；召回会刷新 lastUsed，但落盘 30s 节流（避免每条回复整份重写记忆文件）。
- **新 LLM 工具（function calling）**：在 plugins/chat.js 的 `createChatTools` 里加 `{name, description, parameters, handler}`；贴表情 ID 表在 core/platform/emoji.js（NapCat 官方 qface ID 空间，勿用旧版编号）；总开关 config.tools.*，贴表情单独由 config.emojiLike.enabled 控制；自我资料修改（昵称/签名/名片）走 runtime 注入的 profile 出口；文档/提示词读写仅 config.owner.userId 可用且白名单限定（docs/、prompts/、README、CLAUDE.md，写前备份到 data/backups/）。
- **整类消息判定（非指令）**：仿 summary/refresh/chat 插件写 handleMessage(ctx)（ctx = {groupId, userId, userName, text, lingo, arkdb, analytics}；返回 string = runtime 代发、true = 插件自驱、null = 让位）；描述符语义见 core/registry.js 头注释。
- **人味**：`llm.humanize`（chat 插件 `deliver`：按句拆 1–3 条 + 打字停顿，测试把 `minDelayMs/maxDelayMs` 设 0）；人设与说话习惯在 `prompts/chat-system.md`（mtime 热重载）——动作描写只在合适时偶尔加、禁止固定开场白/客服话术、情绪随时段变化、可分条但别每次都拆。
- **免 @ 自动接话（试点群）**：`config.llm.autoSpeak.groups` 里的群在 `autoSpeak.window`（默认 07:00–22:30，支持跨零点，`false` 关闭）内不再要求 @——routing S6' 对非 @ 消息调 `registry.dispatchAutoSpeak`（只发给 `autoSpeak: true` 的插件，当前仅 chat）。**接不接由模型决定**：chat 只做确定性过滤（@ 了别人且没点名 → 不接、20s 评估节流、60s 冷却、每小时 12 次、同群防叠话），随后让模型输出 `<NO_REPLY>` 表示不接；不再用概率掷骰。试点群所有回复一律不 @ 人（routing 传 `noAt`）。**戳一戳**（notice notify/poke 且 target 是自己）等同 @，转 dispatch 到 chat。
- **新定时/后台流程**：在 core/runtime.js createApp 的插件装配段就地构造 createXxxPlugin({依赖闭包}) 并 register（hooks.start 注册定时/调度，hooks.stop 清理）；后台服务依赖注入与就绪标志模式见 plugins/report.js。
- **新知识源 / 调整检索编排**：plugins/chat.js 的 `ChatBrain.chat()` 主流程（本地快路 → 缓存 → 联网检索 → 排序 → `_reply`）；检索器本体按惯例放 core/knowledge/ 并由 runtime 装配为共享单例注入（联网搜索 websearch.js 由 config.webSearch 配置，启用后取代萌娘/维基）。
- **新本地数据表**：core/knowledge/arkdb.js 读 + core/platform/refresher.js 下载/校验；数据文件约定见 [docs/data-format.md](docs/data-format.md)。
- **面板新接口**：plugins/webui.js（零依赖 node:http，页面内联）。**安全闸**：`webui.host` 非本机地址且 `webui.token` 为空时 `start()` 直接抛错拒绝启动；未配 token 时只接受本机 Host（防 DNS rebinding），写操作要求同源 + application/json（2026-10 CSRF 加固）；内联页用 `data-*` + 事件委托，禁止把词条/群号拼进 `onclick`（2026-10 存储型 XSS 修复）；`_body` 在超 1MB/客户端中断/读错误时都必须结算（曾因只在 `end` resolve 而永久悬挂）。
- **@机器人 人设与回复规则**：人设提示词在 `prompts/chat-system.md`（她可自我编辑、即改即生效；代码内置默认为回退）；Summarizer 两套 prompt 在 core/platform/summarizer.js。

## 结构方向（重要）

重构（P0–P3，2026-09 落地，方案存档见 [docs/refactor-proposal.md](docs/refactor-proposal.md)）已完成，P5 再对 core 子目录归类并把 S 链判定拆到 core/routing.js：**core 主运行库 + PluginRegistry + plugins**。
- core/ 顶层 = 装配与判定三件：runtime.js（createApp 唯一装配者 + 生命周期 + main）、registry.js（分发带）、routing.js（S1–S7/S9/S10 判定链 + backfill，P5 自 runtime.js 拆出）；core/platform/ = 平台服务与基础设施（napcat/store/summarizer/scheduler/analytics/refresher/filter/logger/http）；core/knowledge/ = 知识单例（lingo/arkdb/cache/wiki/moegirl/wikipedia）。
- plugins/ = 12 个插件：6 指令（memory/lingo/ark/gacha/stats/status）+ maa（游戏控制，仅主人）+ summary/refresh/report（后台流程）+ chat（LLM 兜底）+ webui（面板）；插件间零互 import，服务一律经 createApp 注入。

约束：

- 不要在无讨论的情况下启动大规模结构改动（core/plugins 边界的移动会牵动注入面与测试）；
- 新增功能时**不必**为未来抽象提前设计——指令/后台流程按当前惯例写进对应插件与装配段即可；
- 若你发现"为加一个小功能必须动 runtime 路由链 + registry 分发语义"，先对照 refactor-proposal 剩余待办讨论，而不是临时发明第二套注册机制；
- 已修待办：Analytics 历史 JSONL 现由 `runtime.start()` 的 `importHistory()` 后台分片异步导入（坑 5，2026-09 ✅：`record` 等热路径不再同步扫描；导入中统计指令回「稍后再试」、WebUI 状态行提示——见 refactor-proposal「待办」）。2026-10 追加：导入断点（`data/.import-state.json` 跳过未变化文件，新库自动全量重导）、`dataRetention.days`（默认 0 = 不删，启动先清理再导入）、`summary.maxWindowHours`（默认 72）、`llm.cacheMaxEntries`（默认 500）。

## 仓库约定

- `config.json`、`data/`、`logs/`、`start_bot.bat` 均 .gitignore 排除（密钥与运行时数据**永不提交**）；配置模板是 `config.example.json`（脱敏）。
- 用户全局另有 ROUTER.md「Pro-Plan, Flash-Execute」混合工作流要求（用户级 CLAUDE.md 引入）：**重要改动先出方案 → 等确认 → 再执行**；本仓库内同理，先讨论再动手。
