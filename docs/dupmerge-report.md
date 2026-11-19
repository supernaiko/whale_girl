# A 区重复函数合并报告

按任务正文的 10 个编号逐项核对。8 组宿主实现已合并，第 10 组已合并预设名称和简介的实现。 `yxn-voice` 的未使用 `num` 已由基线提交 `89413fc` 删除。

| 组 | 改动文件与移除的本地定义 | 共享位置 | 行为对照 |
| --- | --- | --- | --- |
| 1. 对象判断 | `src/infra/config.js` 和 `src/infra/configPatch.js` 的 `isPlainObject`，`src/services/messagePlugins.js` 的 `plainObject`，`src/services/javascriptPlugins.js` 和 `src/memory/backup.js` 的 `object` | `src/infra/configValues.js` 的 `isPlainObject` | 仍只判断非 null 的对象且排除数组。类实例和无原型对象仍可通过。 |
| 2. `clamp` | `src/http/routes/yxn.js`、`src/memory/budgetPlan.js`、`src/memory/calibration.js` 的 `clamp` | `src/infra/configValues.js` 的 `clamp` | 先取 `Math.max(lo, value)`，再取 `Math.min(hi, ...)`。保留隐式转换、反向边界与 NaN 行为。 |
| 3. `num` | 核对 `custom/plugins/yxn-voice/plugin.js`，基线中已无该定义及引用 | 原入口 `src/http/routes/yxn.js` 与 `custom/plugins/yxn-bond/plugin.js` | 两个现有实现各自保留原转换与回退。 |
| 4. `clampNum` | `src/http/routes/yxn.js` 和 `src/memory/personCard.js` 的 `clampNum` | `src/infra/configValues.js` 的 `clampNum` | 先用 `Number` 转换，非有限数直接返回调用方回退值。有限数沿用原边界顺序并保留小数。 |
| 5. `p` / `pad` / `pad2` | `src/memory/backup.js`、`src/memory/episode.js`（两处）、`src/memory/personCard.js` 的 `p`，`src/services/digest.js` 的 `pad` | 导出 `src/infra/time.js` 已有的 `pad2` | 保留 `String(n).padStart(2, '0')`。备份时间戳、事件 ID、日报日期和消息时分沿用各自的本地时间和输出格式。 |
| 6. `clampText` / `clip` / `text` | `src/memory/extractor.js` 的 `clampText`、`src/memory/relations.js` 的 `clip`。 `src/memory/personCard.js` 的 `text` 改为薄调用 | `src/infra/text.js` 的 `clampText` | 仍将连续空白折叠后 trim，并在超长时按 UTF-16 截断。人物卡默认上限为 200，C0 清洗继续使用独立的 `clean`。 |
| 7. `clamp01` | `src/memory/extractor.js` 和 `src/memory/relations.js` 的 `clamp01` | `src/infra/configValues.js` 的 `clamp01` | 保留 `Number` 转换、非有限数回退，以及原先上界后下界的 0–1 限幅顺序。 |
| 8. `str` | `src/persona/presets.js` 和 `src/services/persona.js` 的本地箭头函数 `str` | `src/infra/text.js` 的 `str` | null 和 undefined 转为空串，先 trim 再按 UTF-16 截断。各字段沿用原上限。 |
| 9. 对话预算 | `src/persona/tokenCheck.js` 的 `effectiveDialogueBudget`、`src/services/budget.js` 的 `dialogueBudget` | `src/memory/budgetPlan.js` 的 `effectiveDialogueBudget` | 接受转换后的正有限数，其他配置回退到默认预算。分片仍由 `planBudget` 处理取整和默认值，服务仍导出 `dialogueBudget`。 |
| 10. 单行文本清理 | 移除 `src/persona/presets.js` 的 `cleanName` 与 `cleanDescription`。 `src/services/location.js` 的 `tidy` 暂时保留 | 预设使用 `src/infra/text.js` 的 `tidy` | 仍将每个 CR、LF、TAB 分别替换为空格再 trim。预设名称和简介的上限分别为 40 和 300，地名清理不限长。 |

## 定位隐私测试阻塞

`tests/location-privacy.test.js` 在 VM 中执行 `src/services/location.js`，并用测试文件自身的 `require` 转发模块加载。定位改为导入 `../infra/text` 后，两项测试在解析依赖时抛出 `MODULE_NOT_FOUND`。按任务约定保留定位的本地实现与测试加载方式。第 10 组的定位迁移仍待完成。

## 验证

- 按任务指定的便携 Node、Python 和 `dotnet` 路径运行 `node --test --test-concurrency=4 tests/*.test.js`。1895 项通过，0 项失败或跳过，与基线一致。
- 使用修改前的 `HEAD` 源码对照了 2778 项输入与输出，覆盖反向边界、非有限值、异常、UTF-16 截断、跨时区日期，以及预算分片和服务导出别名。
- 日报和定位隐私的定向回归共 11 项通过。
- `node scripts/check-layers.js` 通过，检查了 167 个文件。
- 整仓隐私扫描的 12 处命中与基线逐项一致，`src/` 隐私扫描通过。发布自检的唯一失败项来自同一整仓隐私检查。
