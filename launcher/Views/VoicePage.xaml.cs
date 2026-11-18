using System;
using System.Collections.ObjectModel;
using System.Globalization;
using System.Text.Json;
using System.Threading.Tasks;
using System.Windows;
using System.Windows.Controls;

namespace WhaleLauncher.Views
{
    public partial class VoicePage : UserControl, IRefreshable
    {
        private readonly RuntimeSupervisor _sup;
        private readonly ObservableCollection<string> _samples = new ObservableCollection<string>();

        public VoicePage(RuntimeSupervisor sup)
        {
            InitializeComponent();
            _sup = sup;
            SamplesList.ItemsSource = _samples;
            Loaded += async (_, __) => await RefreshAsync();
        }

        public async Task RefreshAsync()
        {
            try
            {
                var r = await Api.Get(_sup.Url, "/api/yxn/voice");
                if (!r.Ok || r.Root.ValueKind != JsonValueKind.Object)
                {
                    StatN.Text = "—";
                    InjectedText.Text = string.IsNullOrEmpty(r.Error) ? "读不到：内核未启动？" : r.Error;
                    return;
                }
                var root = r.Root;
                long N(string name) => root.TryGetProperty(name, out var v) && v.ValueKind == JsonValueKind.Number ? (long)v.GetDouble() : 0;
                double avg = root.TryGetProperty("avg", out var a) && a.ValueKind == JsonValueKind.Number ? a.GetDouble() : 0;
                var n = N("n");
                StatN.Text = n.ToString(CultureInfo.InvariantCulture);
                StatAvg.Text = avg > 0 ? avg.ToString("0.#", CultureInfo.InvariantCulture) : "—";
                StatShort.Text = N("short") + "%";
                StatEmoji.Text = N("emoji") + "%";
                StatPeriod.Text = N("period") + "%";
                UpdatedText.Text = "样本取自她自己的回复";

                var openers = new System.Collections.Generic.List<string>();
                if (root.TryGetProperty("openers", out var ops) && ops.ValueKind == JsonValueKind.Array)
                    foreach (var o in ops.EnumerateArray()) if (o.ValueKind == JsonValueKind.String) openers.Add(o.GetString());
                OpenersText.Text = openers.Count > 0 ? "常用开头：" + string.Join(" / ", openers) : "还没有稳定的开头习惯。";
                InjectedText.Text = n < 8
                    ? "样本还不够（<8 句），暂时不注入，免得把她框死。"
                    : $"【说话方式】……（根据 {n} 句样本生成，见下方统计）";

                _samples.Clear();
                if (root.TryGetProperty("samples", out var ss) && ss.ValueKind == JsonValueKind.Array)
                    foreach (var s in ss.EnumerateArray())
                        if (s.ValueKind == JsonValueKind.String) _samples.Add("· " + s.GetString());
                if (_samples.Count == 0) _samples.Add("（还没有样本，等她回几次话再看）");
            }
            catch (Exception ex)
            {
                InjectedText.Text = "读取失败：" + ex.Message;
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
