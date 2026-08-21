package com.nhzhongguo.codexmax

import android.Manifest
import android.content.Intent
import android.content.pm.PackageManager
import android.net.Uri
import android.os.Build
import android.os.Bundle
import androidx.activity.ComponentActivity
import androidx.activity.OnBackPressedCallback
import androidx.activity.compose.setContent
import androidx.activity.enableEdgeToEdge
import androidx.activity.result.ActivityResultLauncher
import androidx.activity.result.contract.ActivityResultContracts
import androidx.appcompat.app.AppCompatDelegate
import androidx.compose.foundation.layout.Box
import androidx.compose.foundation.layout.fillMaxSize
import androidx.compose.foundation.layout.padding
import androidx.compose.material3.MaterialTheme
import androidx.compose.material3.SnackbarDuration
import androidx.compose.material3.SnackbarHost
import androidx.compose.material3.SnackbarHostState
import androidx.compose.material3.SnackbarResult
import androidx.compose.material3.Surface
import androidx.compose.runtime.Composable
import androidx.compose.runtime.LaunchedEffect
import androidx.compose.runtime.getValue
import androidx.compose.runtime.remember
import androidx.compose.runtime.rememberCoroutineScope
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.res.stringResource
import androidx.compose.ui.unit.dp
import androidx.core.os.LocaleListCompat
import androidx.core.splashscreen.SplashScreen.Companion.installSplashScreen
import androidx.lifecycle.compose.collectAsStateWithLifecycle
import androidx.lifecycle.viewmodel.compose.viewModel
import com.nhzhongguo.codexmax.ui.screen.BrowserScreen
import com.nhzhongguo.codexmax.ui.screen.ConnectionScreen
import com.nhzhongguo.codexmax.ui.state.ConnectionStateViewModel
import com.nhzhongguo.codexmax.ui.state.Screen
import com.nhzhongguo.codexmax.ui.state.WebViewHolder
import com.nhzhongguo.codexmax.ui.theme.CodexMaxTheme
import com.nhzhongguo.codexmax.work.ServerHealthWorker
import kotlinx.coroutines.launch

class MainActivity : ComponentActivity() {

    private val webViewHolder = WebViewHolder()
    private lateinit var notificationPermission: ActivityResultLauncher<String>

    override fun onCreate(savedInstanceState: Bundle?) {
        val splashScreen = installSplashScreen()
        super.onCreate(savedInstanceState)
        enableEdgeToEdge()

        splashScreen.setOnExitAnimationListener { provider ->
            provider.iconView.animate()
                .alpha(0f)
                .scaleX(1.12f)
                .scaleY(1.12f)
                .setDuration(260L)
                .start()
            provider.view.animate()
                .alpha(0f)
                .setDuration(420L)
                .withEndAction(provider::remove)
                .start()
        }

        notificationPermission = registerForActivityResult(
            ActivityResultContracts.RequestPermission()
        ) { granted ->
            if (!granted) {
                // Permission denied - handled via ViewModel snackbar
            }
        }

        // Request notification permission on first launch
        if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.TIRAMISU &&
            checkSelfPermission(Manifest.permission.POST_NOTIFICATIONS) != PackageManager.PERMISSION_GRANTED
        ) {
            notificationPermission.launch(Manifest.permission.POST_NOTIFICATIONS)
        }

        // 注册周期后台健康检查（WorkManager，幂等）
        ServerHealthWorker.schedule(this)

        setContent {
            CodexMaxTheme {
                AppContent(
                    webViewHolder = webViewHolder,
                    onLanguageToggle = ::toggleLanguage,
                    onDownloadUpdate = ::openUpdateUrl,
                )
            }
        }

        // Back press handling
        onBackPressedDispatcher.addCallback(this, object : OnBackPressedCallback(true) {
            override fun handleOnBackPressed() {
                val viewModel = currentViewModel ?: return
                val state = viewModel.state.value
                if (state.screen == Screen.Browser) {
                    if (webViewHolder.canGoBack()) {
                        webViewHolder.goBack()
                    } else {
                        viewModel.disconnect()
                        CodexMonitorService.stop(this@MainActivity)
                    }
                } else {
                    finish()
                }
            }
        })
    }

    private var currentViewModel: ConnectionStateViewModel? = null

    @Composable
    private fun AppContent(
        webViewHolder: WebViewHolder,
        onLanguageToggle: () -> Unit,
        onDownloadUpdate: (String) -> Unit,
    ) {
        val viewModel: ConnectionStateViewModel = viewModel()
        currentViewModel = viewModel
        val state by viewModel.state.collectAsStateWithLifecycle()
        val snackbarHostState = remember { SnackbarHostState() }
        val scope = rememberCoroutineScope()
        val downloadLabel = stringResource(R.string.update_download)

        // Handle snackbar messages from ViewModel
        LaunchedEffect(state.snackbarMessage) {
            val message = state.snackbarMessage
            if (message != null) {
                scope.launch {
                    snackbarHostState.showSnackbar(message)
                }
                viewModel.clearSnackbar()
            }
        }

        // Handle update snackbar
        LaunchedEffect(state.updateInfo) {
            val updateInfo = state.updateInfo ?: return@LaunchedEffect
            val message = getString(R.string.update_available, updateInfo.latestVersion)
            val result = snackbarHostState.showSnackbar(
                message = message,
                actionLabel = downloadLabel,
                duration = SnackbarDuration.Long,
            )
            if (result == SnackbarResult.ActionPerformed) {
                onDownloadUpdate(updateInfo.downloadUrl)
            }
        }

        // Stop monitor service when returning to connection screen
        LaunchedEffect(state.screen) {
            if (state.screen == Screen.Connection) {
                CodexMonitorService.stop(this@MainActivity)
            }
        }

        Box(
            modifier = Modifier.fillMaxSize(),
        ) {
            Surface(
                modifier = Modifier.fillMaxSize(),
                color = MaterialTheme.colorScheme.background,
            ) {
                when (state.screen) {
                    Screen.Connection -> ConnectionScreen(
                        viewModel = viewModel,
                        onLanguageToggle = onLanguageToggle,
                        modifier = Modifier.fillMaxSize(),
                    )
                    Screen.Browser -> BrowserScreen(
                        viewModel = viewModel,
                        webViewHolder = webViewHolder,
                        modifier = Modifier.fillMaxSize(),
                    )
                }
            }

            // Snackbar host at bottom
            SnackbarHost(
                hostState = snackbarHostState,
                modifier = Modifier
                    .align(Alignment.BottomCenter)
                    .padding(
                        start = 16.dp,
                        end = 16.dp,
                        bottom = 24.dp,
                    ),
            )
        }
    }

    private fun toggleLanguage() {
        val language = if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.N) {
            resources.configuration.locales[0]?.language ?: "zh"
        } else {
            @Suppress("DEPRECATION")
            resources.configuration.locale.language.ifEmpty { "zh" }
        }
        AppCompatDelegate.setApplicationLocales(
            LocaleListCompat.forLanguageTags(
                if (language == "zh") "en" else "zh-CN"
            )
        )
    }

    private fun openUpdateUrl(url: String) {
        try {
            startActivity(Intent(Intent.ACTION_VIEW, Uri.parse(url)))
        } catch (e: RuntimeException) {
            currentViewModel?.showSnackbar(getString(R.string.external_link_failed))
        }
    }

    override fun onDestroy() {
        super.onDestroy()
        webViewHolder.clear()
        CodexMonitorService.stop(this)
    }
}

