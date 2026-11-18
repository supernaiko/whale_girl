using System;
using System.Diagnostics;
using System.IO;
using System.Text;
using System.Threading;
using System.Threading.Tasks;

namespace WhaleLauncher;

internal static class DebugProcess
{
    internal static async Task<int> RunAsync(ProcessStartInfo info, string input,
        Func<bool, string, Task> onLine, CancellationToken cancellationToken)
    {
        info.UseShellExecute = false;
        info.CreateNoWindow = true;
        info.RedirectStandardOutput = true;
        info.RedirectStandardError = true;
        info.StandardOutputEncoding = Encoding.UTF8;
        info.StandardErrorEncoding = Encoding.UTF8;
        if (input != null)
        {
            info.RedirectStandardInput = true;
            info.StandardInputEncoding = new UTF8Encoding(false);
        }

        cancellationToken.ThrowIfCancellationRequested();
        using var process = new Process { StartInfo = info };
        using var job = new ProcessJob();
        process.Start();
        var assigned = job.Assign(process);
        // 关窗时 Dispatcher 可能先退出。让取消直接关闭 Job，进程树清理不依赖 UI 回调。
        using var registration = assigned ? cancellationToken.Register(job.Dispose) : default;
        var stdout = ReadLinesAsync(process.StandardOutput, false, onLine);
        var stderr = ReadLinesAsync(process.StandardError, true, onLine);
        var exit = process.WaitForExitAsync();
        var write = input == null ? Task.CompletedTask : WriteInputAsync(process, input, onLine, cancellationToken);
        try
        {
            await Task.WhenAll(exit, write).WaitAsync(cancellationToken).ConfigureAwait(false);
        }
        catch (OperationCanceledException) when (cancellationToken.IsCancellationRequested)
        {
            if (!assigned && !process.HasExited)
            {
                try { process.Kill(entireProcessTree: true); }
                catch (InvalidOperationException) when (process.HasExited) { }
            }
        }
        finally
        {
            job.Dispose();
        }
        await exit.ConfigureAwait(false);
        await Task.WhenAll(stdout, stderr, write).ConfigureAwait(false);
        return process.ExitCode;
    }

    private static async Task ReadLinesAsync(StreamReader reader, bool error, Func<bool, string, Task> onLine)
    {
        while (await reader.ReadLineAsync().ConfigureAwait(false) is { } line)
            await onLine(error, line).ConfigureAwait(false);
    }

    private static async Task WriteInputAsync(Process process, string input, Func<bool, string, Task> onLine,
        CancellationToken cancellationToken)
    {
        try
        {
            await process.StandardInput.WriteAsync(input.AsMemory(), cancellationToken).ConfigureAwait(false);
            await process.StandardInput.FlushAsync(cancellationToken).ConfigureAwait(false);
        }
        catch (Exception ex) when (ex is IOException or OperationCanceledException)
        {
            if (!cancellationToken.IsCancellationRequested) await onLine(true, ex.ToString()).ConfigureAwait(false);
        }
        finally
        {
            try { process.StandardInput.Close(); }
            catch (IOException ex)
            {
                if (!cancellationToken.IsCancellationRequested) await onLine(true, ex.ToString()).ConfigureAwait(false);
            }
        }
    }
}
