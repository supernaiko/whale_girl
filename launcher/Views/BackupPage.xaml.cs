using System;
using System.Collections.Generic;
using System.IO;
using System.IO.Compression;
using System.Linq;
using System.Text;
using System.Text.Json;
using System.Threading.Tasks;
using System.Windows;
using System.Windows.Controls;
using Microsoft.Win32;

namespace WhaleLauncher.Views
{
    /// <summary>把「她这个人」打成 zip：人设、记忆、日记、心情、表情包、语音预设、提醒。</summary>
    public partial class BackupPage : UserControl
    {
        private static readonly string[] Files = { "persona.json", "config.json", "reminders.json", "voice-presets.json", "voice-send.json" };
        private static readonly string[] Dirs = { "memory", "diary", "personas", "stickers", "moments", "plugins" };
        // 插件数据里只带 *.data 目录，插件包本身（flow.json/zip）换机器可以从项目里重装。
        private static readonly string[] SkipPluginFiles = { "accounts.json", "settings.json" };

        private readonly RuntimeSupervisor _sup;
        private readonly string _dataDir;

        public BackupPage(RuntimeSupervisor sup)
        {
            InitializeComponent();
            _sup = sup;
            _dataDir = Path.Combine(sup.BaseDir, "data");
            DataPath.Text = _dataDir;
            Loaded += (_, __) => UpdateStats();
        }

        private void UpdateStats()
        {
            try
            {
                var size = 0L;
                var counts = new StringBuilder();
                foreach (var f in Files)
                {
                    var p = Path.Combine(_dataDir, f);
                    if (File.Exists(p)) size += new FileInfo(p).Length;
                }
                var memory = Path.Combine(_dataDir, "memory", "chats");
                var chats = Directory.Exists(memory) ? Directory.GetDirectories(memory).Length : 0;
                var diaryDir = Path.Combine(_dataDir, "diary");
                var diaries = Directory.Exists(diaryDir) ? Directory.GetFiles(diaryDir, "*.md", SearchOption.AllDirectories).Length : 0;
                var peopleFiles = Directory.Exists(memory) ? Directory.GetFiles(memory, "*.json", SearchOption.AllDirectories).Length : 0;
                foreach (var d in new[] { "memory", "diary", "stickers", "moments", "personas" })
                {
                    var p = Path.Combine(_dataDir, d);
                    if (!Directory.Exists(p)) continue;
                    size += Directory.EnumerateFiles(p, "*", SearchOption.AllDirectories).Sum(f => new FileInfo(f).Length);
                }
                counts.Append($"{chats} 个会话 · {diaries} 篇日记 · {peopleFiles} 个记忆文件 · 约 {size / 1024.0 / 1024.0:0.0} MB");
                var plugins = Path.Combine(_dataDir, "plugins");
                if (Directory.Exists(plugins))
                {
                    var dataDirs = Directory.GetDirectories(plugins, "*.data").Select(Path.GetFileName).ToList();
                    if (dataDirs.Count > 0) counts.Append(" · 插件数据：" + string.Join("、", dataDirs));
                }
                StatLine.Text = counts.ToString();
            }
            catch (Exception ex)
            {
                StatLine.Text = "统计失败：" + ex.Message;
            }
        }

        private IEnumerable<string> CollectItems()
        {
            foreach (var f in Files)
            {
                var p = Path.Combine(_dataDir, f);
                if (File.Exists(p)) yield return f;
            }
            foreach (var d in Dirs)
            {
                var p = Path.Combine(_dataDir, d);
                if (!Directory.Exists(p)) continue;
                foreach (var file in Directory.EnumerateFiles(p, "*", SearchOption.AllDirectories))
                {
                    var rel = Path.GetRelativePath(_dataDir, file).Replace('\\', '/');
                    if (rel.StartsWith("plugins/") && !rel.Contains(".data/")) continue; // 只带插件数据
                    if (rel.StartsWith("plugins/") && SkipPluginFiles.Any(s => rel.EndsWith("/" + s, StringComparison.OrdinalIgnoreCase))) continue;
                    yield return rel;
                }
            }
        }

        private async void OnExport(object sender, RoutedEventArgs e)
        {
            var dialog = new SaveFileDialog
            {
                Title = "导出雅小奈备份",
                Filter = "备份包 (*.zip)|*.zip",
                FileName = "yxn-backup-" + DateTime.Now.ToString("yyyyMMdd-HHmm") + ".zip",
                InitialDirectory = Environment.GetFolderPath(Environment.SpecialFolder.DesktopDirectory),
            };
            if (dialog.ShowDialog() != true) return;

            BtnExport.IsEnabled = false;
            Log("正在打包…");
            try
            {
                var temp = Path.Combine(Path.GetTempPath(), "yxn-backup-" + Guid.NewGuid().ToString("N"));
                var stage = Path.Combine(temp, "yxn");
                Directory.CreateDirectory(stage);
                var list = CollectItems().ToList();
                foreach (var rel in list)
                {
                    var src = Path.Combine(_dataDir, rel.Replace('/', '\\'));
                    var dst = Path.Combine(stage, rel.Replace('/', '\\'));
                    Directory.CreateDirectory(Path.GetDirectoryName(dst));
                    File.Copy(src, dst, true);
                }
                var manifest = new
                {
                    schema = 1,
                    kind = "yxn-backup",
                    exportedAt = DateTimeOffset.Now.ToString("o"),
                    appVersion = UpdateManifestService.LocalVersion(_sup.BaseDir),
                    files = list.Count,
                };
                File.WriteAllText(Path.Combine(stage, "backup-manifest.json"),
                    JsonSerializer.Serialize(manifest, new JsonSerializerOptions { WriteIndented = true }), new UTF8Encoding(false));

                if (File.Exists(dialog.FileName)) File.Delete(dialog.FileName);
                await Task.Run(() => ZipFile.CreateFromDirectory(stage, dialog.FileName, CompressionLevel.Optimal, false));
                try { Directory.Delete(temp, true); } catch { }
                var kb = new FileInfo(dialog.FileName).Length / 1024.0;
                Log($"已导出 {list.Count} 个文件（{kb:0} KB）→ {dialog.FileName}\n换机器时把这个 zip 拷过去，用「选择备份…」恢复。");
            }
            catch (Exception ex)
            {
                Log("导出失败：" + ex.Message);
            }
            finally
            {
                BtnExport.IsEnabled = true;
                UpdateStats();
            }
        }

        private async void OnImport(object sender, RoutedEventArgs e)
        {
            var dialog = new OpenFileDialog
            {
                Title = "选择雅小奈备份",
                Filter = "备份包 (*.zip)|*.zip|所有文件|*.*",
                CheckFileExists = true,
            };
            if (dialog.ShowDialog() != true) return;

            var ok = AppDialog.Confirm(Window.GetWindow(this),
                "恢复会用备份里的内容覆盖同名文件（人设、记忆、日记、心情、表情包等），\n恢复前会自动把当前数据另存一份到 data\\_backup\\。\n\n建议先退出鲸鲸再恢复，恢复完再打开。",
                "确认恢复", okText: "恢复");
            if (!ok) return;

            BtnImport.IsEnabled = false;
            try
            {
                var temp = Path.Combine(Path.GetTempPath(), "yxn-restore-" + Guid.NewGuid().ToString("N"));
                ZipFile.ExtractToDirectory(dialog.FileName, temp);
                var stage = Path.Combine(temp, "yxn");
                var manifestPath = Path.Combine(stage, "backup-manifest.json");
                if (!File.Exists(manifestPath))
                {
                    Log("这不是雅小奈的备份包（缺少 backup-manifest.json）。");
                    return;
                }

                Log("正在备份当前数据…");
                var backupDir = Path.Combine(_dataDir, "_backup");
                Directory.CreateDirectory(backupDir);
                var safety = Path.Combine(backupDir, "before-restore-" + DateTime.Now.ToString("yyyyMMdd-HHmmss") + ".zip");
                var currentStage = Path.Combine(temp, "current");
                Directory.CreateDirectory(currentStage);
                foreach (var rel in CollectItems())
                {
                    var src = Path.Combine(_dataDir, rel.Replace('/', '\\'));
                    var dst = Path.Combine(currentStage, rel.Replace('/', '\\'));
                    Directory.CreateDirectory(Path.GetDirectoryName(dst));
                    File.Copy(src, dst, true);
                }
                ZipFile.CreateFromDirectory(currentStage, safety, CompressionLevel.Optimal, false);

                Log("正在恢复…");
                var restored = 0;
                foreach (var file in Directory.EnumerateFiles(stage, "*", SearchOption.AllDirectories))
                {
                    var rel = Path.GetRelativePath(stage, file);
                    if (rel.Equals("backup-manifest.json", StringComparison.OrdinalIgnoreCase)) continue;
                    var dst = Path.Combine(_dataDir, rel);
                    Directory.CreateDirectory(Path.GetDirectoryName(dst));
                    File.Copy(file, dst, true);
                    restored++;
                }
                try { Directory.Delete(temp, true); } catch { }
                Log($"已恢复 {restored} 个文件。当前数据已另存到：\n{safety}\n请重启内核，让她重新读一遍记忆。");
            }
            catch (Exception ex)
            {
                Log("恢复失败：" + ex.Message);
            }
            finally
            {
                BtnImport.IsEnabled = true;
                UpdateStats();
            }
        }

        private void Log(string text)
        {
            LogText.Text = "[" + DateTime.Now.ToString("HH:mm:ss") + "] " + text;
        }
    }
}
