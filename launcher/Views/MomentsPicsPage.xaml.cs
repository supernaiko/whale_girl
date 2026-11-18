using System;
using System.Collections.Generic;
using System.Diagnostics;
using System.IO;
using System.Text.Json;
using System.Threading.Tasks;
using System.Windows;
using System.Windows.Controls;
using System.Windows.Media.Imaging;
using Microsoft.Win32;

namespace WhaleLauncher.Views
{
    public sealed class PicItem
    {
        public string Name { get; set; } = "";
        public BitmapImage Image { get; set; } = null!;
    }

    public partial class MomentsPicsPage : UserControl, IRefreshable
    {
        readonly RuntimeSupervisor sup;
        string dir = "";

        public MomentsPicsPage(RuntimeSupervisor sup)
        {
            this.sup = sup;
            InitializeComponent();
            Loaded += async (_, _) => await RefreshAsync();
        }

        public Task RefreshAsync() => LoadAsync();

        async void OnRefresh(object sender, RoutedEventArgs e) => await LoadAsync();

        static BitmapImage DecodeDataUrl(string data)
        {
            try
            {
                var comma = data.IndexOf(',');
                var bytes = Convert.FromBase64String(comma >= 0 ? data[(comma + 1)..] : data);
                var bmp = new BitmapImage();
                bmp.BeginInit();
                bmp.CacheOption = BitmapCacheOption.OnLoad;
                bmp.StreamSource = new MemoryStream(bytes);
                bmp.EndInit();
                bmp.Freeze();
                return bmp;
            }
            catch { return null; }
        }

        async Task LoadAsync()
        {
            try
            {
                var res = await Api.Get(sup.Url, "/api/moments/pics");
                if (!res.Ok) { StatusText.Text = Api.Message(res); return; }
                Apply(res);
                UpdatedText.Text = "已刷新 " + DateTime.Now.ToString("HH:mm:ss");
                StatusText.Text = "";
            }
            catch (Exception ex)
            {
                StatusText.Text = "读不到：" + Api.FriendlyError(ex);
            }
        }

        void Apply(ApiResult res)
        {
            dir = res.Str("dir");
            var writer = res.Str("writer");
            foreach (var raw in CmbWriter.Items)
            {
                if (raw is ComboBoxItem item && string.Equals(Convert.ToString(item.Tag), writer, StringComparison.Ordinal))
                {
                    CmbWriter.SelectedItem = item;
                    break;
                }
            }
            var src = res.Str("imageSource");
            foreach (var raw2 in CmbSource.Items)
            {
                if (raw2 is ComboBoxItem item2 && string.Equals(Convert.ToString(item2.Tag), src, StringComparison.Ordinal))
                {
                    CmbSource.SelectedItem = item2;
                    break;
                }
            }
            ChkNoPerson.IsChecked = res.Bool("preferNoPerson");
            ChkRepeat.IsChecked = res.Bool("allowRepeat");

            var items = new List<PicItem>();
            if (res.Has("images") && res.Prop("images").ValueKind == JsonValueKind.Array)
            {
                foreach (var one in res.Prop("images").EnumerateArray())
                {
                    var name = one.TryGetProperty("name", out var n) && n.ValueKind == JsonValueKind.String ? n.GetString() ?? "" : "";
                    var data = one.TryGetProperty("dataUrl", out var d) && d.ValueKind == JsonValueKind.String ? d.GetString() ?? "" : "";
                    var bmp = DecodeDataUrl(data);
                    if (bmp != null) items.Add(new PicItem { Name = name, Image = bmp });
                }
            }
            PicList.ItemsSource = items;
        }

        string Writer() => CmbWriter.SelectedItem is ComboBoxItem item ? Convert.ToString(item.Tag) ?? "deepseek" : "deepseek";

        async void OnRun(object sender, RoutedEventArgs e)
        {
            var prompt = PromptInput.Text.Trim();
            if (prompt.Length == 0) { RunStatus.Text = "先写一句场景"; return; }
            BtnRun.IsEnabled = false;
            RunStatus.Text = "在跑…（一般 40~120 秒）";
            RunInfo.Text = "";
            try
            {
                var res = await Api.PostJson(sup.Url, "/api/moments/debug/run", new
                {
                    prompt,
                    query = QueryInput.Text.Trim(),
                    useSelf = ChkUseSelf.IsChecked == true,
                }, 240);
                if (!res.Ok) { RunStatus.Text = Api.Message(res); return; }
                var pick = (int)res.Long("pick");
                ResultText.Text = res.Str("text");
                UsedPrompt.Text = res.Str("prompt");
                RawOutput.Text = res.Str("raw");
                RunInfo.Text = "耗时 " + (res.Long("elapsedMs") / 1000.0).ToString("0.0") + "s";
                var bmp = default(BitmapImage);
                if (res.Has("candidates") && res.Prop("candidates").ValueKind == JsonValueKind.Array)
                {
                    var list = res.Prop("candidates").EnumerateArray();
                    var idx = 0;
                    foreach (var one in list)
                    {
                        if (idx == pick || (pick < 0 && idx == 0))
                        {
                            var data = one.TryGetProperty("dataUrl", out var d) && d.ValueKind == JsonValueKind.String ? d.GetString() ?? "" : "";
                            bmp = DecodeDataUrl(data);
                            break;
                        }
                        idx++;
                    }
                }
                ResultImage.Source = bmp;
                var err = res.Str("error");
                RunStatus.Text = err.Length > 0 ? err : (pick >= 0 ? "选中第 " + (pick + 1) + " 张" : "没有选中");
            }
            catch (Exception ex)
            {
                RunStatus.Text = "跑失败：" + Api.FriendlyError(ex);
            }
            finally
            {
                BtnRun.IsEnabled = true;
            }
        }


        string paintFile = "";

        async void OnPaint(object sender, RoutedEventArgs e)
        {
            var scene = (PaintScene.Text ?? "").Trim();
            if (scene.Length == 0) { PaintStatus.Text = "先写一句场景"; return; }
            BtnPaint.IsEnabled = false;
            PaintStatus.Text = "Codex 出图中…（40~90 秒）";
            try
            {
                var body = JsonSerializer.Serialize(new { scene });
                var res = await Api.Post(sup.Url, "/api/moments/pics/paint", body, 300);
                if (res == null || !res.Bool("ok"))
                {
                    PaintStatus.Text = "出图失败：" + (res == null ? "无响应" : (res.Str("error") != "" ? res.Str("error") : "HTTP " + res.StatusCode));
                    return;
                }
                PaintPreview.Source = DecodeDataUrl(res.Str("image"));
                paintFile = res.Str("file");
                BtnUsePaint.IsEnabled = paintFile.Length > 0;
                PaintStatus.Text = "✓ 用时 " + (res.Long("elapsedMs") / 1000) + " 秒";
            }
            catch (Exception ex) { PaintStatus.Text = "出错：" + ex.Message; }
            finally { BtnPaint.IsEnabled = true; }
        }

        async void OnUsePaint(object sender, RoutedEventArgs e)
        {
            if (paintFile.Length == 0) return;
            BtnUsePaint.IsEnabled = false;
            try
            {
                var body = JsonSerializer.Serialize(new { path = paintFile });
                var res = await Api.Post(sup.Url, "/api/moments/pics/self/add", body, 15);
                if (res != null && res.Bool("ok"))
                {
                    PaintStatus.Text = "已加入本人图池";
                    await LoadAsync();
                }
                else PaintStatus.Text = "加入失败：" + (res == null ? "无响应" : res.Str("error"));
            }
            catch (Exception ex) { PaintStatus.Text = "出错：" + ex.Message; }
            finally { BtnUsePaint.IsEnabled = true; }
        }

        string Source()
        {
            return CmbSource.SelectedItem is ComboBoxItem item ? Convert.ToString(item.Tag) ?? "weibo" : "weibo";
        }

        async void OnSave(object sender, RoutedEventArgs e)
        {
            try
            {
                var res = await Api.PostJson(sup.Url, "/api/moments/pics/settings", new
                {
                    writer = Writer(),
                    imageSource = Source(),
                    preferNoPerson = ChkNoPerson.IsChecked == true,
                    allowRepeat = ChkRepeat.IsChecked == true,
                });
                SaveText.Text = res.Ok ? "已保存" : Api.Message(res);
                if (res.Ok) Apply(res);
            }
            catch (Exception ex)
            {
                SaveText.Text = "保存失败：" + Api.FriendlyError(ex);
            }
        }

        async void OnAdd(object sender, RoutedEventArgs e)
        {
            try
            {
                var dlg = new OpenFileDialog { Filter = "图片 (*.jpg;*.jpeg;*.png)|*.jpg;*.jpeg;*.png" };
                if (dlg.ShowDialog() != true) return;
                var res = await Api.PostJson(sup.Url, "/api/moments/pics/self/add", new { path = dlg.FileName }, 30);
                StatusText.Text = res.Ok ? "已加入" : Api.Message(res);
                if (res.Ok) Apply(res);
            }
            catch (Exception ex)
            {
                StatusText.Text = "添加失败：" + Api.FriendlyError(ex);
            }
        }

        async void OnRemove(object sender, RoutedEventArgs e)
        {
            try
            {
                var name = Convert.ToString((sender as Button)?.Tag) ?? "";
                if (name.Length == 0) return;
                var res = await Api.PostJson(sup.Url, "/api/moments/pics/self/remove", new { name });
                StatusText.Text = res.Ok ? "已移除 " + name : Api.Message(res);
                if (res.Ok) Apply(res);
            }
            catch (Exception ex)
            {
                StatusText.Text = "移除失败：" + Api.FriendlyError(ex);
            }
        }

        void OnOpenDir(object sender, RoutedEventArgs e)
        {
            try
            {
                if (dir.Length == 0) return;
                Directory.CreateDirectory(dir);
                Process.Start(new ProcessStartInfo("explorer.exe", dir) { UseShellExecute = true });
            }
            catch (Exception ex)
            {
                StatusText.Text = "打不开：" + Api.FriendlyError(ex);
            }
        }

        void OnCopyText(object sender, RoutedEventArgs e) => Copy(ResultText.Text, "文案已复制");

        void OnCopyUsedPrompt(object sender, RoutedEventArgs e) => Copy(UsedPrompt.Text, "提示词已复制");

        void Copy(string text, string ok)
        {
            try
            {
                if (text.Trim().Length == 0) { RunStatus.Text = "还没有内容"; return; }
                Clipboard.SetText(text);
                RunStatus.Text = ok;
            }
            catch (Exception ex)
            {
                RunStatus.Text = "复制失败：" + Api.FriendlyError(ex);
            }
        }
    }
}
