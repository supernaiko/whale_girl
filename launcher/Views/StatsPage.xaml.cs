using System;
using System.Collections.Generic;
using System.Globalization;
using System.Linq;
using System.Text.Json;
using System.Threading.Tasks;
using System.Windows;
using System.Windows.Controls;
using System.Windows.Shapes;
using System.Windows.Threading;

namespace WhaleLauncher.Views
{
    public partial class StatsPage : UserControl, IRefreshable
    {
        private static readonly string[] Weekdays = { "周一", "周二", "周三", "周四", "周五", "周六", "周日" };
        private static readonly string[] HeatBrushes = { "Surface3", "Idle", "Accent", "Accent", "Ok" };
        private static readonly TimeSpan BeijingOffset = TimeSpan.FromHours(8);
        private readonly RuntimeSupervisor _sup;
        private readonly DispatcherTimer _timer;
        private int _days = 7;
        private string _from = "";
        private string _to = "";
        private long _nextRefresh;
        private bool _refreshing;

        internal StatsPage(RuntimeSupervisor sup)
        {
            InitializeComponent();
            _sup = sup;
            _timer = new DispatcherTimer { Interval = TimeSpan.FromSeconds(30) };
            _timer.Tick += async (_, __) => await LoadOverviewAsync();
            Loaded += async (_, __) =>
            {
                _nextRefresh = 0;
                _timer.Start();
                await RefreshAsync();
            };
            Unloaded += (_, __) => _timer.Stop();
        }

        // 主窗也会轮询当前页，避免两秒一次重新扫描日志。
        public Task RefreshAsync() => !_timer.IsEnabled || Environment.TickCount64 < _nextRefresh
            ? Task.CompletedTask : LoadOverviewAsync();

        private async void OnRange(object sender, RoutedEventArgs e)
        {
            if (sender is not Button button || !int.TryParse(button.Tag as string, out var days) || days == _days) return;
            _days = days;
            _from = _to = "";
            foreach (var option in new[] { TodayButton, WeekButton, MonthButton, YearButton })
                option.SetResourceReference(StyleProperty, option == button ? "Primary" : "Ghost");

            UpdatedText.Text = "—";
            RequestsText.Text = TokensText.Text = CostText.Text = CacheText.Text = MessagesText.Text = ReplyLengthText.Text = "—";
            DailyChart.Children.Clear();
            Heatmap.Children.Clear();
            ChatsList.ItemsSource = null;
            ChatsEmpty.Visibility = Visibility.Collapsed;
            SetStatus("正在读取统计…");
            await LoadOverviewAsync();
        }

        private async void OnApplyRange(object sender, RoutedEventArgs e)
        {
            if (FromPicker.SelectedDate is not { } from || ToPicker.SelectedDate is not { } to) { SetStatus("先选起止日期"); return; }
            if (to < from) { SetStatus("结束日期不能早于开始"); return; }
            _from = from.ToString("yyyy-MM-dd", CultureInfo.InvariantCulture);
            _to = to.ToString("yyyy-MM-dd", CultureInfo.InvariantCulture);
            _days = Math.Min(366, (int)(to - from).TotalDays + 1);
            foreach (var option in new[] { TodayButton, WeekButton, MonthButton, YearButton })
                option.SetResourceReference(StyleProperty, "Ghost");
            UpdatedText.Text = "—";
            SetStatus("正在读取 " + _from + " ~ " + _to + " …");
            await LoadOverviewAsync();
        }

        private async void OnRefresh(object sender, RoutedEventArgs e) => await LoadOverviewAsync();

        private async Task LoadOverviewAsync()
        {
            if (_refreshing || !_timer.IsEnabled) return;
            _refreshing = true;
            BtnRefresh.IsEnabled = false;
            try
            {
                int days;
                do
                {
                    days = _days;
                    _nextRefresh = Environment.TickCount64 + (long)_timer.Interval.TotalMilliseconds;
                    _timer.Stop();
                    _timer.Start();
                    var path = _from.Length > 0 && _to.Length > 0
                        ? $"/api/stats/overview?from={_from}&to={_to}"
                        : $"/api/stats/overview?days={days}";
                    var response = await Api.Get(_sup.Url, path);
                    if (!_timer.IsEnabled || days != _days) continue;

                    var generatedAt = response.Long("generatedAt");
                    if (!response.Ok || generatedAt <= 0)
                    {
                        SetStatus(response.StatusCode == 404 ? "当前内核未提供统计接口。"
                            : string.IsNullOrEmpty(response.Error) ? "无法读取统计，请确认内核已启动。" : response.Error);
                        continue;
                    }

                    var generated = BeijingTime(generatedAt);
                    RenderKpis(response.Prop("kpi"));
                    RenderDaily(response.Prop("daily"), generated);
                    RenderHeatmap(response.Prop("heatmap"));
                    HeatTitle.Text = _from.Length > 0 ? _from + " ~ " + _to : $"最近 {_days} 天";
                    RenderChats(response.Prop("chats"));
                    UpdatedText.Text = $"更新于 {generated:MM-dd HH:mm:ss}";
                    SetStatus("");
                } while (_timer.IsEnabled && days != _days);
            }
            finally
            {
                BtnRefresh.IsEnabled = true;
                _refreshing = false;
            }
        }

        private void SetStatus(string text)
        {
            StatusText.Text = text;
            StatusText.Visibility = text.Length == 0 ? Visibility.Collapsed : Visibility.Visible;
        }

        private void RenderKpis(JsonElement kpi)
        {
            RequestsText.Text = Count(Number(kpi, "requests"));
            TokensText.Text = Count(Number(kpi, "billedTokens"));
            CostText.Text = Money(Number(kpi, "cost"));
            CacheText.Text = Percent(Number(kpi, "cacheHitRate"));
            MessagesText.Text = Count(Number(kpi, "messages"));
            ReplyLengthText.Text = Length(Number(kpi, "avgReplyLen"));
        }

        private static JsonElement SumMonth(Dictionary<string, JsonElement> byDay, DateTimeOffset month)
        {
            double tokens = 0, cost = 0, requests = 0;
            for (var d = 1; d <= DateTime.DaysInMonth(month.Year, month.Month); d++)
            {
                var key = new DateTime(month.Year, month.Month, d).ToString("yyyy-MM-dd", CultureInfo.InvariantCulture);
                if (!byDay.TryGetValue(key, out var row)) continue;
                tokens += Number(row, "billedTokens"); cost += Number(row, "cost"); requests += Number(row, "requests");
            }
            var obj = new Dictionary<string, object> { ["billedTokens"] = tokens, ["cost"] = cost, ["requests"] = requests };
            return JsonSerializer.SerializeToElement(obj);
        }

        private void RenderDaily(JsonElement daily, DateTimeOffset generated)
        {
            var byDay = Items(daily).ToDictionary(row => Text(row, "day"));
            var dailyMode = _days <= 31;
            var count = dailyMode ? _days : 12;
            var days = dailyMode
                ? Enumerable.Range(0, count).Select(i => generated.AddDays(i - count + 1)).ToArray()
                : Enumerable.Range(0, count).Select(i => generated.AddMonths(i - count + 1)).ToArray();
            var rows = dailyMode
                ? days.Select(day => byDay.GetValueOrDefault(day.ToString("yyyy-MM-dd", CultureInfo.InvariantCulture))).ToArray()
                : days.Select(month => SumMonth(byDay, month)).ToArray();
            var maxTokens = rows.Max(row => Number(row, "billedTokens"));
            var maxCost = rows.Max(row => Number(row, "cost"));

            DailyChart.Children.Clear();
            DailyChart.ColumnDefinitions.Clear();
            for (var i = 0; i < days.Length; i++)
            {
                DailyChart.ColumnDefinitions.Add(new ColumnDefinition());
                var pair = new Grid { Margin = new Thickness(2, 0, 2, 0) };
                pair.ColumnDefinitions.Add(new ColumnDefinition());
                pair.ColumnDefinitions.Add(new ColumnDefinition());
                pair.RowDefinitions.Add(new RowDefinition());
                pair.RowDefinitions.Add(new RowDefinition { Height = GridLength.Auto });

                var tokens = Number(rows[i], "billedTokens");
                var cost = Number(rows[i], "cost");
                var tokenLabel = tokens >= 100_000 ? (tokens / 10_000).ToString("0.##", CultureInfo.InvariantCulture) + "万" : Count(tokens);
                var costLabel = Money(cost);
                AddBar(pair, 0, tokens, maxTokens, "Accent", tokenLabel, Count(tokens) + " token");
                AddBar(pair, 1, cost, maxCost, "Ok", costLabel, costLabel);

                var date = new TextBlock
                {
                    Text = dailyMode ? days[i].ToString("MM-dd", CultureInfo.InvariantCulture) : days[i].ToString("M", CultureInfo.InvariantCulture) + "月",
                    HorizontalAlignment = HorizontalAlignment.Center,
                    Margin = new Thickness(0, 5, 0, 0),
                };
                date.SetResourceReference(StyleProperty, "Small");
                Grid.SetRow(date, 1);
                Grid.SetColumnSpan(date, 2);
                pair.Children.Add(date);
                Grid.SetColumn(pair, i);
                DailyChart.Children.Add(pair);
            }
        }

        private static void AddBar(Grid pair, int column, double value, double max, string brush, string label, string tooltip)
        {
            var stack = new StackPanel { VerticalAlignment = VerticalAlignment.Bottom, ToolTip = tooltip };
            var caption = new TextBlock
            {
                Text = label, FontSize = 10, TextAlignment = TextAlignment.Center,
                TextTrimming = TextTrimming.CharacterEllipsis, Margin = new Thickness(1, 0, 1, 3),
            };
            caption.SetResourceReference(TextBlock.ForegroundProperty, brush);
            var bar = new Rectangle { Width = 12, Height = value > 0 ? Math.Max(1, 78 * value / max) : 0, RadiusX = 2, RadiusY = 2 };
            bar.SetResourceReference(Shape.FillProperty, brush);
            stack.Children.Add(caption);
            stack.Children.Add(bar);
            Grid.SetColumn(stack, column);
            pair.Children.Add(stack);
        }

        private void RenderHeatmap(JsonElement heatmap)
        {
            var rows = Items(heatmap).Select(row => Items(row).Select(value => Number(value)).ToArray()).ToArray();
            var max = rows.SelectMany(row => row).DefaultIfEmpty().Max();
            Heatmap.Children.Clear();
            Heatmap.RowDefinitions.Clear();
            Heatmap.ColumnDefinitions.Clear();
            Heatmap.ColumnDefinitions.Add(new ColumnDefinition { Width = new GridLength(42) });
            Heatmap.RowDefinitions.Add(new RowDefinition { Height = GridLength.Auto });
            for (var hour = 0; hour < 24; hour++)
            {
                Heatmap.ColumnDefinitions.Add(new ColumnDefinition());
                if (hour % 3 == 0) AddHeatLabel(hour.ToString("00", CultureInfo.InvariantCulture), 0, hour + 1);
            }
            for (var day = 0; day < Weekdays.Length; day++)
            {
                Heatmap.RowDefinitions.Add(new RowDefinition { Height = GridLength.Auto });
                AddHeatLabel(Weekdays[day], day + 1, 0);
                for (var hour = 0; hour < 24; hour++)
                {
                    var count = day < rows.Length && hour < rows[day].Length ? rows[day][hour] : 0;
                    var level = count > 0 ? (int)Math.Ceiling(4 * count / max) : 0;
                    var cell = new Rectangle
                    {
                        Height = 14, RadiusX = 3, RadiusY = 3, Margin = new Thickness(1.5, 1.5, 1.5, 1.5),
                        Opacity = level == 2 ? 0.55 : 1, ToolTip = $"{Weekdays[day]} {hour} 点 · {Count(count)} 条",
                    };
                    cell.SetResourceReference(Shape.FillProperty, HeatBrushes[level]);
                    Grid.SetRow(cell, day + 1);
                    Grid.SetColumn(cell, hour + 1);
                    Heatmap.Children.Add(cell);
                }
            }
        }

        private void AddHeatLabel(string text, int row, int column)
        {
            var label = new TextBlock
            {
                Text = text, VerticalAlignment = VerticalAlignment.Center,
                HorizontalAlignment = column == 0 ? HorizontalAlignment.Left : HorizontalAlignment.Center,
            };
            label.SetResourceReference(StyleProperty, "Small");
            Grid.SetRow(label, row);
            Grid.SetColumn(label, column);
            Heatmap.Children.Add(label);
        }

        private void RenderChats(JsonElement chats)
        {
            var cards = Items(chats).OrderByDescending(row => Number(row, "lastAt")).Take(20).Select(row =>
            {
                var lastAt = (long)Number(row, "lastAt");
                return new
                {
                    Name = Text(row, "name"),
                    Messages = Count(Number(row, "messages")) + " 条",
                    Split = $"她 {Count(Number(row, "mine"))} · 对方 {Count(Number(row, "theirs"))}",
                    Average = "平均 " + Length(Number(row, "avgLen")) + " 字",
                    LastActive = lastAt > 0 ? $"最近 {BeijingTime(lastAt):MM-dd HH:mm}" : "—",
                };
            }).ToArray();
            ChatsList.ItemsSource = cards;
            ChatsEmpty.Visibility = cards.Length == 0 ? Visibility.Visible : Visibility.Collapsed;
        }

        private static DateTimeOffset BeijingTime(long at) => DateTimeOffset.FromUnixTimeMilliseconds(at).ToOffset(BeijingOffset);
        private static JsonElement[] Items(JsonElement element) => element.ValueKind == JsonValueKind.Array
            ? element.EnumerateArray().ToArray() : Array.Empty<JsonElement>();
        private static JsonElement Get(JsonElement element, string name) =>
            element.ValueKind == JsonValueKind.Object && element.TryGetProperty(name, out var value) ? value : default;
        private static string Text(JsonElement element, string name) =>
            Get(element, name) is { ValueKind: JsonValueKind.String } value ? value.GetString() : "";
        private static double Number(JsonElement element, string name) => Number(Get(element, name));
        private static double Number(JsonElement element) =>
            element.ValueKind == JsonValueKind.Number && element.TryGetDouble(out var value) && double.IsFinite(value) ? value : 0;
        private static string Count(double value) => value.ToString("N0", CultureInfo.InvariantCulture);
        private static string Length(double value) => value.ToString("0.#", CultureInfo.InvariantCulture);
        private static string Money(double value) => "¥" + value.ToString(value > 0 && value < 0.01 ? "0.0000####" : "#,0.00####", CultureInfo.InvariantCulture);
        private static string Percent(double value) => (value * 100).ToString("0.#", CultureInfo.InvariantCulture) + "%";
    }
}
