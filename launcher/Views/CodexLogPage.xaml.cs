using System;
using System.Collections.Generic;
using System.Globalization;
using System.IO;
using System.Linq;
using System.Text;
using System.Text.Json;
using System.Threading.Tasks;
using System.Windows;
using System.Windows.Controls;
using System.Windows.Threading;

namespace WhaleLauncher.Views
{
    /// <summary>
    /// 将 whale-ops 插件的 Codex 日志显示成步骤，也可切换到原始日志。
    /// </summary>
    public partial class CodexLogPage : UserControl, IRefreshable
    {
        private readonly RuntimeSupervisor _sup;
        private readonly DispatcherTimer _timer;
        private string _current = "";
        private (long Length, DateTime LastWriteTimeUtc) _currentVersion;
        private RunLog _log;

        internal CodexLogPage(RuntimeSupervisor sup)
        {
            _sup = sup;
            InitializeComponent();
            Title.Text = "Codex 日志";
            Hint.Text = "左边按时间倒序列出最近 50 次 Codex 运行。";

            _timer = new DispatcherTimer { Interval = TimeSpan.FromSeconds(3) };
            _timer.Tick += (_, __) => ReloadIfChanged();
            Loaded += (_, __) => { ReloadList(); _timer.Start(); };
            Unloaded += (_, __) => _timer.Stop();
        }

        private string LogDir => Path.Combine(_sup.BaseDir, "data", "plugins", "whale-ops.data", "codex");

        public Task RefreshAsync() { ReloadList(); return Task.CompletedTask; }

        private void OnRefresh(object sender, RoutedEventArgs e) => ReloadList();

        private void OnWrapChanged(object sender, RoutedEventArgs e)
            => LogText.TextWrapping = Wrap.IsChecked == true ? TextWrapping.Wrap : TextWrapping.NoWrap;

        private void OnRawChanged(object sender, RoutedEventArgs e)
        {
            UpdateView();
            if (Raw.IsChecked == true) RawScroller.ScrollToEnd();
        }

        private void UpdateView()
        {
            var hasLog = _log != null;
            var showRaw = hasLog && Raw.IsChecked == true;
            Summary.Visibility = hasLog ? Visibility.Visible : Visibility.Collapsed;
            RawScroller.Visibility = showRaw ? Visibility.Visible : Visibility.Collapsed;
            StepScroller.Visibility = hasLog && !showRaw ? Visibility.Visible : Visibility.Collapsed;
            StatusText.Visibility = !hasLog || (!showRaw && _log.Steps.Count == 0) ? Visibility.Visible : Visibility.Collapsed;
        }

        private void ShowStatus(string message)
        {
            _current = "";
            _log = null;
            Steps.ItemsSource = null;
            LogText.Text = "";
            StatusText.Text = message;
            UpdateView();
        }

        private void ReloadList()
        {
            try
            {
                var dir = LogDir;
                if (!Directory.Exists(dir))
                {
                    Runs.ItemsSource = null;
                    ShowStatus("还没有日志。\n\n目录：" + dir
                        + "\n\n在微信里发「用 codex ……」，确认后跑一次就会在这里留下记录。");
                    return;
                }

                var files = new DirectoryInfo(dir).GetFiles("*.log")
                    .OrderByDescending(f => f.LastWriteTimeUtc)
                    .Take(50)
                    .ToList();

                if (files.Count == 0)
                {
                    Runs.ItemsSource = null;
                    ShowStatus("这个目录里还没有 run-*.log。\n\n路径：" + dir);
                    return;
                }

                var keep = _current;
                Runs.ItemsSource = files.Select(f => new RunItem(f)).ToList();
                Hint.Text = "共 " + files.Count + " 份日志，最新一份 "
                    + files[0].LastWriteTime.ToString("MM-dd HH:mm:ss") + "。";

                var pick = Follow.IsChecked == true
                    ? files[0]
                    : files.FirstOrDefault(f => f.FullName == keep) ?? files[0];
                Runs.SelectedItem = Runs.Items.Cast<RunItem>().FirstOrDefault(r => r.File.FullName == pick.FullName);
            }
            catch (Exception ex)
            {
                ShowStatus("读取日志失败：" + ex.Message);
            }
        }

        private void OnRunSelected(object sender, SelectionChangedEventArgs e)
        {
            if (Runs.SelectedItem is not RunItem item) return;
            try { Show(item.File); }
            catch (Exception ex) { ShowStatus("打开失败：" + ex.Message); }
        }

        private void Show(FileInfo file)
        {
            var version = (file.Length, file.LastWriteTimeUtc);
            var log = ReadLog(file.FullName);
            var sameRun = _current == file.FullName && _log != null;
            if (sameRun)
            {
                for (var i = 0; i < Math.Min(_log.Steps.Count, log.Steps.Count); i++)
                {
                    var before = _log.Steps[i];
                    var after = log.Steps[i];
                    if (before.Id == after.Id && before.Kind == after.Kind)
                        after.IsExpanded = before.IsExpanded;
                }
            }

            _current = file.FullName;
            _currentVersion = version;
            _log = log;
            TaskText.Text = "任务：" + (log.Task ?? "—");
            CwdText.Text = "工作目录：" + (log.Cwd ?? "—");
            RunStats.Text = log.GetStats();
            Steps.ItemsSource = log.Steps;
            LogText.Text = log.RawText;
            StatusText.Text = log.Steps.Count == 0 ? "暂无可显示的步骤。" : "";
            UpdateView();
            if (!sameRun)
            {
                StepScroller.ScrollToTop();
                RawScroller.ScrollToEnd();
            }
        }

        private static RunLog ReadLog(string path)
        {
            // 步骤和统计需要完整事件流，原始视图保留原有的末尾 800 行。
            using var fs = new FileStream(path, FileMode.Open, FileAccess.Read, FileShare.ReadWrite | FileShare.Delete);
            using var reader = new StreamReader(fs, Encoding.UTF8, true);
            var log = new RunLog();
            var items = new Dictionary<string, LogStep>(StringComparer.Ordinal);
            var tail = new Queue<string>();
            var lineNumber = 0;
            while (reader.ReadLine() is string line)
            {
                KeepLastLine(tail, line, 800);
                if (++lineNumber <= 2 && log.ReadHeader(line)) continue;
                if (!line.AsSpan().TrimStart().StartsWith("{", StringComparison.Ordinal)) continue;
                try
                {
                    using var document = JsonDocument.Parse(line);
                    log.ReadEvent(document.RootElement, items);
                }
                catch (JsonException) { /* 写入中的最后一行和 stderr 都可能不是完整 JSON。 */ }
                catch (InvalidOperationException) { /* 字段里的无效 Unicode 转义可能在解码时才报错。 */ }
            }

            log.RawText = string.Join(Environment.NewLine, tail);
            return log;
        }

        private static void KeepLastLine(Queue<string> tail, string line, int count)
        {
            if (tail.Count == count) tail.Dequeue();
            tail.Enqueue(line);
        }

        private void ReloadIfChanged()
        {
            if (Follow.IsChecked != true || !IsVisible) return;
            try
            {
                var dir = LogDir;
                if (!Directory.Exists(dir)) return;
                var newest = new DirectoryInfo(dir).GetFiles("*.log")
                    .OrderByDescending(f => f.LastWriteTimeUtc).FirstOrDefault();
                if (newest == null) return;
                if (newest.FullName != _current)
                {
                    ReloadList();
                    return;
                }
                if ((newest.Length, newest.LastWriteTimeUtc) != _currentVersion) Show(newest);
            }
            catch { /* 刷新失败不影响看旧内容 */ }
        }

        private static JsonElement Get(JsonElement value, string name)
            => value.ValueKind == JsonValueKind.Object && value.TryGetProperty(name, out var field) ? field : default;

        private static string GetText(JsonElement value, string name)
            => Get(value, name) is { ValueKind: JsonValueKind.String } field ? field.GetString() : null;

        private static long? GetNumber(JsonElement value, string name)
            => Get(value, name) is { ValueKind: JsonValueKind.Number } field && field.TryGetInt64(out var number)
                ? number : null;

        private static DateTimeOffset? GetTimestamp(JsonElement entry)
        {
            var field = Get(entry, "timestamp");
            if (field.ValueKind == JsonValueKind.Undefined) field = Get(entry, "ts");
            if (field.ValueKind == JsonValueKind.String &&
                DateTimeOffset.TryParse(field.GetString(), CultureInfo.InvariantCulture, DateTimeStyles.AssumeUniversal, out var time))
                return time;
            if (field.ValueKind != JsonValueKind.Number || !field.TryGetInt64(out var unixTime)) return null;
            if (unixTime >= -9_999_999_999L && unixTime <= 9_999_999_999L)
                return DateTimeOffset.FromUnixTimeSeconds(unixTime);
            if (unixTime >= DateTimeOffset.MinValue.ToUnixTimeMilliseconds() && unixTime <= DateTimeOffset.MaxValue.ToUnixTimeMilliseconds())
                return DateTimeOffset.FromUnixTimeMilliseconds(unixTime);
            return null;
        }

        private sealed class RunLog
        {
            private bool? _success;
            private long? _inputTokens;
            private long? _outputTokens;
            private long? _cachedTokens;
            private DateTimeOffset? _firstTime;
            private DateTimeOffset? _lastTime;

            public string Task { get; private set; }
            public string Cwd { get; private set; }
            public string RawText { get; set; }
            public List<LogStep> Steps { get; } = new();

            public bool ReadHeader(string line)
            {
                if (line.StartsWith("# ", StringComparison.Ordinal)) line = line[2..];
                if (line.StartsWith("cwd:", StringComparison.Ordinal))
                    Cwd = line[4..].Trim();
                else if (line.StartsWith("task:", StringComparison.Ordinal))
                    Task = line[5..].Trim();
                else if (line.StartsWith("task-b64:", StringComparison.Ordinal))
                {
                    try { Task = Encoding.UTF8.GetString(Convert.FromBase64String(line[9..])); }
                    catch (FormatException) { /* 任务头也可能还没写完。 */ }
                }
                else return false;
                return true;
            }

            public void ReadEvent(JsonElement entry, Dictionary<string, LogStep> items)
            {
                var type = GetText(entry, "type");
                if (type == null) return;
                if (GetTimestamp(entry) is DateTimeOffset timestamp)
                {
                    if (_firstTime.HasValue) _lastTime = timestamp;
                    else _firstTime = timestamp;
                }

                switch (type)
                {
                    case "item.started":
                    case "item.updated":
                    case "item.completed":
                        ReadItem(Get(entry, "item"), items);
                        break;
                    case "error":
                    case "turn.failed":
                        _success = false;
                        var message = GetText(entry, "message") ?? GetText(Get(entry, "error"), "message");
                        if (type == "error" || !string.IsNullOrEmpty(message))
                            Steps.Add(new LogStep(null, "error", message));
                        break;
                    case "turn.completed":
                        _success = true;
                        var usage = Get(entry, "usage");
                        if (GetNumber(usage, "input_tokens") is long input) _inputTokens = (_inputTokens ?? 0) + input;
                        if (GetNumber(usage, "output_tokens") is long output) _outputTokens = (_outputTokens ?? 0) + output;
                        if (GetNumber(usage, "cached_input_tokens") is long cached) _cachedTokens = (_cachedTokens ?? 0) + cached;
                        break;
                }
            }

            private void ReadItem(JsonElement item, Dictionary<string, LogStep> items)
            {
                var id = GetText(item, "id");
                if (!string.IsNullOrEmpty(id) && items.TryGetValue(id, out var existing))
                {
                    existing.Apply(item);
                    return;
                }

                var kind = GetText(item, "type");
                if (kind is not ("command_execution" or "file_change" or "mcp_tool_call" or "agent_message" or "reasoning")) return;
                var step = new LogStep(id, kind);
                step.Apply(item);
                Steps.Add(step);
                if (!string.IsNullOrEmpty(id)) items.Add(id, step);
            }

            public string GetStats()
            {
                var status = _success switch { true => "成功", false => "失败", _ => "未确认" };
                var stats = $"步骤数 {Steps.Count}  ·  状态 {status}  ·  Token 输入 {FormatTokens(_inputTokens)} / 输出 {FormatTokens(_outputTokens)} / 缓存 {FormatTokens(_cachedTokens)}";
                if (_firstTime is DateTimeOffset first && _lastTime is DateTimeOffset last && last >= first)
                    stats += $"  ·  耗时 {(last - first).TotalSeconds:0.###} 秒";
                return stats;
            }

            private static string FormatTokens(long? tokens) => tokens?.ToString("N0") ?? "—";
        }

        private sealed class LogStep
        {
            private string _text;
            private string _output;
            private long? _exitCode;
            private string _server;
            private string _tool;

            public LogStep(string id, string kind, string text = null)
            {
                Id = id;
                Kind = kind;
                _text = text;
            }

            public string Id { get; }
            public string Kind { get; }
            public bool IsExpanded { get; set; }

            public string Title => Kind switch
            {
                "command_execution" => "执行命令",
                "file_change" => "修改文件",
                "mcp_tool_call" when _server != null && _tool != null => $"调用 {_server}.{_tool}",
                "mcp_tool_call" => "调用 " + (_tool ?? _server ?? "工具"),
                "agent_message" => "助手发言",
                "reasoning" => "推理",
                _ => "错误"
            };

            public string Detail => Kind == "command_execution"
                ? string.Join("\n\n", new[] { _text, _exitCode.HasValue ? $"退出码：{_exitCode}" : null, _output }
                    .Where(section => !string.IsNullOrEmpty(section)))
                : _text ?? "";

            public void Apply(JsonElement item)
            {
                switch (Kind)
                {
                    case "command_execution":
                        _text = GetText(item, "command") ?? _text;
                        _exitCode = GetNumber(item, "exit_code") ?? _exitCode;
                        if (GetText(item, "aggregated_output") is string output)
                        {
                            using var reader = new StringReader(output);
                            var tail = new Queue<string>();
                            while (reader.ReadLine() is string line) KeepLastLine(tail, line, 20);
                            _output = tail.Count > 0 ? "输出末尾：\n" + string.Join("\n", tail) : null;
                        }
                        break;
                    case "file_change":
                        var changes = Get(item, "changes");
                        if (changes.ValueKind == JsonValueKind.Array)
                            _text = string.Join("\n", changes.EnumerateArray()
                                .Select(change => GetText(change, "path")).Where(path => !string.IsNullOrEmpty(path)));
                        break;
                    case "mcp_tool_call":
                        _server = GetText(item, "server") ?? _server;
                        _tool = GetText(item, "tool") ?? _tool;
                        var arguments = Get(item, "arguments");
                        if (arguments.ValueKind is not (JsonValueKind.Undefined or JsonValueKind.Null))
                            _text = FormatArguments(arguments);
                        break;
                    case "agent_message":
                    case "reasoning":
                        var text = Kind == "reasoning" ? GetText(item, "summary") ?? GetText(item, "text") : GetText(item, "text");
                        if (text != null) _text = Clip(text, 500);
                        break;
                }
            }

            private static string FormatArguments(JsonElement arguments)
            {
                if (arguments.ValueKind != JsonValueKind.Object) return Clip(arguments.GetRawText(), 500);
                var lines = new List<string>();
                foreach (var argument in arguments.EnumerateObject())
                {
                    if (lines.Count == 8)
                    {
                        lines.Add("…");
                        break;
                    }
                    lines.Add(Clip(argument.Name, 80) + "：" + Clip(argument.Value.GetRawText(), 240));
                }
                return string.Join("\n", lines);
            }

            private static string Clip(string text, int limit)
            {
                var offset = 0;
                for (var i = 0; i < limit && offset < text.Length; i++)
                {
                    var next = offset + StringInfo.GetNextTextElementLength(text, offset);
                    if (i == limit - 1 && next < text.Length) return text[..offset] + "…";
                    offset = next;
                }
                return text;
            }
        }

        private sealed class RunItem
        {
            public RunItem(FileInfo file) { File = file; }
            public FileInfo File { get; }

            public override string ToString()
            {
                var size = File.Length < 1024 ? File.Length + " B" : (File.Length / 1024) + " KB";
                return File.LastWriteTime.ToString("MM-dd HH:mm") + "  ·  " + size;
            }
        }
    }
}
