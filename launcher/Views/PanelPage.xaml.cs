using System;
using System.Collections.Generic;
using System.Collections.ObjectModel;
using System.Globalization;
using System.Text.Json;
using System.Threading.Tasks;
using System.Windows;
using System.Windows.Controls;
using System.Windows.Media;
using System.Windows.Shapes;
using System.Windows.Threading;

namespace WhaleLauncher.Views
{
    public sealed class ChatRow
    {
        public string Name { get; set; } = "";
        public string Value { get; set; } = "";
    }

    /// <summary>
    /// 数据面板：心情 / 花销 / 聊天统计合成一屏，上下滚动，不再分页签。
    /// 数据来源：/api/yxn/status、/api/cost/usage、/api/stats/overview，30 秒自动刷新。
    /// </summary>
    public partial class PanelPage : UserControl, IRefreshable
    {
        private readonly RuntimeSupervisor _sup;
        private readonly ObservableCollection<ChatRow> _chats = new ObservableCollection<ChatRow>();
        private readonly DispatcherTimer _timer;
        private readonly List<(long t, double v, double e)> _history = new List<(long, double, double)>();
        private readonly List<(string date, double cost)> _costDaily = new List<(string, double)>();
        private readonly List<(string date, double messages)> _dailyMessages = new List<(string, double)>();
        private int _costDays = 7;
        private bool _busy;
        private double _todayRequests;

        public PanelPage(RuntimeSupervisor sup)
        {
            InitializeComponent();
            _sup = sup;
            ChatList.ItemsSource = _chats;
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

        public async Task RefreshAsync()
        {
            if (_busy) return;
            _busy = true;
            try
            {
                await Task.WhenAll(LoadMoodAsync(), LoadStatsAsync(), LoadCostAsync());
                UpdatedText.Text = "更新于 " + DateTime.Now.ToString("HH:mm:ss", CultureInfo.InvariantCulture);
            }
            finally { _busy = false; }
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
                    KpiMoodSub.Text = "";
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

            Polyline Line4(Func<(long t, double v, double e), double> pick, Brush brush)
            {
                var line = new Polyline { Stroke = brush, StrokeThickness = 1.6, StrokeLineJoin = PenLineJoin.Round };
                foreach (var p in _history)
                {
                    line.Points.Add(new Point(
                        (p.t - minT) / (double)span * w,
                        pad + usable * (1 - Clamp(pick(p)) / 100.0)));
                }
                return line;
            }

            HistoryCanvas.Children.Add(Line4(p => p.v, (Brush)FindResource("Accent")));
            HistoryCanvas.Children.Add(Line4(p => p.e, (Brush)FindResource("Ok")));
            AddTimeLabels(HistoryCanvas, w, h, minT, minT + span);
        }

        // ---------- 花销 ----------
        private async Task LoadCostAsync()
        {
            try
            {
                var r = await Api.Get(_sup.Url, "/api/cost/usage?days=" + _costDays);
                if (!r.Ok || r.Root.ValueKind != JsonValueKind.Object) { CostTotal.Text = "—"; return; }
                var root = r.Root;
                var today = root.TryGetProperty("today", out var t) ? t : default;
                var total = root.TryGetProperty("total", out var tt) ? tt : default;
                var todayCost = Num(today, "costCny");
                var totalCost = Num(total, "costCny");
                CostTotal.Text = "¥" + totalCost.ToString("0.000", CultureInfo.InvariantCulture);
                CostHint.Text = $"今天 ¥{todayCost:0.000} · 近 {_costDays} 天 · {Num(total, "requests"):0} 次请求";
                KpiCost.Text = "¥" + todayCost.ToString("0.000", CultureInfo.InvariantCulture);
                KpiCostSub.Text = $"{Num(today, "requests"):0} 次请求";
                _todayRequests = Num(today, "requests");
                KpiToday.Text = _todayRequests > 0 ? _todayRequests.ToString("0") : "0";
                KpiTodaySub.Text = _todayRequests > 0 ? "次 DeepSeek 调用" : "今天还没调用";

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
                DrawCost();
            }
            catch (Exception ex) { CostHint.Text = "读取失败：" + ex.Message; }
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
                if (!r.Ok || r.Root.ValueKind != JsonValueKind.Object) { StatsHint.Text = "—"; return; }
                var root = r.Root;
                var kpi = root.TryGetProperty("kpi", out var k) ? k : default;
                var messages = Num(kpi, "messages");
                var replies = Num(kpi, "replies");
                var activeDays = Num(kpi, "activeDays");
                var avgLen = Num(kpi, "avgReplyLen");
                KpiWeek.Text = messages > 0 ? messages.ToString("0") : "0";
                KpiWeekSub.Text = avgLen > 0 ? $"平均 {avgLen:0} 字/句 · {activeDays:0} 天" : "";
                StatsHint.Text = $"{messages:0} 条消息 · 她回了 {replies:0} 条 · {activeDays:0} 天有聊天（柱状为每日 token）";

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
                DrawStats();

                _chats.Clear();
                if (root.TryGetProperty("chats", out var chats) && chats.ValueKind == JsonValueKind.Array)
                {
                    var list = new List<(string name, double n)>();
                    foreach (var c in chats.EnumerateArray())
                    {
                        if (c.ValueKind != JsonValueKind.Object) continue;
                        var name = Str(c, "name") ?? Str(c, "title") ?? Str(c, "chatId") ?? "会话";
                        list.Add((name, Num(c, "messages")));
                    }
                    list.Sort((a, b) => b.n.CompareTo(a.n));
                    foreach (var (name, n) in list.GetRange(0, Math.Min(4, list.Count)))
                    {
                        _chats.Add(new ChatRow { Name = name, Value = n.ToString("0") + " 条" });
                    }
                }
            }
            catch (Exception ex) { StatsHint.Text = "读取失败：" + ex.Message; }
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

        private static string Str(JsonElement el, string name)
        {
            if (el.ValueKind != JsonValueKind.Object || !el.TryGetProperty(name, out var v)) return null;
            return v.ValueKind == JsonValueKind.String ? v.GetString() : null;
        }

        private static double Clamp(double v) => Math.Max(0, Math.Min(100, v));
    }
}
