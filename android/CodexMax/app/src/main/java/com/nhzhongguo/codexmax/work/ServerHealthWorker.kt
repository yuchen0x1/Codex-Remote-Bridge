package com.nhzhongguo.codexmax.work

import android.content.Context
import androidx.work.CoroutineWorker
import androidx.work.ExistingPeriodicWorkPolicy
import androidx.work.PeriodicWorkRequestBuilder
import androidx.work.WorkManager
import androidx.work.WorkerParameters
import com.nhzhongguo.codexmax.ConnectionStore
import com.nhzhongguo.codexmax.ConnectionUrl
import com.nhzhongguo.codexmax.PinnedTls
import java.net.HttpURLConnection
import java.net.URL
import java.util.concurrent.TimeUnit

/**
 * 周期后台健康检查：每 15 分钟探测一次已保存的电脑端服务地址。
 * 结果写入 SharedPreferences（供连接页展示最近一次连通状态），失败自动重试。
 */
class ServerHealthWorker(
    context: Context,
    params: WorkerParameters,
) : CoroutineWorker(context, params) {

    override suspend fun doWork(): Result {
        val prefs = applicationContext.getSharedPreferences(PREFS_NAME, Context.MODE_PRIVATE)
        val savedUrl = prefs.getString(KEY_LAST_URL, null)
        if (savedUrl.isNullOrBlank()) return Result.success() // 尚无连接，无需检查

        val parsed = ConnectionUrl.parse(savedUrl)
        if (!parsed.isValid()) return Result.success()

        val connection = parsed.value()
        val healthUrl = connection.origin() + "/codex/health?token=" + connection.token()
        // HTTPS + 自签名：必须用已固定指纹的 socket factory，默认信任库会直接握手失败。
        val pinned = ConnectionStore(applicationContext).loadCertFingerprint()
        val ok = if (connection.scheme() == "https") {
            PinnedTls.probePinned(healthUrl, pinned)
        } else {
            try {
                val http = URL(healthUrl).openConnection() as HttpURLConnection
                http.connectTimeout = 5000
                http.readTimeout = 5000
                http.requestMethod = "GET"
                val reachable = http.responseCode in 200..299
                http.disconnect()
                reachable
            } catch (e: Exception) {
                false
            }
        }
        saveResult(prefs, ok)
        return if (ok) Result.success() else Result.retry()
    }

    private fun saveResult(prefs: android.content.SharedPreferences, ok: Boolean) {
        prefs.edit()
            .putBoolean(KEY_LAST_HEALTH_OK, ok)
            .putLong(KEY_LAST_HEALTH_AT, System.currentTimeMillis())
            .apply()
    }

    companion object {
        private const val WORK_NAME = "codex-server-health-check"
        // 与 ConnectionStore 保持一致，直接复用已保存的连接地址
        private const val PREFS_NAME = "codex_max_connection"
        private const val KEY_LAST_URL = "last_url"
        private const val KEY_LAST_HEALTH_OK = "last_health_ok"
        private const val KEY_LAST_HEALTH_AT = "last_health_at"

        /** 注册周期任务（幂等：已存在则保持原任务） */
        fun schedule(context: Context) {
            val request = PeriodicWorkRequestBuilder<ServerHealthWorker>(15, TimeUnit.MINUTES).build()
            WorkManager.getInstance(context)
                .enqueueUniquePeriodicWork(WORK_NAME, ExistingPeriodicWorkPolicy.KEEP, request)
        }
    }
}
