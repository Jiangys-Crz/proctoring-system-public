package com.cwnupaa.proctor.api

import android.content.Context
import android.content.SharedPreferences
import okhttp3.MediaType.Companion.toMediaType
import okhttp3.MultipartBody
import okhttp3.OkHttpClient
import okhttp3.Request
import okhttp3.RequestBody.Companion.asRequestBody
import okhttp3.RequestBody.Companion.toRequestBody
import org.json.JSONObject
import java.io.File
import java.util.concurrent.TimeUnit
import java.net.URI
import android.security.keystore.KeyGenParameterSpec
import android.security.keystore.KeyProperties
import android.util.Base64
import java.security.KeyStore
import javax.crypto.Cipher
import javax.crypto.KeyGenerator
import javax.crypto.SecretKey
import javax.crypto.spec.GCMParameterSpec

class SessionRevokedException : RuntimeException("会话已注销，请重新登录")

/**
 * 后端 API 客户端：App 扮演原小程序"第二机位"角色。
 * 所有请求带 x-proctor-client: app；登录后带 x-proctor-session-token。
 */
class ApiClient(context: Context) {

    private val prefs: SharedPreferences =
        context.getSharedPreferences("cwnupaa_proctor", Context.MODE_PRIVATE)

    private val http = OkHttpClient.Builder()
        .connectTimeout(10, TimeUnit.SECONDS)
        .readTimeout(30, TimeUnit.SECONDS)
        .writeTimeout(60, TimeUnit.SECONDS)
        .followRedirects(false)
        .followSslRedirects(false)
        .build()

    init { prefs.edit().remove("token").apply() }
    private fun secureOrigin(value: String): String {
        val uri = URI(value.trim())
        require(uri.scheme == "https" && !uri.host.isNullOrBlank() && uri.userInfo == null && uri.query == null && uri.fragment == null && (uri.path.isNullOrEmpty() || uri.path == "/")) { "监考服务器必须使用 HTTPS 域名或地址" }
        return "https://${uri.host.lowercase()}${if (uri.port >= 0 && uri.port != 443) ":${uri.port}" else ""}"
    }
    private fun tokenKey(): SecretKey {
        val store = KeyStore.getInstance("AndroidKeyStore").apply { load(null) }
        (store.getKey("proctor-session", null) as? SecretKey)?.let { return it }
        return KeyGenerator.getInstance(KeyProperties.KEY_ALGORITHM_AES, "AndroidKeyStore").apply {
            init(KeyGenParameterSpec.Builder("proctor-session", KeyProperties.PURPOSE_ENCRYPT or KeyProperties.PURPOSE_DECRYPT).setBlockModes(KeyProperties.BLOCK_MODE_GCM).setEncryptionPaddings(KeyProperties.ENCRYPTION_PADDING_NONE).build())
        }.generateKey()
    }

    private fun tokenFor(origin: String): String {
        val snapshot = prefs.all
        if (snapshot["tokenOrigin"] != origin) return ""
        return runCatching {
            val bytes = Base64.decode(snapshot["tokenEncrypted"] as? String ?: "", Base64.NO_WRAP)
            val cipher = Cipher.getInstance("AES/GCM/NoPadding")
            cipher.init(Cipher.DECRYPT_MODE, tokenKey(), GCMParameterSpec(128, bytes.copyOfRange(0, 12)))
            String(cipher.doFinal(bytes.copyOfRange(12, bytes.size)), Charsets.UTF_8)
        }.getOrDefault("")
    }
    var token: String
        get() = tokenFor(serverUrl)
        private set(value) {
            if (value.isBlank()) { clearSession(); return }
            val cipher = Cipher.getInstance("AES/GCM/NoPadding")
            cipher.init(Cipher.ENCRYPT_MODE, tokenKey())
            prefs.edit().putString("tokenEncrypted", Base64.encodeToString(cipher.iv + cipher.doFinal(value.toByteArray(Charsets.UTF_8)), Base64.NO_WRAP)).putString("tokenOrigin", serverUrl).apply()
        }
    @Synchronized
    fun saveSession(response: JSONObject, id: String, value: String) {
        require(response.getString("_clientServerOrigin") == serverUrl && id.isNotBlank() && value.isNotBlank()) { "服务器已切换，请重新登录" }
        sessionId = id; token = value
    }

    var serverUrl: String
        get() = runCatching { secureOrigin(prefs.getString("serverUrl", "https://proctoring.example.org") ?: "") }.getOrDefault("https://proctoring.example.org")
        @Synchronized set(value) {
            val next = secureOrigin(value)
            if (next != serverUrl) clearSession()
            prefs.edit().putString("serverUrl", next).apply()
        }

    var sessionId: String
        get() = prefs.getString("sessionId", "") ?: ""
        set(value) = prefs.edit().putString("sessionId", value).apply()

    val deviceId: String
        get() {
            var id = prefs.getString("deviceId", "")
            if (id.isNullOrEmpty()) {
                id = "app_${System.currentTimeMillis()}_${android.os.Build.MODEL.replace(" ", "_")}"
                prefs.edit().putString("deviceId", id).apply()
            }
            return id
        }

    @Synchronized
    fun clearSession() {
        prefs.edit().remove("token").remove("tokenEncrypted").remove("tokenOrigin").remove("sessionId").apply()
    }

    private fun base() = serverUrl
    private fun responseJson(response: okhttp3.Response): JSONObject {
        val expected = secureOrigin(response.request.url.newBuilder().encodedPath("/").query(null).fragment(null).build().toString())
        require(expected == serverUrl) { "服务器已切换，请重新登录" }
        val json = runCatching { JSONObject(response.body?.string() ?: "{}") }.getOrDefault(JSONObject())
        if (json.optString("code") == "CLIENT_SESSION_REVOKED") { clearSession(); throw SessionRevokedException() }
        json.optJSONObject("data")?.put("_clientServerOrigin", expected)
        return json
    }

    private fun jsonHeaders(origin: String): okhttp3.Headers {
        val b = okhttp3.Headers.Builder()
            .add("content-type", "application/json")
            .add("x-proctor-client", "app")
        val credential = tokenFor(origin)
        if (credential.isNotBlank()) { b.add("x-proctor-session-token", credential); b.add("authorization", "Bearer $credential") }
        return b.build()
    }

    /** GET 返回 JSON 对象 */
    fun getJson(path: String, vararg query: Pair<String, String>): JSONObject {
        val origin = base()
        val url = buildString {
            append(origin)
            append(path)
            if (query.isNotEmpty()) {
                append('?')
                append(query.joinToString("&") { (k, v) -> "${urlEncode(k)}=${urlEncode(v)}" })
            }
        }
        val req = Request.Builder().url(url).headers(jsonHeaders(origin)).get().build()
        http.newCall(req).execute().use { resp ->
            val json = responseJson(resp)
            if (!resp.isSuccessful || json.optBoolean("ok") == false) {
                throw RuntimeException(json.optString("message", "请求失败 HTTP ${resp.code}"))
            }
            return json.getJSONObject("data")
        }
    }

    /** GET 返回 JSON 数组（data 为数组的接口，如 /api/client/exams、/api/client/voice） */
    fun getArray(path: String, vararg query: Pair<String, String>): org.json.JSONArray {
        val origin = base()
        val url = buildString {
            append(origin)
            append(path)
            if (query.isNotEmpty()) {
                append('?')
                append(query.joinToString("&") { (k, v) -> "${urlEncode(k)}=${urlEncode(v)}" })
            }
        }
        val req = Request.Builder().url(url).headers(jsonHeaders(origin)).get().build()
        http.newCall(req).execute().use { resp ->
            val json = responseJson(resp)
            if (!resp.isSuccessful || json.optBoolean("ok") == false) {
                throw RuntimeException(json.optString("message", "请求失败 HTTP ${resp.code}"))
            }
            return json.getJSONArray("data")
        }
    }

    /** POST JSON 返回 data 对象 */
    fun postJson(path: String, payload: JSONObject): JSONObject {
        val origin = base()
        val req = Request.Builder()
            .url(origin + path)
            .headers(jsonHeaders(origin))
            .post(payload.toString().toRequestBody("application/json".toMediaType()))
            .build()
        http.newCall(req).execute().use { resp ->
            val json = responseJson(resp)
            if (!resp.isSuccessful || json.optBoolean("ok") == false) {
                throw RuntimeException(json.optString("message", "请求失败 HTTP ${resp.code}"))
            }
            return json.optJSONObject("data") ?: JSONObject()
        }
    }

    /** multipart 上传文件（channel 如 IDENTITY_PHOTO / ROOM_VIDEO / MOBILE_CAMERA） */
    fun upload(path: String, file: File, channel: String, fields: Map<String, String> = emptyMap(), mimeType: String = "application/octet-stream", uploadTicket: String? = null): JSONObject {
        val origin = base()
        val uploadHeaders = jsonHeaders(origin).newBuilder().apply { if (!uploadTicket.isNullOrBlank()) add("x-proctor-upload-ticket", uploadTicket) }.build()
        val mb = MultipartBody.Builder().setType(MultipartBody.FORM)
            .addFormDataPart("channel", channel)
        fields.forEach { (k, v) -> mb.addFormDataPart(k, v) }
        mb.addFormDataPart(
            "file", file.name,
            file.asRequestBody(mimeType.toMediaType())
        )
        val req = Request.Builder()
            .url(origin + path)
            .headers(uploadHeaders)
            .post(mb.build())
            .build()
        http.newCall(req).execute().use { resp ->
            val json = responseJson(resp)
            if (!resp.isSuccessful || json.optBoolean("ok") == false) {
                throw RuntimeException(json.optString("message", "上传失败 HTTP ${resp.code}"))
            }
            return json.optJSONObject("data") ?: JSONObject()
        }
    }

    fun mediaHeaders(value: String): Map<String, String> {
        val url = URI(value)
        val origin = secureOrigin(URI(url.scheme, url.authority, null, null, null).toString())
        require(origin == serverUrl) { "语音地址必须属于当前 HTTPS 服务器" }
        return jsonHeaders(origin).toMap()
    }

    private fun urlEncode(value: String): String =
        java.net.URLEncoder.encode(value, "UTF-8")
}
