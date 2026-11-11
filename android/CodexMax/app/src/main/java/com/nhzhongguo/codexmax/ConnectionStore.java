package com.nhzhongguo.codexmax;

import android.content.Context;
import android.content.SharedPreferences;

public final class ConnectionStore {
    private static final String PREFERENCES = "codex_max_connection";
    private static final String LAST_URL = "last_url";
    /** 已固定的自签名证书 SHA-256 指纹（无冒号大写十六进制）。 */
    private static final String CERT_FINGERPRINT = "cert_fingerprint";

    private final SharedPreferences preferences;

    public ConnectionStore(Context context) {
        preferences = context.getApplicationContext()
                .getSharedPreferences(PREFERENCES, Context.MODE_PRIVATE);
    }

    public String load() {
        return preferences.getString(LAST_URL, "");
    }

    public void save(String url) {
        preferences.edit().putString(LAST_URL, url).apply();
    }

    public void clear() {
        // 切换服务端时旧指纹必然失效，必须一并清除，否则新服务会被判为证书不匹配
        preferences.edit().remove(LAST_URL).remove(CERT_FINGERPRINT).apply();
    }

    public String loadCertFingerprint() {
        return preferences.getString(CERT_FINGERPRINT, "");
    }

    public void saveCertFingerprint(String fingerprint) {
        String normalized = fingerprint == null ? "" : fingerprint.replace(":", "").trim().toUpperCase();
        if (normalized.isEmpty()) {
            preferences.edit().remove(CERT_FINGERPRINT).apply();
        } else {
            preferences.edit().putString(CERT_FINGERPRINT, normalized).apply();
        }
    }
}
