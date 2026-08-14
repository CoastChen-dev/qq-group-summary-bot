# QQ 群聊每小时概括机器人 (NapCat)

基于 [NapCat](https://github.com/NapNeko/NapCatQQ) 的 OneBot 11 协议，通过正向 WebSocket 连接，
实时接收群消息、本地持久化，并**每隔一小时**抓取时段内聊天记录，调用 LLM API 生成概括后发回群里。

## 功能

- 实时接收群消息并持久化到 `data/messages/<群号>/<日期>.jsonl`
- 群里发「@机器人 总结 / /总结 / #总结」可手动触发概括（**必须 @ 机器人**，防止误触发）
- **每日 9:00** 自动统计昨日各群消息，将「昨日活跃群（≥100 条）日报」**私聊发送**给指定 QQ
- **静默时段**（默认 0:00-8:00）：不响应任何总结请求
- **离线补偿**：每次启动时自动从**上次下线时刻**（持久化的最后在线时间）拉取错过的历史消息，重启/掉线也能补齐
- **敏感内容过滤**：隐私信息（手机号/身份证/银行卡/邮箱/地址/IP/密码）和色情/暴力/违法等不当内容在送 LLM 前自动过滤，概括中不会出现
- 消息量少于阈值（`minMessages`）时手动总结自动跳过，避免打扰
- 断线自动重连；概括进度写入 `data/state/`，重启不重复
- 已端到端验证：收消息 → 存记录 → 调 DeepSeek → 概括发送，全程正常

## 目录结构

```
src/
  index.js      主入口（事件分发 + 定时任务编排）
  napcat.js     OneBot 11 正向 WebSocket 客户端
  store.js      消息存储 / 持久化 / 时段提取
  summarizer.js LLM（OpenAI 兼容接口）概括器
  scheduler.js  定时调度器
  logger.js     日志
config.json     配置文件
start_bot.bat   Windows 快捷启动脚本
bot.log         stdout 日志
data/           运行数据（消息记录 + 概括进度）
```

## 快速开始

### 1. 准备 NapCat（推荐用 NCD 桌面管理工具）

1. 安装 [NapCatQQ-Desktop](https://github.com/NapNeko/NapCatQQ-Desktop/releases)（NCD）。
2. NCD 里「组件」页依次安装 **Node.js / QQ / NapCat**。
3. 「机器人」页点「创建第一个实例」，填写：
   - **QQ 账号**：机器人 QQ 号
   - **底座类型**：NapCat（不带 QQ GUI）
   - **连接**：新增「WS 正向服务器」，端口 `3001`（记下 token）
4. 保存并「启动」，手机 QQ 扫码登录机器人账号。

> 提示：若电脑上残留过其他 QQ 账号的登录态，NapCat 可能错误复用旧账号导致连接配置不生效。
> 到 `C:\Users\<你>\AppData\Roaming\QQ\Partitions` 删除旧账号的 `qqnt_<旧号>` 目录，
> 并清理 NapCat 配置目录里旧账号的 `onebot11_<旧号>.json`，再重启机器人账号。

### 2. 修改配置 `config.json`

- `napcat.wsUrl`：NapCat 正向 WebSocket 地址（默认 `ws://127.0.0.1:3001`）
- `napcat.selfId`：机器人 QQ 号
- `napcat.accessToken`：NCD 里 WS 服务器生成的 token（连 WS 需携带）
- `groups`：要监控的群号列表，例如 `[123456, 789012]`；留空 `[]` 表示监控所有群
- `llm.baseUrl` / `llm.model`：OpenAI 兼容接口（默认 DeepSeek，可换 OpenAI / 通义 / 其他）
- `llm.apiKey`：**必填**，也可用环境变量 `LLM_API_KEY` 设置（优先级更高）
- `llm.baseUrl` / `llm.model`：OpenAI 兼容接口（默认 DeepSeek，可换 OpenAI / 通义 / 其他）
- `schedule`：日报任务时间（`hour`/`minute`，默认 9:00）
- `minMessages`：手动总结低于该消息条数时跳过
- `report`：日报配置
  - `userId`：日报私聊接收人 QQ 号（**必填**）
  - `minMessages`：昨日消息数达到该值的群才生成日报（默认 100）
  - `hour`：日报发送时间（默认 9 点）
- `quiet`：静默时段（默认 `enabled: true, start: 0, end: 8`，即 0:00-8:00 不响应总结；设 `enabled: false` 可关闭）
- `backfill`：离线补偿（`maxHours` 默认 72，为 lastSeen 的兜底上限；实际从上次下线的 lastSeen 时刻开始补偿）
- `filter`：敏感内容过滤（`enabled: true` 默认开启）
- `commands.manualSummary`：手动触发概括的关键词（需 @机器人 且消息包含其中任一关键词）

### 3. 安装依赖并运行

```bash
npm install
# 复制配置模板并填写真实值
cp config.example.json config.json
# 编辑 config.json：填 llm.apiKey / napcat.accessToken / report.userId 等
npm start
```

Windows 下也可直接双击 `start_bot.bat`（后台运行，日志写 `bot.log`）。

> `config.json` 含敏感信息（API Key、token），已被 `.gitignore` 排除，不会提交到仓库；
> 仓库中提供脱敏模板 `config.example.json`。

看到 `QQ 群聊概括机器人已启动（仅 @ 触发总结；每日 9:00 发送昨日日报）` 即正常运行。

## 使用方式

- **手动总结**：在群里发「@机器人 总结」（静默时段 0:00-8:00 内不响应）
- **每日日报**：每天 9:00 自动把昨日活跃群（≥100 条消息）的概括私聊发给 `report.userId`

## 发送效果示例

手动总结（发到群里）：

```
【群聊概括】
从 2026-08-13 22:00 到 2026-08-13 23:00｜共 86 条消息

1. 主要话题
   - 后端接口联调问题，讨论了超时与重试策略
   - 下午茶团购，准备预定奶茶
2. 关键信息
   - 明早 10 点开会，会议号 123-456-789
3. 待办或提醒
   - 张三需要在下班前提交 PR
4. 活跃概况
   - 整体活跃，技术讨论为主，间杂闲聊
```

每日日报（私聊发送给配置的 QQ）：

```
【昨日群聊日报 2026-08-12】
共 2 个活跃群

【技术交流群】123 条消息
1. 主要话题
   - 新框架选型讨论...
...

---
【摸鱼群】150 条消息
1. 主要话题
   - 今天吃什么...
...
```

## 日常管理

- 停止机器人：`taskkill /f /pid <node 的 PID>`（在任务管理器或 `Get-Process node` 里查）
- 重启：双击 `start_bot.bat`
- 查看日志：`bot.log`（程序自身写入，不依赖重定向）
- NapCat 与 QQ 登录：用 NCD 管理，别直接用本机器人脚本去动 NapCat 配置

## 常见问题

- **连不上 NapCat**：确认 NapCat 已登录并开启正向 WebSocket 服务，检查 `wsUrl` 端口与 `accessToken`。
- **机器人收不到群消息**：确认机器人已加入对应群；检查 `groups` 是否留空（空=全部）或包含目标群。
- **LLM 调用报错**：确认 `apiKey` 与 `baseUrl` 正确、模型名有效。
- **重启后重复概括**：`lastSummaryAt` 已持久化到 `data/state/`，正常不会重复；若手动删除了 state 文件，会从当前时段重新概括。
- **日报没发送**：确认 `report.userId` 已配置、昨日消息数达到 `report.minMessages`（默认 100）。数据按日期存于 `data/messages/<群号>/<日期>.jsonl`，机器人会自动从磁盘读取昨日数据。
- **NapCat 提示 `未找到对应版本的偏移数据`**：NapCat 对最新版 QQ 的适配可能滞后（本机为 QQ 9.9.33 时 NapCat 4.18.18 提示过）。消息收发已验证正常，个别高级 API 可能受限；可关注 NapCat 更新。

## 说明

- 摘要内容由 LLM 生成，仅供群内成员参考，不作为事实依据。
- 聊天记录保存在本地 `data/` 目录，请妥善保管，注意隐私。
