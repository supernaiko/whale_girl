using System;
using System.Globalization;
using System.IO;
using System.Linq;
using System.Text.Json;
using System.Threading.Tasks;
using System.Windows;
using System.Windows.Controls;

namespace WhaleLauncher.Views
{
    public partial class CostPage : UserControl
    {
        private readonly RuntimeSupervisor _sup;
        private Pricing _pricing = Pricing.FromJson(default);
        private SessionUsage _codexUsage;
        private int _days = 1;
        private bool _loading;

        internal CostPage(RuntimeSupervisor sup)
        {
            _sup = sup;
            InitializeComponent();
            Loaded += async (_, _) => await RefreshAsync();
        }

        private async void OnRefresh(object sender, RoutedEventArgs e) => await RefreshAsync();

        private void OnCodexBandChanged(object sender, RoutedEventArgs e) => DisplayCodexCost();

        private async void OnRangeChanged(object sender, RoutedEventArgs e)
        {
            if (sender is RadioButton { Tag: string tag } && int.TryParse(tag, out var days) && days != _days)
            {
                _days = days;
                await RefreshAsync();
            }
        }

        internal async Task RefreshAsync()
        {
            if (_loading) return;
            _loading = true;
            RefreshButton.IsEnabled = RangeButtons.IsEnabled = false;
            DisplayWhale(null, "正在读取用量…");
            DisplayCodex(null);
            try
            {
                var days = _days;
                var today = DateTime.Today;
                var profile = Environment.GetEnvironmentVariable("USERPROFILE");
                if (string.IsNullOrWhiteSpace(profile)) profile = Environment.GetFolderPath(Environment.SpecialFolder.UserProfile);
                var root = Path.Combine(profile, ".codex", "sessions");
                var sessionsTask = Task.Run(() => ReadSessions(root, today.AddDays(1 - days), today.AddDays(1)));
                var usage = await Api.Get(_sup.Url, "/api/cost/usage?days=" + days, timeoutSeconds: 3);
                var total = usage.Prop("total");
                var hasUsage = usage.Ok && total.ValueKind == JsonValueKind.Object;
                DisplayWhale(hasUsage ? usage : null, usage.StatusCode == 404
                    ? "当前运行的内核尚未提供花销统计。"
                    : "暂时无法读取内核用量。" + (string.IsNullOrEmpty(usage.Error) ? "" : " " + usage.Error));
                var pricing = usage.Prop("pricing");
                _pricing = Get(pricing, "models").ValueKind == JsonValueKind.Object
                    ? Pricing.FromJson(pricing) : ReadLocalPricing(_sup.DataDir);
                DisplayPricing();
                DisplayCodex(await sessionsTask);
            }
            finally
            {
                RefreshButton.IsEnabled = RangeButtons.IsEnabled = true;
                _loading = false;
            }
        }

        private void DisplayWhale(ApiResult usage, string status)
        {
            var total = new ApiResult { Root = usage?.Prop("total") ?? default };
            var requests = total.Long("requests");
            var prompt = total.Long("prompt");
            var cached = total.Long("cached");
            var rows = usage?.Prop("byDay") ?? default;
            var peak = usage?.Prop("peak") ?? default;
            var offPeak = usage?.Prop("offPeak") ?? default;
            WhalePeakCost.Text = "高峰 " + BandCost(peak);
            WhaleOffPeakCost.Text = "空闲 " + BandCost(offPeak);
            WhaleRequests.Text = Count(usage == null ? null : requests);
            WhalePrompt.Text = Count(usage == null ? null : prompt);
            WhaleCached.Text = Count(usage == null ? null : cached);
            WhaleCompletion.Text = Count(usage == null ? null : total.Long("completion"));
            WhaleHitRate.Text = prompt > 0 ? ((double)cached / prompt).ToString("P1", CultureInfo.InvariantCulture) : "—";
            DailyUsage.ItemsSource = rows.ValueKind == JsonValueKind.Array
                ? rows.EnumerateArray().Reverse().Select(row => new
                {
                    Date = new ApiResult { Root = row }.Str("date"),
                    Requests = Count(Counter(row, "requests")),
                    Cost = Money(Number(row, "costCny")),
                }).ToArray()
                : null;
            SetStatus(WhaleStatus, usage == null ? status : peak.ValueKind == JsonValueKind.Undefined
                ? "当前内核尚未提供峰谷明细。" : requests == 0 ? "所选时段暂无用量记录。" : "");
        }

        private void DisplayPricing()
        {
            WhaleFlashRates.Text = "Flash 高峰单价（命中 / 未命中 / 输出，每百万 token） " + _pricing.Flash.Peak.Label;
            SetStatus(WhaleProRates, _pricing.Pro is ModelPricing pro ? "Pro 高峰单价 " + pro.Peak.Label : "");
            PricingNote.Text = $@"北京时间 {_pricing.OffPeakStart}–{_pricing.OffPeakEnd} 为空闲，其余为高峰。单价可在 data\pricing.json 修改。";
        }

        private void DisplayCodexCost()
        {
            var usage = _codexUsage;
            var rates = CodexOffPeakOption.IsChecked == true ? _pricing.Flash.OffPeak : _pricing.Flash.Peak;
            CodexCost.Text = usage == null || (usage.Sessions == 0 && usage.Skipped != 0)
                ? "—" : Money(rates.Cost(usage.Prompt, usage.Cached, usage.Output));
        }

        private void DisplayCodex(SessionUsage usage)
        {
            _codexUsage = usage;
            DisplayCodexCost();
            CodexSessions.Text = Count(usage?.Sessions);
            CodexPrompt.Text = Count(usage?.Prompt);
            CodexCached.Text = Count(usage?.Cached);
            CodexCompletion.Text = Count(usage?.Output);
            CodexReasoning.Text = Count(usage?.Reasoning);
            var status = usage == null ? "正在扫描会话…" : "";
            if (usage?.Skipped > 0) status = "部分 Codex 会话无法读取，金额仅包含已读取的会话。";
            else if (usage?.Sessions == 0) status = "所选时段暂无带用量记录的会话。";
            SetStatus(CodexStatus, status);
        }

        private static void SetStatus(TextBlock block, string message)
        {
            block.Text = message;
            block.Visibility = message.Length == 0 ? Visibility.Collapsed : Visibility.Visible;
        }

        private static string Count(long? value) => value?.ToString("N0", CultureInfo.InvariantCulture) ?? "—";

        private static string Money(double value) => "¥" + value.ToString("#,0.0000####", CultureInfo.InvariantCulture);

        private static string BandCost(JsonElement band)
            => band.ValueKind == JsonValueKind.Object ? Money(Number(band, "costCny")) : "—";

        private static SessionUsage ReadSessions(string root, DateTime start, DateTime end)
        {
            var result = new SessionUsage();
            var options = new EnumerationOptions
            {
                RecurseSubdirectories = true,
                AttributesToSkip = FileAttributes.ReparsePoint,
                IgnoreInaccessible = false,
            };
            try
            {
                foreach (var file in new DirectoryInfo(root).EnumerateFiles("*.jsonl", options))
                {
                    try
                    {
                        var modified = file.LastWriteTime;
                        if (modified < start || modified >= end) continue;
                        if (ReadSession(file.FullName) is not TokenUsage usage) continue;
                        result.Sessions++;
                        result.Prompt += usage.Prompt;
                        result.Cached += usage.Cached;
                        result.Output += usage.Output;
                        result.Reasoning += usage.Reasoning;
                    }
                    catch (IOException) { result.Skipped++; }
                    catch (UnauthorizedAccessException) { result.Skipped++; }
                }
            }
            catch (DirectoryNotFoundException) when (!Directory.Exists(root)) { /* 还未创建会话目录。 */ }
            catch (IOException) { result.Skipped++; }
            catch (UnauthorizedAccessException) { result.Skipped++; }
            return result;
        }

        private static TokenUsage? ReadSession(string path)
        {
            using var stream = new FileStream(path, FileMode.Open, FileAccess.Read, FileShare.ReadWrite | FileShare.Delete);
            using var reader = new StreamReader(stream);
            TokenUsage? latest = null;
            while (reader.ReadLine() is string line)
            {
                // 会话文件还含长篇正文，只解析可能带累计用量的行。
                if (!line.Contains("\"total_token_usage\"", StringComparison.Ordinal)) continue;
                try
                {
                    using var json = JsonDocument.Parse(line);
                    var entry = json.RootElement;
                    var payload = Get(entry, "payload");
                    if (!IsType(entry, "event_msg") || !IsType(payload, "token_count")) continue;
                    var total = Get(Get(payload, "info"), "total_token_usage");
                    if (Counter(total, "input_tokens") is not long input || Counter(total, "output_tokens") is not long output)
                        continue;
                    latest = new TokenUsage(input, Math.Min(input, Counter(total, "cached_input_tokens") ?? 0),
                        output, Counter(total, "reasoning_output_tokens") ?? 0);
                }
                catch (JsonException) { /* 活跃会话的最后一行可能还没写完。 */ }
            }
            return latest;
        }

        private static JsonElement Get(JsonElement obj, string key)
            => obj.ValueKind == JsonValueKind.Object && obj.TryGetProperty(key, out var value) ? value : default;

        private static bool IsType(JsonElement obj, string type)
            => Get(obj, "type") is { ValueKind: JsonValueKind.String } field && field.ValueEquals(type);

        private static long? Counter(JsonElement obj, string key)
            => Get(obj, key) is { ValueKind: JsonValueKind.Number } field && field.TryGetInt64(out var value) && value >= 0
                ? value : null;

        private static double Number(JsonElement obj, string key, double fallback = 0)
            => Get(obj, key) is { ValueKind: JsonValueKind.Number } field && field.TryGetDouble(out var value)
                && double.IsFinite(value) && value >= 0 ? value : fallback;

        private static Pricing ReadLocalPricing(string dataDir)
        {
            try
            {
                using var doc = JsonDocument.Parse(File.ReadAllText(Path.Combine(dataDir, "pricing.json")));
                return Pricing.FromJson(doc.RootElement);
            }
            catch (IOException) { }
            catch (UnauthorizedAccessException) { }
            catch (JsonException) { }
            return Pricing.FromJson(default);
        }

        private readonly record struct TokenUsage(long Prompt, long Cached, long Output, long Reasoning);

        private sealed class SessionUsage
        {
            public long Sessions;
            public long Prompt;
            public long Cached;
            public long Output;
            public long Reasoning;
            public int Skipped;
        }

        private readonly record struct Pricing(ModelPricing Flash, ModelPricing? Pro, string OffPeakStart, string OffPeakEnd)
        {
            public static Pricing FromJson(JsonElement root)
            {
                const string defaultStart = "00:30";
                const string defaultEnd = "08:30";
                var models = Get(root, "models");
                var flash = Get(models, "flash");
                var pro = Get(models, "pro");
                var window = Get(root, "offPeakWindow");
                var start = ReadClock(window, "start", defaultStart);
                var end = ReadClock(window, "end", defaultEnd);
                if (start == end) (start, end) = (defaultStart, defaultEnd);
                return new Pricing(
                    new ModelPricing(Rates.FromJson(Get(flash, "peak"), new Rates(0.04, 2, 8)),
                        Rates.FromJson(Get(flash, "offPeak"), new Rates(0.02, 1, 4))),
                    pro.ValueKind == JsonValueKind.Object
                        ? new ModelPricing(Rates.FromJson(Get(pro, "peak"), new Rates(0.20, 8, 32)),
                            Rates.FromJson(Get(pro, "offPeak"), new Rates(0.10, 4, 16))) : null,
                    start, end);
            }

            private static string ReadClock(JsonElement window, string key, string fallback)
                => Get(window, key) is { ValueKind: JsonValueKind.String } field
                    && TimeOnly.TryParseExact(field.GetString(), "HH:mm", CultureInfo.InvariantCulture, DateTimeStyles.None, out var time)
                    ? time.ToString("HH:mm", CultureInfo.InvariantCulture) : fallback;
        }

        private readonly record struct ModelPricing(Rates Peak, Rates OffPeak);

        private readonly record struct Rates(double CacheHit, double CacheMiss, double Output)
        {
            public static Rates FromJson(JsonElement band, Rates fallback)
                => new Rates(Number(band, "cacheHitPerM", fallback.CacheHit),
                    Number(band, "cacheMissPerM", fallback.CacheMiss), Number(band, "outputPerM", fallback.Output));

            public string Label => $"{UnitPrice(CacheHit)} / {UnitPrice(CacheMiss)} / {UnitPrice(Output)}";

            private static string UnitPrice(double value) => "¥" + value.ToString("0.00######", CultureInfo.InvariantCulture);

            // reasoning_output_tokens 包含在 output_tokens 里，和 DeepSeek 的输出计费口径一致。
            public double Cost(long prompt, long cached, long output)
                => (cached * CacheHit + (prompt - cached) * CacheMiss + output * Output) / 1_000_000;
        }
    }
}
