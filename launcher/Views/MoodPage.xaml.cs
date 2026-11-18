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
    public sealed class MoodPerson
    {
        public string Name { get; set; } = "";
        public string Tier { get; set; } = "";
        public double Closeness { get; set; }
        public string ClosenessText { get; set; } = "";
        public double Trust { get; set; }
        public string TrustText { get; set; } = "";
        public string Extra { get; set; } = "";
    }

    public partial class MoodPage : UserControl, IRefreshable
    {
        private readonly RuntimeSupervisor _sup;
        private readonly ObservableCollection<MoodPerson> _people = new ObservableCollection<MoodPerson>();
        private readonly DispatcherTimer _timer;
        private bool _busy;
        private List<(long t, double v, double e)> _history = new List<(long, double, double)>();

        public MoodPage(RuntimeSupervisor sup)
        {
            InitializeComponent();
            _sup = sup;
            PeopleList.ItemsSource = _people;
            _timer = new DispatcherTimer { Interval = TimeSpan.FromSeconds(15) };
            _timer.Tick += async (_, __) => await RefreshAsync();
            Loaded += async (_, __) => { _timer.Start(); await RefreshAsync(); };
            HistoryCanvas.SizeChanged += (_, __) => DrawHistory();
            Unloaded += (_, __) => _timer.Stop();
        }

        public async Task RefreshAsync()
        {
            if (_busy) return;
            _busy = true;
            try
            {
                var r = await Api.Get(_sup.Url, "/api/yxn/status");
                if (!r.Ok || r.Root.ValueKind != JsonValueKind.Object)
                {
                    MoodLabel.Text = "读不到";
                    MoodWhy.Text = string.IsNullOrEmpty(r.Error) ? "内核未启动，或 yxn-bond 插件未加载。" : r.Error;
                    UpdatedText.Text = "—";
                    _people.Clear();
                    PeopleEmpty.Text = "";
                    BtnRefresh.Tag = null;
                    return;
                }

                var root = r.Root;
                var mood = root.TryGetProperty("mood", out var m) ? m : default;
                if (mood.ValueKind == JsonValueKind.Object)
                {
                    var valence = mood.TryGetProperty("valence", out var v) ? v.GetDouble() : 0;
                    var energy = mood.TryGetProperty("energy", out var e) ? e.GetDouble() : 0;
                    var label = mood.TryGetProperty("label", out var l) ? l.GetString() : "";
                    var why = mood.TryGetProperty("why", out var w) ? w.GetString() : "";
                    var at = mood.TryGetProperty("updatedAt", out var u) ? u.GetInt64() : 0;

                    MoodLabel.Text = string.IsNullOrEmpty(label) ? "—" : label;
                    MoodWhy.Text = string.IsNullOrEmpty(why) ? "还没有明显起伏。" : "最近：" + why;
                    ValenceBar.Value = Math.Max(0, Math.Min(100, valence));
                    EnergyBar.Value = Math.Max(0, Math.Min(100, energy));
                    ValenceText.Text = Math.Round(valence).ToString(CultureInfo.InvariantCulture);
                    EnergyText.Text = Math.Round(energy).ToString(CultureInfo.InvariantCulture);
                    UpdatedText.Text = at > 0
                        ? "更新于 " + DateTimeOffset.FromUnixTimeMilliseconds(at).ToLocalTime().ToString("MM-dd HH:mm:ss")
                        : "—";
                }

                _people.Clear();
                if (root.TryGetProperty("people", out var people) && people.ValueKind == JsonValueKind.Array)
                {
                    foreach (var p in people.EnumerateArray())
                    {
                        if (p.ValueKind != JsonValueKind.Object) continue;
                        var name = p.TryGetProperty("name", out var n) ? n.GetString() : "";
                        var wxid = p.TryGetProperty("wxid", out var x) ? x.GetString() : "";
                        var closeness = p.TryGetProperty("closeness", out var c) ? c.GetDouble() : 0;
                        var trust = p.TryGetProperty("trust", out var t) ? t.GetDouble() : 0;
                        var tier = p.TryGetProperty("tier", out var ti) ? ti.GetString() : "";
                        var lastAt = p.TryGetProperty("lastAt", out var la) ? la.GetInt64() : 0;
                        var count = p.TryGetProperty("interactions", out var ic) ? ic.GetInt64() : 0;
                        var lastText = lastAt > 0
                            ? DateTimeOffset.FromUnixTimeMilliseconds(lastAt).ToLocalTime().ToString("MM-dd HH:mm")
                            : "—";
                        _people.Add(new MoodPerson
                        {
                            Name = string.IsNullOrEmpty(name) ? wxid : name,
                            Tier = tier,
                            Closeness = closeness,
                            ClosenessText = "亲近 " + Math.Round(closeness).ToString(CultureInfo.InvariantCulture),
                            Trust = trust,
                            TrustText = "信任 " + Math.Round(trust).ToString(CultureInfo.InvariantCulture),
                            Extra = count + " 次 · 最近 " + lastText,
                        });
                    }
                }
                _history.Clear();
                if (root.TryGetProperty("history", out var hist) && hist.ValueKind == JsonValueKind.Array)
                {
                    foreach (var point in hist.EnumerateArray())
                    {
                        if (point.ValueKind != JsonValueKind.Object) continue;
                        var t = point.TryGetProperty("t", out var pt) ? pt.GetInt64() : 0;
                        var pv = point.TryGetProperty("v", out var pvEl) ? pvEl.GetDouble() : 0;
                        var pe = point.TryGetProperty("e", out var peEl) ? peEl.GetDouble() : 0;
                        if (t > 0) _history.Add((t, pv, pe));
                    }
                }
                DrawHistory();

                PeopleEmpty.Text = _people.Count == 0 ? "她还没对谁积累出印象" : _people.Count + " 个人";
            }
            catch (Exception ex)
            {
                MoodWhy.Text = "读取失败：" + ex.Message;
            }
            finally
            {
                _busy = false;
            }
        }

        /// <summary>把 24 小时心情/精力画成两条折线；没数据就留一行提示</summary>
        private void DrawHistory()
        {
            HistoryCanvas.Children.Clear();
            var width = HistoryCanvas.ActualWidth;
            var height = HistoryCanvas.ActualHeight;
            if (width < 40 || height < 30) { HistoryEmpty.Text = "画布太小"; return; }
            if (_history.Count < 2)
            {
                HistoryEmpty.Text = _history.Count == 0 ? "还没攒够数据，每 5 分钟记一个点" : "只有一个点，再等等";
                return;
            }
            HistoryEmpty.Text = _history.Count + " 个点 · 最近 24 小时";

            var minT = _history[0].t;
            var maxT = _history[_history.Count - 1].t;
            var span = Math.Max(1, maxT - minT);
            var padTop = 6.0;
            var padBottom = 6.0;
            var usable = height - padTop - padBottom;

            // 基线（50）
            var baseY = padTop + usable * (1 - 50 / 100.0);
            HistoryCanvas.Children.Add(new Line
            {
                X1 = 0, X2 = width, Y1 = baseY, Y2 = baseY,
                Stroke = (Brush)FindResource("Surface3"), StrokeThickness = 1,
            });

            Polyline Build(Func<(long t, double v, double e), double> pick, Brush brush)
            {
                var line = new Polyline { Stroke = brush, StrokeThickness = 1.6, StrokeLineJoin = PenLineJoin.Round };
                foreach (var point in _history)
                {
                    var x = (point.t - minT) / (double)span * width;
                    var y = padTop + usable * (1 - Math.Max(0, Math.Min(100, pick(point))) / 100.0);
                    line.Points.Add(new Point(x, y));
                }
                return line;
            }

            HistoryCanvas.Children.Add(Build(p => p.v, (Brush)FindResource("Accent")));
            HistoryCanvas.Children.Add(Build(p => p.e, (Brush)FindResource("Ok")));

            // 时间刻度：左端和右端
            foreach (var (t, align) in new[] { (minT, TextAlignment.Left), (maxT, TextAlignment.Right) })
            {
                var label = new TextBlock
                {
                    Text = DateTimeOffset.FromUnixTimeMilliseconds(t).ToLocalTime().ToString("HH:mm", CultureInfo.InvariantCulture),
                    FontSize = 10,
                    Foreground = (Brush)FindResource("Muted"),
                };
                label.Measure(new Size(double.PositiveInfinity, double.PositiveInfinity));
                Canvas.SetLeft(label, align == TextAlignment.Left ? 0 : width - label.DesiredSize.Width);
                Canvas.SetTop(label, height - label.DesiredSize.Height);
                HistoryCanvas.Children.Add(label);
            }
        }

        private async void OnRefresh(object sender, RoutedEventArgs e)
        {
            BtnRefresh.IsEnabled = false;
            try { await RefreshAsync(); }
            finally { BtnRefresh.IsEnabled = true; }
        }
    }
}
