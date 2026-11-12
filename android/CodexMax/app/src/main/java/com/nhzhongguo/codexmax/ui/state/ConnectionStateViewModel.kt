package com.nhzhongguo.codexmax.ui.state

import android.app.Application
import android.content.pm.PackageManager
import android.os.Build
import android.util.Log
import androidx.lifecycle.AndroidViewModel
import androidx.lifecycle.viewModelScope
import com.nhzhongguo.codexmax.BuildConfig
import com.nhzhongguo.codexmax.ConnectionStore
import com.nhzhongguo.codexmax.ConnectionUrl
import com.nhzhongguo.codexmax.PinnedTls
import com.nhzhongguo.codexmax.R
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.flow.MutableStateFlow
import kotlinx.coroutines.flow.StateFlow
import kotlinx.coroutines.flow.asStateFlow
import kotlinx.coroutines.flow.update
import kotlinx.coroutines.launch
import kotlinx.coroutines.withContext
import org.json.JSONObject
import java.io.BufferedReader
import java.io.InputStreamReader
import java.net.HttpURLConnection
import java.nio.charset.StandardCharsets

data class UpdateInfo(
    val latestVersion: String,
    val downloadUrl: String,
    val sizeBytes: Long = 0,
    val sha256: String = "",
    val releaseNotesUrl: String = "",
)

data class ConnectionState(
    val addressInput: String = "",
    val recentUrl: String = "",
    val hasRecent: Boolean = false,
    val statusMessage: String = "",
    val statusIsError: Boolean = false,
    val showStatus: Boolean = false,
    val activeConnection: ConnectionUrl? = null,
    val screen: Screen = Screen.Connection,
    val pageProgress: Int = 0,
    val pageProgressVisible: Boolean = false,
    val browserError: String? = null,
    val updateInfo: UpdateInfo? = null,
    val promptedUpdateVersion: String? = null,
    val snackbarMessage: String? = null,
    val serverOnline: Boolean? = null,
)

enum class Screen {
    Connection,
    Browser,
}

class ConnectionStateViewModel(
    application: Application,
) : AndroidViewModel(application) {

    private val store = ConnectionStore(application)
    private val _state = MutableStateFlow(loadInitialState())
    val state: StateFlow<ConnectionState> = _state.asStateFlow()

    private fun loadInitialState(): ConnectionState {
        val recent = store.load()
        val parsed = ConnectionUrl.parse(recent)
        return ConnectionState(
            addressInput = if (parsed.isValid()) recent else "",
            recentUrl = recent,
            hasRecent = parsed.isValid(),
            serverOnline = readHealthStatus(),
        )
    }

    /** 读取 WorkManager 周期健康检查写入的最近一次连通状态 */
    private fun readHealthStatus(): Boolean? {
        return try {
            val prefs = getApplication<Application>()
                .getSharedPreferences(HEALTH_PREFS, android.content.Context.MODE_PRIVATE)
            if (prefs.contains(HEALTH_KEY_OK)) prefs.getBoolean(HEALTH_KEY_OK, false) else null
        } catch (e: Exception) {
            null
        }
    }

    /** 手动触发一次健康检查（前台任务，更新 UI 状态） */
    fun refreshServerHealth() {
        val connection = _state.value.activeConnection ?: return
        viewModelScope.launch {
            val online = withContext(Dispatchers.IO) {
                try {
                    val http = PinnedTls.openPinnedConnection(
                        connection.statusUrl(),
                        store.loadCertFingerprint(),
                    ) ?: return@withContext false
                    val ok = http.responseCode in 200..299
                    http.disconnect()
                    ok
                } catch (e: Exception) {
                    false
                }
            }
            _state.update { it.copy(serverOnline = online) }
        }
    }

    fun updateAddressInput(value: String) {
        _state.update { it.copy(addressInput = value) }
    }

    fun clearStatus() {
        _state.update { it.copy(showStatus = false, statusMessage = "", statusIsError = false) }
    }

    fun showStatus(message: String, isError: Boolean) {
        _state.update {
            it.copy(
                showStatus = message.isNotBlank(),
                statusMessage = message,
                statusIsError = isError,
            )
        }
    }

    fun showSnackbar(message: String) {
        _state.update { it.copy(snackbarMessage = message) }
    }

    fun clearSnackbar() {
        _state.update { it.copy(snackbarMessage = null) }
    }

    fun clearRecent() {
        store.clear()
        _state.update {
            it.copy(
                addressInput = "",
                recentUrl = "",
                hasRecent = false,
            )
        }
        showStatus("已清除上次连接", isError = false)
    }

    /** 配对/连接时固定下来的自签名证书指纹（TOFU）。空串表示尚未固定。 */
    fun pinnedCertFingerprint(): String = store.loadCertFingerprint()

    /** 证书指纹不匹配：不降级、不放行，明确告知用户。 */
    fun onCertificateRejected() {
        onConnectionFailed(getApplication<Application>().getString(R.string.certificate_rejected))
    }

    /**
     * 用已固定指纹独立验证目标 origin 的证书。
     * WebView 的 SslError 不暴露证书 DER，无法直接比对；这里直接做一次指纹固定的 TLS 握手，
     * 成功即证明服务端证书就是已固定的那一张（RFC 2818 的 pinning 判定方式）。
     */
    fun verifyPinnedCertificate(origin: String): Boolean {
        val pinned = store.loadCertFingerprint()
        if (pinned.isBlank()) return false
        return PinnedTls.probePinned("$origin/codex/health", pinned)
    }

    /** 从服务 /codex/health 拉取指纹并固定（仅 https 连接需要）。 */
    private suspend fun pinCertificate(connection: ConnectionUrl) {
        if (connection.scheme() != "https") {
            store.saveCertFingerprint("")
            return
        }
        if (store.loadCertFingerprint().isNotBlank()) return
        val fingerprint = withContext(Dispatchers.IO) { fetchServerFingerprint(connection) }
        if (fingerprint.isNotBlank()) store.saveCertFingerprint(fingerprint)
    }

    private fun fetchServerFingerprint(connection: ConnectionUrl): String {
        val fingerprint = PinnedTls.fetchFingerprint(connection.healthUrl())
        if (fingerprint.isBlank()) {
            Log.w("CodexRemoteBridge", "fingerprint fetch failed for ${connection.origin()}")
        }
        return fingerprint
    }

    fun connect(rawUrl: String): Boolean {
        val result = ConnectionUrl.parse(rawUrl)
        if (!result.isValid()) {
            showStatus(result.error(), isError = true)
            return false
        }
        val connection = result.value()
        store.save(connection.normalizedUrl())
        viewModelScope.launch { pinCertificate(connection) }
        _state.update {
            it.copy(
                addressInput = connection.normalizedUrl(),
                recentUrl = connection.normalizedUrl(),
                hasRecent = true,
                activeConnection = connection,
                screen = Screen.Browser,
                pageProgressVisible = true,
                pageProgress = 0,
                showStatus = false,
                statusMessage = "",
                browserError = null,
            )
        }
        return true
    }

    fun connectRecent() {
        val recent = store.load()
        if (recent.isNotBlank()) connect(recent)
    }

    fun disconnect() {
        _state.update {
            it.copy(
                browserError = null,
                activeConnection = null,
                screen = Screen.Connection,
                pageProgress = 0,
                pageProgressVisible = false,
            )
        }
    }

    fun updateProgress(progress: Int) {
        _state.update {
            it.copy(
                pageProgress = progress,
                pageProgressVisible = progress < 100,
            )
        }
    }

    fun onPageLoaded() {
        _state.update {
            it.copy(
                pageProgress = 100,
                pageProgressVisible = false,
            )
        }
        val connection = _state.value.activeConnection ?: return
        checkForUpdate(connection)
    }

    /** WebView 加载失败时保留在浏览器页，层内展示错误视图，由用户选择重试或回到连接页 */
    fun onConnectionFailed(message: String) {
        _state.update {
            it.copy(
                browserError = message,
                pageProgress = 0,
                pageProgressVisible = false,
            )
        }
    }

    /** 清除层内错误视图（重试前调用） */
    fun clearBrowserError() {
        _state.update { it.copy(browserError = null) }
    }

    /** 回到连接页；若有失败信息则带到连接页状态栏展示 */
    fun backToConnection() {
        val error = _state.value.browserError
        _state.update {
            it.copy(
                browserError = null,
                activeConnection = null,
                screen = Screen.Connection,
                pageProgress = 0,
                pageProgressVisible = false,
                showStatus = !error.isNullOrBlank(),
                statusMessage = error ?: "",
                statusIsError = !error.isNullOrBlank(),
            )
        }
    }

    fun hasCamera(): Boolean {
        return getApplication<Application>().packageManager
            .hasSystemFeature(PackageManager.FEATURE_CAMERA_ANY)
    }

    fun shouldRequestNotificationPermission(): Boolean {
        if (Build.VERSION.SDK_INT < Build.VERSION_CODES.TIRAMISU) return false
        return getApplication<Application>().checkSelfPermission(
            android.Manifest.permission.POST_NOTIFICATIONS
        ) != PackageManager.PERMISSION_GRANTED
    }

    private fun checkForUpdate(connection: ConnectionUrl) {
        val currentPrompted = _state.value.promptedUpdateVersion
        viewModelScope.launch {
            try {
                val update = withContext(Dispatchers.IO) {
                    fetchUpdateInfo(connection)
                }
                if (update != null) {
                    val latest = update.latestVersion
                    if (latest.isNotEmpty() &&
                        latest != currentPrompted &&
                        compareVersions(latest, BuildConfig.VERSION_NAME) > 0
                    ) {
                        _state.update {
                            it.copy(
                                updateInfo = update,
                                promptedUpdateVersion = latest,
                            )
                        }
                    }
                }
            } catch (e: Exception) {
                Log.d(TAG, "Update check failed: ${e.message}")
            }
        }
    }

    private fun fetchUpdateInfo(connection: ConnectionUrl): UpdateInfo? {
        var http: HttpURLConnection? = null
        try {
            http = PinnedTls.openPinnedConnection(
                connection.configUrl(),
                store.loadCertFingerprint(),
            ) ?: return null
            http.setRequestProperty("x-mobile-typer-token", connection.token())
            if (http.responseCode != 200) return null
            val body = readStream(http.inputStream)
            val root = JSONObject(body)
            val update = root.optJSONObject("update") ?: return null
            val manifestUrl = update.optString("manifestUrl")
            if (manifestUrl.isNotBlank()) {
                if (!isAllowedGithubUrl(manifestUrl)) return null
                return fetchRemoteManifest(manifestUrl)
            }
            val androidUpdate = update.optJSONObject("android") ?: return null
            if (!androidUpdate.optBoolean("available")) return null
            val latest = androidUpdate.optString("latestVersion")
            if (latest.isEmpty()) return null
            return UpdateInfo(latest, connection.downloadUrl())
        } finally {
            http?.disconnect()
        }
    }

    private fun fetchRemoteManifest(url: String): UpdateInfo? {
        var remote: HttpURLConnection? = null
        return try {
            remote = (java.net.URL(url).openConnection() as HttpURLConnection).apply {
                connectTimeout = 8_000
                readTimeout = 8_000
                requestMethod = "GET"
                setRequestProperty("Accept", "application/json")
            }
            if (remote.responseCode !in 200..299) return null
            val root = JSONObject(readStream(remote.inputStream))
            val latest = root.optString("version")
            val assets = root.optJSONArray("assets") ?: return null
            for (index in 0 until assets.length()) {
                val asset = assets.optJSONObject(index) ?: continue
                if (asset.optString("platform") != "android" || asset.optString("kind") != "android-apk") continue
                val download = asset.optString("url")
                if (latest.isBlank() || !isAllowedGithubUrl(download)) return null
                return UpdateInfo(
                    latestVersion = latest,
                    downloadUrl = download,
                    sizeBytes = asset.optLong("sizeBytes", 0),
                    sha256 = asset.optString("sha256"),
                    releaseNotesUrl = root.optString("releaseNotesUrl"),
                )
            }
            null
        } catch (e: Exception) {
            Log.d(TAG, "Remote update manifest unavailable: ${e.message}")
            null
        } finally {
            remote?.disconnect()
        }
    }

    private fun isAllowedGithubUrl(value: String): Boolean {
        return try {
            val uri = android.net.Uri.parse(value)
            uri.scheme == "https" && uri.host in setOf(
                "github.com",
                "objects.githubusercontent.com",
                "github-releases.githubusercontent.com",
            )
        } catch (_: Exception) {
            false
        }
    }

    companion object {
        private const val TAG = "ConnectionState"
        private const val HEALTH_PREFS = "codex_max_connection"
        private const val HEALTH_KEY_OK = "last_health_ok"

        fun compareVersions(left: String, right: String): Int {
            val leftParts = left.split(".")
            val rightParts = right.split(".")
            val length = maxOf(leftParts.size, rightParts.size)
            for (i in 0 until length) {
                val leftValue = if (i < leftParts.size) parseVersionPart(leftParts[i]) else 0
                val rightValue = if (i < rightParts.size) parseVersionPart(rightParts[i]) else 0
                if (leftValue != rightValue) return leftValue.compareTo(rightValue)
            }
            return 0
        }

        private fun parseVersionPart(part: String): Int {
            return try {
                part.trim().toInt()
            } catch (e: NumberFormatException) {
                0
            }
        }

        private fun readStream(input: java.io.InputStream): String {
            val builder = StringBuilder()
            BufferedReader(InputStreamReader(input, StandardCharsets.UTF_8)).use { reader ->
                var line: String?
                while (reader.readLine().also { line = it } != null) builder.append(line)
            }
            return builder.toString()
        }
    }
}
