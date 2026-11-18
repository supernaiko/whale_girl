using System;
using System.Collections.Generic;
using System.IO;
using System.Linq;
using System.Text;
using System.Threading.Tasks;
using System.Windows;
using System.Windows.Controls;
using System.Windows.Threading;

namespace WhaleLauncher.Views
{
    /// <summary>
    /// Codex 运行日志：读 whale-ops 插件落盘的 run-*.log，左边选运行、右边看全文。
    /// 插件哪天没装，页面只显示路径提示，不会报错。
    /// </summary>
    public partial class CodexLogPage : UserControl, IRefreshable
    {
        private readonly RuntimeSupervisor _sup;
        private readonly DispatcherTimer _timer;
        private string _current = "";

        internal CodexLogPage(RuntimeSupervisor sup)
        {
            _sup = sup;
            InitializeComponent();
            Title.Text = "Codex 日志";
            Hint.Text = "插件每次调用 codex 都会留一份日志（命令、工作目录、逐条事件和最后的报错）。"
                + "左边按时间倒序列出最近 50 次运行。";

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

        private void ReloadList()
        {
            try
            {
                var dir = LogDir;
                if (!Directory.Exists(dir))
                {
                    Runs.ItemsSource = null;
                    LogText.Text = "还没有日志。\n\n目录：" + dir
                        + "\n\n在微信里发「用 codex ……」，确认后跑一次就会在这里留下记录。";
                    return;
                }

                var files = new DirectoryInfo(dir).GetFiles("*.log")
                    .OrderByDescending(f => f.LastWriteTimeUtc)
                    .Take(50)
                    .ToList();

                if (files.Count == 0)
                {
                    Runs.ItemsSource = null;
                    LogText.Text = "这个目录里还没有 run-*.log。\n\n路径：" + dir;
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
                LogText.Text = "读取日志失败：" + ex.Message;
            }
        }

        private void OnRunSelected(object sender, SelectionChangedEventArgs e)
        {
            if (Runs.SelectedItem is RunItem item) Show(item.File);
        }

        private void Show(FileInfo file)
        {
            try
            {
                _current = file.FullName;
                LogText.Text = ReadTail(file.FullName, 800);
                Scroller.ScrollToEnd();
            }
            catch (Exception ex)
            {
                LogText.Text = "打开失败：" + ex.Message;
            }
        }

        // 运行中的日志正被写，用 FileShare.ReadWrite 才不会撞锁。
        private static string ReadTail(string path, int maxLines)
        {
            using (var fs = new FileStream(path, FileMode.Open, FileAccess.Read, FileShare.ReadWrite | FileShare.Delete))
            using (var reader = new StreamReader(fs, Encoding.UTF8, true))
            {
                var lines = new List<string>();
                string line;
                while ((line = reader.ReadLine()) != null)
                {
                    lines.Add(line);
                    if (lines.Count > maxLines * 2) lines.RemoveRange(0, lines.Count - maxLines);
                }
                var tail = lines.Count > maxLines ? lines.Skip(lines.Count - maxLines) : lines;
                return string.Join(Environment.NewLine, tail);
            }
        }

        private void ReloadIfChanged()
        {
            if (Follow.IsChecked != true) return;
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
                if (newest.LastWriteTimeUtc > DateTime.UtcNow.AddMinutes(-10) && OnScreen())
                {
                    var before = LogText.Text.Length;
                    var tail = ReadTail(newest.FullName, 800);
                    if (tail.Length != before) LogText.Text = tail;
                }
            }
            catch { /* 刷新失败不影响看旧内容 */ }
        }

        private bool OnScreen() => IsVisible;

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
