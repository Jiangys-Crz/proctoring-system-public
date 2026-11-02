package com.cwnupaa.proctor.api

import java.security.KeyStore
import java.security.cert.CertificateException
import java.security.cert.X509Certificate
import javax.net.ssl.TrustManagerFactory
import javax.net.ssl.X509TrustManager

/** SAN-only matching: no common-name fallback, multi-label wildcard or suffix match. */
fun mediaHostnameMatches(host: String, alternativeNames: Collection<List<*>>?): Boolean {
    val expected = host.lowercase().trim('[', ']').trimEnd('.')
    val ip = expected.contains(':') || Regex("^[0-9.]+$").matches(expected)
    return alternativeNames?.any { san ->
        val kind = san.firstOrNull() as? Int
        val name = (san.getOrNull(1) as? String)?.lowercase()?.trimEnd('.') ?: return@any false
        if (ip) kind == 7 && runCatching { java.net.InetAddress.getByName(name) == java.net.InetAddress.getByName(expected) }.getOrDefault(false)
        else kind == 2 && (name == expected || (name.startsWith("*.") && name.drop(2).split('.').all { it.isNotEmpty() } && name.drop(2).count { it == '.' } >= 1 && expected.endsWith(name.drop(1)) && expected.count { it == '.' } == name.count { it == '.' }))
    } == true
}

/** RootEncoder 2.5.5 does not pass a TLS serverName to Ktor: enforce SAN here. */
fun mediaTrustManager(host: String): X509TrustManager {
    val factory = TrustManagerFactory.getInstance(TrustManagerFactory.getDefaultAlgorithm())
    factory.init(null as KeyStore?)
    val trusted = factory.trustManagers.filterIsInstance<X509TrustManager>().first()
    return object : X509TrustManager {
        override fun getAcceptedIssuers(): Array<X509Certificate> = trusted.acceptedIssuers
        override fun checkClientTrusted(chain: Array<X509Certificate>, authType: String) = trusted.checkClientTrusted(chain, authType)
        override fun checkServerTrusted(chain: Array<X509Certificate>, authType: String) {
            trusted.checkServerTrusted(chain, authType)
            val valid = mediaHostnameMatches(host, chain.first().subjectAlternativeNames)
            if (!valid) throw CertificateException("媒体服务器证书域名不匹配")
        }
    }
}
