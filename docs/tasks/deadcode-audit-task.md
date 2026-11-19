# 任务：鲸鲸(whale_girl) JS 源码死代码 / 重复逻辑审计

只读审计，禁止修改任何代码。工作目录 C:\dev\whale-girl，扫描范围仅 src\ 与 custom\plugins\ 下的 .js（不含 tests、不含 node_modules、不含 app 目录）。

## 目标
产出一份可执行清理清单，写到 `docs\deadcode-audit.md`。清单按风险分级，每条给：文件:行号、函数/常量名、判断依据、建议动作。

## 要查的四类
1. **死导出**：`module.exports` / `exports.X` 导出的函数/常量，全仓库（src+tests+custom\plugins）没有任何 import/require 引用。用 grep 精确核对（注意 require 路径别名、解构导入 `const {x} = require(...)`）。
2. **死局部**：模块内定义的顶层 function/const，模块内从未调用（不导出也不使用）。
3. **重复函数**：两个及以上文件里实现几乎相同的纯函数（例如字符串清理、日期格式化、路径安全、剪贴板/UTF-8 处理、xxhash/crc 等），指出可合并到哪个文件、谁该被删。
4. **失效代码**：`if (false)`、被注释掉但保留的大段、`return` 后永不执行的分支、明显写错但未被测试覆盖的（例如永远返回常量的 getter）。

## 输出格式（docs\deadcode-audit.md）
- 顶部：统计摘要（扫描文件数、发现 dead-export N、dead-local M、duplicate K 组、dead-code J 处）。
- 三个表格分区：A 安全可删（删除不影响测试与运行）/ B 需人工确认（可能被动态 require 或插件反射引用）/ C 误报（排查过证明还在用）。
- 重复函数单独一节：列出每组函数名 + 所在文件:行 + 建议保留位置。

## 硬性要求
- 绝对不要改 src、tests、custom\plugins 下的任何文件，只写 docs\deadcode-audit.md。
- 判定「死」前必须 grep 全仓库（含 tests、custom\plugins、scripts、bridge 里被 require 的可能性），把 grep 命令与命中结果附在每条依据里。
- 动态 require 场景要谨慎（本项目有 require('../../../src/services/...') 这种相对路径反射加载），不确定就放 B 区。
- 中文用 UTF-8，不要 emoji 标题。

## 验证
完成前自检：`docs\deadcode-audit.md` 存在且三个分区都有内容；抽查 3 条 A 区结论，grep 确认确实零引用。把抽查结果写进报告末尾。
