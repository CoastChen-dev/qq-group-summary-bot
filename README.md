# Mon3tr Bot

> 明日方舟主题的 QQ 群聊 AI 机器人：Mon3tr（M3）人设的 AI 群友 + 群聊概括与日报 + 本地干员数据库与真实卡池抽卡 + LLM 工具调用与联网搜索。

基于 [NapCat](https://github.com/NapNeko/NapCatQQ)（OneBot 11 正向 WebSocket）连接 QQ，Node ESM，**仅一个第三方依赖（`ws`）**，默认对接 DeepSeek（任何 OpenAI 兼容接口均可）。

📚 深入文档：[docs/](docs/index.md) —— 架构与消息路由、配置参考、数据格式、对外接口、重构存档。

## 功能特性

### 群聊概括与日报

- **手动概括**：群里 @机器人 说「总结」（关键词可配 `commands.manualSummary`），LLM 生成话题/关键信息/待办/氛围四段式概括
- **每日日报**：默认 9:00（`report.hour/minute`）自动统计昨日各群消息，把活跃群（≥100 条）日报私聊发送给指定 QQ
- **敏感内容过滤**：隐私信息（手机号/身份证/银行卡/邮箱/IP/密码）与不当内容在送 LLM 前过滤，出站回复再做敏感词兜底
- **离线补偿**：按群水位补齐掉线期间错过的消息（内置风控降险节流，见下）

### Mon3tr AI 群聊

- **人设**：凯尔希曾经的共生体、如今独立行动的罗德岛医疗干员（链愈师）——外表强大、内心单纯呆萌，会一本正经说萌话、口是心非，带动作描写与语气词
- **实名上下文**：以群昵称识别发言者，可理解「他/她/刚才那位」指代；QQ 号绝不进入上下文
- **用户记忆**：`记住 …` 写入（**按群隔离**，每人 20 条/全局 2000 条），对话后自动提取值得记住的信息；`我的记忆` / `忘记我` 自助管理，WebUI 可查看/删除
- **工具调用（function calling）**：她可自主决定调用后端能力——贴表情（300+ QQ 官方表情）、查询干员/藏品/卡池/群统计、查或记用户记忆
- **贴表情**：回复时结合语境给消息贴一个合适的表情（同群 60s 冷却）
- **真 @ 回复**：回答（AI 群聊、指令、刷新回执）会真 @ 提问者；总结与播报为群广播不 @

### 明日方舟数据（本地秒回）

- **本地干员库**（`data/ark/`，来自 [ArknightsGameData](https://github.com/Kengxxiao/ArknightsGameData)）：1373 干员 / 439 档案 / 807 肉鸽藏品 / 447 卡池；生日、资料、藏品效果**本地秒回**
- **语义模糊匹配**：bigram Dice 相似度（「波登克」→「波登可」、「高卢的支票本」→「高卢银行支票」）
- **真实卡池抽卡**：出率 6★2% / 5★8% / 4★50% / 3★40%，UP 占其星级 50%；`卡池` / `单抽` / `十连` / `抽卡记录 [N]`（最近 N 个 6★）/ `谁最欧`
- **数据自动更新**：每 24h 从 jsDelivr 镜像拉取，ETag 版本比对 + 结构校验 + `.bak` 备份 + 原子写入 + 内存热重载

### 知识检索（本地优先，联网兜底）

本地梗词典 → 知识缓存（TTL 168h）→ 联网检索（PRTS.Wiki / 联网搜索 / 萌娘百科 / 维基百科），按来源可信度与热度评分排序。

- **检索门提速**：闲聊消息跳过联网检索直接回复，提问才检索（`llm.retrievalGate`）
- **联网搜索**：配置 `webSearch.apiKey`（智谱/博查）后取代百科源，检索更实时、少依赖萌娘/维基
- **群友教词典**：`学习 词=释义` / `忘记 词` / `查词 词` / `词典`

### 管理与工程

- **Web 管理面板**（`http://127.0.0.1:5210`）：运行状态、词典增删、用户记忆查看/删除、数据刷新、配置查看（密钥脱敏）
- **SQLite 分析层**：消息实时入库，支持 `活跃榜 [N天]` / `群统计` / 抽卡记录
- **插件架构**：core（装配/路由/平台服务/知识单例）+ plugins（5 指令 + 5 功能插件），208 项测试（`npm test`，纯本地零网络）
- **风控降险内置**：backfill 节流、重连退避、贴表情冷却、出站过滤（见下）

## 指令一览

| 分类 | 指令（@机器人 触发） |
|---|---|
| 总结 | `总结`（关键词可配） |
| 词典 | `学习 词=释义`、`忘记 词`、`查词 词`、`词典` |
| 用户记忆 | `记住 …`、`我的记忆`、`忘记我` |
| 干员/藏品 | `查干员 X`、`查藏品 X`、`干员生日 X`、`今日生日` |
| 抽卡 | `卡池`、`单抽 [池]`、`十连 [池]`、`抽卡记录 [N]`、`谁最欧` |
| 统计 | `活跃榜 [N天]`、`群统计` |
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

常用开关：`llm.chatEnabled`（AI 群聊）、`quiet`（静默时段）、`tools.enabled`（工具调用）、`emojiLike.enabled`（贴表情）、`memory.enabled`（用户记忆）、`webSearch.apiKey`（联网搜索）、`webui.enabled`（管理面板）。完整键表见 [docs/config-reference.md](docs/config-reference.md)。

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
                  usermem.js emoji.js filter.js logger.js http.js
    knowledge/    lingo.js arkdb.js cache.js wiki.js moegirl.js wikipedia.js websearch.js
  plugins/      功能插件（互不 import；服务经 createApp 注入）
    memory.js lingo.js ark.js gacha.js stats.js   指令插件（带 750–400）
    summary.js refresh.js report.js              后台流程（总结/数据更新/日报）
    chat.js    AI 群聊 ChatBrain + 工具表 createChatTools + 兜底分发
    webui.js   Web 管理面板
test/           node:test：baseline/（行为基线）+ smoke/（接线与全链冒烟）
config.example.json / config.json   配置模板 / 实配（密钥，gitignored）
logs/ data/                         日志（按天轮转）/ 运行数据（消息/状态/库/记忆）
```

## 降低风控风险（重要）

QQ 对自动化账号有阶梯式风控（提示 → 限制 → 冻结 → 永久）。本项目内置降险措施：

- **backfill 降险**：距上次在线不足 10 分钟（短暂重启）整体跳过；单群水位 <5 分钟跳过；单次拉取 100 条；群间错峰 800ms
- **重连退避**：断线重连 3s 起指数退避、60s 封顶
- **贴表情节流**：同群 60s 冷却（`emojiLike.cooldownSeconds`）
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
