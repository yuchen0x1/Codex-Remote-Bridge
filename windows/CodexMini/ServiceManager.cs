using System.Diagnostics;
using System.IO;
using System.IO.Compression;
using System.Net;
using System.Net.Http;
using System.Net.Http.Json;
using System.Net.Sockets;
using System.Net.NetworkInformation;
using System.Security.Cryptography;
using System.Text;
using System.Text.Json;
using System.Text.Json.Serialization;
using System.Windows.Forms;

namespace CodexMiniWin;

internal enum ServiceState
{
    NotInstalled,
    Running,
    Stopped,
    Unknown
}

internal sealed record ServiceSnapshot(
    ServiceState State,
    bool HealthOk,
    int Port,
    int? Pid,
    int? ThreadCount,
    string LatestThreadTitle,
    string ControlMode,
    string LogPreview,
    DateTime LastUpdated
);

internal sealed record HealthSnapshot(
    bool Ok,
    string ControlMode
);

internal sealed record CdpLaunchSnapshot(
    bool Ok,
    string Message
);

internal sealed class ServiceManager
{
    private const string DisplayName = "Codex Remote Bridge";
    private const string AppDataName = "Codex Remote Bridge";
    private static readonly string[] LegacyAppDataNames = { "ChatGPT Win", "Codex Max" };
    private const int DefaultPort = 8787;
    private static readonly JsonSerializerOptions JsonOptions = new()
    {
        PropertyNamingPolicy = JsonNamingPolicy.CamelCase,
        WriteIndented = true
    };

    private readonly HttpClient http = new() { Timeout = TimeSpan.FromSeconds(2) };
    private readonly string appDataDir;
    private readonly string[] legacyAppDataDirs;
    private readonly string logsDir;
    private readonly string installDir;
    private readonly string configPath;
    private readonly string stdoutPath;
    private readonly string stderrPath;
    private readonly string embeddedProjectDir;
    private readonly string sourceProjectDir;
    private readonly string embeddedNodePath;
    private readonly string appDataNodePath;

    public ServiceManager()
    {
        appDataDir = Path.Combine(Environment.GetFolderPath(Environment.SpecialFolder.ApplicationData), AppDataName);
        legacyAppDataDirs = LegacyAppDataNames
            .Select(name => Path.Combine(Environment.GetFolderPath(Environment.SpecialFolder.ApplicationData), name))
            .ToArray();
        logsDir = Path.Combine(appDataDir, "logs");
        installDir = Path.Combine(appDataDir, "service");
        configPath = Path.Combine(appDataDir, "launcher.json");
        stdoutPath = Path.Combine(logsDir, "service.out.log");
        stderrPath = Path.Combine(logsDir, "service.err.log");
        embeddedProjectDir = Path.Combine(AppContext.BaseDirectory, "Resources", "CodexMaxProject");
        sourceProjectDir = FindSourceProjectDir(AppContext.BaseDirectory);
        embeddedNodePath = Path.Combine(AppContext.BaseDirectory, "Resources", "node", "node.exe");
        appDataNodePath = Path.Combine(appDataDir, "node", "node.exe");
    }

    public string ShortInstallDirectory => installDir;
    public string LogsDirectory => logsDir;
    public string AndroidApkPath => ResolveAndroidApkPath();
    public string WindowsInstallerPath => ResolveWindowsInstallerPath();

    public async Task PrepareIfNeededAsync()
    {
        MigrateLegacyStateIfNeeded();
        Directory.CreateDirectory(appDataDir);
        Directory.CreateDirectory(logsDir);
        var config = ReadConfig();
        WriteConfig(config);
        if (Directory.Exists(embeddedProjectDir) && File.Exists(Path.Combine(embeddedProjectDir, "server.js")))
        {
            CopyDirectory(embeddedProjectDir, installDir);
        }
        else
        {
            ExtractEmbeddedPayloadIfNeeded();
        }
        await Task.CompletedTask;
    }

    public async Task<ServiceSnapshot> RefreshAsync()
    {
        var config = ReadConfig();
        var state = ResolveState(config);
        var health = await GetHealthAsync(config);
        var (threadCount, latestThreadTitle) = health.Ok
            ? await RefreshThreadsAsync(config)
            : (null, "尚未读取线程");
        return new ServiceSnapshot(
            health.Ok ? ServiceState.Running : state,
            health.Ok,
            config.Port,
            ResolvePid(config),
            threadCount,
            latestThreadTitle,
            health.ControlMode,
            ReadLogPreview(),
            DateTime.Now
        );
    }

    public async Task StartAsync()
    {
        await PrepareIfNeededAsync();
        var config = ReadConfig();
        var projectDir = ResolveServiceProjectDir();
        var serverPath = Path.Combine(projectDir, "server.js");
        var serviceStamp = ComputeServiceStamp(projectDir);
        var healthOk = await CheckHealthAsync(config);
        if (healthOk && !string.IsNullOrWhiteSpace(config.ServiceStamp) && config.ServiceStamp == serviceStamp && !ServiceProcessNeedsRestart(config.Pid, serverPath)) return;

        var requestedPort = config.Port;
        var existingPid = FindPortOwnerPid(config.Port);
        if (existingPid > 0)
        {
            if (existingPid != config.Pid || !IsManagedServiceProcess(existingPid))
            {
                var fallbackPort = FindAvailablePort(requestedPort + 1, 10);
                if (fallbackPort == 0)
                {
                    throw new InvalidOperationException(
                        $"端口 {requestedPort} 已被其他程序占用（PID {existingPid}），且未找到可用的备用端口。"
                    );
                }
                config.Port = fallbackPort;
                WriteConfig(config);
                existingPid = 0;
            }
            else
            {
                await KillProcessTreeAsync(existingPid);
                await Task.Delay(500);
            }
        }

        if (!File.Exists(serverPath))
        {
            throw new InvalidOperationException("没有找到内嵌服务文件 server.js。");
        }

        var nodePath = ResolveNodePath();
        var start = new ProcessStartInfo(nodePath)
        {
            WorkingDirectory = projectDir,
            CreateNoWindow = true,
            UseShellExecute = false,
            WindowStyle = ProcessWindowStyle.Hidden,
            RedirectStandardOutput = true,
            RedirectStandardError = true
        };
        start.ArgumentList.Add("server.js");
        start.Environment["MOBILE_TYPER_TOKEN"] = config.Token;
        start.Environment["PORT"] = config.Port.ToString();
        start.Environment["CODEX_MAX_APP_NAME"] = DisplayName;
        start.Environment["CODEX_MAX_STATE_DIR"] = Path.Combine(Environment.GetFolderPath(Environment.SpecialFolder.UserProfile), ".codex-max");

        var process = StartManagedServiceProcess(start) ?? throw new InvalidOperationException($"启动 {DisplayName} 服务失败。");
        _ = Task.Run(() => AppendProcessOutputAsync(process.StandardOutput, stdoutPath));
        _ = Task.Run(() => AppendProcessOutputAsync(process.StandardError, stderrPath));
        config.Pid = process.Id;
        config.ServiceStamp = serviceStamp;
        WriteConfig(config);

        for (var i = 0; i < 24; i++)
        {
            await Task.Delay(250);
            if (await CheckHealthAsync(config)) return;
        }

        throw new InvalidOperationException($"{DisplayName} 服务启动后没有通过健康检查。" + Environment.NewLine + ReadTail(stderrPath, 1200));
    }

    public async Task StopAsync()
    {
        var config = ReadConfig();
        if (config.Pid > 0 && IsManagedServiceProcess(config.Pid))
        {
            await KillProcessTreeAsync(config.Pid);
        }

        config.Pid = 0;
        config.ServiceStamp = "";
        WriteConfig(config);
        await Task.Delay(350);
    }

    public async Task RestartAsync()
    {
        await StopAsync();
        await Task.Delay(350);
        await StartAsync();
    }

    public async Task<CdpLaunchSnapshot> LaunchControlledCodexAsync()
    {
        var config = ReadConfig();
        if (!await CheckHealthAsync(config)) await StartAsync();
        config = ReadConfig();
        using var launchHttp = new HttpClient { Timeout = TimeSpan.FromSeconds(35) };
        using var response = await launchHttp.PostAsJsonAsync(
            BuildLoopbackServiceUri(config, "/codex/cdp-launch", new Dictionary<string, string?>
            {
                ["token"] = config.Token
            }),
            new { forceRestart = true },
            JsonOptions
        );
        var result = await response.Content.ReadFromJsonAsync<CdpLaunchResponse>(JsonOptions);
        if (!response.IsSuccessStatusCode || result?.Ok != true)
        {
            throw new InvalidOperationException(result?.Message ?? "启动 CDP 受控 ChatGPT 失败。");
        }
        return new CdpLaunchSnapshot(true, result.Message ?? "已启动 CDP 受控 ChatGPT");
    }

    public async Task OpenWebAsync()
    {
        if (!await CheckHealthAsync(ReadConfig())) await StartAsync();
        StartShellOpenHttpUrl(PrimaryEntryUrl());
    }

    public async Task CopyLocalLinkAsync()
    {
        if (!await CheckHealthAsync(ReadConfig())) await StartAsync();
        Clipboard.SetText(PrimaryEntryUrl());
    }

    public void OpenLogs()
    {
        Directory.CreateDirectory(logsDir);
        StartShellOpenDirectory(logsDir);
    }

    private void MigrateLegacyStateIfNeeded()
    {
        if (File.Exists(configPath)) return;
        foreach (var legacyAppDataDir in legacyAppDataDirs)
        {
            var legacyConfigPath = Path.Combine(legacyAppDataDir, "launcher.json");
            if (!File.Exists(legacyConfigPath)) continue;
            Directory.CreateDirectory(appDataDir);
            File.Copy(legacyConfigPath, configPath, overwrite: false);
            return;
        }
    }

    public void OpenAndroidApkLocation()
    {
        OpenArtifactLocation(AndroidApkPath, "没有找到 Android APK。请先构建 Android App。");
    }

    public void OpenWindowsInstallerLocation()
    {
        OpenArtifactLocation(WindowsInstallerPath, "没有找到 Windows 安装包。请先构建 Windows 安装包。");
    }

    public string PrimaryEntryUrl()
    {
        var urls = EntryUrls().ToList();
        return urls.Count > 1 ? urls[1] : urls[0];
    }

    public IEnumerable<string> EntryUrls()
    {
        var config = ReadConfig();
        var token = Uri.EscapeDataString(config.Token);
        yield return $"http://localhost:{config.Port}/?token={token}";
        foreach (var address in LanAddresses())
        {
            yield return $"http://{address}:{config.Port}/?token={token}";
        }
    }

    private static Uri BuildLoopbackServiceUri(LauncherConfig config, string path, IReadOnlyDictionary<string, string?>? query = null)
    {
        if (config.Port < 1 || config.Port > 65535)
        {
            throw new InvalidOperationException("本地服务端口无效。");
        }

        var builder = new UriBuilder(Uri.UriSchemeHttp, IPAddress.Loopback.ToString(), config.Port, NormalizeHttpPath(path));
        if (query is not null && query.Count > 0)
        {
            builder.Query = string.Join("&", query
                .Where(item => item.Value is not null)
                .Select(item => $"{Uri.EscapeDataString(item.Key)}={Uri.EscapeDataString(item.Value ?? "")}"));
        }
        return ValidateLoopbackHttpUri(builder.Uri);
    }

    private static Uri ValidateLoopbackHttpUri(Uri uri)
    {
        if (!uri.IsAbsoluteUri || uri.Scheme != Uri.UriSchemeHttp)
        {
            throw new InvalidOperationException("本地服务 URL 必须使用 http。");
        }
        if (!IPAddress.TryParse(uri.Host, out var host) || !IPAddress.IsLoopback(host))
        {
            throw new InvalidOperationException("本地服务 URL 必须指向环回地址。");
        }
        if (uri.Port < 1 || uri.Port > 65535)
        {
            throw new InvalidOperationException("本地服务 URL 端口无效。");
        }
        return uri;
    }

    private static string NormalizeHttpPath(string path)
    {
        var value = string.IsNullOrWhiteSpace(path) ? "/" : path.Trim();
        return value.StartsWith("/", StringComparison.Ordinal) ? value : "/" + value;
    }

    private static Process? StartManagedServiceProcess(ProcessStartInfo start)
    {
        if (start.UseShellExecute || !Path.GetFileName(start.FileName).Equals("node.exe", StringComparison.OrdinalIgnoreCase))
        {
            throw new InvalidOperationException("只能启动受控的 Node.js 服务进程。");
        }
        if (start.ArgumentList.Count != 1 || !start.ArgumentList[0].Equals("server.js", StringComparison.OrdinalIgnoreCase))
        {
            throw new InvalidOperationException("服务进程参数无效。");
        }
        return StartPreparedProcess(start);
    }

    private static Process? StartCheckedProcess(ProcessStartInfo start, string expectedFileName)
    {
        if (start.UseShellExecute || !Path.GetFileName(start.FileName).Equals(expectedFileName, StringComparison.OrdinalIgnoreCase))
        {
            throw new InvalidOperationException("进程启动目标无效。");
        }
        return StartPreparedProcess(start);
    }

    private static Process? StartPreparedProcess(ProcessStartInfo start)
    {
        var process = new Process { StartInfo = start };
        if (process.Start()) return process;
        process.Dispose();
        return null;
    }

    private static Process? StartCheckedShellOpen(ProcessStartInfo start)
    {
        if (!start.UseShellExecute || string.IsNullOrWhiteSpace(start.FileName))
        {
            throw new InvalidOperationException("Shell 打开目标无效。");
        }
        return StartPreparedProcess(start);
    }

    private static void StartShellOpenHttpUrl(string value)
    {
        if (!Uri.TryCreate(value, UriKind.Absolute, out var uri))
        {
            throw new InvalidOperationException("打开的 URL 无效。");
        }
        if (uri.Scheme != Uri.UriSchemeHttp && uri.Scheme != Uri.UriSchemeHttps)
        {
            throw new InvalidOperationException("只能打开 http/https URL。");
        }
        if (!uri.Host.Equals("localhost", StringComparison.OrdinalIgnoreCase) &&
            (!IPAddress.TryParse(uri.Host, out var address) || IPAddress.IsLoopback(address) == false && !IsUsableLanAddress(address)))
        {
            throw new InvalidOperationException("只能打开本地服务 URL。");
        }
        var start = new ProcessStartInfo(uri.ToString()) { UseShellExecute = true };
        StartCheckedShellOpen(start);
    }

    private static void StartShellOpenDirectory(string directory)
    {
        var fullPath = Path.GetFullPath(directory);
        if (!Directory.Exists(fullPath))
        {
            throw new InvalidOperationException("打开的目录不存在。");
        }
        var start = new ProcessStartInfo(fullPath) { UseShellExecute = true };
        StartCheckedShellOpen(start);
    }

    private static void StartExplorerSelectFile(string file)
    {
        var fullPath = Path.GetFullPath(file);
        if (!File.Exists(fullPath))
        {
            throw new InvalidOperationException("打开的文件不存在。");
        }
        var start = new ProcessStartInfo("explorer.exe")
        {
            UseShellExecute = false
        };
        start.ArgumentList.Add("/select," + fullPath);
        StartCheckedProcess(start, "explorer.exe");
    }

    private async Task<bool> CheckHealthAsync(LauncherConfig config)
    {
        return (await GetHealthAsync(config)).Ok;
    }

    public async Task<string?> CheckForUpdateAsync()
    {
        var config = ReadConfig();
        try
        {
            var uri = BuildLoopbackServiceUri(config, "/codex/config", new Dictionary<string, string?>
            {
                ["token"] = config.Token
            });
            using var response = await http.GetAsync(uri);
            if (!response.IsSuccessStatusCode) return null;
            var payload = await response.Content.ReadFromJsonAsync<ClientConfigResponse>(JsonOptions);
            var update = payload?.Update;
            if (update is null) return null;

            var lines = new List<string>();
            var currentVersion = typeof(ServiceManager).Assembly.GetName().Version?.ToString(3) ?? "3.1.1";
            if (update.Windows is { Available: true } windows &&
                TryParseVersion(windows.LatestVersion, out var latestWindows) &&
                TryParseVersion(currentVersion, out var current) &&
                latestWindows > current)
            {
                lines.Add($"电脑版新版本 v{windows.LatestVersion} 可下载安装。");
            }

            if (update.Android is { Available: true } android && !string.IsNullOrWhiteSpace(android.LatestVersion))
            {
                var localApk = AndroidApkPath;
                var localVersion = localApk != null && File.Exists(localApk)
                    ? Path.GetFileNameWithoutExtension(localApk)
                    : "";
                if (localVersion.IndexOf(android.LatestVersion, StringComparison.OrdinalIgnoreCase) < 0)
                {
                    lines.Add($"Android 客户端最新版本 v{android.LatestVersion}。");
                }
            }

            return lines.Count == 0 ? null : string.Join(Environment.NewLine, lines);
        }
        catch
        {
            return null;
        }
    }

    private static bool TryParseVersion(string? text, out Version version)
    {
        version = new Version();
        if (string.IsNullOrWhiteSpace(text)) return false;
        if (!Version.TryParse(text.TrimStart('v'), out var parsed) || parsed is null) return false;
        version = parsed;
        return true;
    }

    private async Task<HealthSnapshot> GetHealthAsync(LauncherConfig config)
    {
        try
        {
            // /codex/health 不校验 token，健康状态必须走需鉴权的 /codex/config
            using var response = await http.GetAsync(BuildLoopbackServiceUri(config, "/codex/config", new Dictionary<string, string?>
            {
                ["token"] = config.Token
            }));
            if (!response.IsSuccessStatusCode) return new HealthSnapshot(false, "");
            var payload = await response.Content.ReadFromJsonAsync<ClientConfigResponse>(JsonOptions);
            if (payload?.Ok != true) return new HealthSnapshot(false, "");
            var controlMode = "";
            try
            {
                using var healthResponse = await http.GetAsync(BuildLoopbackServiceUri(config, "/codex/health"));
                var health = await healthResponse.Content.ReadFromJsonAsync<HealthResponse>(JsonOptions);
                controlMode = health?.ControlMode ?? "";
            }
            catch
            {
            }
            return new HealthSnapshot(true, controlMode);
        }
        catch
        {
            return new HealthSnapshot(false, "");
        }
    }

    private async Task<(int? Count, string LatestTitle)> RefreshThreadsAsync(LauncherConfig config)
    {
        try
        {
            var summary = await http.GetFromJsonAsync<ThreadSummary>(BuildLoopbackServiceUri(config, "/codex/threads", new Dictionary<string, string?>
            {
                ["limit"] = "20",
                ["token"] = config.Token
            }));
            var rows = summary?.Threads ?? new List<ThreadRow>();
            var title = rows.FirstOrDefault()?.Title ?? rows.FirstOrDefault()?.Name ?? "暂无线程";
            return (rows.Count, title);
        }
        catch
        {
            return (null, "尚未读取线程");
        }
    }

    private LauncherConfig ReadConfig()
    {
        try
        {
            if (File.Exists(configPath))
            {
                var loaded = JsonSerializer.Deserialize<LauncherConfig>(File.ReadAllText(configPath), JsonOptions);
                if (loaded is not null && !string.IsNullOrWhiteSpace(loaded.Token))
                {
                    if (loaded.Port <= 0) loaded.Port = DefaultPort;
                    return loaded;
                }
            }
        }
        catch
        {
        }
        var persistedToken = ReadPersistedToken();
        if (!string.IsNullOrWhiteSpace(persistedToken))
        {
            var config = new LauncherConfig { Token = persistedToken, Port = DefaultPort };
            WriteConfig(config);
            return config;
        }
        return new LauncherConfig { Token = GenerateToken(), Port = DefaultPort };
    }

    private void WriteConfig(LauncherConfig config)
    {
        Directory.CreateDirectory(appDataDir);
        File.WriteAllText(configPath, JsonSerializer.Serialize(config, JsonOptions), new UTF8Encoding(false));
    }

    private ServiceState ResolveState(LauncherConfig config)
    {
        if (!File.Exists(Path.Combine(ResolveServiceProjectDir(), "server.js"))) return ServiceState.NotInstalled;
        var pid = ResolvePid(config);
        return pid.HasValue ? ServiceState.Running : ServiceState.Stopped;
    }

    private int? ResolvePid(LauncherConfig config)
    {
        var portPid = FindPortOwnerPid(config.Port);
        if (portPid > 0) return portPid;
        if (config.Pid > 0)
        {
            try
            {
                using var process = Process.GetProcessById(config.Pid);
                if (!process.HasExited) return config.Pid;
            }
            catch
            {
            }
        }
        return null;
    }

    private string ResolveServiceProjectDir()
    {
        if (Directory.Exists(installDir) && File.Exists(Path.Combine(installDir, "server.js"))) return installDir;
        if (Directory.Exists(embeddedProjectDir) && File.Exists(Path.Combine(embeddedProjectDir, "server.js"))) return embeddedProjectDir;
        return sourceProjectDir;
    }

    private static string ComputeServiceStamp(string projectDir)
    {
        try
        {
            using var sha = SHA256.Create();
            foreach (var relativePath in new[] {
                "server.js",
                Path.Combine("public", "index.html"),
                Path.Combine("src", "platform", "win32.js"),
                Path.Combine("src", "platform", "index.js")
            })
            {
                var file = Path.Combine(projectDir, relativePath);
                if (!File.Exists(file)) continue;
                sha.TransformBlock(Encoding.UTF8.GetBytes(relativePath), 0, Encoding.UTF8.GetByteCount(relativePath), null, 0);
                var bytes = File.ReadAllBytes(file);
                sha.TransformBlock(bytes, 0, bytes.Length, null, 0);
            }
            sha.TransformFinalBlock(Array.Empty<byte>(), 0, 0);
            return Convert.ToHexString(sha.Hash ?? Array.Empty<byte>());
        }
        catch
        {
            return "";
        }
    }

    private string ResolveNodePath()
    {
        if (File.Exists(appDataNodePath)) return appDataNodePath;
        if (File.Exists(embeddedNodePath)) return embeddedNodePath;
        var pathEnv = Environment.GetEnvironmentVariable("PATH") ?? "";
        foreach (var dir in pathEnv.Split(Path.PathSeparator, StringSplitOptions.RemoveEmptyEntries))
        {
            var candidate = Path.Combine(dir.Trim(), "node.exe");
            if (File.Exists(candidate)) return candidate;
        }
        throw new InvalidOperationException("没有找到 Node.js。请安装 Node.js 20+，或在 App 资源中内置 node.exe。");
    }

    private string ResolveWindowsInstallerPath()
    {
        var names = new[] { "Codex-Remote-Bridge-Windows-Setup.exe", "ChatGPT-Win-Windows-Setup.exe" };
        foreach (var name in names)
        {
            var sourceCandidate = Path.Combine(sourceProjectDir, "dist", "windows", "installer", name);
            if (File.Exists(sourceCandidate)) return sourceCandidate;
            var baseCandidate = Path.Combine(AppContext.BaseDirectory, "dist", "windows", "installer", name);
            if (File.Exists(baseCandidate)) return baseCandidate;
        }
        return Path.Combine(sourceProjectDir, "dist", "windows", "installer", names[0]);
    }

    private string ResolveAndroidApkPath()
    {
        var releaseCandidate = Path.Combine(sourceProjectDir, "dist", "android", "ChatGPT-AZ-Android-v1.2.0.apk");
        if (File.Exists(releaseCandidate)) return releaseCandidate;
        var releaseBuildCandidate = Path.Combine("C:\\", "CodexBuild", "AndroidOutput", "outputs", "apk", "release", "app-release.apk");
        if (File.Exists(releaseBuildCandidate)) return releaseBuildCandidate;
        var debugCandidate = Path.Combine("C:\\", "CodexBuild", "AndroidOutput", "outputs", "apk", "debug", "app-debug.apk");
        if (File.Exists(debugCandidate)) return debugCandidate;
        return releaseCandidate;
    }

    private static void OpenArtifactLocation(string file, string missingMessage)
    {
        if (File.Exists(file))
        {
            StartExplorerSelectFile(file);
            return;
        }

        var directory = Path.GetDirectoryName(file);
        if (!string.IsNullOrWhiteSpace(directory) && Directory.Exists(directory))
        {
            StartShellOpenDirectory(directory);
            throw new InvalidOperationException($"{missingMessage}{Environment.NewLine}已打开目录：{directory}");
        }

        throw new InvalidOperationException($"{missingMessage}{Environment.NewLine}{file}");
    }

    private bool ExtractEmbeddedPayloadIfNeeded()
    {
        var assembly = typeof(ServiceManager).Assembly;
        var resourceName = assembly.GetManifestResourceNames()
            .FirstOrDefault(name => name.EndsWith("CodexMaxPayload.zip", StringComparison.OrdinalIgnoreCase));
        if (string.IsNullOrWhiteSpace(resourceName)) return false;
        using var stream = assembly.GetManifestResourceStream(resourceName);
        if (stream is null) return false;

        using var archive = new ZipArchive(stream, ZipArchiveMode.Read);
        foreach (var entry in archive.Entries)
        {
            if (string.IsNullOrWhiteSpace(entry.Name)) continue;
            var relative = entry.FullName.Replace('/', Path.DirectorySeparatorChar);
            if (relative.Equals(Path.Combine("node", "node.exe"), StringComparison.OrdinalIgnoreCase) &&
                File.Exists(appDataNodePath))
            {
                continue;
            }
            var target = Path.GetFullPath(Path.Combine(appDataDir, relative));
            var appDataRoot = Path.GetFullPath(appDataDir);
            if (!IsWithinDirectory(appDataRoot, target)) continue;
            Directory.CreateDirectory(Path.GetDirectoryName(target)!);
            entry.ExtractToFile(target, overwrite: true);
        }
        return true;
    }

    private static bool IsWithinDirectory(string root, string target)
    {
        var rootPrefix = root.EndsWith(Path.DirectorySeparatorChar.ToString(), StringComparison.Ordinal)
            ? root
            : root + Path.DirectorySeparatorChar;
        return target.StartsWith(rootPrefix, StringComparison.OrdinalIgnoreCase);
    }

    private string ReadLogPreview()
    {
        foreach (var file in new[] { stderrPath, stdoutPath })
        {
            var text = ReadTail(file, 1200).Trim();
            if (!string.IsNullOrWhiteSpace(text)) return text;
        }
        return "";
    }

    private static string ReadTail(string file, int maxChars)
    {
        try
        {
            if (!File.Exists(file)) return "";
            var text = File.ReadAllText(file);
            return text.Length <= maxChars ? text : text[^maxChars..];
        }
        catch
        {
            return "";
        }
    }

    private static string ReadPersistedToken()
    {
        try
        {
            var tokenFile = Path.Combine(
                Environment.GetFolderPath(Environment.SpecialFolder.UserProfile),
                ".codex-max",
                "token");
            if (!File.Exists(tokenFile)) return "";
            var token = File.ReadAllText(tokenFile).Trim();
            return token.Length >= 16 && token.Length <= 64 ? token : "";
        }
        catch
        {
            return "";
        }
    }

    private static string GenerateToken()
    {
        var bytes = RandomNumberGenerator.GetBytes(18);
        return Convert.ToBase64String(bytes).TrimEnd('=').Replace('+', '-').Replace('/', '_');
    }

    private static string FindSourceProjectDir(string start)
    {
        var current = new DirectoryInfo(start);
        while (current is not null)
        {
            if (File.Exists(Path.Combine(current.FullName, "server.js")) &&
                Directory.Exists(Path.Combine(current.FullName, "public")))
            {
                return current.FullName;
            }
            current = current.Parent;
        }
        return start;
    }

    private static IEnumerable<string> LanAddresses()
    {
        var rows = NetworkInterface.GetAllNetworkInterfaces()
            .Where(item => item.OperationalStatus == OperationalStatus.Up)
            .SelectMany(item => item.GetIPProperties().UnicastAddresses)
            .Where(item => item.Address.AddressFamily == System.Net.Sockets.AddressFamily.InterNetwork)
            .Select(item => item.Address)
            .Where(IsUsableLanAddress)
            .Select(address => address.ToString())
            .Distinct()
            .ToList();

        return rows
            .OrderBy(address => LanAddressPriority(address))
            .ThenBy(address => address, StringComparer.Ordinal);
    }

    private static bool IsUsableLanAddress(IPAddress address)
    {
        if (IPAddress.IsLoopback(address)) return false;
        var bytes = address.GetAddressBytes();
        if (bytes.Length != 4) return false;
        if (bytes[0] == 169 && bytes[1] == 254) return false;
        if (bytes[0] == 198 && (bytes[1] == 18 || bytes[1] == 19)) return false;
        if (bytes[0] == 100 && bytes[1] >= 64 && bytes[1] <= 127) return false;
        if (bytes[0] == 172 && bytes[1] >= 16 && bytes[1] <= 31) return true;
        if (bytes[0] == 192 && bytes[1] == 168) return true;
        if (bytes[0] == 10) return true;
        return false;
    }

    private static int LanAddressPriority(string address)
    {
        if (address.StartsWith("192.168.", StringComparison.Ordinal)) return 0;
        if (address.StartsWith("10.", StringComparison.Ordinal)) return 1;
        if (address.StartsWith("172.", StringComparison.Ordinal)) return 2;
        return 9;
    }

    private static int FindPortOwnerPid(int port)
    {
        try
        {
            var start = new ProcessStartInfo("netstat.exe", "-ano -p tcp")
            {
                CreateNoWindow = true,
                UseShellExecute = false,
                RedirectStandardOutput = true,
                RedirectStandardError = true
            };
            using var process = StartCheckedProcess(start, "netstat.exe");
            if (process is null) return 0;
            var output = process.StandardOutput.ReadToEnd();
            process.WaitForExit(2500);
            foreach (var line in output.Split('\n'))
            {
                var parts = line.Split(' ', StringSplitOptions.RemoveEmptyEntries);
                if (parts.Length < 5) continue;
                if (!parts[0].Equals("TCP", StringComparison.OrdinalIgnoreCase)) continue;
                if (!parts[1].EndsWith($":{port}", StringComparison.Ordinal)) continue;
                if (!parts[3].Equals("LISTENING", StringComparison.OrdinalIgnoreCase)) continue;
                if (int.TryParse(parts[4], out var pid)) return pid;
            }
        }
        catch
        {
        }
        return 0;
    }

    private static int FindAvailablePort(int startPort, int maxTries)
    {
        for (var i = 0; i < maxTries; i++)
        {
            var candidate = startPort + i;
            if (candidate < 1 || candidate > 65535) break;
            if (FindPortOwnerPid(candidate) == 0) return candidate;
        }
        return 0;
    }

    private static bool IsManagedServiceProcess(int pid)
    {
        try
        {
            using var process = Process.GetProcessById(pid);
            var name = process.ProcessName;
            if (!name.Equals("node", StringComparison.OrdinalIgnoreCase)) return false;
            var commandLine = GetProcessCommandLine(pid);
            if (commandLine.Contains("server.js", StringComparison.OrdinalIgnoreCase)) return true;
            if (commandLine.Contains("CodexMaxProject", StringComparison.OrdinalIgnoreCase)) return true;
            if (commandLine.Contains("Codex Remote Bridge", StringComparison.OrdinalIgnoreCase)) return true;
            if (commandLine.Contains("ChatGPT Win", StringComparison.OrdinalIgnoreCase)) return true;
            if (commandLine.Contains("Codex Max", StringComparison.OrdinalIgnoreCase)) return true;
            return false;
        }
        catch
        {
            return false;
        }
    }

    private static bool ServiceProcessNeedsRestart(int pid, string serverPath)
    {
        if (pid <= 0 || !File.Exists(serverPath)) return false;
        try
        {
            using var process = Process.GetProcessById(pid);
            return !process.HasExited && File.GetLastWriteTimeUtc(serverPath) > process.StartTime.ToUniversalTime();
        }
        catch
        {
            return false;
        }
    }

    private static async Task KillProcessTreeAsync(int pid)
    {
        try
        {
            using var process = Process.GetProcessById(pid);
            if (process.HasExited) return;
            process.Kill(entireProcessTree: true);
            await process.WaitForExitAsync();
        }
        catch
        {
        }
    }

    private static async Task AppendProcessOutputAsync(StreamReader reader, string file)
    {
        try
        {
            Directory.CreateDirectory(Path.GetDirectoryName(file)!);
            await using var stream = new FileStream(file, FileMode.Append, FileAccess.Write, FileShare.ReadWrite);
            await using var writer = new StreamWriter(stream, new UTF8Encoding(false));
            while (!reader.EndOfStream)
            {
                var line = await reader.ReadLineAsync();
                if (line is null) break;
                await writer.WriteLineAsync(line);
                await writer.FlushAsync();
            }
        }
        catch
        {
        }
    }

    private static string GetProcessCommandLine(int pid)
    {
        try
        {
            var start = new ProcessStartInfo("powershell.exe")
            {
                CreateNoWindow = true,
                UseShellExecute = false,
                RedirectStandardOutput = true,
                RedirectStandardError = true
            };
            start.ArgumentList.Add("-NoLogo");
            start.ArgumentList.Add("-NoProfile");
            start.ArgumentList.Add("-NonInteractive");
            start.ArgumentList.Add("-ExecutionPolicy");
            start.ArgumentList.Add("Bypass");
            start.ArgumentList.Add("-Command");
            start.ArgumentList.Add("(Get-CimInstance Win32_Process -Filter 'ProcessId = " + pid.ToString() + "').CommandLine");
            using var process = StartCheckedProcess(start, "powershell.exe");
            if (process is null) return "";
            var output = process.StandardOutput.ReadToEnd();
            process.WaitForExit(2500);
            return output.Trim();
        }
        catch
        {
            return "";
        }
    }

    private static void CopyDirectory(string sourceDir, string targetDir)
    {
        Directory.CreateDirectory(targetDir);
        foreach (var directory in Directory.EnumerateDirectories(sourceDir, "*", SearchOption.AllDirectories))
        {
            Directory.CreateDirectory(Path.Combine(targetDir, Path.GetRelativePath(sourceDir, directory)));
        }
        foreach (var file in Directory.EnumerateFiles(sourceDir, "*", SearchOption.AllDirectories))
        {
            var target = Path.Combine(targetDir, Path.GetRelativePath(sourceDir, file));
            Directory.CreateDirectory(Path.GetDirectoryName(target)!);
            File.Copy(file, target, overwrite: true);
        }
    }

    private sealed class ClientConfigResponse
    {
        [JsonPropertyName("ok")]
        public bool Ok { get; set; }

        [JsonPropertyName("update")]
        public UpdateInfo? Update { get; set; }
    }

    private sealed class UpdateInfo
    {
        [JsonPropertyName("service")]
        public string? Service { get; set; }

        [JsonPropertyName("android")]
        public PlatformUpdate? Android { get; set; }

        [JsonPropertyName("windows")]
        public PlatformUpdate? Windows { get; set; }
    }

    private sealed class PlatformUpdate
    {
        [JsonPropertyName("available")]
        public bool Available { get; set; }

        [JsonPropertyName("latestVersion")]
        public string? LatestVersion { get; set; }

        [JsonPropertyName("fileName")]
        public string? FileName { get; set; }
    }

    private sealed class LauncherConfig
    {
        public string Token { get; set; } = "";
        public int Port { get; set; } = DefaultPort;
        public int Pid { get; set; }
        public string ServiceStamp { get; set; } = "";
    }

    private sealed class ThreadSummary
    {
        [JsonPropertyName("threads")]
        public List<ThreadRow> Threads { get; set; } = new();
    }

    private sealed class ThreadRow
    {
        [JsonPropertyName("title")]
        public string? Title { get; set; }

        [JsonPropertyName("name")]
        public string? Name { get; set; }
    }

    private sealed class HealthResponse
    {
        [JsonPropertyName("ok")]
        public bool Ok { get; set; }

        [JsonPropertyName("controlMode")]
        public string? ControlMode { get; set; }
    }

    private sealed class CdpLaunchResponse
    {
        [JsonPropertyName("ok")]
        public bool Ok { get; set; }

        [JsonPropertyName("message")]
        public string? Message { get; set; }
    }
}
