package com.nhzhongguo.codexmax;

import android.app.Service;
import android.content.Context;
import android.content.Intent;
import android.os.Build;
import android.os.IBinder;

import androidx.annotation.Nullable;

import org.json.JSONObject;

import java.io.BufferedReader;
import java.io.InputStreamReader;
import java.net.HttpURLConnection;
import java.nio.charset.StandardCharsets;
import java.util.concurrent.Executors;
import java.util.concurrent.ScheduledExecutorService;
import java.util.concurrent.TimeUnit;

public final class CodexMonitorService extends Service {
    private static final String ACTION_START = "com.nhzhongguo.codexmax.START_MONITOR";
    private static final String ACTION_STOP = "com.nhzhongguo.codexmax.STOP_MONITOR";
    private static final String EXTRA_URL = "connection_url";

    private final TaskStateTracker stateTracker = new TaskStateTracker();
    private ScheduledExecutorService executor;
    private NotificationHelper notifications;
    private volatile ConnectionUrl connection;

    public static void start(Context context, String connectionUrl) {
        Intent intent = new Intent(context, CodexMonitorService.class)
                .setAction(ACTION_START)
                .putExtra(EXTRA_URL, connectionUrl);
        if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.O) {
            context.startForegroundService(intent);
        } else {
            context.startService(intent);
        }
    }

    public static void stop(Context context) {
        Intent intent = new Intent(context, CodexMonitorService.class).setAction(ACTION_STOP);
        try {
            context.startService(intent);
        } catch (RuntimeException ignored) {
            context.stopService(intent);
        }
    }

    @Override
    public void onCreate() {
        super.onCreate();
        notifications = new NotificationHelper(this);
    }

    @Override
    public int onStartCommand(Intent intent, int flags, int startId) {
        startForeground(
                NotificationHelper.MONITOR_NOTIFICATION_ID,
                notifications.ongoing(getString(R.string.monitor_connecting))
        );

        if (intent != null && ACTION_STOP.equals(intent.getAction())) {
            stopMonitoring();
            removeForegroundNotification();
            stopSelf();
            return START_NOT_STICKY;
        }

        String rawUrl = intent == null ? "" : intent.getStringExtra(EXTRA_URL);
        ConnectionUrl.ParseResult parsed = ConnectionUrl.parse(rawUrl);
        if (!parsed.isValid()) {
            removeForegroundNotification();
            stopSelf();
            return START_NOT_STICKY;
        }

        connection = parsed.value();
        startMonitoring();
        return START_NOT_STICKY;
    }

    @Nullable
    @Override
    public IBinder onBind(Intent intent) {
        return null;
    }

    @Override
    public void onDestroy() {
        stopMonitoring();
        super.onDestroy();
    }

    private synchronized void startMonitoring() {
        if (executor != null && !executor.isShutdown()) return;
        executor = Executors.newSingleThreadScheduledExecutor();
        executor.scheduleWithFixedDelay(this::pollSafely, 0, 6, TimeUnit.SECONDS);
    }

    private synchronized void stopMonitoring() {
        if (executor == null) return;
        executor.shutdownNow();
        executor = null;
    }

    @SuppressWarnings("deprecation")
    private void removeForegroundNotification() {
        if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.N) {
            stopForeground(STOP_FOREGROUND_REMOVE);
        } else {
            stopForeground(true);
        }
    }

    private void pollSafely() {
        try {
            TaskStateTracker.Event event = poll();
            if (event != TaskStateTracker.Event.NONE) notifications.showFinished(event);
        } catch (Exception ignored) {
        }
    }

    private TaskStateTracker.Event poll() throws Exception {
        ConnectionUrl current = connection;
        if (current == null) return TaskStateTracker.Event.NONE;

        String pinned = new ConnectionStore(this).loadCertFingerprint();
        HttpURLConnection connection = PinnedTls.openPinnedConnection(current.statusUrl(), pinned);
        if (connection == null) return TaskStateTracker.Event.NONE;
        connection.setConnectTimeout(8_000);
        connection.setReadTimeout(8_000);
        connection.setRequestProperty("Cache-Control", "no-store");
        connection.setRequestProperty("Accept", "application/json");
        try {
            if (connection.getResponseCode() != HttpURLConnection.HTTP_OK) {
                return TaskStateTracker.Event.NONE;
            }
            StringBuilder body = new StringBuilder();
            try (BufferedReader reader = new BufferedReader(new InputStreamReader(
                    connection.getInputStream(), StandardCharsets.UTF_8))) {
                for (String line; (line = reader.readLine()) != null; ) body.append(line);
            }
            JSONObject data = new JSONObject(body.toString());
            if (!data.optBoolean("ok", false) || !data.optBoolean("available", false)) {
                return TaskStateTracker.Event.NONE;
            }
            return stateTracker.accept(new TaskStateTracker.Snapshot(
                    data.optBoolean("active", false),
                    data.optString("status", ""),
                    data.optString("threadId", ""),
                    data.optString("completedAt", "")
            ));
        } finally {
            connection.disconnect();
        }
    }
}
