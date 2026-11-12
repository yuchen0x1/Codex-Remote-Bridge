import SwiftUI

// MARK: - 语义色板（与 Web/Android 一致：青绿主色、蓝辅色、琥珀、危险红、成功绿）
// 颜色值与 android/.../ui/theme/Color.kt 对齐，避免跨端语义漂移。
extension Color {
    static let appBackground = Color(red: 16 / 255, green: 20 / 255, blue: 25 / 255) // #101419
    static let appSurface = Color(red: 25 / 255, green: 31 / 255, blue: 38 / 255) // #191F26
    static let appSurfaceAlt = Color(red: 33 / 255, green: 41 / 255, blue: 50 / 255) // #212932
    static let appSurfaceDeep = Color(red: 21 / 255, green: 26 / 255, blue: 34 / 255) // #151A22
    static let appDivider = Color(red: 48 / 255, green: 58 / 255, blue: 69 / 255) // #303A45
    static let appPrimary = Color(red: 71 / 255, green: 215 / 255, blue: 172 / 255) // #47D7AC 青绿
    static let appSecondary = Color(red: 112 / 255, green: 167 / 255, blue: 255 / 255) // #70A7FF 蓝
    static let appTertiary = Color(red: 255 / 255, green: 179 / 255, blue: 106 / 255) // #FFB36A 琥珀
    static let appDanger = Color(red: 255 / 255, green: 125 / 255, blue: 135 / 255) // #FF7D87 错误/离线
    static let appSuccess = Color(red: 52 / 255, green: 168 / 255, blue: 83 / 255) // #34A853
    static let appTextPrimary = Color(red: 243 / 255, green: 246 / 255, blue: 248 / 255) // #F3F6F8
    static let appTextSecondary = Color(red: 170 / 255, green: 181 / 255, blue: 192 / 255) // #AAB5C0
    static let appTextTertiary = Color(red: 112 / 255, green: 124 / 255, blue: 136 / 255) // #707C88
    static let appThreadAccent = Color(red: 143 / 255, green: 122 / 255, blue: 255 / 255) // 线程指标紫色点缀
}

struct ContentView: View {
    @EnvironmentObject private var service: ServiceManager

    var body: some View {
        VStack(alignment: .leading, spacing: 16) {
            header
            statusPanel
            actionPanel
            Spacer(minLength: 0)
            bottomBar
        }
        .padding(24)
        .background(
            LinearGradient(colors: [.appBackground, .appSurface], startPoint: .topLeading, endPoint: .bottomTrailing)
        )
        .foregroundStyle(.appTextPrimary)
        .alert("Codex Remote Bridge", isPresented: $service.showAlert) {
            Button("好") {}
        } message: {
            Text(service.alertMessage)
        }
    }

    private var header: some View {
        HStack(spacing: 14) {
            Image(systemName: "iphone.and.arrow.forward")
                .font(.system(size: 34, weight: .bold))
                .foregroundStyle(.appPrimary)
            VStack(alignment: .leading, spacing: 4) {
                Text(service.appName)
                    .font(.system(size: 28, weight: .bold, design: .rounded))
                Text("本地部署版 · 手机连接这台 Mac 上的 Codex")
                    .font(.system(size: 13, weight: .medium))
                    .foregroundStyle(.appTextSecondary)
            }
            Spacer()
            StatusBadge(title: service.state.displayName, color: service.statusColor)
        }
    }

    private var statusPanel: some View {
        VStack(alignment: .leading, spacing: 14) {
            HStack(spacing: 12) {
                MetricCard(title: "HTTP", value: service.healthOK ? "正常" : "不可用", footnote: service.healthText, tint: service.healthOK ? .appSuccess : .appTertiary)
                MetricCard(title: "端口", value: String(service.port), footnote: service.currentEntryKindText, tint: .appPrimary)
                MetricCard(title: "线程", value: service.threadCountText, footnote: service.latestThreadTitle, tint: .appThreadAccent)
            }
            Text(service.shortInstallDirectory)
                .font(.system(size: 12, weight: .medium, design: .monospaced))
                .foregroundStyle(.appTextTertiary)
                .lineLimit(1)
        }
        .padding(16)
        .panelBackground(cornerRadius: 22)
    }

    private var actionPanel: some View {
        VStack(alignment: .leading, spacing: 12) {
            HStack {
                VStack(alignment: .leading, spacing: 3) {
                    Text("常用操作")
                        .font(.system(size: 15, weight: .bold, design: .rounded))
                    Text("只保留本机服务、局域网访问和本地日志")
                        .font(.system(size: 11, weight: .medium))
                        .foregroundStyle(.appTextTertiary)
                }
                Spacer()
                Text(service.lastUpdatedText)
                    .font(.system(size: 11, weight: .medium, design: .monospaced))
                    .foregroundStyle(.appTextTertiary)
            }

            HStack(spacing: 10) {
                LargeActionButton(title: "打开网页", systemImage: "safari", tint: .appSecondary) { service.openWeb() }
                LargeActionButton(title: service.currentCopyButtonTitle, systemImage: "link", tint: .appPrimary) { service.copyLocalLink() }
                LargeActionButton(title: "重启服务", systemImage: "arrow.clockwise", tint: .appTertiary) { Task { await service.restart() } }
                LargeActionButton(title: "刷新状态", systemImage: "arrow.triangle.2.circlepath", tint: .appTextTertiary) { Task { await service.refresh() } }
            }
            HStack(spacing: 10) {
                Text(service.updateText)
                    .font(.system(size: 11, weight: .medium))
                    .foregroundStyle(.appTextSecondary)
                    .lineLimit(2)
                Spacer()
                Button("检查更新") { Task { await service.checkForUpdate() } }
                    .buttonStyle(.borderedProminent)
                    .tint(.appPrimary)
                    .disabled(service.latestUpdateURL != nil)
                if service.latestUpdateURL != nil {
                    Button("打开下载") { service.openLatestUpdate() }
                        .buttonStyle(.bordered)
                }
            }
        }
        .padding(16)
        .panelBackground(cornerRadius: 22)
    }

    private var bottomBar: some View {
        HStack(spacing: 12) {
            Label(service.logPreview.isEmpty ? "暂无最近日志" : "最近日志已收起，完整内容可从右侧打开", systemImage: "doc.text")
                .font(.system(size: 11, weight: .medium))
                .foregroundStyle(.appTextTertiary)
                .lineLimit(1)
            Spacer(minLength: 16)
            VStack(alignment: .trailing, spacing: 2) {
                Text(service.currentEntryKindText)
                    .font(.system(size: 9, weight: .bold))
                    .foregroundStyle(.appTextTertiary.opacity(0.75))
                Text(service.currentEntryURLString)
                    .font(.system(size: 11, weight: .medium, design: .monospaced))
                    .foregroundStyle(.appTextTertiary)
                    .lineLimit(1)
                    .truncationMode(.middle)
                    .textSelection(.enabled)
            }
            TextLinkButton(title: "打开日志", systemImage: "doc.text.magnifyingglass") { service.openLogs() }
            TextLinkButton(title: service.state == .running || service.healthOK ? "停止" : "启动", systemImage: service.state == .running || service.healthOK ? "stop.fill" : "play.fill") {
                Task { service.state == .running || service.healthOK ? await service.stop() : await service.start() }
            }
        }
    }
}

private extension View {
    func panelBackground(cornerRadius: CGFloat) -> some View {
        self
            .background(.appSurfaceAlt, in: RoundedRectangle(cornerRadius: cornerRadius, style: .continuous))
            .overlay(RoundedRectangle(cornerRadius: cornerRadius, style: .continuous).stroke(.appDivider))
    }
}

private struct StatusBadge: View {
    let title: String
    let color: Color
    var body: some View {
        HStack(spacing: 7) {
            Circle().fill(color).frame(width: 8, height: 8).shadow(color: color.opacity(0.75), radius: 7)
            Text(title).font(.system(size: 12, weight: .bold)).lineLimit(1)
        }
        .padding(.horizontal, 12)
        .padding(.vertical, 7)
        .background(color.opacity(0.15), in: Capsule())
        .overlay(Capsule().stroke(color.opacity(0.32)))
    }
}

private struct MetricCard: View {
    let title: String
    let value: String
    let footnote: String
    let tint: Color
    var body: some View {
        VStack(alignment: .leading, spacing: 8) {
            Text(title).font(.system(size: 11, weight: .bold)).foregroundStyle(.appTextTertiary)
            Text(value).font(.system(size: 24, weight: .bold, design: .rounded)).foregroundStyle(tint)
            Text(footnote).font(.system(size: 11, weight: .medium)).foregroundStyle(.appTextTertiary).lineLimit(1)
        }
        .frame(maxWidth: .infinity, alignment: .leading)
        .padding(14)
        .background(.appSurfaceDeep, in: RoundedRectangle(cornerRadius: 18, style: .continuous))
        .overlay(RoundedRectangle(cornerRadius: 18, style: .continuous).stroke(tint.opacity(0.18)))
    }
}

private struct LargeActionButton: View {
    let title: String
    let systemImage: String
    let tint: Color
    var action: () -> Void
    var body: some View {
        Button(action: action) {
            VStack(spacing: 9) {
                Image(systemName: systemImage).font(.system(size: 20, weight: .bold))
                Text(title).font(.system(size: 12, weight: .bold)).lineLimit(1)
            }
            .frame(maxWidth: .infinity)
            .frame(height: 74)
            .background(tint.opacity(0.15), in: RoundedRectangle(cornerRadius: 18, style: .continuous))
            .overlay(RoundedRectangle(cornerRadius: 18, style: .continuous).stroke(tint.opacity(0.28)))
        }
        .buttonStyle(.plain)
        .foregroundStyle(tint)
    }
}

private struct TextLinkButton: View {
    let title: String
    let systemImage: String
    var action: () -> Void
    var body: some View {
        Button(action: action) {
            Label(title, systemImage: systemImage)
                .font(.system(size: 12, weight: .bold))
        }
        .buttonStyle(.plain)
        .foregroundStyle(.appTextSecondary)
    }
}
