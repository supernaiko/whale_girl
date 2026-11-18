using System;
using System.Collections.Generic;
using System.Collections.ObjectModel;
using System.Globalization;
using System.Linq;
using System.Text;
using System.Text.Json;
using System.Threading.Tasks;
using System.Windows;
using System.Windows.Controls;

namespace WhaleLauncher.Views
{
    public sealed class ChatBucketRow
    {
        public string Id { get; set; } = "";
        public string Title { get; set; } = "";
        public string CountText { get; set; } = "";
        public string WeightText { get; set; } = "";
        public string Example { get; set; } = "";
        public bool Off { get; set; }
    }

    public partial class YxnChatPage : UserControl, IRefreshable
    {
        private static readonly Dictionary<string, string> Titles = new Dictionary<string, string>
        {
            ["greeting"] = "打招呼",
            ["care"] = "关心",
            ["food"] = "吃的",
            ["bored"] = "没事干",
            ["tired"] = "累了",
            ["happy"] = "开心",
            ["sad"] = "低落",
            ["angry"] = "生气",
            ["flirt"] = "撒娇/撩",
            ["work"] = "工作学习",
            ["other"] = "其他",
        };

        private readonly RuntimeSupervisor _sup;
        private readonly ObservableCollection<ChatBucketRow> _rows = new ObservableCollection<ChatBucketRow>();
        private string _mode = "off";
        private readonly List<string> _off = new List<string>();
        private bool _busy;
        private bool _loading;

        public YxnChatPage(RuntimeSupervisor sup)
        {
            InitializeComponent();
            _sup = sup;
            BucketList.ItemsSource = _rows;
            Loaded += async (_, __) => await RefreshAsync();
        }

        public async Task RefreshAsync()
        {
            if (_busy) return;
            _busy = true;
            _loading = true;
            try
            {
                var r = await Api.Get(_sup.Url, "/api/yxn/chat");
                if (!r.Ok || r.Root.ValueKind != JsonValueKind.Object)
                {
                    SaveText.Text = string.IsNullOrEmpty(r.Error) ? "内核未启动，或 yxn-chat 插件未加载。" : r.Error;
                    UpdatedText.Text = "—";
                    return;
                }
                var root = r.Root;
                var cfg = root.TryGetProperty("config", out var c) ? c : default;
                if (cfg.ValueKind == JsonValueKind.Object)
                {
                    _mode = Str(cfg, "mode", "off");
                    var prob = cfg.TryGetProperty("probability", out var p) ? p.GetDouble() : 0.25;
                    ProbSlider.Value = Math.Round(prob * 100);
                    ProbText.Text = ProbSlider.Value.ToString("0") + "%";
                    var read = cfg.TryGetProperty("readDelay", out var rd) ? rd : default;
                    DelayMinBox.Text = read.ValueKind == JsonValueKind.Object ? Num(rd, "min", 3) : "3";
                    DelayMaxBox.Text = read.ValueKind == JsonValueKind.Object ? Num(rd, "max", 30) : "30";
                    TypingBox.Text = Num(cfg, "typingMsPerChar", 120);
                    MaxDelayBox.Text = Num(cfg, "maxDelaySec", 45);
                    RamBox.Text = Num(cfg, "minFreeRamMB", 1024);
                    _off.Clear();
                    if (cfg.TryGetProperty("bucketsOff", out var offs) && offs.ValueKind == JsonValueKind.Array)
                    {
                        foreach (var o in offs.EnumerateArray())
                            if (o.ValueKind == JsonValueKind.String) _off.Add(o.GetString());
                    }
                    foreach (ComboBoxItem item in ModeBox.Items)
                        if ((string)item.Tag == _mode) ModeBox.SelectedItem = item;
                    ModeHint.Text = _mode == "off" ? "只用 DeepSeek" : _mode == "fallback" ? "失败时兜底" : "按概率接管";
                }

                var totals = root.TryGetProperty("totals", out var t) ? t : default;
                if (totals.ValueKind == JsonValueKind.Object)
                    PoolText.Text = $"共 {Num(totals, "count", 0)} 条 · {Num(totals, "buckets", 0)} 个话题 · 池 {Num(totals, "poolLines", 0)} 行";

                _rows.Clear();
                if (root.TryGetProperty("buckets", out var bs) && bs.ValueKind == JsonValueKind.Array)
                {
                    foreach (var b in bs.EnumerateArray())
                    {
                        var id = Str(b, "id", "");
                        var count = Num(b, "count", 0);
                        var example = "";
                        if (b.TryGetProperty("examples", out var ex) && ex.ValueKind == JsonValueKind.Array && ex.GetArrayLength() > 0)
                            example = ex[ex.GetArrayLength() - 1].GetString() ?? "";
                        _rows.Add(new ChatBucketRow
                        {
                            Id = id,
                            Title = Titles.TryGetValue(id, out var title) ? title : id,
                            CountText = count + " 条",
                            WeightText = "均权 " + Num(b, "avgWeight", 0),
                            Example = example,
                            Off = _off.Contains(id),
                        });
                    }
                }

                var model = root.TryGetProperty("localModel", out var lm) ? lm : default;
                if (model.ValueKind == JsonValueKind.Object)
                {
                    ModelEnabledBox.IsChecked = model.TryGetProperty("enabled", out var en) && en.ValueKind == JsonValueKind.True;
                    ModelCmdBox.Text = Str(model, "cmd", "");
                    ModelPathBox.Text = Str(model, "modelPath", "");
                    ModelTokensBox.Text = Num(model, "maxTokens", 64);
                    var modelOk = model.TryGetProperty("modelExists", out var me) && me.ValueKind == JsonValueKind.True;
                    var cmdOk = model.TryGetProperty("cmdExists", out var ce) && ce.ValueKind == JsonValueKind.True;
                    ModelStateText.Text = !ModelEnabledBox.IsChecked.GetValueOrDefault() ? "未启用"
                        : (modelOk && cmdOk) ? "已就绪" : (modelOk ? "缺 llama-cli" : "缺模型文件");
                }

                var sb = new StringBuilder();
                if (root.TryGetProperty("activity", out var act) && act.ValueKind == JsonValueKind.Array)
                {
                    foreach (var line in act.EnumerateArray())
                        sb.AppendLine(line.GetString());
                }
                LogBox.Text = sb.Length == 0 ? "还没有活动记录。" : sb.ToString();
                DirText.Text = Str(root, "dir", "") + " · " + DateTime.Now.ToString("HH:mm:ss");
                UpdatedText.Text = "刷新于 " + DateTime.Now.ToString("HH:mm:ss");
                SaveText.Text = "";
            }
            finally
            {
                _loading = false;
                _busy = false;
            }
        }

        private void OnModeChanged(object sender, SelectionChangedEventArgs e)
        {
            if (_loading) return;
            if (ModeBox.SelectedItem is ComboBoxItem item) _mode = (string)item.Tag;
            ModeHint.Text = _mode == "off" ? "只用 DeepSeek" : _mode == "fallback" ? "失败时兜底" : "按概率接管";
        }

        private void OnProbChanged(object sender, RoutedPropertyChangedEventArgs<double> e)
        {
            if (ProbText != null) ProbText.Text = e.NewValue.ToString("0") + "%";
        }

        private async void OnBucketToggle(object sender, RoutedEventArgs e)
        {
            if (_loading || _busy) return;
            if (sender is CheckBox box && box.DataContext is ChatBucketRow row)
            {
                if (box.IsChecked == true) _off.Remove(row.Id); else if (!_off.Contains(row.Id)) _off.Add(row.Id);
                await SaveAsync(null);
            }
        }

        private async void OnRefresh(object sender, RoutedEventArgs e) => await RefreshAsync();

        private async void OnSave(object sender, RoutedEventArgs e) => await SaveAsync(null);

        private async void OnSaveModel(object sender, RoutedEventArgs e)
        {
            var model = new Dictionary<string, object>
            {
                ["enabled"] = ModelEnabledBox.IsChecked == true,
                ["cmd"] = ModelCmdBox.Text.Trim(),
                ["modelPath"] = ModelPathBox.Text.Trim(),
                ["maxTokens"] = ParseInt(ModelTokensBox.Text, 64),
            };
            await SaveAsync(model);
        }

        private async void OnLocalTest(object sender, RoutedEventArgs e) => await LocalTestAsync(false);

        private async void OnLocalTestSend(object sender, RoutedEventArgs e) => await LocalTestAsync(true);

        private void OnLocalTestCopy(object sender, RoutedEventArgs e)
        {
            if (!string.IsNullOrEmpty(LocalTestOutput.Text)) Clipboard.SetText(LocalTestOutput.Text);
        }

        private async Task LocalTestAsync(bool send)
        {
            if (string.IsNullOrWhiteSpace(LocalTestInput.Text)) { LocalTestState.Text = "先填「对方说」"; return; }
            BtnLocalTest.IsEnabled = false;
            BtnLocalTestSend.IsEnabled = false;
            LocalTestState.Text = "生成中…（0.5B 模型一般 3~10 秒）";
            try
            {
                var payload = new Dictionary<string, object>
                {
                    ["text"] = LocalTestInput.Text.Trim(),
                    ["instruction"] = LocalTestInstruction.Text.Trim(),
                    ["send"] = send,
                    ["chat"] = "文件传输助手",
                    ["timeoutMs"] = 120000,
                };
                var r = await Api.Post(_sup.Url, "/api/yxn/chat/local-test", JsonSerializer.Serialize(payload));
                if (!r.Ok)
                {
                    LocalTestState.Text = "失败：" + (string.IsNullOrEmpty(r.Error) ? "内核没响应" : r.Error);
                    return;
                }
                var root = r.Root;
                var ok = root.TryGetProperty("ok", out var okv) && okv.ValueKind == JsonValueKind.True;
                var text = root.TryGetProperty("text", out var t) ? t.GetString() ?? "" : "";
                var ms = root.TryGetProperty("ms", out var m) ? m.GetDouble() : 0;
                var error = root.TryGetProperty("error", out var er) ? er.GetString() ?? "" : "";
                if (!ok) { LocalTestState.Text = "失败：" + error; LocalTestOutput.Text = ""; return; }
                LocalTestOutput.Text = text;
                var sent = root.TryGetProperty("job", out var j) && j.ValueKind == JsonValueKind.Object;
                LocalTestState.Text = (sent ? "已交给微信发送 · " : "") + Math.Round(ms / 1000, 1) + "s";
            }
            catch (Exception ex)
            {
                LocalTestState.Text = "出错：" + ex.Message;
            }
            finally
            {
                BtnLocalTest.IsEnabled = true;
                BtnLocalTestSend.IsEnabled = true;
            }
        }

        private async Task SaveAsync(Dictionary<string, object> model)
        {
            if (_busy) return;
            _busy = true;
            BtnSave.IsEnabled = false;
            BtnSaveModel.IsEnabled = false;
            try
            {
                var config = new Dictionary<string, object>
                {
                    ["mode"] = _mode,
                    ["probability"] = Math.Round(ProbSlider.Value / 100.0, 2),
                    ["readDelay"] = new Dictionary<string, object>
                    {
                        ["min"] = ParseInt(DelayMinBox.Text, 3),
                        ["max"] = ParseInt(DelayMaxBox.Text, 30),
                    },
                    ["typingMsPerChar"] = ParseInt(TypingBox.Text, 120),
                    ["maxDelaySec"] = ParseInt(MaxDelayBox.Text, 45),
                    ["minFreeRamMB"] = ParseInt(RamBox.Text, 1024),
                    ["bucketsOff"] = _off.ToArray(),
                };
                var payload = new Dictionary<string, object> { ["config"] = config };
                if (model != null) payload["localModel"] = model;
                var r = await Api.Post(_sup.Url, "/api/yxn/chat/config", JsonSerializer.Serialize(payload));
                if (!r.Ok)
                {
                    SaveText.Text = "保存失败：" + (string.IsNullOrEmpty(r.Error) ? "内核没响应" : r.Error);
                    return;
                }
                SaveText.Text = "已保存 " + DateTime.Now.ToString("HH:mm:ss");
            }
            finally
            {
                BtnSave.IsEnabled = true;
                BtnSaveModel.IsEnabled = true;
                _busy = false;
            }
        }

        private static string Str(JsonElement e, string name, string d)
            => e.ValueKind == JsonValueKind.Object && e.TryGetProperty(name, out var v) && v.ValueKind == JsonValueKind.String ? v.GetString() : d;

        private static string Num(JsonElement e, string name, int d)
            => e.ValueKind == JsonValueKind.Object && e.TryGetProperty(name, out var v)
                ? (v.ValueKind == JsonValueKind.Number ? v.GetDouble().ToString("0.##", CultureInfo.InvariantCulture) : d.ToString())
                : d.ToString();

        private static int ParseInt(string s, int d) => int.TryParse(s?.Trim(), out var v) ? v : d;
    }
}
