目标：在 C:\dev\whale-girl\custom\plugins\yxn-chat\ 新建插件 `yxn-chat`（名字：本地回话），实现「加权回复池 + 人味延迟 + 可迁移数据」，先不接本地模型，但预留接口。

## 一、数据布局（必须全在插件数据目录里，方便整目录搬走）
`whale.paths.pluginData` 下：
- `brain.json`：{ schema:1, personaTraits:{sweet,sharp,talky}, buckets:{ [bucket]: [{ text, weight, sweet, sharp, talky, source, uses, lastUsedAt, addedAt }] }, stats:{sent,picked,skipped} }
- `pool.jsonl`：只追加的原始素材（她从 DeepSeek 说过的好句子），每行 {at,bucket,text,source:'learned'|'seed'|'manual'}
- `config.json`：{ mode:'off'|'fallback'|'probabilistic', probability:0.25, readDelay:{min:3,max:30}, typingMsPerChar:120, maxDelaySec:45, minFreeRamMB:1024, bucketsOff:[] }
- `local-model.json`：留给本地模型的配置占位 { enabled:false, cmd:'', modelPath:'', maxTokens:64 }
全部读写用原子替换（临时文件 + rename），jsonl 用 append。

## 二、插件清单
plugin.json：Id `yxn-chat`，Name `本地回话`，Api 4，Kind message，Hooks `["chat.pre_reply","chat.generate","app.start","timer.tick"]`，Permissions `["system.full"]`，ExecutionTimeoutMs 60000，IntervalSeconds 300。

## 三、行为
1. `app.start`：首次运行（brain.json 不存在）时从宿主记忆灌种子——读 `data\memory\chats\*.jsonl` 里 role=assistant、长度 4~30、不含链接和人名的句子，按关键词分桶，初始 weight 1，source 'seed'；每桶最多 40 条，总量最多 400。日志 `[yxn-chat] seeded N in M buckets`。
2. `chat.pre_reply`：只判断要不要接——命中以下条件之一才接管（返回 wake 由宿主继续生成？不，这里只做判定）：
   - 不要在这里生成正文；本 hook 只决定 `{action:'pass'}`，避免和 whale-ops 抢。
   - 如果命中「不该接」的情况（whale-ops 命令、明确要 codex/dsh、链接、语音），返回 `{action:'pass'}` 并不接管。
   - 其它情况返回 `{action:'pass'}`。**即 pre_reply 永远 pass**，真正的接管放 chat.generate。
3. `chat.generate`：
   - 若消息命中 whale-ops 命令特征（包含「建/删/改/发/打开/运行/截图/codex/dsh」等），直接 `return {}`，不接管。
   - 若 `mode==='off'` → `return {}`。
   - 若 `mode==='fallback'` 且本轮是 DeepSeek 失败（ctx.reason 或 ctx.error 存在）→ 接管。
   - 若 `mode==='probabilistic'` 且 `Math.random() < probability` 且桶属于「轻量桶」（greeting/miss/goodnight/praise/food/bored/complain）→ 接管。
   - 接管时：选桶（按关键词表）→ 从该桶按权重采样一条（见下）→ 应用语气微调（去掉句尾句号、把「好的」换「行」等简单规则）→ **等待人味延迟**（readDelay 随机 + 字数×120ms，封顶 maxDelaySec）→ `return { text }`。
   - 采样失败（桶空）→ `return {}`。
4. `timer.tick`：每小时做一次维护——权重衰减（14 天未用 ×0.95）、低于 0.05 的从库中移除（保留在 pool.jsonl）、每桶最多 150 条、内存不足时记录一条警告。
5. 采样算法（纯函数，必须单测）：
   - score = weight × traitAffinity(reply, personaTraits) × recencyPenalty(now - lastUsedAt)
   - traitAffinity = 1 - (|sweet-p.sweet| + |sharp-p.sharp| + |talky-p.talky|)/3
   - recencyPenalty：<2 小时 0.4，<24 小时 0.8，否则 1
   - softmax(temperature=0.7) 后随机抽取；用可注入 rng 便于测试
6. 学习：`chat.before_send` 不接；改为在 `chat.generate` 结束时把宿主最终回复（ctx.finalText 若存在）以 source 'learned' 追加到 pool.jsonl 并进 brain（初始 weight 1，按关键词分桶），同一文本 24 小时内不重复入库。

## 四、延迟实现
`await new Promise(r => setTimeout(r, ms))`，但必须在超时保护内：若计算出的延迟 > 45000 则截断；若插件执行剩余预算不足，直接缩短到剩余预算的 80%。

## 五、测试 `tests\chat.test.js`
- 采样：同权重多条，rng 固定时结果稳定；权重高的被选中概率显著更高（跑 1000 次统计）。
- 延迟：配置 min/max 与字数换算正确、封顶生效。
- 守卫：含「建个文件」「用codex」等消息不接管。
- 学习去重：同文本 24 小时内只入一次。
- 种子导入：给 3 条 assistant 消息，能分到正确桶。
跑 `node --test tests/chat.test.js` 全过。

## 六、交付
- 代码、plugin.json、tests、README.md（说明数据布局、怎么整目录迁移、怎么切模式）。
- 在 `C:\dev\whale-girl\_report_chat.md` 写：实现范围、测试结果、已知限制、下一步接本地模型的位置（函数名）。
约束：不改 src\（宿主）与其它插件；不发真实消息；不修改 app\data。
