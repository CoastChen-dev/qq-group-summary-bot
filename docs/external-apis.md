# 对外接口面

> 本 bot 与外部系统交互的全部接口：NapCat（OneBot 11 WS）、LLM（OpenAI 兼容）、三个 Wiki（MediaWiki API 家族）、ArknightsGameData 下载。调试联调时对照本节。

## 1. NapCat / OneBot 11（core/platform/napcat.js）

**连接**：正向 WebSocket `ws://127.0.0.1:3001`（`napcat.wsUrl`），有 token 时拼 `?access_token=`。断线后 `reconnectDelay`(3s) 自动重连；`close()` 置 closed 标志后不再重连。**注意：无应用层心跳处理——心跳 meta_event 到达后因不含 lifecycle 分支被事件处理函数忽略。**

**入站事件**：所有带 `post_type` 的帧逐条派发给 `onEvent` 注册的回调（多回调；回调抛错仅 console.error，不影响其他回调）。WS open 时 NapCat 客户端**自己合成**一个 `lifecycle/connect` 事件（非 NapCat 原生下发，是本 bot 重连后恢复 ready 的锚点）。

**出站调用**（`call(action, params)`，echo 关联，**15s 超时**，WS 未 OPEN 直接 reject）：

| 方法 | action | 参数 | 用途 |
|---|---|---|---|
| `getLoginInfo` | `get_login_info` | — | 回填 selfId |
| `sendGroupMsg` | `send_group_msg` | `auto_escape: true` | 群播报（纯文本，不 @） |
| `sendGroupMsgAt` | `send_group_msg` | 段式 `[at, text]` | 回答提问者（真 @；S10/S12 指令回复、chat LLM 回复、refresh 手动回执） |
| `sendPrivateMsg` | `send_private_msg` | `auto_escape: true` | 日报私聊 |
| `setMsgEmojiLike` | `set_msg_emoji_like` | `message_id`, `emoji_id`（QQ 黄脸小数字 ID 如 `'14'`／Unicode 码点串如 `'128077'`，均实测可用）, `set: true` | LLM 工具 `react_emoji` 调用（贴表情） |
| `getGroupInfo` | `get_group_info` | — | 日报标题取群名 |
| `getGroupMsgHistory` | `get_group_msg_history` | `message_seq:0, count:1000` | backfill 补偿拉取 |

响应处理：`status==='ok' && retcode===0` → resolve data；否则 reject。**无 echo 的响应仅记日志忽略**（并发下无法可靠关联，防错配）。

## 2. LLM（OpenAI 兼容 /chat/completions）

两个调用点各自独立发请求，统一经 core/platform/http.js 的 `fetchRetry` 包装（2026-09 加固，原无超时/重试）：每次尝试 60s 超时、最多重试 2 次——仅**网络错误/超时/HTTP 5xx** 触发重试（5xx 只在非最后尝试时重试，最后一次原样返回供提取 body），2xx/4xx 一律原样返回响应：

```
POST {llm.baseUrl}/chat/completions
Authorization: Bearer {apiKey}
{ model, messages: [system, user], temperature, max_tokens }
```

| 维度 | Summarizer（概括/日报） | ChatBrain（群聊，plugins/chat.js） |
|---|---|---|
| 请求形状 | system=「严谨简洁的群聊分析助手」+ user=完整结构化 prompt | system=长人设提示（Mon3tr + 群聊规则 + 实名上下文/用户记忆 + 知识上下文段） |
| temperature | 0.7 | 0.8 |
| max_tokens 默认 | 2048 | 1024 |
| 并发限制 | 无 | 信号量 3（llm.chatConcurrency） |
| 超时/重试 | 60s/次 × 2 次重试（fetchRetry） | 同左 |
| 失败兜底 | 抛错冒泡（调用方处理） | 返回 `defaultReply` 文案（照发） |
| 成功副作用 | 无 | 追加群上下文历史（失败不写） |
| 响应取值 | `choices[0].message.content.trim()`；空则抛错 | 同左 |

错误统一为 `LLM API 错误 <status>: <body 前 N 字>`（Summarizer 500 / ChatBrain 300）。

> ChatBrain 主调用支持 **function calling（工具）**：请求带 `tools` 定义，模型返回 `tool_calls` 时由
> `_runTool` 本地执行并回填结果继续生成（最多 `tools.maxRounds` 轮，末轮不带工具收口）。
> 另有两次 fire-and-forget 辅助小调用（同一端点、经 fetchRetry，失败均静默回退、不影响回复时序）：
> ① **用户记忆自动提取** `_extractMemory`（temperature 0.2、max_tokens 200、30s×1 重试，输出 JSON 数组）。

## 3. 三个 Wiki 检索器（MediaWiki 家族）与联网搜索

共同点：均为"search → 取页内容 → 关键词定位截段 → `【标题】…` 拼接"，输出 `{context, sources, scoreSize}`；请求间有最小间隔节流。

> **提速（2026-09，ChatBrain）**：三源检索**并行执行**（`Promise.all`，单源失败/超时各自兜 null），单源超时 5s（`llm.wikiTimeoutMs`/`moegirlTimeoutMs`/`wikipediaTimeoutMs`）；且默认开启**检索门**（`llm.retrievalGate`）——闲聊消息（无问句特征）跳过通用检索（萌娘/维基）直接进 LLM，方舟相关问题仍检索 PRTS.Wiki。

### 联网搜索（可选替代源，config.webSearch）

DeepSeek API **不支持服务端联网搜索**（Responses API 的 `web_search` 等内置工具被忽略，只支持 function 工具），故联网检索走自建 `WebSearchRetriever`（core/knowledge/websearch.js）：配置 `webSearch.apiKey` 后，检索门放行的通用检索**改走搜索 API**（不再调用萌娘/维基），输出 `【联网搜索】` 上下文段参与统一评分（trust 70）。

| provider | 端点 | 请求 | 响应取值 |
|---|---|---|---|
| `zhipu`（默认） | `https://open.bigmodel.cn/api/paas/v4/web_search` | `{search_engine:'search_std', search_query, count}`，Bearer | `search_result[].{title,link,content}` |
| `bocha` | `https://api.bochaai.com/v1/web-search` | `{query, summary:true, count}`，Bearer | `data.webPages.value[].{name,url,summary}` |

单次超时 5s ×1 重试；失败/无结果返回空（ChatBrain 按空处理，不抛错）。

| | WikiRetriever (PRTS.Wiki) | MoegirlRetriever (萌娘百科) | WikipediaRetriever (维基) |
|---|---|---|---|
| search | MediaWiki API（12s 超时、1.5s×3 重试、**HTML 反爬探测→10s 冷却**） | OpenSearch API | API search |
| 取页 | wikitext + 白名单清洗（去 ref/标签，保关键参数行） | **浏览器 UA 抓 HTML** + mw-parser-output 容器正则 | 段落 extract 纯文本 |
| 截断 | `wikiMaxCharPerPage`(4000) | `moegirlMaxCharPerPage`(5000) | 2000 |
| 超时 | 12s/请求（AbortSignal） | 15s/请求 × 1 次重试（fetchRetry） | 10s/请求 |
| 话题门 | 仅方舟相关问题（`isArknightsRelated` 词表+关卡正则）才检索 | 无条件检索（萌娘命中方舟梗兜底 17 个主词条页） | 仅**非**方舟问题且 `enabled===true`（需代理） |
| 并入上下文 | topK=3 | topK=2 | topK=2 |

共享纯函数（core/knowledge/wiki.js 导出，moegirl/wikipedia 检索器与 chat 插件复用）：`extractKeywords`（问句剥语气词）、`isArknightsRelated`。

## 4. ArknightsGameData 下载（core/platform/refresher.js）

- 镜像源（按序 fallback）：jsDelivr CDN → GitHub raw。
- 4 表：干员表 / 档案 / 藏品 / 卡池（`zh_CN/gamedata/excel/`）。
- 版本比对：`If-None-Match: <etag>` → **304 = 未变化**，跳过下载。
- 结构校验：文件 <1024B / 首字节非 `{` / 计数（干员≥500、档案≥100、藏品≥500、卡池≥10）任一不过 → 拒绝写入并抛错。
- 原子写入：`.tmp` → 旧文件备份 `.bak` → rename；90s 请求超时。
- 上游数据结构约定（ArkDB 消费面）：character_table（`.characters` 或扁平）、handbook `.handbookDict`、藏品递归找 `type==='RELIC'`、卡池 `.gachaPoolClient`。

## 5. 实名上下文与用户记忆（plugins/chat.js ChatBrain 内部约定）

- **实名上下文**：对话历史与当前提问以群昵称（群名片优先）为前缀（`张三：...`），`_displayName` 按群维护「QQ → 最近昵称」映射（每群上限 200，满了逐出最旧）；system prompt 允许模型自然地称呼群友、理解「他/她/刚才那位」指代。**QQ 号绝不进 prompt**（仅作内部键）。该成员映射只存内存、不落盘、重启即清。
- **用户记忆注入**：`buildMessages` 经 `_memoryContext` 注入【用户记忆】段——提问者本人的事实 + 问题中点名的其他成员的事实（昵称精确匹配，按群隔离；见 core/platform/usermem.js）。
- **自动提取**：`_reply` 成功后 fire-and-forget 调 `_extractMemory`——同一 LLM 端点、`temperature 0.2`、`max_tokens 200`、30s 超时 ×1 重试，要求模型只输出 JSON 字符串数组（≤3 条，每条 ≤30 字）；`_parseFacts` 容错解析（允许 markdown 包裹），失败只记日志不影响回复。问题 <4 字跳过；`config.memory.autoExtract=false` 或 `enabled=false` 时关闭。
- **容量**：每人 20 条 / 全局 2000 条（config.memory 可调），超限丢最旧；事实写盘于 data/user_memory.json（见 data-format.md §6）。
