目标：只读分析 C:\dev\whale-girl（fork）与上游 Banan1cee/whale_girl 的差异，产出一份「以后怎么跟上游走」的方案报告，不要改任何源码。

步骤：
1. `git -C C:\dev\whale-girl remote -v` 看 upstream 是否已配；没有就 `git remote add upstream https://github.com/Banan1cee/whale_girl.git`，然后 `git fetch upstream --depth=50`（走代理 HTTPS_PROXY=http://127.0.0.1:10808）。
2. 对比：`git log --oneline upstream/main..dev`（本地独有提交）、`git log --oneline dev..upstream/main`（上游新增）、`git diff --stat upstream/main...dev`（改动面）。
3. 按文件归类本地改动：
   - 必须保留的功能（朋友圈微博配图、发文件、表情、调试台、花销/心情/说话方式/备份页、gate/bond/voice 插件、yxn 路由、Codex provider 等）
   - 与上游结构冲突面大的部分（例如 `src\pipeline\chat.js`、`src\services\moments*`、`launcher\MainWindow.xaml.cs`）
4. 给出三种策略并比较（工作量/风险/维护成本）：
   A. 定期 merge upstream/main，冲突手工解
   B. 只挑 release tag 合并，本地改动打成 patch 队列
   C. 把本地改动做成独立插件/补丁目录，上游文件尽量不动
   推荐一个，并给出「下次上游发版时的具体操作清单」。
5. 输出到 `C:\dev\whale-girl\docs\upstream-merge-plan.md`（中文，含命令、冲突热点文件列表、每步预计耗时）。

约束：
- 只读 + 写这一个 md；不要 commit、不要改源码、不要 push。
- 不执行任何会发微信消息或动用户数据的操作。
- 完成后在终端输出 5 行以内摘要。
