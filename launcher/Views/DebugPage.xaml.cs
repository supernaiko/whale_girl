using System;
using System.Collections.Generic;
using System.Diagnostics;
using System.IO;
using System.Linq;
using System.Text.Json;
using System.Threading;
using System.Threading.Tasks;
using System.Windows;
using System.Windows.Controls;
using System.Windows.Data;
using Microsoft.Win32;

namespace WhaleLauncher.Views;

public partial class DebugPage : UserControl
{
    private const int ResponseLimit = 2000;
    private const int LogLimit = 150_000;
    private const int CodexTimeoutMinutes = 20;
    private const string ContactsPath = "/api/wechat/contacts";
    private const string FileHelperId = "filehelper";
    private readonly RuntimeSupervisor _sup;
    private readonly string _dataDirOverride;
    private readonly ComboBox[] _contactPickers;
    private readonly List<ContactTarget> _contactTargets = new()
    {
        new ContactTarget { Wxid = FileHelperId, Name = "文件传输助手" }
    };
    private CancellationTokenSource _pageLifetime = new();
    private CancellationTokenSource _codexCancel;
    private bool _updatingContactChoices;
    private string DataDir => _dataDirOverride ?? _sup.DataDir;
    private string BaseUrl => _dataDirOverride == null ? _sup.Url : $"http://127.0.0.1:{RuntimeSupervisor.ReadPort(DataDir)}";

    private sealed class ContactTarget : ContactInfo
    {
        public string Label => Remark.Length == 0 ? Display
            : Name.Length == 0 || Name == Remark || Name == Wxid ? Remark
            : $"{Remark}（{Name}）";
    }

    internal DebugPage(RuntimeSupervisor sup)
    {
        _sup = sup;
        var args = Environment.GetCommandLineArgs();
        for (var i = 1; i < args.Length - 1; i++)
            if (string.Equals(args[i], "--data", StringComparison.OrdinalIgnoreCase))
                _dataDirOverride = Path.GetFullPath(args[++i]);

        InitializeComponent();
        _contactPickers = new[] { FileChat, EmoticonChat, TextChat };
        foreach (var picker in _contactPickers)
        {
            picker.ItemsSource = new ListCollectionView(_contactTargets);
            picker.AddHandler(TextBox.TextChangedEvent, new TextChangedEventHandler(OnContactTextChanged));
            picker.DropDownOpened += OnContactDropDownOpened;
        }
        CodexDirectory.Text = Environment.GetFolderPath(Environment.SpecialFolder.DesktopDirectory);
        UpdateCodexHint();
        Loaded += OnPageLoaded;
        Unloaded += (_, _) => CancelActiveWork();
    }

    internal void CancelActiveWork()
    {
        var lifetime = _pageLifetime;
        _pageLifetime = null;
        lifetime?.Cancel();
        lifetime?.Dispose();
    }

    private async void OnPageLoaded(object sender, RoutedEventArgs e)
    {
        _pageLifetime ??= new CancellationTokenSource();
        await LoadContactsAsync();
    }

    private async void OnRefreshContacts(object sender, RoutedEventArgs e) => await LoadContactsAsync();

    private async Task LoadContactsAsync()
    {
        if (_pageLifetime == null) return;
        var lifetime = _pageLifetime;
        var cancellationToken = lifetime.Token;
        RefreshContacts.IsEnabled = false;
        ContactState.Text = "正在读取联系人…";
        var clock = Stopwatch.StartNew();
        try
        {
            // sync 接口会覆盖桥接上传的缓存，启动器刷新只读取当前快照。
            var response = await Api.Get(BaseUrl, ContactsPath).WaitAsync(cancellationToken);
            cancellationToken.ThrowIfCancellationRequested();
            var items = response.Prop("items");
            if (!response.Ok || items.ValueKind != JsonValueKind.Array)
            {
                ContactState.Text = "联系人读取失败";
                var detail = response.Ok ? "响应缺少联系人清单" : response.Error;
                AppendLog($"GET {ContactsPath} · {clock.ElapsedMilliseconds} ms · HTTP {response.StatusCode}",
                    $"读取失败 · 条数未知{(detail.Length > 0 ? " · " + ClipResponse(detail) : "")}");
                return;
            }

            var account = response.Str("account");
            var contacts = items.EnumerateArray()
                .Select(item => new ContactTarget
                {
                    Wxid = JsonRead.Str(item, "wxid"),
                    Name = JsonRead.Str(item, "name"),
                    Remark = JsonRead.Str(item, "remark")
                })
                .Where(item => !string.IsNullOrWhiteSpace(item.Wxid) && item.Wxid != "*")
                .ToList();
            if (!contacts.Any(item => IsContactId(item, FileHelperId)))
                contacts.Add(new ContactTarget { Wxid = FileHelperId, Name = "文件传输助手" });

            _contactTargets.Clear();
            _contactTargets.AddRange(contacts.OrderBy(item =>
                IsContactId(item, FileHelperId) ? 0 : IsContactId(item, account) ? 1 : 2));
            foreach (var picker in _contactPickers) FilterContactChoices(picker);

            var total = JsonRead.TryLong(response.Root, "total", out var count) ? count : items.GetArrayLength();
            ContactState.Text = total == 0 ? "联系人未同步" : $"联系人 {total} 条";
            AppendLog($"GET {ContactsPath} · {clock.ElapsedMilliseconds} ms · HTTP {response.StatusCode}", $"{total} 条联系人");
        }
        catch (OperationCanceledException) when (cancellationToken.IsCancellationRequested)
        {
            // 页面离开后，正在读取的结果不再更新控件。
        }
        finally
        {
            if (ReferenceEquals(_pageLifetime, lifetime)) RefreshContacts.IsEnabled = true;
        }
    }

    private static bool IsContactId(ContactInfo item, string wxid)
        => string.Equals(item.Wxid, wxid, StringComparison.OrdinalIgnoreCase);

    private void OnContactTextChanged(object sender, TextChangedEventArgs e)
    {
        var picker = (ComboBox)sender;
        // 输入法提交后 ComboBox.Text 才会更新，选中联系人时则由 WPF 回填 wxid。
        if (_updatingContactChoices || e.OriginalSource is not TextBox editor || picker.Text != editor.Text
            || (picker.SelectedItem is ContactTarget selected && selected.Wxid == picker.Text)) return;
        FilterContactChoices(picker, editor.IsKeyboardFocused);
    }

    private void OnContactDropDownOpened(object sender, EventArgs e)
    {
        if (_updatingContactChoices) return;
        var picker = (ComboBox)sender;
        if (picker.SelectedItem != null && picker.Items.Count != _contactTargets.Count) FilterContactChoices(picker);
        else if (!picker.HasItems) picker.IsDropDownOpen = false;
    }

    private void FilterContactChoices(ComboBox picker, bool showSuggestions = false)
    {
        var text = picker.Text;
        var selected = picker.SelectedItem as ContactTarget;
        var usingSelection = selected != null && selected.Wxid == text;
        var query = usingSelection ? "" : text;
        var editor = picker.Template?.FindName("PART_EditableTextBox", picker) as TextBox;
        var selectionStart = editor?.SelectionStart ?? 0;
        var selectionLength = editor?.SelectionLength ?? 0;
        _updatingContactChoices = true;
        try
        {
            if (selected != null && !usingSelection) picker.SelectedIndex = -1;
            ((ListCollectionView)picker.ItemsSource).Filter = item => ContactDirectory.Matches((ContactTarget)item, query);
            // 过滤或刷新淘汰已选项时，WPF 会清空文本。发送始终读取用户看到的输入。
            if (picker.Text != text) picker.Text = text;
            if (showSuggestions || picker.IsDropDownOpen) picker.IsDropDownOpen = picker.HasItems;
            if (editor != null && (editor.SelectionStart != selectionStart || editor.SelectionLength != selectionLength))
                editor.Select(selectionStart, selectionLength);
        }
        finally
        {
            _updatingContactChoices = false;
        }
    }

    private async Task WithButtonAsync(object sender, string operation, Action<string> show, Func<CancellationToken, Task> run)
    {
        if (_pageLifetime == null) return;
        var cancellationToken = _pageLifetime.Token;
        var button = (Button)sender;
        button.IsEnabled = false;
        try { await run(cancellationToken); }
        catch (OperationCanceledException) when (cancellationToken.IsCancellationRequested)
        {
            show("已取消");
        }
        catch (Exception ex)
        {
            show(ex.ToString());
            AppendLog(operation, ClipResponse(ex.ToString()));
        }
        finally { button.IsEnabled = true; }
    }

    private void OnPickFile(object sender, RoutedEventArgs e)
    {
        try
        {
            var dialog = new OpenFileDialog { CheckFileExists = true, Filter = "所有文件|*.*" };
            if (dialog.ShowDialog(Window.GetWindow(this)) == true) FilePath.Text = dialog.FileName;
        }
        catch (Exception ex)
        {
            FileResult.Text = ex.ToString();
            AppendLog("选择文件", ex.ToString());
        }
    }

    private async void OnSendFile(object sender, RoutedEventArgs e)
    {
        string jobId = null;
        await WithButtonAsync(sender, "发文件",
            error => FileResult.Text = string.IsNullOrEmpty(jobId) ? error : $"jobId {jobId}\n{error}", async token =>
        {
            var request = new { chat = FileChat.Text, path = FilePath.Text };
            FileResult.Text = "正在提交文件任务…";
            var response = await RequestAsync("/api/send-file", request, token);
            FileResult.Text = response.Raw;
            if (!response.Ok) return;
            jobId = response.Str("jobId");
            if (string.IsNullOrEmpty(jobId)) throw new InvalidDataException("缺少 jobId。" + response.Raw);

            FileResult.Text = $"jobId {jobId}\nqueued";
            var clock = Stopwatch.StartNew();
            var path = "/api/send-file/status?id=" + Uri.EscapeDataString(jobId);
            while (clock.Elapsed < TimeSpan.FromSeconds(190))
            {
                await Task.Delay(TimeSpan.FromSeconds(1), token);
                var status = await RequestAsync(path, null, token);
                var state = status.Str("status");
                var error = status.Str("error");
                FileResult.Text = $"jobId {jobId}\n{state}" + (error.Length > 0 ? "\n" + error : "");
                if (!status.Ok || string.IsNullOrEmpty(state))
                {
                    FileResult.Text += "\n" + status.Raw;
                    return;
                }
                if (state is not ("queued" or "sending")) return;
            }
            FileResult.AppendText("\n等待状态超时。");
            AppendLog("发文件", $"jobId {jobId} 等待状态超时");
        });
    }

    private async void OnSendEmoticon(object sender, RoutedEventArgs e) =>
        await WithButtonAsync(sender, "发表情", error => EmoticonResult.Text = error, async token =>
        {
            EmoticonResult.Text = "正在提交…";
            var response = await RequestAsync("/api/send-emoticon", new { chat = EmoticonChat.Text, code = EmoticonCode.Text }, token);
            EmoticonResult.Text = response.Raw;
        });

    private async void OnSendText(object sender, RoutedEventArgs e) =>
        await WithButtonAsync(sender, "发送文本", error => TextResult.Text = error, async token =>
        {
            TextResult.Text = "正在提交…";
            var response = await RequestAsync("/api/send-text", new { chat = TextChat.Text, text = SendText.Text }, token);
            TextResult.Text = response.Raw;
        });

    private async Task<ApiResult> RequestAsync(string path, object body, CancellationToken cancellationToken)
    {
        var clock = Stopwatch.StartNew();
        var request = (body == null ? "GET " : "POST ") + path;
        try
        {
            var configPath = _dataDirOverride == null ? ConfigurationPath.Resolve(_sup.BaseDir) : Path.Combine(DataDir, "config.json");
            var json = await File.ReadAllTextAsync(configPath, cancellationToken);
            using var config = JsonDocument.Parse(json);
            if (!config.RootElement.TryGetProperty("gateway", out var gateway)
                || !gateway.TryGetProperty("wechat", out var wechat)
                || !wechat.TryGetProperty("inboundToken", out var tokenNode)
                || tokenNode.ValueKind != JsonValueKind.String || string.IsNullOrWhiteSpace(tokenNode.GetString()))
                throw new InvalidDataException($"配置文件缺少 gateway.wechat.inboundToken。\n{configPath}");

            var result = await Api.SendAuthenticatedAsync(BaseUrl, path, body, tokenNode.GetString(), cancellationToken);
            LogHttp(request, clock.ElapsedMilliseconds, result.StatusCode, result.Raw);
            return result;
        }
        catch (Exception ex)
        {
            LogHttp(request, clock.ElapsedMilliseconds, null, ex.ToString());
            throw;
        }
    }

    private void OnCodexPromptChanged(object sender, TextChangedEventArgs e) => UpdateCodexHint();

    private void UpdateCodexHint()
    {
        if (CodexHint != null) CodexHint.Text = $"{CodexPrompt.Text.Length} 字符  ·  超时 {CodexTimeoutMinutes} 分钟";
    }

    private async void OnRunCodex(object sender, RoutedEventArgs e) =>
        await WithButtonAsync(sender, "Codex", error => CodexState.Text = error, async token =>
        {
            var prompt = CodexPrompt.Text;
            if (string.IsNullOrWhiteSpace(prompt)) throw new ArgumentException("请输入 Codex 任务。");
            if (string.IsNullOrWhiteSpace(CodexDirectory.Text)) throw new ArgumentException("请输入工作目录。");

            var directory = Path.GetFullPath(CodexDirectory.Text.Trim());
            var codex = Path.Combine(Environment.GetFolderPath(Environment.SpecialFolder.ApplicationData), "npm", "codex.cmd");
            if (!File.Exists(codex)) throw new FileNotFoundException("找不到 codex.cmd。", codex);
            var info = new ProcessStartInfo
            {
                FileName = Path.Combine(Environment.SystemDirectory, "cmd.exe"),
                WorkingDirectory = directory,
                // 默认工作目录是桌面，通常没有 Git 仓库。
                Arguments = "/D /V:OFF /S /C \"\"%WHALE_DEBUG_CODEX%\" exec -c model_reasoning_effort=\"high\" --dangerously-bypass-approvals-and-sandbox --skip-git-repo-check -\"",
            };
            info.Environment["WHALE_DEBUG_CODEX"] = codex;
            info.Environment["HTTPS_PROXY"] = "http://127.0.0.1:10808";
            info.Environment["HTTP_PROXY"] = "http://127.0.0.1:10808";

            using var stop = new CancellationTokenSource();
            using var timeout = new CancellationTokenSource(TimeSpan.FromMinutes(CodexTimeoutMinutes));
            using var run = CancellationTokenSource.CreateLinkedTokenSource(token, stop.Token, timeout.Token);
            _codexCancel = stop;
            CancelCodex.IsEnabled = true;
            CodexState.Text = "运行中…";
            AppendLog("Codex", "开始运行 · " + directory);
            var clock = Stopwatch.StartNew();
            try
            {
                var exitCode = await Task.Run(() => DebugProcess.RunAsync(info, prompt, (error, line) =>
                {
                    if (Dispatcher.HasShutdownStarted) return Task.CompletedTask;
                    return Dispatcher.InvokeAsync(() => AppendLog(error ? "Codex stderr" : "Codex stdout", line)).Task;
                }, run.Token));

                var result = timeout.IsCancellationRequested ? "已超时 · " : run.IsCancellationRequested ? "已取消 · " : "";
                CodexState.Text = $"{result}退出码 {exitCode} · {clock.Elapsed.TotalSeconds:F1} 秒";
                AppendLog("Codex", CodexState.Text);
            }
            finally
            {
                _codexCancel = null;
                CancelCodex.IsEnabled = false;
            }
        });

    private void OnCancelCodex(object sender, RoutedEventArgs e)
    {
        CancelCodex.IsEnabled = false;
        _codexCancel?.Cancel();
    }

    private void LogHttp(string request, long milliseconds, int? status, string body) =>
        AppendLog($"{request} · {milliseconds} ms · HTTP {status?.ToString() ?? "—"}",
            ClipResponse(body));

    private static string ClipResponse(string body) =>
        body.Length <= ResponseLimit ? body : body[..(ResponseLimit - 1)] + "…";

    private void AppendLog(string source, string message)
    {
        Log.AppendText($"[{DateTime.Now:HH:mm:ss}] {source}  {message}{Environment.NewLine}");
        if (Log.Text.Length > LogLimit)
        {
            Log.Select(0, Log.Text.Length - LogLimit);
            Log.SelectedText = "";
        }
        Log.ScrollToEnd();
    }

    private void OnClearLog(object sender, RoutedEventArgs e) => Log.Clear();
}
