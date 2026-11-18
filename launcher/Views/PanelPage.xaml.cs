using System;
using System.Collections.Generic;
using System.Globalization;
using System.Linq;
using System.Text.Json;
using System.Threading.Tasks;
using System.Windows;
using System.Windows.Controls;
using System.Windows.Input;
using System.Windows.Media;
using System.Windows.Shapes;
using System.Windows.Threading;

namespace WhaleLauncher.Views
{
    /// <summary>数据面板的概览汇总与 30 秒自动刷新。</summary>
    public partial class PanelPage : UserControl, IRefreshable
    {
        private const int InsightsDays = 7;
        private readonly record struct TrendPoint(long X, double First, double Second = 0);
        private sealed record ChatRow(string Name, string Messages, string Tokens, string Cost, double Share, string ShareLabel)
        {
            public string Details => $"{Name}\n消息数 {Messages} · token {Tokens} · 花费 {Cost} · 占比 {ShareLabel}";
        }

        private readonly RuntimeSupervisor _sup;
        private readonly DispatcherTimer _timer;
        private readonly List<(long t, double v, double e)> _history = new List<(long, double, double)>();
        private readonly List<(string date, double cost)> _costDaily = new List<(string, double)>();
        private readonly List<(string date, double messages)> _dailyMessages = new List<(string, double)>();
        private TrendPoint[] _memoryTrend = Array.Empty<TrendPoint>();
        private TrendPoint[] _chatTrend = Array.Empty<TrendPoint>();
        private ChatRow[] _chatRows = Array.Empty<ChatRow>();
        private DateTime _trendStartDate;
        private string _trendStart = "";
        private string _trendEnd = "";
        private int _costDays = 7;
        private int _costLoadId;
        private bool _busy;

        public PanelPage(RuntimeSupervisor sup)
        {
            InitializeComponent();
            _sup = sup;
            TabMood.Content = new MoodPage(sup);
            TabCost.Content = new CostPage(sup);
            TabStats.Content = new StatsPage(sup);
            _timer = new DispatcherTimer { Interval = TimeSpan.FromSeconds(30) };
            _timer.Tick += async (_, __) => await RefreshAsync();
            Loaded += async (_, __) => { _timer.Start(); await RefreshAsync(); };
            Unloaded += (_, __) => _timer.Stop();
            HistoryCanvas.SizeChanged += (_, __) => DrawHistory();
            CostCanvas.SizeChanged += (_, __) => DrawCost();
            StatsCanvas.SizeChanged += (_, __) => DrawStats();
            MemoryCanvas.SizeChanged += (_, __) => DrawDailyTrend(MemoryCanvas, _memoryTrend);
            ChatTrendCanvas.SizeChanged += (_, __) => DrawDailyTrend(ChatTrendCanvas, _chatTrend, dual: true);
        }

        private async void OnRefreshClick(object sender, RoutedEventArgs e)
        {
            BtnRefresh.IsEnabled = false;
            try { await RefreshAsync(); }
            finally { BtnRefresh.IsEnabled = true; }
        }

        private async void OnCostRange(object sender, RoutedEventArgs e)
        {
            if (sender is Button b && int.TryParse(b.Tag as string, out var days)) _costDays = days;
            await LoadCostAsync();
        }

        private void OnChatListMouseWheel(object sender, MouseWheelEventArgs e)
        {
            var scroll = (ScrollViewer)sender;
            var canScroll = e.Delta > 0 ? scroll.VerticalOffset > 0 : scroll.VerticalOffset < scroll.ScrollableHeight;
            if (canScroll) return;

            // 列表滚到边缘时，滚轮继续移动概览页。
            e.Handled = true;
            OverviewScroll.RaiseEvent(new MouseWheelEventArgs(e.MouseDevice, e.Timestamp, e.Delta) { RoutedEvent = MouseWheelEvent });
        }

        public async Task RefreshAsync()
        {
            if (_busy) return;
            _busy = true;
            try
            {
                await Task.WhenAll(LoadMoodAsync(), LoadStatsAsync(), LoadCostAsync(), LoadInsightsAsync());
                UpdatedText.Text = "更新于 " + DateTime.Now.ToString("HH:mm:ss", CultureInfo.InvariantCulture);
            }
            finally { _busy = false; }
        }

        private async Task LoadInsightsAsync()
        {
            var result = await Api.Get(_sup.Url, $"/api/insights/series?days={InsightsDays}&bucket=day");
            if (!result.Ok || LocalTime(result.Root, "generatedAt") is not { } generated)
            {
                MemoryHint.Text = "暂时无法读取记忆记录";
                ChatTrendHint.Text = HeatmapHint.Text = "暂时无法读取聊天记录";
                ExtremesHint.Text = "暂时无法读取心情记录";
                BondHint.Text = "暂时无法读取好感记录";
                _memoryTrend = _chatTrend = Array.Empty<TrendPoint>();
                MemoryCanvas.Visibility = ChatTrendCanvas.Visibility = ChatLegend.Visibility = Visibility.Collapsed;
                HeatmapCanvas.Visibility = ExtremeRows.Visibility = BondLegend.Visibility = Visibility.Collapsed;
                BondRows.Children.Clear();
                return;
            }

            var start = generated.Date.AddDays(1 - InsightsDays);
            _trendStartDate = start;
            _trendStart = start.ToString("M/d", CultureInfo.InvariantCulture);
            _trendEnd = generated.ToString("M/d", CultureInfo.InvariantCulture);

            var memory = result.Prop("memory");
            var total = Num(Rows(memory).LastOrDefault(), "total");
            MemoryHint.Text = $"近 {InsightsDays} 天每日新增 · 累计 {total:0} 张事件卡";
            if (total == 0) MemoryHint.Text += " · 还没有事件卡";
            _memoryTrend = total > 0 ? ReadDailyTrend(memory, start, "added") : Array.Empty<TrendPoint>();
            MemoryCanvas.Visibility = total > 0 ? Visibility.Visible : Visibility.Collapsed;
            DrawDailyTrend(MemoryCanvas, _memoryTrend);

            _chatTrend = ReadDailyTrend(result.Prop("chat"), start, "messages", "mine");
            var hasChat = _chatTrend.Any(p => p.First > 0);
            ChatTrendHint.Text = hasChat ? $"近 {InsightsDays} 天 · 按天统计" : $"近 {InsightsDays} 天还没有聊天记录";
            ChatTrendCanvas.Visibility = ChatLegend.Visibility = hasChat ? Visibility.Visible : Visibility.Collapsed;
            DrawDailyTrend(ChatTrendCanvas, _chatTrend, dual: true);

            DrawHeatmap(result.Prop("heatmap"));
            ShowExtremes(result.Prop("extremes"));
            ShowBonds(result.Prop("bond"));
        }

        private static TrendPoint[] ReadDailyTrend(JsonElement series, DateTime start, string first, string second = null)
        {
            // 只有发生过活动的日期才会出现在接口里，按日历补零才能保留真实间隔。
            var points = new TrendPoint[InsightsDays];
            for (var i = 0; i < points.Length; i++) points[i] = new TrendPoint(i, 0);
            foreach (var row in Rows(series))
            {
                if (LocalTime(row, "t") is not { } time) continue;
                var day = (time.Date - start).Days;
                if (day >= 0 && day < points.Length)
                    points[day] = new TrendPoint(day, Num(row, first), second == null ? 0 : Num(row, second));
            }
            return points;
        }

        private void DrawDailyTrend(Canvas canvas, TrendPoint[] points, bool dual = false,
            string firstName = "新增", string secondName = "她回复")
        {
            if (points.Length == 0 || canvas.Visibility != Visibility.Visible) return;
            var max = Math.Max(1, points.Max(p => Math.Max(p.First, p.Second)));
            DrawTrend(canvas, points, max, _trendStart, _trendEnd, dual, firstName, secondName);
        }

        private void DrawHeatmap(JsonElement heatmap)
        {
            var max = Num(heatmap, "max");
            var rows = Rows(Property(heatmap, "rows")).ToArray();
            HeatmapHint.Text = max > 0 ? $"近 {InsightsDays} 天 · 每个时段的消息数" : $"近 {InsightsDays} 天还没有聊天记录";
            HeatmapCanvas.Visibility = Visibility.Visible;
            HeatmapCanvas.Children.Clear();

            const int gridLeft = 40;
            const int gridTop = 18;
            const int cellSize = 10;
            const int step = cellSize + 2;
            var weekdays = new[] { "周一", "周二", "周三", "周四", "周五", "周六", "周日" };
            var accent = (Brush)FindResource("Accent");
            var surface = (Brush)FindResource("Surface3");
            foreach (var hour in new[] { 0, 6, 12, 18, 23 })
                AddChartLabel(HeatmapCanvas, hour.ToString("00", CultureInfo.InvariantCulture),
                    gridLeft + hour * step + cellSize / 2.0, 0, align: 0.5);

            for (var day = 0; day < weekdays.Length; day++)
            {
                var top = gridTop + day * step;
                AddChartLabel(HeatmapCanvas, weekdays[day], 0, top - 2);
                var counts = day < rows.Length ? Rows(rows[day]).ToArray() : Array.Empty<JsonElement>();
                for (var hour = 0; hour < 24; hour++)
                {
                    var count = hour < counts.Length && counts[hour].ValueKind == JsonValueKind.Number
                        && counts[hour].TryGetDouble(out var value) ? value : 0;
                    var active = count > 0 && max > 0;
                    var cell = new Rectangle
                    {
                        Width = cellSize, Height = cellSize, Fill = active ? accent : surface,
                        Opacity = active ? 0.2 + 0.8 * Math.Min(count / max, 1) : 1,
                    };
                    cell.ToolTip = $"{weekdays[day]} {hour:00}:00 · {count:0} 条";
                    ToolTipService.SetInitialShowDelay(cell, 0);
                    Canvas.SetLeft(cell, gridLeft + hour * step);
                    Canvas.SetTop(cell, top);
                    HeatmapCanvas.Children.Add(cell);
                }
            }
        }

        private void ShowExtremes(JsonElement extremes)
        {
            string FormatExtreme(string label, JsonElement point)
            {
                if (LocalTime(point, "t") is not { } time) return null;
                var reason = Str(point, "why");
                if (string.IsNullOrWhiteSpace(reason)) reason = "暂无相关事件";
                return $"{label} · {Num(point, "v"):0.#} · {time:HH:mm} · {reason}";
            }

            var high = FormatExtreme("最高", Property(extremes, "high"));
            var low = FormatExtreme("最低", Property(extremes, "low"));
            var hasExtremes = high != null || low != null;
            ExtremesHint.Text = hasExtremes ? "今天的最高与最低心情" : "今天还没有心情记录";
            ExtremeRows.Visibility = hasExtremes ? Visibility.Visible : Visibility.Collapsed;
            MoodHigh.Text = high ?? "最高 · 暂无记录";
            MoodLow.Text = low ?? "最低 · 暂无记录";
        }

        private void ShowBonds(JsonElement bond)
        {
            BondRows.Children.Clear();
            var people = Rows(Property(bond, "people")).Take(5).ToArray();
            var hasHistory = false;
            foreach (var person in people)
            {
                var name = Str(person, "name");
                BondRows.Children.Add(new TextBlock
                {
                    Text = string.IsNullOrWhiteSpace(name) ? "未命名联系人" : name,
                    Style = (Style)FindResource("Label"), Margin = new Thickness(0, 12, 0, 0),
                    TextTrimming = TextTrimming.CharacterEllipsis,
                });

                var points = new List<TrendPoint>();
                foreach (var row in Rows(Property(person, "series")))
                {
                    if (LocalTime(row, "t") is { } time)
                        points.Add(new TrendPoint(time.ToUnixTimeMilliseconds(), Num(row, "closeness"), Num(row, "trust")));
                }
                // 接口总会附上当前值，至少还有一个实测点才有历史曲线。
                if (points.Count < 2)
                {
                    BondRows.Children.Add(new TextBlock { Text = "还没有好感记录", Style = (Style)FindResource("Small") });
                    continue;
                }

                hasHistory = true;
                var chart = new Canvas { Height = 84, Margin = new Thickness(0, 6, 0, 0), ClipToBounds = true };
                string TimeLabel(long t) => DateTimeOffset.FromUnixTimeMilliseconds(t).ToLocalTime()
                    .ToString("M/d HH:mm", CultureInfo.InvariantCulture);
                var startLabel = TimeLabel(points[0].X);
                var endLabel = TimeLabel(points[^1].X);
                chart.SizeChanged += (_, __) => DrawTrend(chart, points, 100, startLabel, endLabel, dual: true);
                BondRows.Children.Add(chart);
            }

            BondHint.Text = people.Length > 0 ? $"近 {InsightsDays} 天 · 按亲近度显示前 {people.Length} 位" : "还没有好感记录";
            BondLegend.Visibility = hasHistory ? Visibility.Visible : Visibility.Collapsed;
        }

        private void DrawTrend(Canvas canvas, IReadOnlyList<TrendPoint> points, double max, string start, string end, bool dual,
            string firstName = "数值", string secondName = "第二条")
        {
            canvas.Children.Clear();
            var width = canvas.ActualWidth;
            var height = canvas.ActualHeight;
            if (width < 100 || height < 40) return;

            const double top = 8;
            var bottom = height - 21;
            var right = width - 4;
            var left = AddChartLabel(canvas, max.ToString("0", CultureInfo.InvariantCulture), 0, top - 6) + 8;
            AddChartLabel(canvas, "0", 0, bottom - 6);
            AddChartLabel(canvas, start, left, height - 14);
            AddChartLabel(canvas, end, right, height - 14, align: 1);
            var axis = (Brush)FindResource("Line");
            foreach (var y in new[] { top, bottom })
                canvas.Children.Add(new Line { X1 = left, X2 = right, Y1 = y, Y2 = y, Stroke = axis, StrokeThickness = 1 });

            var span = Math.Max(1, points[^1].X - points[0].X);
            void AddCurve(string brushKey, bool second, string seriesName)
            {
                var line = new Polyline
                {
                    Stroke = (Brush)FindResource(brushKey), StrokeThickness = 1.8, StrokeLineJoin = PenLineJoin.Round,
                };
                // 两组数值相同时，虚线仍能露出下方的实线。
                if (second) line.StrokeDashArray = new DoubleCollection { 3, 2 };
                foreach (var point in points)
                {
                    var x = left + (right - left) * (point.X - points[0].X) / span;
                    var y = bottom - (bottom - top) * Math.Clamp((second ? point.Second : point.First) / max, 0, 1);
                    line.Points.Add(new Point(x, y));
                    var value = second ? point.Second : point.First;
                    var day = _trendStartDate.AddDays((int)point.X).ToString("M/d", CultureInfo.InvariantCulture);
                    AddHover(canvas, x, y, $"{day} · {seriesName} {value:0.#}");
                }
                canvas.Children.Add(line);
            }

            AddCurve("Accent", second: false, seriesName: firstName);
            if (dual) AddCurve("Ok", second: true, seriesName: secondName);
        }

        /// <summary>折线图上挂一个不可见的命中点，鼠标悬停时显示 tooltip。</summary>
        private static void AddHover(Canvas canvas, double x, double y, string text)
        {
            var dot = new Ellipse
            {
                Width = 14, Height = 14,
                Fill = Brushes.Transparent,
                ToolTip = text,
                IsHitTestVisible = true,
            };
            ToolTipService.SetInitialShowDelay(dot, 0);
            ToolTipService.SetShowDuration(dot, 30000);
            Canvas.SetLeft(dot, x - 7);
            Canvas.SetTop(dot, y - 7);
            canvas.Children.Add(dot);
        }

        private double AddChartLabel(Canvas canvas, string text, double x, double y, double align = 0)
        {
            var label = new TextBlock { Text = text, FontSize = 10, Foreground = (Brush)FindResource("Muted") };
            label.Measure(new Size(double.PositiveInfinity, double.PositiveInfinity));
            Canvas.SetLeft(label, x - label.DesiredSize.Width * align);
            Canvas.SetTop(label, y);
            canvas.Children.Add(label);
            return label.DesiredSize.Width;
        }

        private static JsonElement Property(JsonElement el, string name)
            => el.ValueKind == JsonValueKind.Object && el.TryGetProperty(name, out var value) ? value : default;

        private static IEnumerable<JsonElement> Rows(JsonElement el)
            => el.ValueKind == JsonValueKind.Array ? el.EnumerateArray() : Array.Empty<JsonElement>();

        private static DateTimeOffset? LocalTime(JsonElement el, string name)
        {
            var timestamp = Property(el, name);
            if (timestamp.ValueKind != JsonValueKind.Number || !timestamp.TryGetInt64(out var ms)
                || ms < DateTimeOffset.MinValue.ToUnixTimeMilliseconds() || ms > DateTimeOffset.MaxValue.ToUnixTimeMilliseconds())
                return null;
            return DateTimeOffset.FromUnixTimeMilliseconds(ms).ToLocalTime();
        }

        // ---------- 心情 ----------
        private async Task LoadMoodAsync()
        {
            try
            {
                var r = await Api.Get(_sup.Url, "/api/yxn/status");
                if (!r.Ok || r.Root.ValueKind != JsonValueKind.Object)
                {
                    MoodLabel.Text = "读不到";
                    MoodWhy.Text = "内核未启动，或 yxn-bond 没加载。";
                    KpiMood.Text = "—";
                    KpiMoodSub.Text = "暂时无法读取心情";
                    return;
                }
                if (r.Root.TryGetProperty("mood", out var mood) && mood.ValueKind == JsonValueKind.Object)
                {
                    var v = Num(mood, "valence");
                    var e = Num(mood, "energy");
                    MoodLabel.Text = Str(mood, "label") ?? "—";
                    MoodWhy.Text = string.IsNullOrEmpty(Str(mood, "why")) ? "还没有明显起伏。" : "最近：" + Str(mood, "why");
                    ValenceBar.Value = Clamp(v);
                    EnergyBar.Value = Clamp(e);
                    ValenceText.Text = Math.Round(v).ToString(CultureInfo.InvariantCulture);
                    EnergyText.Text = Math.Round(e).ToString(CultureInfo.InvariantCulture);
                    KpiMood.Text = MoodLabel.Text;
                    KpiMoodSub.Text = MoodWhy.Text;
                }
                else
                {
                    KpiMood.Text = "—";
                    KpiMoodSub.Text = "暂无心情记录";
                }

                _history.Clear();
                if (r.Root.TryGetProperty("history", out var hist) && hist.ValueKind == JsonValueKind.Array)
                {
                    foreach (var p in hist.EnumerateArray())
                    {
                        if (p.ValueKind != JsonValueKind.Object) continue;
                        var t = p.TryGetProperty("t", out var pt) ? pt.GetInt64() : 0;
                        if (t > 0) _history.Add((t, Num(p, "v"), Num(p, "e")));
                    }
                }
                DrawHistory();
            }
            catch (Exception ex)
            {
                MoodWhy.Text = "读取失败：" + ex.Message;
                KpiMood.Text = "—";
                KpiMoodSub.Text = "暂时无法读取心情";
            }
        }

        private void DrawHistory()
        {
            HistoryCanvas.Children.Clear();
            var w = HistoryCanvas.ActualWidth;
            var h = HistoryCanvas.ActualHeight;
            if (w < 40 || h < 30) return;
            if (_history.Count < 2)
            {
                HistoryHint.Text = "每 5 分钟记一个点，攒一攒就有了";
                return;
            }
            HistoryHint.Text = _history.Count + " 个点";

            var minT = _history[0].t;
            var span = Math.Max(1, _history[_history.Count - 1].t - minT);
            const double pad = 6;
            var usable = h - pad * 2;
            var baseY = pad + usable * 0.5;
            HistoryCanvas.Children.Add(new Line
            {
                X1 = 0, X2 = w, Y1 = baseY, Y2 = baseY,
                Stroke = (Brush)FindResource("Surface3"), StrokeThickness = 1,
            });

            Polyline Line4(Func<(long t, double v, double e), double> pick, Brush brush, string seriesName)
            {
                var line = new Polyline { Stroke = brush, StrokeThickness = 1.6, StrokeLineJoin = PenLineJoin.Round };
                foreach (var p in _history)
                {
                    var px = (p.t - minT) / (double)span * w;
                    var py = pad + usable * (1 - Clamp(pick(p)) / 100.0);
                    line.Points.Add(new Point(px, py));
                    var at = DateTimeOffset.FromUnixTimeMilliseconds(p.t).ToLocalTime();
                    AddHover(HistoryCanvas, px, py, $"{at:HH:mm} · {seriesName} {Clamp(pick(p)):0}");
                }
                return line;
            }

            HistoryCanvas.Children.Add(Line4(p => p.v, (Brush)FindResource("Accent"), "心情"));
            HistoryCanvas.Children.Add(Line4(p => p.e, (Brush)FindResource("Ok"), "精力"));
            AddTimeLabels(HistoryCanvas, w, h, minT, minT + span);
        }

        // ---------- 花销 ----------
        private async Task LoadCostAsync()
        {
            var loadId = ++_costLoadId;
            var days = _costDays;
            var range = days == 1 ? "今日" : $"近 {days} 天";
            try
            {
                var r = await Api.Get(_sup.Url, "/api/cost/usage?days=" + days);
                // 切换时段时，新请求可能比自动刷新的旧请求先返回。
                if (loadId != _costLoadId) return;
                var root = r.Root;
                var today = Property(root, "today");
                var total = Property(root, "total");
                if (!r.Ok || total.ValueKind != JsonValueKind.Object)
                {
                    ShowCostUnavailable(range, "暂时无法读取花费");
                    return;
                }

                var todayRequests = CountText(NonNegativeNumber(today, "requests"));
                var totalRequests = CountText(NonNegativeNumber(total, "requests"));
                KpiToday.Text = todayRequests;
                KpiCost.Text = CostText(NonNegativeNumber(today, "costCny"));
                KpiCostSub.Text = $"{todayRequests} 次请求";
                CostTotal.Text = KpiCostRange.Text = CostText(NonNegativeNumber(total, "costCny"));
                KpiCostRangeSub.Text = $"{range} · {totalRequests} 次";
                CostHint.Text = $"{range} · {totalRequests} 次请求";

                var peak = root.TryGetProperty("peak", out var pk) ? Num(pk, "costCny") : 0;
                var off = root.TryGetProperty("offPeak", out var op) ? Num(op, "costCny") : 0;
                CostPeak.Text = $"高峰 ¥{peak:0.000} · 空闲 ¥{off:0.000}（空闲 00:30–08:30）";

                _costDaily.Clear();
                if (root.TryGetProperty("byDay", out var byDay) && byDay.ValueKind == JsonValueKind.Array)
                {
                    foreach (var d in byDay.EnumerateArray())
                    {
                        if (d.ValueKind != JsonValueKind.Object) continue;
                        var date = Str(d, "date") ?? "";
                        if (date.Length >= 10) date = date.Substring(5);
                        _costDaily.Add((date, Num(d, "costCny")));
                    }
                }
                CostCanvas.Visibility = Visibility.Visible;
                DrawCost();
            }
            catch (Exception ex)
            {
                if (loadId == _costLoadId) ShowCostUnavailable(range, "读取失败：" + ex.Message);
            }
        }

        private void ShowCostUnavailable(string range, string status)
        {
            KpiToday.Text = KpiCost.Text = KpiCostRange.Text = CostTotal.Text = CostPeak.Text = "—";
            KpiCostSub.Text = "DeepSeek 预估";
            KpiCostRangeSub.Text = range;
            CostHint.Text = status;
            CostCanvas.Visibility = Visibility.Collapsed;
        }

        private void DrawCost()
        {
            CostCanvas.Children.Clear();
            DrawBars(CostCanvas, _costDaily.ConvertAll(x => (x.date, x.cost)), "Accent", "今天还没有花费");
        }

        // ---------- 统计 ----------
        private async Task LoadStatsAsync()
        {
            try
            {
                var r = await Api.Get(_sup.Url, "/api/stats/overview?days=7");
                if (!r.Ok || r.Root.ValueKind != JsonValueKind.Object)
                {
                    ShowStatsUnavailable("暂时无法读取聊天统计");
                    return;
                }
                var root = r.Root;
                var kpi = root.TryGetProperty("kpi", out var k) ? k : default;
                var messages = NonNegativeNumber(kpi, "messages");
                var replies = Num(kpi, "replies");
                var activeDays = NonNegativeNumber(kpi, "activeDays");
                var avgLen = Num(kpi, "avgReplyLen");
                KpiWeek.Text = CountText(messages);
                KpiWeekSub.Text = $"她回复 {replies:0} 条";
                KpiWeekTokens.Text = CountText(NonNegativeNumber(kpi, "billedTokens"));
                KpiWeekTokensSub.Text = activeDays is { } days ? $"{days:0} 天有模型请求" : "输入与输出合计";
                StatsHint.Text = avgLen > 0 ? $"平均回复 {avgLen:0} 字 · 每日计费 token" : "每日计费 token";

                _dailyMessages.Clear();
                if (root.TryGetProperty("daily", out var daily) && daily.ValueKind == JsonValueKind.Array)
                {
                    foreach (var d in daily.EnumerateArray())
                    {
                        if (d.ValueKind != JsonValueKind.Object) continue;
                        var date = Str(d, "day") ?? Str(d, "date") ?? "";
                        if (date.Length >= 10) date = date.Substring(5);
                        _dailyMessages.Add((date, Num(d, "billedTokens")));
                    }
                }
                StatsCanvas.Visibility = Visibility.Visible;
                DrawStats();

                ShowChatDetails(r.Prop("chats"));
            }
            catch (Exception ex) { ShowStatsUnavailable("读取失败：" + ex.Message); }
        }

        private void ShowStatsUnavailable(string status)
        {
            KpiWeek.Text = KpiWeekTokens.Text = "—";
            KpiWeekSub.Text = "包含双方消息";
            KpiWeekTokensSub.Text = "输入与输出合计";
            StatsHint.Text = status;
            StatsCanvas.Visibility = Visibility.Collapsed;
            ShowChatDetails(default);
        }

        private void ShowChatDetails(JsonElement chats)
        {
            var rows = ReadChatRows(chats, out var useTokens);
            ChatDetailsHint.Text = chats.ValueKind != JsonValueKind.Array ? "暂时无法读取会话明细"
                : rows.Length == 0 ? "近 7 天暂无会话" : $"近 7 天 · {rows.Length} 个会话";
            ChatShareHeader.Text = useTokens ? "token 占比" : "消息占比";
            ChatDetailsRows.Visibility = rows.Length > 0 ? Visibility.Visible : Visibility.Collapsed;
            if (_chatRows.SequenceEqual(rows)) return;

            _chatRows = rows;
            ChatList.ItemsSource = rows;
        }

        private static ChatRow[] ReadChatRows(JsonElement chats, out bool useTokens)
        {
            var sessions = Rows(chats).Where(row => row.ValueKind == JsonValueKind.Object).Select(row =>
            {
                var name = Str(row, "name");
                if (string.IsNullOrWhiteSpace(name)) name = Str(row, "title");
                if (string.IsNullOrWhiteSpace(name)) name = "未命名会话";
                return (Name: name, Messages: NonNegativeNumber(row, "messages"),
                    Tokens: NonNegativeNumber(row, "billedTokens") ?? NonNegativeNumber(row, "tokens"),
                    Cost: NonNegativeNumber(row, "costCny") ?? NonNegativeNumber(row, "cost"));
            }).ToArray();

            // 只有每个会话都有 token 时才使用同一计量口径，避免把缺失的用量当成零。
            var tokenTotal = sessions.Sum(row => row.Tokens ?? 0);
            var byTokens = useTokens = tokenTotal > 0 && sessions.All(row => row.Tokens.HasValue);
            var total = byTokens ? tokenTotal : sessions.Sum(row => row.Messages ?? 0);
            return sessions.OrderByDescending(row => row.Messages).Select(row =>
            {
                var amount = byTokens ? row.Tokens : row.Messages;
                var share = total > 0 ? amount / total : null;
                return new ChatRow(row.Name, CountText(row.Messages), CountText(row.Tokens), CostText(row.Cost),
                    share ?? 0, share?.ToString("P1", CultureInfo.InvariantCulture) ?? "—");
            }).ToArray();
        }

        private void DrawStats()
        {
            StatsCanvas.Children.Clear();
            DrawBars(StatsCanvas, _dailyMessages, "Ok", "近 7 天还没有用量");
        }

        // ---------- 通用柱状图 ----------
        private void DrawBars(Canvas canvas, List<(string label, double value)> rows, string brushKey, string emptyText)
        {
            canvas.Children.Clear();
            var w = canvas.ActualWidth;
            var h = canvas.ActualHeight;
            if (w < 40 || h < 30) return;
            if (rows.Count == 0 || rows.TrueForAll(r => r.value <= 0))
            {
                var tip = new TextBlock { Text = emptyText, FontSize = 11, Foreground = (Brush)FindResource("Muted") };
                Canvas.SetLeft(tip, 0);
                Canvas.SetTop(tip, h / 2 - 8);
                canvas.Children.Add(tip);
                return;
            }

            var max = 0.0;
            foreach (var r in rows) max = Math.Max(max, r.value);
            max = Math.Max(max, 0.0001);
            var gap = 6.0;
            var barW = Math.Max(2, (w - gap * (rows.Count + 1)) / rows.Count);
            var brush = (Brush)FindResource(brushKey);
            for (var i = 0; i < rows.Count; i++)
            {
                var barH = Math.Max(2, (h - 18) * rows[i].value / max);
                var rect = new Rectangle
                {
                    Width = barW, Height = barH,
                    Fill = brush, RadiusX = 2, RadiusY = 2, Opacity = rows[i].value > 0 ? 0.85 : 0.25,
                };
                rect.ToolTip = $"{rows[i].label} · {rows[i].value:0.##}";
                ToolTipService.SetInitialShowDelay(rect, 0);
                Canvas.SetLeft(rect, gap + i * (barW + gap));
                Canvas.SetTop(rect, h - 14 - barH);
                canvas.Children.Add(rect);

                var label = new TextBlock { Text = rows[i].label, FontSize = 9, Foreground = (Brush)FindResource("Muted") };
                label.Measure(new Size(double.PositiveInfinity, double.PositiveInfinity));
                Canvas.SetLeft(label, gap + i * (barW + gap) + (barW - label.DesiredSize.Width) / 2);
                Canvas.SetTop(label, h - 12);
                canvas.Children.Add(label);
            }
        }

        private void AddTimeLabels(Canvas canvas, double w, double h, long minT, long maxT)
        {
            foreach (var (t, left) in new[] { (minT, true), (maxT, false) })
            {
                var label = new TextBlock
                {
                    Text = DateTimeOffset.FromUnixTimeMilliseconds(t).ToLocalTime().ToString("HH:mm", CultureInfo.InvariantCulture),
                    FontSize = 10,
                    Foreground = (Brush)FindResource("Muted"),
                };
                label.Measure(new Size(double.PositiveInfinity, double.PositiveInfinity));
                Canvas.SetLeft(label, left ? 0 : w - label.DesiredSize.Width);
                Canvas.SetTop(label, h - label.DesiredSize.Height);
                canvas.Children.Add(label);
            }
        }

        private static double Num(JsonElement el, string name)
        {
            if (el.ValueKind != JsonValueKind.Object || !el.TryGetProperty(name, out var v)) return 0;
            return v.ValueKind == JsonValueKind.Number && v.TryGetDouble(out var d) ? d : 0;
        }

        private static double? NonNegativeNumber(JsonElement el, string name)
        {
            var value = Property(el, name);
            return value.ValueKind == JsonValueKind.Number && value.TryGetDouble(out var number)
                && double.IsFinite(number) && number >= 0 ? number : null;
        }

        private static string CountText(double? value) => value?.ToString("N0", CultureInfo.CurrentCulture) ?? "—";

        private static string CostText(double? value) => value is { } cost
            ? "¥" + cost.ToString("0.000", CultureInfo.InvariantCulture) : "—";

        private static string Str(JsonElement el, string name)
        {
            if (el.ValueKind != JsonValueKind.Object || !el.TryGetProperty(name, out var v)) return null;
            return v.ValueKind == JsonValueKind.String ? v.GetString() : null;
        }

        private static double Clamp(double v) => Math.Max(0, Math.Min(100, v));
    }
}
