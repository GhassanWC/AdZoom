using System.Diagnostics;
using System.Text.Json;
using ExportApi.Models;

namespace ExportApi.Services;

public sealed record RenderOutcome(int ExitCode, bool Canceled, RenderEvent? Done, RenderEvent? Error, bool TimedOut = false);

/// <summary>
/// Spawns the bundled Node render CLI (services/export-worker/dist/cli.js) for
/// ONE job, streams its NDJSON stdout to <paramref name="onEvent"/>, captures
/// stderr to the log buffer, and cancels cooperatively (writes "cancel" to the
/// child's stdin → it aborts ffmpeg) escalating to a process-tree kill.
/// </summary>
public sealed class RenderSubprocess(ExportOptions opts, LogBuffer logs, ILogger<RenderSubprocess> log)
{
    public async Task<RenderOutcome> RunAsync(
        string jobId,
        Dictionary<string, object?> spec,
        string workDir,
        Action<RenderEvent> onEvent,
        CancellationToken cancel,
        string specName = "spec.json",
        int timeoutSeconds = 0)
    {
        Directory.CreateDirectory(workDir);
        var specPath = Path.Combine(workDir, specName);
        await File.WriteAllTextAsync(specPath, JsonSerializer.Serialize(spec), CancellationToken.None);

        var psi = new ProcessStartInfo
        {
            FileName = opts.RenderCliNode,
            RedirectStandardInput = true,
            RedirectStandardOutput = true,
            RedirectStandardError = true,
            UseShellExecute = false,
        };
        psi.ArgumentList.Add(opts.RenderCliEntry);
        psi.ArgumentList.Add(specPath);

        using var proc = new Process { StartInfo = psi };
        if (opts.SingleJob)
            BatchLog.Line($"renderer start job={jobId} cmd={opts.RenderCliNode} {opts.RenderCliEntry} {specName}");
        proc.Start();

        RenderEvent? doneEvent = null;
        RenderEvent? errorEvent = null;

        var stdoutTask = Task.Run(async () =>
        {
            string? line;
            while ((line = await proc.StandardOutput.ReadLineAsync()) != null)
            {
                var ev = RenderEvent.TryParse(line);
                if (ev is null)
                {
                    log.LogWarning("[export:cli] non-JSON stdout line (ignored): {Line}", line);
                    continue;
                }
                if (ev.Type == "done") doneEvent = ev;
                else if (ev.Type == "error") errorEvent = ev;
                try { onEvent(ev); }
                catch (Exception ex) { log.LogError(ex, "[export:cli] onEvent threw for {Type}", ev.Type); }
            }
        });

        var stderrTask = Task.Run(async () =>
        {
            string? line;
            while ((line = await proc.StandardError.ReadLineAsync()) != null)
            {
                logs.Append(jobId, line);
                log.LogInformation("[export:cli] {Line}", line);
            }
        });

        // Cooperative cancel: write "cancel" to stdin → CLI aborts ffmpeg (exits 2 =
        // canceled); then escalate to a process-tree kill so nothing orphans.
        using var reg = cancel.Register(() =>
        {
            try { proc.StandardInput.WriteLine("cancel"); proc.StandardInput.Flush(); }
            catch { /* stdin may be closed */ }
            _ = Task.Run(async () =>
            {
                try
                {
                    await Task.Delay(TimeSpan.FromSeconds(5));
                    if (!proc.HasExited) proc.Kill(entireProcessTree: true);
                }
                catch { /* already gone */ }
            });
        });

        // Hard timeout backstop (timeoutSeconds > 0): if the CLI doesn't exit in time
        // it's WEDGED (e.g. ffmpeg ignoring its own kill). HARD-kill the whole process
        // tree — NOT the cooperative "cancel" (which exits 2 = a clean user-cancel the
        // caller treats as success). A SIGKILL yields a non-zero exit + TimedOut=true so
        // the caller fails the job CLEARLY instead of hanging the UI forever. The Node
        // CLI has its OWN (shorter) audiomux timeout, so this only fires if the whole
        // process is stuck — give it a generous margin over the CLI's budget.
        var timedOut = false;
        using var timeoutCts = new CancellationTokenSource();
        Task? timeoutTask = timeoutSeconds <= 0 ? null : Task.Run(async () =>
        {
            try { await Task.Delay(TimeSpan.FromSeconds(timeoutSeconds), timeoutCts.Token); }
            catch (OperationCanceledException) { return; } // exited in time — stand down
            if (proc.HasExited) return; // finished in the boundary race
            timedOut = true;
            BatchLog.Error($"render-cli TIMEOUT after {timeoutSeconds}s job={jobId} spec={specName} — hard-killing the process tree");
            try { proc.Kill(entireProcessTree: true); } catch { /* already gone */ }
        });

        await proc.WaitForExitAsync(CancellationToken.None);
        timeoutCts.Cancel(); // stand the watchdog down
        if (timeoutTask is not null) { try { await timeoutTask; } catch { /* non-fatal */ } }
        await Task.WhenAll(stdoutTask, stderrTask);

        return new RenderOutcome(proc.ExitCode, cancel.IsCancellationRequested, doneEvent, errorEvent, timedOut);
    }
}
