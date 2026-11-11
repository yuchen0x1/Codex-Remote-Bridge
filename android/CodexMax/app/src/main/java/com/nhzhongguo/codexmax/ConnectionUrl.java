package com.nhzhongguo.codexmax;

import java.net.URI;
import java.net.URISyntaxException;
import java.net.URLDecoder;
import java.net.URLEncoder;
import java.io.UnsupportedEncodingException;

public final class ConnectionUrl {
    private final URI uri;
    private final String token;

    private ConnectionUrl(URI uri, String token) {
        this.uri = uri;
        this.token = token;
    }

    public static ParseResult parse(String input) {
        String raw = input == null ? "" : input.trim();
        if (raw.isEmpty()) {
            return ParseResult.invalid("请输入电脑端连接地址");
        }

        try {
            URI uri = new URI(raw);
            String scheme = uri.getScheme();
            if (!"http".equalsIgnoreCase(scheme) && !"https".equalsIgnoreCase(scheme)) {
                return ParseResult.invalid("连接地址必须使用 http 或 https");
            }
            if (uri.getHost() == null || uri.getHost().isBlank()) {
                return ParseResult.invalid("连接地址缺少电脑 IP");
            }
            if (isLoopback(uri.getHost())) {
                return ParseResult.invalid("手机不能使用 localhost，请填写电脑的局域网 IP");
            }

            String token = queryValue(uri.getRawQuery(), "token");
            if (token.isBlank()) {
                return ParseResult.invalid("连接地址缺少 token");
            }
            return ParseResult.valid(new ConnectionUrl(uri.normalize(), token));
        } catch (URISyntaxException error) {
            return ParseResult.invalid("连接地址格式不正确");
        }
    }

    public String normalizedUrl() {
        return uri.toString();
    }

    public String origin() {
        return uri.getScheme() + "://" + uri.getRawAuthority();
    }

    public String token() {
        return token;
    }

    /** 连接协议：https 或 http。自签名证书固定只对 https 生效。 */
    public String scheme() {
        return uri.getScheme() == null ? "http" : uri.getScheme().toLowerCase();
    }

    /** 健康检查地址（不鉴权），用于首次固定证书指纹。 */
    public String healthUrl() {
        return origin() + "/codex/health";
    }

    public String statusUrl() {
        return origin() + "/codex/status?token=" + encode(token);
    }

    public String configUrl() {
        return origin() + "/codex/config?token=" + encode(token);
    }

    public String downloadUrl() {
        return origin() + "/codex/download?file=android&token=" + encode(token);
    }

    public boolean hasSameOrigin(String otherUrl) {
        try {
            URI other = new URI(otherUrl);
            return equalsIgnoreCase(uri.getScheme(), other.getScheme())
                    && equalsIgnoreCase(uri.getHost(), other.getHost())
                    && effectivePort(uri) == effectivePort(other);
        } catch (URISyntaxException error) {
            return false;
        }
    }

    private static boolean isLoopback(String host) {
        return "localhost".equalsIgnoreCase(host)
                || "127.0.0.1".equals(host)
                || "::1".equals(host);
    }

    private static String queryValue(String query, String targetKey) {
        if (query == null || query.isBlank()) return "";
        for (String part : query.split("&")) {
            int separator = part.indexOf('=');
            if (separator <= 0) continue;
            String key = decode(part.substring(0, separator));
            if (targetKey.equals(key)) return decode(part.substring(separator + 1));
        }
        return "";
    }

    private static int effectivePort(URI value) {
        if (value.getPort() >= 0) return value.getPort();
        return "https".equalsIgnoreCase(value.getScheme()) ? 443 : 80;
    }

    private static boolean equalsIgnoreCase(String left, String right) {
        return left != null && right != null && left.equalsIgnoreCase(right);
    }

    private static String decode(String value) {
        try {
            return URLDecoder.decode(value, "UTF-8");
        } catch (UnsupportedEncodingException impossible) {
            throw new IllegalStateException(impossible);
        }
    }

    private static String encode(String value) {
        try {
            return URLEncoder.encode(value, "UTF-8");
        } catch (UnsupportedEncodingException impossible) {
            throw new IllegalStateException(impossible);
        }
    }

    public static final class ParseResult {
        private final ConnectionUrl value;
        private final String error;

        private ParseResult(ConnectionUrl value, String error) {
            this.value = value;
            this.error = error;
        }

        static ParseResult valid(ConnectionUrl value) {
            return new ParseResult(value, "");
        }

        static ParseResult invalid(String error) {
            return new ParseResult(null, error);
        }

        public boolean isValid() {
            return value != null;
        }

        public ConnectionUrl value() {
            if (value == null) throw new IllegalStateException(error);
            return value;
        }

        public String error() {
            return error;
        }
    }
}
