package com.nhzhongguo.codexmax;

import java.io.ByteArrayOutputStream;
import java.io.InputStream;
import java.net.HttpURLConnection;
import java.net.URL;
import java.security.MessageDigest;
import java.security.SecureRandom;
import java.security.cert.X509Certificate;
import java.util.Locale;

import javax.net.ssl.HostnameVerifier;
import javax.net.ssl.HttpsURLConnection;
import javax.net.ssl.SSLContext;
import javax.net.ssl.SSLSocketFactory;
import javax.net.ssl.TrustManager;
import javax.net.ssl.X509TrustManager;

/**
 * 自签名 HTTPS 访问工具。
 *
 * 服务端默认以自签名证书提供 HTTPS，Android 默认信任库无法验证，直接连接会抛
 * SSLHandshakeException。这里的策略是「指纹固定（TOFU）」而不是「无条件信任」：
 *
 * 1. {@link #fetchFingerprint} 仅在首次配对时使用宽松信任器，用于读取服务在
 *    /codex/health 中自报的证书指纹。拿到之后立即持久化，后续不再使用宽松信任器；
 *    首次配对仍应在用户确认的可信局域网中完成。
 * 2. {@link #createPinnedSocketFactory} 只接受指纹与已固定值完全一致的证书。
 *
 * 任何情况下都不使用「永远 proceed」的 TrustManager 做业务请求。
 */
public final class PinnedTls {

    private PinnedTls() {}

    /** 归一化指纹：去掉冒号、转大写，便于与各种来源比较。 */
    public static String normalize(String fingerprint) {
        if (fingerprint == null) return "";
        return fingerprint.replace(":", "").trim().toUpperCase(Locale.ROOT);
    }

    /** 计算证书 SHA-256 指纹，输出与 Node 端一致的冒号分隔大写十六进制。 */
    public static String fingerprintOf(X509Certificate certificate) {
        try {
            byte[] digest = MessageDigest.getInstance("SHA-256").digest(certificate.getEncoded());
            StringBuilder builder = new StringBuilder(digest.length * 3);
            for (int i = 0; i < digest.length; i++) {
                if (i > 0) builder.append(':');
                builder.append(String.format(Locale.ROOT, "%02X", digest[i]));
            }
            return builder.toString();
        } catch (Exception error) {
            return "";
        }
    }

    /**
     * 只信任「指纹等于 pinnedFingerprint」的证书。
     * 指纹为空时返回 null，调用方应视为不可连接（而不是降级为信任所有证书）。
     */
    public static SSLSocketFactory createPinnedSocketFactory(String pinnedFingerprint) {
        final String expected = normalize(pinnedFingerprint);
        if (expected.isEmpty()) return null;
        try {
            SSLContext context = SSLContext.getInstance("TLS");
            context.init(null, new TrustManager[] { new X509TrustManager() {
                @Override
                public void checkClientTrusted(X509Certificate[] chain, String authType) {
                    // 客户端证书不参与本场景
                }

                @Override
                public void checkServerTrusted(X509Certificate[] chain, String authType)
                        throws java.security.cert.CertificateException {
                    if (chain == null || chain.length == 0) {
                        throw new java.security.cert.CertificateException("服务端未提供证书");
                    }
                    String actual = normalize(fingerprintOf(chain[0]));
                    if (!expected.equals(actual)) {
                        throw new java.security.cert.CertificateException(
                                "证书指纹不匹配：expected=" + expected + " actual=" + actual);
                    }
                }

                @Override
                public X509Certificate[] getAcceptedIssuers() {
                    return new X509Certificate[0];
                }
            } }, new SecureRandom());
            return context.getSocketFactory();
        } catch (Exception error) {
            return null;
        }
    }

    /** 豁免主机名校验：证书指纹已验证，且服务地址是局域网 IP，域名必然不匹配。 */
    public static HostnameVerifier allowAnyHostAfterPinning() {
        return (hostname, session) -> true;
    }

    /**
     * 首次配对：读取服务自报的证书指纹。
     *
     * 仅在 {@link ConnectionStore#loadCertFingerprint()} 为空时调用一次。
     * 注意这里信任的是"这一次握手"，落地后立刻变成严格固定。
     */
    public static String fetchFingerprint(String healthUrl) {
        HttpURLConnection connection = null;
        try {
            TrustManager[] trustOnce = new TrustManager[] { new X509TrustManager() {
                @Override
                public void checkClientTrusted(X509Certificate[] chain, String authType) {}

                @Override
                public void checkServerTrusted(X509Certificate[] chain, String authType) {}

                @Override
                public X509Certificate[] getAcceptedIssuers() { return new X509Certificate[0]; }
            } };
            SSLContext context = SSLContext.getInstance("TLS");
            context.init(null, trustOnce, new SecureRandom());

            URL url = new URL(healthUrl);
            connection = (HttpURLConnection) url.openConnection();
            connection.setConnectTimeout(5000);
            connection.setReadTimeout(5000);
            if (connection instanceof HttpsURLConnection) {
                HttpsURLConnection https = (HttpsURLConnection) connection;
                https.setSSLSocketFactory(context.getSocketFactory());
                https.setHostnameVerifier(allowAnyHostAfterPinning());
            }
            String body = readBody(connection.getInputStream());
            String reported = extractJsonString(body, "certFingerprint");
            return normalize(reported);
        } catch (Exception error) {
            return "";
        } finally {
            if (connection != null) connection.disconnect();
        }
    }

    /** 用已固定指纹发起一次 GET，返回是否 2xx。用于后台健康检查。 */
    public static boolean probePinned(String targetUrl, String pinnedFingerprint) {
        HttpURLConnection connection = null;
        try {
            connection = openPinnedConnection(targetUrl, pinnedFingerprint);
            if (connection == null) return false;
            connection.setRequestMethod("GET");
            return connection.getResponseCode() >= 200 && connection.getResponseCode() < 300;
        } catch (Exception error) {
            return false;
        } finally {
            if (connection != null) connection.disconnect();
        }
    }

    /**
     * 创建一个带固定指纹 TLS 配置的 HTTP(S) 连接。
     *
     * 返回 null 表示 HTTPS 尚未固定指纹，调用方必须把它视为不可连接；
     * HTTP 连接不需要证书固定，仍按普通连接返回。调用方负责 disconnect。
     */
    public static HttpURLConnection openPinnedConnection(String targetUrl, String pinnedFingerprint)
            throws Exception {
        URL url = new URL(targetUrl);
        HttpURLConnection connection = (HttpURLConnection) url.openConnection();
        connection.setConnectTimeout(5000);
        connection.setReadTimeout(5000);
        if (connection instanceof HttpsURLConnection) {
            SSLSocketFactory factory = createPinnedSocketFactory(pinnedFingerprint);
            if (factory == null) {
                connection.disconnect();
                return null;
            }
            HttpsURLConnection https = (HttpsURLConnection) connection;
            https.setSSLSocketFactory(factory);
            https.setHostnameVerifier(allowAnyHostAfterPinning());
        }
        return connection;
    }

    private static String readBody(InputStream input) throws Exception {
        ByteArrayOutputStream buffer = new ByteArrayOutputStream();
        byte[] chunk = new byte[4096];
        int read;
        while ((read = input.read(chunk)) != -1) buffer.write(chunk, 0, read);
        return buffer.toString("UTF-8");
    }

    /** 轻量 JSON 取值：只服务 certFingerprint 一个字段，避免为此引入解析依赖。 */
    private static String extractJsonString(String json, String key) {
        if (json == null) return "";
        String needle = "\"" + key + "\"";
        int keyIndex = json.indexOf(needle);
        if (keyIndex < 0) return "";
        int colon = json.indexOf(':', keyIndex + needle.length());
        if (colon < 0) return "";
        int firstQuote = json.indexOf('"', colon + 1);
        if (firstQuote < 0) return "";
        int secondQuote = json.indexOf('"', firstQuote + 1);
        if (secondQuote < 0) return "";
        return json.substring(firstQuote + 1, secondQuote);
    }
}
