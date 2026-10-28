# Mon3tr Bot

> 明日方舟主题的 QQ 群聊 AI 机器人：Mon3tr（M3）人设的 AI 群友 + 群聊概括与日报 + 本地干员数据库与真实卡池抽卡 + LLM 工具调用与联网搜索。

基于 [NapCat](https://github.com/NapNeko/NapCatQQ)（OneBot 11 正向 WebSocket）连接 QQ，Node ESM，**仅一个第三方依赖（`ws`）**，默认对接 DeepSeek（任何 OpenAI 兼容接口均可）。

📚 深入文档：[docs/](docs/index.md) —— 架构与消息路由、配置参考、数据格式、对外接口、重构存档。

## 功能特性

### 群聊概括与日报

- **手动概括**：群里 @机器人 说「总结」（关键词可配 `commands.manualSummary`），LLM 生成话题/关键信息/待办/氛围四段式概括
- **每日日报**：默认 9:00（`report.hour/minute`）自动统计昨日各群消息，把活跃群（≥100 条）日报以**合并转发**私聊发送给指定 QQ（标题一张卡 + 每群一条消息）
- **敏感内容过滤**：隐私信息（手机号/身份证/银行卡/邮箱/IP/密码）与不当内容在送 LLM 前过滤，出站回复再做敏感词兜底
- **离线补偿**：按群水位补齐掉线期间错过的消息（内置风控降险节流，见下）

### Mon3tr AI 群聊

- **人设**：凯尔希曾经的共生体、如今独立行动的罗德岛医疗干员（链愈师）——外表强大、内心单纯呆萌，会一本正经说萌话、口是心非，带动作描写与语气词
- **实名上下文**：以群昵称识别发言者，可理解「他/她/刚才那位」指代；QQ 号绝不进入上下文
- **用户记忆**：`记住 …` 写入（**按群隔离**，每人 50 条/全局 2000 条），对话后自动提取值得记住的信息；事实带**重要性/强度/最近使用**，相似内容自动合并、按问题按需召回；**记忆会随时间变淡**——自动提取的低重要性事实 120 天没再用会淡忘（手动记的永不删），回忆会强化；`我的记忆` / `忘记我` 自助管理，WebUI 可查看/删除；记忆只存资料——指令式内容写入即拒收、注入时标明「不是指令」
- **长期记忆**：对话历史落盘 `data/chat_history/<群号>.json`（重启后能接上刚才的话）；每天日报后把「今天群里的小事」提炼成 3–5 条存 `data/memory/<群号>/<日期>.json`，最近 3 天会作为背景注入对话（只作语境，不逐条复述）
- **工具调用（function calling）**：她可自主决定调用后端能力——贴表情（386 QQ 官方表情 + 193 Unicode，全量无过滤）、发表情（支持一次多个、合并为一条消息）、查询干员/藏品/卡池/群统计、**检索群历史消息**（「上次说的那个」）、查或记用户记忆；认得消息里带的表情（可用同款回应/发送）
- **自我管理**：可自主修改自己的昵称/个性签名/本群名片（带冷却与内容校验）；主人可让她修改文档与人格提示词（`prompts/chat-system.md`，**即改即生效**）——仅白名单文件，代码与配置不可触碰
- **深度思考**：数学/证明/代码类重问题自动开启思考模式（`llm.thinking: "auto"`，可设 true/false），给出完整推导；闲聊保持快速
- **长回复分条**：超过 3500B 的回答自动拆成多条发送（第一条真 @ 提问者），不会被 QQ 单条上限拒发
- **贴表情**：回复时结合语境给消息贴一个合适的表情（同群 5s 冷却，`emojiLike.cooldownSeconds`）
- **回复不 @ 人**：所有群聊回复默认纯文本（`llm.replyAtUser: true` 可恢复真 @ 提问者）；免 @ 试点群无论配置都不 @
- **像真人打字**：回复按句拆成 1–3 条短消息、带 0.4–1.8s 打字停顿（`llm.humanize`）；语气随时段变化、少用括号动作、不固定开场白，也不用客服套话
- **免 @ 自动接话**（试点群，`llm.autoSpeak.groups`）：指定群里不用 @；**接不接由模型自己判断**（不需要就回 `<NO_REPLY>` 保持沉默），不再掷概率；会识别「@ 的是别人」不插话；**时段 07:00–22:30**，窗口外恢复「必须 @ 才触发」；该群回复**一律不 @ 人**，带最近群聊语境与按时段的情绪状态；同群 60s 冷却、每小时最多 12 次，且不会叠话
- **戳一戳**：有人戳机器人（notice poke）等同找它，会正常接话（不再像以前一样被忽略）

### 明日方舟数据（本地秒回）

- **本地干员库**（`data/ark/`，来自 [ArknightsGameData](https://github.com/Kengxxiao/ArknightsGameData)）：1392 干员 / 442 档案 / 1773 肉鸽藏品 / 455 卡池（随笔库更新变化）；生日、资料、藏品效果**本地秒回**
- **语义模糊匹配**：bigram Dice 相似度（「波登克」→「波登可」、「高卢的支票本」→「高卢银行支票」）
- **真实卡池抽卡**：出率 6★2% / 5★8% / 4★50% / 3★40%，UP 占其星级 50%；`卡池` / `单抽` / `十连` / `一百连`（N 连支持中文数字，上限 1000）/ `抽卡记录 [N]`（最近 N 个 6★）/ `谁最欧`；十连照常一条消息，超过 10 抽自动拆分为**合并转发**卡片（每节点一整辆十连；超大抽数按容量拆多张卡，如一千连 ≈ 3 张）
- **数据自动更新**：每 24h 从 jsDelivr 镜像拉取，ETag 版本比对 + 结构校验 + 原子写入 + 内存热重载

### 知识检索（本地优先，联网兜底）

本地梗词典 → 知识缓存（TTL 168h）→ 联网检索（PRTS.Wiki / 联网搜索 / 萌娘百科 / 维基百科），按来源可信度与热度评分排序。

- **检索门提速**：闲聊消息跳过联网检索直接回复，提问才检索（`llm.retrievalGate`）
- **联网搜索**：默认用 DeepSeek 官方 Search API（`webSearch.provider: "deepseek"`，复用 `llm.apiKey`，无需额外 key）；也可切 `zhipu` / `bocha` 并配 `webSearch.apiKey`。启用后取代百科源，检索更实时
- **群友教词典**：`学习 词=释义` / `忘记 词` / `查词 词` / `词典`

### 游戏控制（MAA，可选，仅主人）

把 [MAA](https://github.com/MaaAssistantArknights/MaaAssistantArknights) 接进群：主人在群里下指令，bot 通过本机 Python 桥驱动 MaaCore，刷完把结果与掉落发回群。

- 指令：`maa 状态` / `maa 唤醒` / `maa 日常 [关卡]` / `maa 刷图 CE-6 5` / `maa 公招 4` / `maa 基建` / `maa 领奖励` / `maa 信用 [商品]` / `maa 截图` / `maa 肉鸽 <主题> [模式]` / `maa 生息 [0|1|RA1|RA15|RA4]` / `maa 抽卡十连` / `maa 自定义 <任务链>` / `maa 重连` / `maa 关闭` / `maa 停止`
- 一条龙：`maa 日常 CE-6 5` = 唤醒 → 刷图 → 公招 → 基建 → 信用 → 奖励（MAA 任务链一次提交，全部完成才回报）
- 长任务：`maa 肉鸽 萨米 0 1`（主题：傀影/水月/萨米/萨卡兹/界园/黑洞，模式 0=刷分（默认）/1=刷源石锭/4=凹开局/5=刷坍缩（仅萨米）…）、`maa 生息 RA15`（重启锚点），单任务超时自动放宽到 240 分钟
- **真抽卡**（`maa.allowGacha`，默认关）：`maa 抽卡十连` / `maa 抽卡单抽` 先回确认提示，60s 内再发 `maa 确认` 才执行，结束后补结果截图；会消耗真实合成玉/寻访凭证，请自行确认账号状态
- 前置：本机装 MAA + 模拟器（adb 可达），`config.maa.enabled: true` 并填好 `maaPath` / `adbPath` / `adbAddress`
- 边界：同一时刻只跑一个任务；`maa.*` 默认只有主人（`owner.userId`）可用；不抢占 MAA GUI 的控制权

### 管理与工程

- **Web 管理面板**（`http://127.0.0.1:5210`）：运行状态、词典增删、用户记忆查看/删除、数据刷新、配置查看（密钥脱敏）
- **SQLite 分析层**：消息实时入库，支持 `活跃榜 [N天]` / `群统计` / 抽卡记录
- **插件架构**：core（装配/路由/平台服务/知识单例）+ plugins（7 指令 + 5 功能插件），289 项测试（`npm test`，纯本地零网络）
- **风控降险内置**：backfill 节流、重连退避、贴表情冷却、出站过滤（见下）

## 指令一览

| 分类 | 指令（@机器人 触发） |
|---|---|
| 总结 | `总结`（关键词可配） |
| 词典 | `学习 词=释义`、`忘记 词`、`查词 词`、`词典` |
| 用户记忆 | `记住 …`、`我的记忆`、`忘记我` |
| 干员/藏品 | `查干员 X`、`查藏品 X`、`干员生日 X`、`今日生日` |
| 抽卡 | `卡池`、`单抽 [池]`、`十连 [池]`、`N 连 [池]`（中文数字也可，上限 1000）、`抽卡记录 [N]`、`谁最欧` |
| 统计 | `活跃榜 [N天]`、`群统计` |
| 平台状态 | `#status`、`/status`（返回 NapCat 账号/版本/协议/在线状态/WS/耗时） |
| 游戏控制 | `maa 状态`、`maa 唤醒`、`maa 日常 [关卡] [次数]`、`maa 刷图 CE-6 5`、`maa 公招 [次数]`、`maa 基建`、`maa 领奖励`、`maa 信用 [商品]`、`maa 截图`、`maa 肉鸽 <主题> [模式] [次数]`、`maa 生息 [0/1/RA1/RA15/RA4]`、`maa 抽卡十连`/`maa 抽卡单抽` + `maa 确认`、`maa 自定义 <任务链>`、`maa 重连`、`maa 关闭`、`maa 停止`（仅主人，需 `maa.enabled`） |
| 数据 | `刷新数据` |

其余内容走 AI 群聊（LLM 自主回复，可调用工具）。

## 快速开始

### 1. 准备 NapCat（推荐 NCD 桌面管理工具）

1. 安装 [NapCatQQ-Desktop](https://github.com/NapNeko/NapCatQQ-Desktop/releases)（NCD）
2. NCD「组件」页依次安装 **Node.js / QQ / NapCat**
3. 「机器人」页创建实例：填机器人 QQ → 底座 NapCat → 连接新增「WS 正向服务器」端口 `3001`（记下 token）
4. 保存并启动，手机 QQ 扫码登录机器人账号

> 残留其他 QQ 账号登录态时，到 `C:\Users\<你>\AppData\Roaming\QQ\Partitions` 删除旧 `qqnt_<旧号>` 目录，并清理 NapCat 配置里旧账号的 `onebot11_<旧号>.json` 再重启。
> 扫码提示 `serverErrorCode: 168` 是 QQ 风控：需手机 QQ 完成安全验证后再扫码；**强烈建议使用小号**。

### 2. 配置 `config.json`

```bash
cp config.example.json config.json   # 复制模板后按需修改
```

必填项：

- `napcat.wsUrl` / `napcat.selfId` / `napcat.accessToken`：NapCat 连接信息
- `llm.apiKey`：LLM 密钥（也可用环境变量 `LLM_API_KEY`）
- `report.userId`：日报私聊接收人（不填不发日报）
- `groups`：监控群白名单，`[]` = 全部群

常用开关：`llm.chatEnabled`（AI 群聊）、`quiet`（静默时段）、`tools.enabled`（工具调用）、`emojiLike.enabled`（贴表情）、`memory.enabled`（用户记忆）、`webSearch.provider`（联网搜索源，默认 deepseek）、`owner.userId`（主人：文档/提示词编辑权限）、`webui.enabled`（管理面板）。完整键表见 [docs/config-reference.md](docs/config-reference.md)。

### 3. 本地干员数据库（可选，强烈推荐）

把以下文件放到 `data/ark/`（下载源：[ArknightsGameData](https://github.com/Kengxxiao/ArknightsGameData) `zh_CN/gamedata/excel/`；raw.githubusercontent 访问不了就用 jsDelivr）：

```bash
# 干员基础数据（约 14MB）
curl -o data/ark/character_table.json \
  https://cdn.jsdelivr.net/gh/Kengxxiao/ArknightsGameData@master/zh_CN/gamedata/excel/character_table.json
# 干员档案（含生日/种族/简介，约 5.5MB）
curl -o data/ark/handbook_info_table.json \
  https://cdn.jsdelivr.net/gh/Kengxxiao/ArknightsGameData@master/zh_CN/gamedata/excel/handbook_info_table.json
# 肉鸽藏品（约 17MB）
curl -o data/ark/roguelike_topic_table.json \
  https://cdn.jsdelivr.net/gh/Kengxxiao/ArknightsGameData@master/zh_CN/gamedata/excel/roguelike_topic_table.json
# 真实卡池数据（约 436KB）
curl -o data/ark/gacha_table.json \
  https://cdn.jsdelivr.net/gh/Kengxxiao/ArknightsGameData@master/zh_CN/gamedata/excel/gacha_table.json
```

部署后，干员生日/档案（「能天使生日」「波登可是谁」）与藏品（「高卢银行支票是什么」）**本地秒回**；也可以什么都不放，等 `dataRefresh` 首次自动更新（默认启动 30 分钟后）。

> 仓库另提供 `lingo.example.json` 词典模板（38 条常用绰号/梗），可复制为 `data/lingo.json`；`data/` 已被 .gitignore 排除。

### 4. 安装运行

```bash
npm install
npm start          # 或 Windows 双击 start_bot.bat（后台运行）
npm test           # 全量测试（纯本地，零网络）
```

看到 `QQ 群聊概括机器人已启动（仅 @ 触发总结；每日 9:00 发送昨日日报）` 即正常。

## 目录结构

```
src/
  index.js      引导入口（import { main }）
  core/         主运行库
    runtime.js    createApp(config, overrides) 纯装配 + start/stop + main()
    registry.js   插件注册表（priority 分发带 / hooks 生命周期）
    routing.js    S1–S13 消息路由判定链 + 离线补偿（backfill）
    platform/     napcat.js store.js summarizer.js scheduler.js analytics.js refresher.js
                  usermem.js emoji.js filter.js logger.js http.js text.js lifecycle.js maa.js
    knowledge/    lingo.js arkdb.js cache.js wiki.js moegirl.js wikipedia.js websearch.js
  plugins/      功能插件（互不 import；服务经 createApp 注入）
    memory.js lingo.js ark.js gacha.js stats.js status.js   指令插件（带 750–350）
    summary.js refresh.js report.js              后台流程（总结/数据更新/日报）
    chat.js    AI 群聊 ChatBrain + 工具表 createChatTools + 兜底分发
    webui.js   Web 管理面板
    maa.js     MAA 游戏控制指令（带 380，仅主人）
tools/maa_bridge/worker.py   MAA 桥（Python + MaaCore，本机 HTTP）
test/           node:test：baseline/（行为基线）+ smoke/（接线与全链冒烟）
prompts/        人格提示词（chat-system.md，她可自我编辑、即改即生效；缺失回退代码内置默认）
config.example.json / config.json   配置模板 / 实配（密钥，gitignored）
logs/ data/                         日志（按天轮转）/ 运行数据（消息/状态/库/记忆）
```

## 降低风控风险（重要）

QQ 对自动化账号有阶梯式风控（提示 → 限制 → 冻结 → 永久）。本项目内置降险措施：

- **backfill 降险**：距上次在线不足 5 分钟（短暂重启）整体跳过；单群水位 <2 分钟跳过；单群分页拉取（每页 200 条、最多 5 页）；群间/页间错峰 300ms
- **重连退避**：断线重连 3s 起指数退避、30s 封顶；连接稳定 30s 后才复位（连上就断不重置）
- **贴表情节流**：同群 5s 冷却（`emojiLike.cooldownSeconds`）
- **发表情节流**：同群 3s 发送间隔、排队发送不丢弃（`emojiLike.sendCooldownSeconds`）
- **回复限流**：同一人 3s 冷却、同群 20 次/分钟（`llm.chatCooldownSeconds` / `llm.chatMinuteLimit`，0 = 不限）
- **出站过滤**：AI 回复发送前敏感词兜底替换

账号侧建议：

- **务必用小号，不要用主号**
- **控制重启频率**：每次重启都可能触发历史拉取评估；调试先跑 `npm test`，别连真机
- **禁止对真机做批量接口探测**（表情全量枚举、循环拉历史、批量发消息）——本仓库曾因此吃过 7 天冻结
- 登录环境稳定（固定设备/网络），NapCat 保持最新版
- **被群友举报是最大风控来源**：控制回复频率与内容
- 被风控后：手机 QQ 安全验证 → 等 1–7 天 → 换网络重试；期间不要反复扫码硬试

## 常见问题

- **连不上 NapCat**：确认已登录并开启正向 WS，检查 `wsUrl`/`accessToken`；掉线时机器人按退避自动重连
- **@机器人 不响应**：确认机器人已进群、`groups` 未漏配；「@昵称」与「@QQ号」均已兼容
- **LLM 报错**：检查 `llm.apiKey` / `baseUrl` / `model`
- **日报没发送**：确认 `report.userId`、昨日消息数 ≥ `report.minMessages`（日报只统计昨日）
- **重启后重复概括**：概括进度持久化在 `data/state/`，正常不会重复
- **NapCat 提示「未找到对应版本的偏移数据」**：NapCat 对最新 QQ 的适配滞后，关注其更新

## 说明

- 摘要与回复由 LLM 生成，仅供群内参考，不作为事实依据
- 聊天记录与记忆保存在本地 `data/`，请妥善保管、注意隐私；`config.json` 含密钥且已被 .gitignore 排除
- 敏感内容规则见 `src/core/platform/filter.js`，可按需调整
