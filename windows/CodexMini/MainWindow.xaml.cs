using System.IO;
using System.Windows;
using System.Windows.Media;
using System.Windows.Media.Imaging;
using System.Windows.Threading;
using QRCoder;
using WpfControl = System.Windows.Controls.Control;
using WpfMessageBox = System.Windows.MessageBox;

namespace CodexMiniWin;

public partial class MainWindow : Window
{
    private readonly ServiceManager service = new();
    private readonly DispatcherTimer refreshTimer = new() { Interval = TimeSpan.FromSeconds(5) };
    private readonly List<WpfControl> actionControls;
    private bool serviceRunning;

    public MainWindow()
    {
        Icon = LoadWindowIcon();
        InitializeComponent();
        actionControls = new List<WpfControl>
        {
            OpenWebButton,
            CopyLinkButton,
            LaunchCdpButton,
            LanDiagnosticButton,
            OpenApkButton,
            OpenInstallerButton,
            UpdateButton,
            RestartButton,
            RefreshButton,
            OpenLogsButton,
            StartStopButton
        };
        refreshTimer.Tick += async (_, _) => await RefreshStateAsync();
        Loaded += async (_, _) =>
        {
            await RunActionAsync(async () =>
            {
                await service.PrepareIfNeededAsync();
                await service.StartAsync();
            });
            await RefreshStateAsync();
            await CheckUpdateOnceAsync();
            refreshTimer.Start();
        };
        Closed += (_, _) => refreshTimer.Stop();
    }

    private async void OpenWeb_Click(object sender, RoutedEventArgs e)
    {
        await RunActionAsync(async () => await service.OpenWebAsync());
        await RefreshStateAsync();
    }

    private async void CopyLink_Click(object sender, RoutedEventArgs e)
    {
        await RunActionAsync(async () =>
        {
            await service.CopyLocalLinkAsync();
            WpfMessageBox.Show(this, "已复制本机链接", "Codex Remote Bridge", MessageBoxButton.OK, MessageBoxImage.Information);
        });
        await RefreshStateAsync();
    }

    private async void Restart_Click(object sender, RoutedEventArgs e)
    {
        await RunActionAsync(async () => await service.RestartAsync());
        await RefreshStateAsync();
    }

    private async void LaunchCdp_Click(object sender, RoutedEventArgs e)
    {
        await RunActionAsync(async () =>
        {
            var result = await service.LaunchControlledCodexAsync();
            WpfMessageBox.Show(this, result.Message, "Codex Remote Bridge", MessageBoxButton.OK, MessageBoxImage.Information);
        });
        await RefreshStateAsync();
    }

    private async void LanDiagnostic_Click(object sender, RoutedEventArgs e)
    {
        await RunActionAsync(async () =>
        {
            var snapshot = await service.RefreshAsync();
            WpfMessageBox.Show(this, BuildDiagnosticMessage(snapshot), "局域网诊断", MessageBoxButton.OK, MessageBoxImage.Information);
        });
        await RefreshStateAsync();
    }

    private void OpenApk_Click(object sender, RoutedEventArgs e)
    {
        try
        {
            service.OpenAndroidApkLocation();
        }
        catch (Exception ex)
        {
            WpfMessageBox.Show(this, ex.Message, "Android APK", MessageBoxButton.OK, MessageBoxImage.Warning);
        }
    }

    private void OpenInstaller_Click(object sender, RoutedEventArgs e)
    {
        try
        {
            service.OpenWindowsInstallerLocation();
        }
        catch (Exception ex)
        {
            WpfMessageBox.Show(this, ex.Message, "Windows 安装包", MessageBoxButton.OK, MessageBoxImage.Warning);
        }
    }

    private async void Refresh_Click(object sender, RoutedEventArgs e)
    {
        await RefreshStateAsync();
    }

    private void OpenLogs_Click(object sender, RoutedEventArgs e)
    {
        service.OpenLogs();
    }

    private async void StartStop_Click(object sender, RoutedEventArgs e)
    {
        await RunActionAsync(async () =>
        {
            if (serviceRunning) await service.StopAsync();
            else await service.StartAsync();
        });
        await RefreshStateAsync();
    }

    private bool updateChecked;
    private UpdateCheckResult? latestUpdate;

    private async void Update_Click(object sender, RoutedEventArgs e)
    {
        await CheckUpdateOnceAsync(force: true);
    }

    private async Task CheckUpdateOnceAsync(bool force = false)
    {
        if (updateChecked && !force) return;
        updateChecked = true;
        var update = await service.CheckForUpdateAsync();
        latestUpdate = update;
        if (update is null)
        {
            if (force) WpfMessageBox.Show(this, "当前已是最新版本，或暂时无法访问更新服务。", "检查更新", MessageBoxButton.OK, MessageBoxImage.Information);
            return;
        }

        var size = update.SizeBytes > 0 ? $"大小：{update.SizeBytes / 1024d / 1024d:F1} MB" : "大小：未知";
        var signature = update.SignatureVerified ? "签名：已验证" : "签名：发布清单未提供数字签名";
        var message = $"发现 Windows 新版本 v{update.LatestVersion}。{Environment.NewLine}{size}{Environment.NewLine}{signature}";
        var result = WpfMessageBox.Show(this, message + Environment.NewLine + Environment.NewLine + "现在下载并校验后启动安装程序吗？", "发现新版本", MessageBoxButton.YesNo, MessageBoxImage.Information);
        if (result != MessageBoxResult.Yes) return;

        try
        {
            SetBusy(true);
            var progress = new Progress<double>(value => UpdatedAt.Text = $"下载更新 {value:P0}");
            var installer = await service.DownloadAndInstallUpdateAsync(update, progress);
            WpfMessageBox.Show(this, $"已完成下载、大小检查和 SHA-256 校验。安装程序已启动：{Environment.NewLine}{installer}", "更新已准备", MessageBoxButton.OK, MessageBoxImage.Information);
        }
        catch (Exception ex)
        {
            WpfMessageBox.Show(this, $"更新失败，当前版本保持不变。{Environment.NewLine}{ex.Message}", "更新失败", MessageBoxButton.OK, MessageBoxImage.Warning);
        }
        finally
        {
            SetBusy(false);
        }
    }

    private async Task RefreshStateAsync()
    {
        var snapshot = await service.RefreshAsync();
        serviceRunning = snapshot.HealthOk;
        var good = (SolidColorBrush)FindResource("GreenBrush");
        var warn = (SolidColorBrush)FindResource("OrangeBrush");
        var bad = (SolidColorBrush)FindResource("DangerBrush");
        var statusBrush = snapshot.HealthOk ? good : snapshot.State == ServiceState.Running ? warn : bad;
        StateDot.Foreground = statusBrush;
        StateText.Foreground = statusBrush;
        StateText.Text = StateTextFor(snapshot.State);
        HttpValue.Foreground = snapshot.HealthOk ? good : warn;
        HttpValue.Text = snapshot.HealthOk ? "正常" : snapshot.State == ServiceState.Running ? "异常" : "离线";
        HttpFootnote.Text = snapshot.HealthOk
            ? (snapshot.ControlMode == "cdp" ? "CDP 无感控制" : "GUI 回退控制")
            : "健康检查不可用";
        PhoneValue.Foreground = snapshot.HealthOk ? good : warn;
        PhoneValue.Text = snapshot.HealthOk ? "可扫码" : "待启动";
        PhoneFootnote.Text = snapshot.HealthOk ? "手机 App/WebView 可连接" : "先启动服务再扫码";
        PhoneQrStatus.Text = snapshot.HealthOk ? "入口就绪 / 等待手机" : "服务未启动 / 先重启";
        PhoneQrStatus.Foreground = snapshot.HealthOk ? good : warn;
        PortValue.Text = snapshot.Port.ToString();
        PortFootnote.Text = snapshot.Pid.HasValue ? $"PID {snapshot.Pid}" : "等待监听";
        InstallPath.Text = service.ShortInstallDirectory;
        UpdatedAt.Text = "更新于 " + snapshot.LastUpdated.ToString("HH:mm:ss");
        EntryKind.Text = "本机入口";
        var entryUrl = service.PrimaryEntryUrl();
        EntryUrl.Text = entryUrl;
        QrUrl.Text = entryUrl;
        QrImage.Source = QrCodeImage(entryUrl);
        LogPreview.Text = string.IsNullOrWhiteSpace(snapshot.LogPreview)
            ? "暂无最近日志"
            : "最近日志已收起，完整内容可从右侧打开";
        StartStopButton.Content = snapshot.HealthOk ? "\uE71A 停止" : "\uE768 启动";
    }

    private string BuildDiagnosticMessage(ServiceSnapshot snapshot)
    {
        var urls = service.EntryUrls().ToList();
        var lanUrls = urls.Where(url => !url.Contains("localhost", StringComparison.OrdinalIgnoreCase)).ToList();
        var androidApkExists = File.Exists(service.AndroidApkPath);
        var windowsInstallerExists = File.Exists(service.WindowsInstallerPath);
        var lines = new List<string>
        {
            $"服务状态：{StateTextFor(snapshot.State)}",
            $"健康检查：{(snapshot.HealthOk ? "正常" : "异常/未启动")}",
            $"控制模式：{(string.IsNullOrWhiteSpace(snapshot.ControlMode) ? "-" : snapshot.ControlMode.ToUpperInvariant())}",
            $"监听端口：{snapshot.Port}",
            $"服务 PID：{(snapshot.Pid.HasValue ? snapshot.Pid.Value.ToString() : "-")}",
            $"手机入口：{(snapshot.HealthOk ? "可扫码连接" : "服务未健康，建议先点“启动/重启服务”")}",
            "",
            "可用入口："
        };

        lines.AddRange(urls.Select(url => "  " + url));
        if (lanUrls.Count == 0)
        {
            lines.Add("  未发现可用局域网 IPv4 地址，请检查 Wi‑Fi/网卡状态。");
        }

        lines.Add("");
        lines.Add($"Android APK：{(androidApkExists ? "已生成" : "未找到")}");
        lines.Add(service.AndroidApkPath);
        lines.Add($"Windows 安装包：{(windowsInstallerExists ? "已生成" : "未找到")}");
        lines.Add(service.WindowsInstallerPath);
        lines.Add("");
        lines.Add("排查建议：");
        lines.Add("1. 手机和电脑连接同一个 Wi‑Fi。");
        lines.Add($"2. Windows 防火墙允许端口 {snapshot.Port} 入站访问。");
        lines.Add("3. 如果 token 无效，重新扫描控制台二维码。");
        lines.Add("4. 如果手机打不开，先点“重启服务”，再重新扫码。");
        return string.Join(Environment.NewLine, lines);
    }

    private async Task RunActionAsync(Func<Task> action)
    {
        SetBusy(true);
        try
        {
            await action();
        }
        catch (Exception ex)
        {
            WpfMessageBox.Show(this, ex.Message, "Codex Remote Bridge", MessageBoxButton.OK, MessageBoxImage.Error);
        }
        finally
        {
            SetBusy(false);
        }
    }

    private void SetBusy(bool busy)
    {
        Cursor = busy ? System.Windows.Input.Cursors.Wait : null;
        foreach (var control in actionControls) control.IsEnabled = !busy;
    }

    private static BitmapImage QrCodeImage(string text)
    {
        using var generator = new QRCodeGenerator();
        using var data = generator.CreateQrCode(text, QRCodeGenerator.ECCLevel.M);
        var png = new PngByteQRCode(data);
        var bytes = png.GetGraphic(8, [20, 24, 32], [247, 250, 255], true);
        using var stream = new MemoryStream(bytes);
        var image = new BitmapImage();
        image.BeginInit();
        image.CacheOption = BitmapCacheOption.OnLoad;
        image.StreamSource = stream;
        image.EndInit();
        image.Freeze();
        return image;
    }

    private static string StateTextFor(ServiceState state) => state switch
    {
        ServiceState.NotInstalled => "未安装",
        ServiceState.Running => "运行中",
        ServiceState.Stopped => "已停止",
        _ => "未知"
    };

    // 单文件发布模式下 XAML 无法解析 Content 文件的相对 URI（ContentFilePart 缺陷），
    // 改为从内嵌资源加载窗口图标。
    private static ImageSource LoadWindowIcon()
    {
        try
        {
            using var stream = typeof(MainWindow).Assembly
                .GetManifestResourceStream("CodexMiniWin.Resources.ChatGPTWin.ico");
            if (stream is null) return null!;
            var image = new BitmapImage();
            image.BeginInit();
            image.StreamSource = stream;
            image.CacheOption = BitmapCacheOption.OnLoad;
            image.EndInit();
            image.Freeze();
            return image;
        }
        catch
        {
            return null!;
        }
    }
}
