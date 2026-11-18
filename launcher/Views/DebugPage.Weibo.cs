using System;
using System.Diagnostics;
using System.IO;
using System.Linq;
using System.Net.Http;
using System.Security.Cryptography;
using System.Text;
using System.Text.Json;
using System.Threading;
using System.Threading.Tasks;
using System.Windows;
using System.Windows.Controls;
using System.Windows.Media.Imaging;
using System.Windows.Navigation;

namespace WhaleLauncher.Views;

public partial class DebugPage
{
    private const string WeiboSearchScript = """
        const fs = require('node:fs/promises');
        const https = require('node:https');
        const { performance } = require('node:perf_hooks');
        const [serviceFile, cookieFile, query] = process.argv.slice(1);

        // 原有搜索函数只返回帖子。记录子进程里的原始 HTTP 回执，便于区分没有结果和被微博拒绝。
        let transfer = Promise.resolve(null);
        const get = https.get.bind(https);
        https.get = (...args) => {
          const started = performance.now();
          const request = get(...args);
          transfer = new Promise(resolve => {
            const finish = (status, body) => resolve({ status, body, ms: Math.round(performance.now() - started) });
            request.once('error', err => finish(null, err.stack));
            request.once('response', response => {
              const preview = Buffer.alloc(6003);
              let length = 0;
              response.on('data', chunk => { length += chunk.copy(preview, length); });
              response.once('end', () => finish(response.statusCode, preview.toString('utf8', 0, length).slice(0, 2001)));
              response.once('error', err => finish(response.statusCode, err.stack));
            });
          });
          return request;
        };

        (async () => {
          let posts = [];
          let error = '';
          try {
            const cookie = (await fs.readFile(cookieFile, 'utf8')).trim();
            const { searchPosts } = require(serviceFile);
            posts = (await searchPosts(query, { cookie })).map(({ mid, text, images }) => {
              const chars = Array.from(text);
              return {
                Excerpt: chars.slice(0, 60).join('') + (chars.length > 60 ? '…' : ''),
                Images: images,
                PostUrl: 'https://weibo.com/2/detail/' + encodeURIComponent(mid)
              };
            });
          } catch (err) {
            error = err.stack || String(err);
          }
          process.stdout.write(JSON.stringify({ Posts: posts, Error: error, Http: await transfer }));
        })().catch(err => { console.error(err); process.exitCode = 1; });
        """;

    private static readonly HttpClient WeiboHttp = new(new HttpClientHandler { AllowAutoRedirect = false })
    {
        Timeout = TimeSpan.FromSeconds(20),
        MaxResponseContentBufferSize = 20 * 1024 * 1024,
    };

    private CancellationTokenSource _imagePreview;

    private sealed record WeiboPost(string Excerpt, string[] Images, string PostUrl)
    {
        public string FirstImage => Images.FirstOrDefault() ?? "";
    }

    private async void OnSearchWeibo(object sender, RoutedEventArgs e) =>
        await WithButtonAsync(sender, "微博搜索", error => WeiboState.Text = error, async token =>
        {
            var query = WeiboQuery.Text.Trim();
            if (query.Length == 0) throw new ArgumentException("请输入微博关键词。");
            WeiboPosts.ItemsSource = null;
            WeiboState.Text = "搜索中…";
            var clock = Stopwatch.StartNew();
            var directory = new DirectoryInfo(_sup.BaseDir);
            while (directory != null && !File.Exists(Path.Combine(directory.FullName, "src", "services", "weiboPosts.js")))
                directory = directory.Parent;
            if (directory == null) throw new FileNotFoundException("无法定位 src/services/weiboPosts.js。");

            var node = new[] { DataDir, Path.GetDirectoryName(DataDir), _sup.BaseDir }
                .Where(root => !string.IsNullOrEmpty(root))
                .Select(root => Path.Combine(root, "runtime", "node.exe"))
                .FirstOrDefault(File.Exists);
            if (node == null) throw new FileNotFoundException("找不到内置 runtime/node.exe。", Path.Combine(DataDir, "runtime", "node.exe"));
            var info = new ProcessStartInfo { FileName = node, WorkingDirectory = directory.FullName };
            foreach (var arg in new[] { "-e", WeiboSearchScript, "--", Path.Combine(directory.FullName, "src", "services", "weiboPosts.js"),
                Path.Combine(DataDir, "weibo.cookie"), query })
                info.ArgumentList.Add(arg);

            using var timeout = CancellationTokenSource.CreateLinkedTokenSource(token);
            timeout.CancelAfter(TimeSpan.FromSeconds(30));
            var output = new StringBuilder();
            var errors = new StringBuilder();
            const string request = "GET s.weibo.com/weibo";
            var exit = await Task.Run(() => DebugProcess.RunAsync(info, null, (error, line) =>
            {
                (error ? errors : output).AppendLine(line);
                return Task.CompletedTask;
            }, timeout.Token));
            token.ThrowIfCancellationRequested();
            if (exit != 0 || timeout.IsCancellationRequested)
            {
                var detail = $"Node 退出码 {exit}\n{errors}{output}";
                LogHttp(request, clock.ElapsedMilliseconds, null, detail);
                if (timeout.IsCancellationRequested) throw new TimeoutException("微博搜索超时。\n" + detail);
                throw new IOException(detail);
            }

            using var document = JsonDocument.Parse(output.ToString());
            var result = document.RootElement;
            var http = result.GetProperty("Http");
            var errorText = result.GetProperty("Error").GetString();
            if (http.ValueKind == JsonValueKind.Object)
            {
                var statusNode = http.GetProperty("status");
                int? status = statusNode.ValueKind == JsonValueKind.Number ? statusNode.GetInt32() : null;
                var body = http.GetProperty("body").GetString() ?? "";
                LogHttp(request, http.GetProperty("ms").GetInt64(), status, body);
                if (status.HasValue && status != 200) throw new IOException($"微博搜索 HTTP {status}\n{body}");
            }
            else LogHttp(request, clock.ElapsedMilliseconds, null, errorText);
            if (errorText.Length > 0) throw new IOException(errorText);
            if (errors.Length > 0) AppendLog("微博 Node stderr", errors.ToString());

            var posts = result.GetProperty("Posts").Deserialize<WeiboPost[]>();
            WeiboPosts.ItemsSource = posts;
            WeiboState.Text = $"{posts.Length} 条结果 · {clock.ElapsedMilliseconds} ms";
        });

    private void OnWeiboPostSelected(object sender, SelectionChangedEventArgs e)
    {
        var post = WeiboPosts.SelectedItem as WeiboPost;
        OriginalPostUrl.Text = post?.PostUrl ?? "";
        OriginalPost.NavigateUri = post == null ? null : new Uri(post.PostUrl);
        WeiboImages.ItemsSource = post?.Images;
        WeiboImages.SelectedIndex = post?.Images.Length > 0 ? 0 : -1;
        if (post?.Images.Length == 0) WeiboImageState.Text = "这条微博没有图片。";
    }

    private async void OnWeiboImageSelected(object sender, SelectionChangedEventArgs e)
    {
        _imagePreview?.Cancel();
        WeiboPreview.Source = null;
        WeiboImageState.Text = "";
        var url = WeiboImages.SelectedItem as string;
        DownloadWeibo.IsEnabled = url != null;
        if (url == null || _pageLifetime == null) return;

        using var load = CancellationTokenSource.CreateLinkedTokenSource(_pageLifetime.Token);
        _imagePreview = load;
        WeiboImageState.Text = "正在加载大图…";
        try
        {
            var (bytes, _) = await FetchWeiboImageAsync(url, load.Token);
            var image = await Task.Run(() =>
            {
                using var stream = new MemoryStream(bytes);
                var bitmap = BitmapFrame.Create(stream, BitmapCreateOptions.None, BitmapCacheOption.OnLoad);
                bitmap.Freeze();
                return bitmap;
            }, load.Token);
            load.Token.ThrowIfCancellationRequested();
            WeiboPreview.Source = image;
            WeiboImageState.Text = "";
        }
        catch (OperationCanceledException) when (load.IsCancellationRequested)
        {
            if (_imagePreview == load) WeiboImageState.Text = "已取消";
        }
        catch (Exception ex)
        {
            if (!load.IsCancellationRequested) WeiboImageState.Text = ex.ToString();
            AppendLog("微博大图", ClipResponse(ex.ToString()));
        }
        finally
        {
            if (_imagePreview == load) _imagePreview = null;
        }
    }

    private async void OnDownloadWeibo(object sender, RoutedEventArgs e) =>
        await WithButtonAsync(sender, "微博下载", error => WeiboImageState.Text = error, async token =>
        {
            if (WeiboImages.SelectedItem is not string url) return;
            var (bytes, extension) = await FetchWeiboImageAsync(url, token);
            var dir = Path.Combine(DataDir, "debug", "weibo");
            Directory.CreateDirectory(dir);
            var file = Path.Combine(dir, Convert.ToHexString(SHA256.HashData(bytes))[..16].ToLowerInvariant() + extension);
            // 完整写入后再改名，取消下载或窗口关闭时不会留下可误用的半张图。
            var temp = file + "." + Guid.NewGuid().ToString("N") + ".tmp";
            try
            {
                await File.WriteAllBytesAsync(temp, bytes, token);
                File.Move(temp, file, overwrite: true);
            }
            finally { if (File.Exists(temp)) File.Delete(temp); }
            WeiboImageState.Text = file;
            AppendLog("微博下载", file);
        });

    private async Task<(byte[] Bytes, string Extension)> FetchWeiboImageAsync(string url, CancellationToken token)
    {
        var clock = Stopwatch.StartNew();
        using var request = new HttpRequestMessage(HttpMethod.Get, url);
        var uri = request.RequestUri;
        if (!uri.IsAbsoluteUri || uri.Scheme != Uri.UriSchemeHttps || !uri.IsDefaultPort ||
            !System.Text.RegularExpressions.Regex.IsMatch(uri.Host, @"^wx[0-9]\.sinaimg\.cn$") || uri.UserInfo.Length != 0)
            throw new InvalidDataException("微博图片 URL 无效。\n" + url);
        request.Headers.Referrer = new Uri("https://weibo.com/");
        request.Headers.UserAgent.ParseAdd("Mozilla/5.0");
        request.Headers.Accept.ParseAdd("image/jpeg, image/png, image/gif, image/*;q=0.5");
        int? status = null;
        try
        {
            using var response = await WeiboHttp.SendAsync(request, token);
            status = (int)response.StatusCode;
            var contentType = response.Content.Headers.ContentType?.MediaType ?? "";
            if (!response.IsSuccessStatusCode || !contentType.StartsWith("image/", StringComparison.OrdinalIgnoreCase))
                throw new IOException($"HTTP {status} {response.ReasonPhrase}\n" + await response.Content.ReadAsStringAsync(token));

            var data = await response.Content.ReadAsByteArrayAsync(token);
            LogHttp("GET " + url, clock.ElapsedMilliseconds, status, $"[{contentType} · {data.Length} 字节]");
            var extension = contentType.ToLowerInvariant() switch
            {
                "image/jpeg" => ".jpg",
                "image/png" => ".png",
                "image/gif" => ".gif",
                "image/webp" => ".webp",
                "image/avif" => ".avif",
                _ => ".img",
            };
            return (data, extension);
        }
        catch (Exception ex)
        {
            LogHttp("GET " + url, clock.ElapsedMilliseconds, status, ex.ToString());
            throw;
        }
    }

    private void OnOpenWeiboPost(object sender, RequestNavigateEventArgs e)
    {
        e.Handled = true;
        try { Process.Start(new ProcessStartInfo(e.Uri.AbsoluteUri) { UseShellExecute = true }); }
        catch (Exception ex)
        {
            WeiboState.Text = ex.ToString();
            AppendLog("打开原帖", ex.ToString());
        }
    }
}
