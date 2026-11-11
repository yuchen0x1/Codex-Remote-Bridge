package com.nhzhongguo.codexmax.ui.screen

import android.annotation.SuppressLint
import android.content.Intent
import android.graphics.Bitmap
import android.net.Uri
import android.os.Build
import android.view.ViewGroup
import android.webkit.RenderProcessGoneDetail
import android.webkit.SslErrorHandler
import android.webkit.ValueCallback
import android.webkit.WebChromeClient
import android.webkit.WebResourceError
import android.webkit.WebResourceRequest
import android.webkit.WebResourceResponse
import android.webkit.WebSettings
import android.webkit.WebView
import android.webkit.WebViewClient
import androidx.activity.compose.rememberLauncherForActivityResult
import androidx.activity.result.contract.ActivityResultContracts
import androidx.compose.foundation.BorderStroke
import androidx.compose.foundation.background
import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Box
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.Spacer
import androidx.compose.foundation.layout.fillMaxSize
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.height
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.layout.size
import androidx.compose.foundation.layout.width
import androidx.compose.foundation.shape.RoundedCornerShape
import androidx.compose.material.icons.Icons
import androidx.compose.material.icons.filled.CloudOff
import androidx.compose.material.icons.filled.Refresh
import androidx.compose.material3.Button
import androidx.compose.material3.ButtonDefaults
import androidx.compose.material3.Icon
import androidx.compose.material3.LinearProgressIndicator
import androidx.compose.material3.MaterialTheme
import androidx.compose.material3.OutlinedButton
import androidx.compose.material3.Text
import androidx.compose.runtime.Composable
import androidx.compose.runtime.LaunchedEffect
import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.remember
import androidx.compose.runtime.setValue
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.draw.clip
import androidx.compose.ui.graphics.toArgb
import androidx.compose.ui.platform.LocalContext
import androidx.compose.ui.res.stringResource
import androidx.compose.ui.text.style.TextAlign
import androidx.compose.ui.unit.dp
import androidx.compose.ui.viewinterop.AndroidView
import androidx.lifecycle.compose.collectAsStateWithLifecycle
import com.nhzhongguo.codexmax.CodexMonitorService
import com.nhzhongguo.codexmax.R
import com.nhzhongguo.codexmax.ui.state.ConnectionStateViewModel
import com.nhzhongguo.codexmax.ui.state.Screen
import com.nhzhongguo.codexmax.ui.state.WebViewHolder
import com.nhzhongguo.codexmax.ui.theme.Background
import com.nhzhongguo.codexmax.ui.theme.Danger
import com.nhzhongguo.codexmax.ui.theme.Divider
import com.nhzhongguo.codexmax.ui.theme.Primary
import com.nhzhongguo.codexmax.ui.theme.Surface
import com.nhzhongguo.codexmax.ui.theme.TextPrimary
import com.nhzhongguo.codexmax.ui.theme.TextSecondary

@SuppressLint("SetJavaScriptEnabled")
@Composable
fun BrowserScreen(
    viewModel: ConnectionStateViewModel,
    webViewHolder: WebViewHolder,
    modifier: Modifier = Modifier,
) {
    val state by viewModel.state.collectAsStateWithLifecycle()
    val context = LocalContext.current
    val connection = state.activeConnection ?: return

    var fileCallback by remember { mutableStateOf<ValueCallback<Array<Uri>>?>(null) }
    var pageLoadRequestId by remember { mutableStateOf(0) }
    var pageLoaded by remember { mutableStateOf(false) }

    val filePicker = rememberLauncherForActivityResult(
        contract = ActivityResultContracts.StartActivityForResult(),
        onResult = { result ->
            val callback = fileCallback
            fileCallback = null
            callback?.onReceiveValue(
                WebChromeClient.FileChooserParams.parseResult(result.resultCode, result.data)
            )
        },
    )

    // Page load timeout；重试时通过 pageLoadRequestId 重启计时
    LaunchedEffect(connection.normalizedUrl(), pageLoadRequestId) {
        val requestId = pageLoadRequestId
        pageLoaded = false
        kotlinx.coroutines.delay(20_000L)
        if (requestId == pageLoadRequestId && !pageLoaded &&
            state.screen == Screen.Browser && state.browserError == null
        ) {
            viewModel.onConnectionFailed(context.getString(R.string.connection_timed_out))
        }
    }

    // 重试：清除错误层、重启超时计时并重新加载当前 WebView
    fun retryLoad() {
        pageLoadRequestId++
        pageLoaded = false
        viewModel.clearBrowserError()
        webViewHolder.webView?.reload()
    }

    Column(modifier = modifier.fillMaxSize()) {
        // Progress bar
        if (state.pageProgressVisible) {
            LinearProgressIndicator(
                progress = { state.pageProgress / 100f },
                modifier = Modifier
                    .fillMaxWidth()
                    .height(3.dp),
                color = Primary,
                trackColor = Surface,
            )
        }

        Box(modifier = Modifier.fillMaxSize()) {
            // WebView
            AndroidView(
                factory = { ctx ->
                    WebView(ctx).apply {
                        layoutParams = ViewGroup.LayoutParams(
                            ViewGroup.LayoutParams.MATCH_PARENT,
                            ViewGroup.LayoutParams.MATCH_PARENT,
                        )
                        setBackgroundColor(Background.toArgb())

                        settings.apply {
                            javaScriptEnabled = true
                            domStorageEnabled = true
                            databaseEnabled = true
                            allowContentAccess = true
                            allowFileAccess = false
                            mediaPlaybackRequiresUserGesture = false
                            cacheMode = WebSettings.LOAD_NO_CACHE
                            mixedContentMode = WebSettings.MIXED_CONTENT_NEVER_ALLOW
                            loadsImagesAutomatically = true
                            blockNetworkImage = false
                            loadWithOverviewMode = false
                            useWideViewPort = false
                            if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.O) {
                                safeBrowsingEnabled = true
                            }
                        }

                        addJavascriptInterface(
                            object {
                                @android.webkit.JavascriptInterface
                                fun reload() {
                                    post { reload() }
                                }

                                @android.webkit.JavascriptInterface
                                fun disconnect() {
                                    post {
                                        viewModel.disconnect()
                                    }
                                }
                            },
                            "ChatGPTAZNative",
                        )

                        webChromeClient = object : WebChromeClient() {
                            override fun onShowFileChooser(
                                view: WebView?,
                                callback: ValueCallback<Array<Uri>>?,
                                params: FileChooserParams?,
                            ): Boolean {
                                fileCallback?.onReceiveValue(null)
                                fileCallback = callback
                                return try {
                                    val intent = params?.createIntent()?.apply {
                                        putExtra(Intent.EXTRA_ALLOW_MULTIPLE, true)
                                    }
                                    if (intent != null) {
                                        filePicker.launch(intent)
                                    }
                                    true
                                } catch (e: RuntimeException) {
                                    fileCallback = null
                                    false
                                }
                            }

                            override fun onProgressChanged(view: WebView?, newProgress: Int) {
                                viewModel.updateProgress(newProgress)
                            }
                        }

                        webViewClient = object : WebViewClient() {
                            /**
                             * 自签名证书处理：以「我们自己的指纹固定握手」为唯一权威。
                             *
                             * SslCertificate 不暴露 DER 字节，无法直接算指纹；因此这里不解析它，
                             * 而是用已固定指纹向同一 origin 再做一次独立 TLS 握手：
                             * 成功说明服务端证书确实是指纹匹配的那一张，可以放行 WebView；
                             * 失败则一律 cancel。这样既不会"永远信任"，也不会因自签名而全断。
                             */
                            @SuppressLint("WebViewClientOnReceivedSslError")
                            override fun onReceivedSslError(
                                view: WebView?,
                                handler: SslErrorHandler?,
                                error: android.net.http.SslError?,
                            ) {
                                val origin = connection.origin()
                                val verified = viewModel.verifyPinnedCertificate(origin)
                                if (verified) {
                                    handler?.proceed()
                                } else {
                                    handler?.cancel()
                                    viewModel.onCertificateRejected()
                                }
                            }

                            override fun onPageStarted(view: WebView?, url: String?, favicon: Bitmap?) {
                                pageLoaded = false
                                viewModel.updateProgress(0)
                            }

                            override fun onPageCommitVisible(view: WebView?, url: String?) {
                                pageLoaded = true
                                viewModel.onPageLoaded()
                                viewModel.clearBrowserError()
                                applyWebViewportInsets(this@apply)
                            }

                            override fun onPageFinished(view: WebView?, url: String?) {
                                pageLoaded = true
                                viewModel.onPageLoaded()
                                applyWebViewportInsets(this@apply)
                                // 页面成功加载后才拉起监控，错误页/401 页不重复启动
                                if (viewModel.state.value.browserError == null) {
                                    CodexMonitorService.start(context, connection.normalizedUrl())
                                }
                            }

                            override fun shouldOverrideUrlLoading(
                                view: WebView?,
                                request: WebResourceRequest?,
                            ): Boolean {
                                val requestUrl = request?.url?.toString() ?: return false
                                if (connection.hasSameOrigin(requestUrl)) return false
                                try {
                                    context.startActivity(Intent(Intent.ACTION_VIEW, Uri.parse(requestUrl)))
                                } catch (e: RuntimeException) {
                                    viewModel.showSnackbar(
                                        context.getString(R.string.external_link_failed)
                                    )
                                }
                                return true
                            }

                            override fun onReceivedError(
                                view: WebView?,
                                request: WebResourceRequest?,
                                error: WebResourceError?,
                            ) {
                                if (request?.isForMainFrame == true) {
                                    viewModel.onConnectionFailed(
                                        context.getString(R.string.connection_failed)
                                    )
                                }
                            }

                            override fun onReceivedHttpError(
                                view: WebView?,
                                request: WebResourceRequest?,
                                errorResponse: WebResourceResponse?,
                            ) {
                                if (request?.isForMainFrame != true) return
                                val code = errorResponse?.statusCode ?: 0
                                val message = if (code == 401) {
                                    context.getString(R.string.token_invalid)
                                } else {
                                    context.getString(R.string.http_error, code)
                                }
                                viewModel.onConnectionFailed(message)
                            }

                            override fun onRenderProcessGone(
                                view: WebView?,
                                detail: RenderProcessGoneDetail?,
                            ): Boolean {
                                viewModel.onConnectionFailed(
                                    context.getString(R.string.webview_process_failed)
                                )
                                return true
                            }
                        }

                        webViewHolder.webView = this
                        loadUrl(connection.normalizedUrl())
                    }
                },
                update = { webView ->
                    // Apply viewport insets whenever keyboard height changes
                    applyWebViewportInsets(webView)
                },
                onRelease = { webView ->
                    webView.stopLoading()
                    webView.destroy()
                    webViewHolder.webView = null
                },
                modifier = Modifier
                    .fillMaxSize()
                    .background(Background),
            )

            // 层内失败视图：WebView 加载失败时覆盖展示，提供重试与回连接页
            val browserError = state.browserError
            if (browserError != null) {
                BrowserErrorView(
                    message = browserError,
                    onRetry = ::retryLoad,
                    onBackToConnection = viewModel::backToConnection,
                    modifier = Modifier.fillMaxSize(),
                )
            }
        }
    }
}

@Composable
private fun BrowserErrorView(
    message: String,
    onRetry: () -> Unit,
    onBackToConnection: () -> Unit,
    modifier: Modifier = Modifier,
) {
    Column(
        modifier = modifier
            .background(Background)
            .padding(horizontal = 24.dp),
        horizontalAlignment = Alignment.CenterHorizontally,
        verticalArrangement = Arrangement.Center,
    ) {
        Box(
            modifier = Modifier
                .size(64.dp)
                .clip(RoundedCornerShape(16.dp))
                .background(Danger.copy(alpha = 0.15f)),
            contentAlignment = Alignment.Center,
        ) {
            Icon(
                imageVector = Icons.Filled.CloudOff,
                contentDescription = null,
                tint = Danger,
                modifier = Modifier.size(32.dp),
            )
        }

        Spacer(modifier = Modifier.height(16.dp))

        Text(
            text = stringResource(R.string.browser_error_title),
            style = MaterialTheme.typography.titleLarge,
            color = TextPrimary,
        )

        Spacer(modifier = Modifier.height(6.dp))

        Text(
            text = message,
            style = MaterialTheme.typography.bodyMedium,
            color = TextSecondary,
            textAlign = TextAlign.Center,
        )

        Spacer(modifier = Modifier.height(24.dp))

        Button(
            onClick = onRetry,
            modifier = Modifier
                .fillMaxWidth()
                .height(50.dp),
            shape = RoundedCornerShape(8.dp),
            colors = ButtonDefaults.buttonColors(
                containerColor = Primary,
                contentColor = Background,
            ),
        ) {
            Icon(
                imageVector = Icons.Filled.Refresh,
                contentDescription = null,
                modifier = Modifier.size(18.dp),
            )
            Spacer(modifier = Modifier.width(8.dp))
            Text(
                text = stringResource(R.string.retry),
                style = MaterialTheme.typography.labelLarge,
            )
        }

        Spacer(modifier = Modifier.height(10.dp))

        OutlinedButton(
            onClick = onBackToConnection,
            modifier = Modifier
                .fillMaxWidth()
                .height(50.dp),
            shape = RoundedCornerShape(8.dp),
            colors = ButtonDefaults.outlinedButtonColors(
                contentColor = TextSecondary,
            ),
            border = BorderStroke(1.dp, Divider),
        ) {
            Text(
                text = stringResource(R.string.back_to_connection),
                style = MaterialTheme.typography.labelLarge,
            )
        }
    }
}

private fun applyWebViewportInsets(webView: WebView) {
    val script = "(function(){var d=document.documentElement;" +
        "d.style.setProperty('--native-safe-area-top','0px');" +
        "d.style.setProperty('--native-safe-area-bottom','0px');" +
        "d.style.setProperty('--native-keyboard-height','0px');" +
        "d.dataset.nativeSafeArea='true';" +
        "window.dispatchEvent(new Event('chatgptwininsetschange'));})();"
    webView.evaluateJavascript(script, null)
}
