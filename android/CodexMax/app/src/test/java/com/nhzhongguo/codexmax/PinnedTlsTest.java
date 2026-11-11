package com.nhzhongguo.codexmax;

import org.junit.Test;

import javax.net.ssl.SSLSocketFactory;

import static org.junit.Assert.assertEquals;
import static org.junit.Assert.assertNotNull;
import static org.junit.Assert.assertNull;
import static org.junit.Assert.assertTrue;

/**
 * PinnedTls 的指纹语义测试。
 * 服务端默认 HTTPS + 自签名，Android 默认信任库会直接握手失败，
 * 因此这里的固定逻辑是「App 能否连接」的关键路径，必须有单测兜住。
 *
 * 说明：证书生成依赖平台内部 API，不适合放进单元测试；
 * 证书指纹的正确性由服务端 Node 测试（certs.js）与端到端握手共同保证。
 */
public class PinnedTlsTest {

    @Test
    public void normalizeStripsColonsWhitespaceAndUppercases() {
        assertEquals("AABBCC", PinnedTls.normalize("aa:bb:cc"));
        assertEquals("AABBCC", PinnedTls.normalize(" AA:BB:CC "));
        assertEquals("AABBCC", PinnedTls.normalize("aabbcc"));
        assertEquals("", PinnedTls.normalize(null));
        assertEquals("", PinnedTls.normalize("   "));
    }

    /** 核心安全属性：没有固定指纹时绝不返回「信任任何证书」的 factory。 */
    @Test
    public void emptyFingerprintRefusesToBuildFactory() {
        assertNull(PinnedTls.createPinnedSocketFactory(""));
        assertNull(PinnedTls.createPinnedSocketFactory(null));
        assertNull(PinnedTls.createPinnedSocketFactory("   "));
        assertNull(PinnedTls.createPinnedSocketFactory("::::"));
    }

    @Test
    public void validFingerprintProducesSocketFactory() {
        String fingerprint = "AA:" + "BB:".repeat(30) + "CC";
        SSLSocketFactory factory = PinnedTls.createPinnedSocketFactory(fingerprint);
        assertNotNull(factory);
    }

    /** 指纹比较必须忽略冒号与大小写差异，否则同一证书会被误判。 */
    @Test
    public void fingerprintComparisonIsFormatInsensitive() {
        String nodeStyle = "B7:25:FC:C3";
        String androidStyle = "b725fcc3";
        assertEquals(PinnedTls.normalize(nodeStyle), PinnedTls.normalize(androidStyle));
    }

    @Test
    public void hostnameVerifierAllowsPinnedLanAddress() {
        // 服务地址是局域网 IP，证书 SAN 里的 DNS 名必然不匹配；指纹已验证后放行主机名
        assertTrue(PinnedTls.allowAnyHostAfterPinning().verify("192.168.1.3", null));
    }

    @Test
    public void httpsWithoutPinRefusesToCreateConnection() throws Exception {
        assertNull(PinnedTls.openPinnedConnection("https://127.0.0.1:1/codex/health", ""));
    }
}
