package com.cwnupaa.proctor.ui

import android.content.Context
import android.media.MediaPlayer
import android.media.MediaRecorder
import android.view.SurfaceHolder

import android.view.WindowManager
import androidx.activity.compose.rememberLauncherForActivityResult
import androidx.compose.foundation.background
import androidx.compose.foundation.layout.*
import androidx.compose.material3.*
import androidx.compose.runtime.*
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.graphics.Color
import androidx.compose.ui.platform.LocalContext
import androidx.compose.ui.unit.dp
import androidx.compose.ui.viewinterop.AndroidView
import androidx.core.content.ContextCompat
import com.cwnupaa.proctor.api.ApiClient
import com.cwnupaa.proctor.api.SessionRevokedException
import com.pedro.common.ConnectChecker
import com.pedro.library.view.OpenGlView
import com.pedro.encoder.input.video.CameraHelper
import com.cwnupaa.proctor.api.mediaTrustManager
import com.pedro.library.rtmp.RtmpCamera2
import org.json.JSONObject
import java.io.File
import kotlin.concurrent.thread
import kotlinx.coroutines.delay
import kotlinx.coroutines.launch

/** 第二机位监考页：RTMP 推流、心跳、语音、摄像头翻转、会话结束回登录 */
@Composable
fun MonitorScreen(api: ApiClient, onExit: () -> Unit) {
    val context = LocalContext.current
    val activity = context as? android.app.Activity
    val scope = rememberCoroutineScope()
    var status by remember { mutableStateOf("正在启动第二机位…") }
    var voiceStatus by remember { mutableStateOf("等待监考老师语音") }
    var recordingVoice by remember { mutableStateOf(false) }
    var rtmpReady by remember { mutableStateOf(false) }
    var rtmpConnected by remember { mutableStateOf(false) }

    var publishStarting by remember { mutableStateOf(false) }
    var monitoringActive by remember { mutableStateOf(true) }
    val preview = remember { OpenGlView(context) }
    val rtmp = remember {
        RtmpCamera2(preview, object : ConnectChecker {
            override fun onConnectionStarted(url: String) {}
            override fun onConnectionSuccess() { publishStarting = false; rtmpConnected = true; status = "第二机位加密推流中" }
            override fun onConnectionFailed(reason: String) { publishStarting = false; rtmpConnected = false; status = "第二机位推流连接异常" }
            override fun onNewBitrate(bitrate: Long) {}
            override fun onDisconnect() { publishStarting = false; rtmpConnected = false }
            override fun onAuthError() { publishStarting = false; rtmpConnected = false; status = "媒体发布凭证失效，正在重新获取" }
            override fun onAuthSuccess() {}
        }).apply { getStreamClient().setLogs(false) }
    }
    val recorder = remember { mutableStateOf<MediaRecorder?>(null) }
    val lastVoiceAt = remember { mutableStateOf("") }
    val rtmpUrl = remember { mutableStateOf("") }
    val player = remember { mutableStateOf<MediaPlayer?>(null) }

    // 强制横屏
    LaunchedEffect(Unit) {
        activity?.requestedOrientation = android.content.pm.ActivityInfo.SCREEN_ORIENTATION_SENSOR_LANDSCAPE
    }

    fun stopPush() {
        monitoringActive = false; publishStarting = false; rtmpConnected = false
        runCatching { rtmp.stopStream() }
        runCatching { rtmp.stopPreview() }
    }


    // 组装推流地址 + 启动推流
    fun startPush() {
        val sid = api.sessionId
        if (!monitoringActive || sid.isBlank() || !rtmpReady) return
        if (publishStarting || rtmpConnected) return
        publishStarting = true
        thread {
            try {
                val result = api.getJson("/api/client/media-publish", "sessionId" to sid, "channel" to "MOBILE_CAMERA")
                val url = result.optString("url")
                val uri = java.net.URI(url)
                require(uri.scheme == "rtmps" && !uri.host.isNullOrBlank() && uri.userInfo == null) { "服务器尚未配置加密第二机位推流" }
                val mediaToken = result.optString("token")
                val urlTokens = (uri.rawQuery ?: "").split('&').mapNotNull { part ->
                    val pieces = part.split('=', limit = 2)
                    if (pieces.size == 2 && pieces[0] == "token") java.net.URLDecoder.decode(pieces[1], "UTF-8") else null
                }
                require(mediaToken.isNotBlank() && mediaToken != api.token && urlTokens == listOf(mediaToken) && uri.fragment == null && uri.path == "/$sid/MOBILE_CAMERA") { "缺少有效的专用媒体发布凭证" }
                if (!monitoringActive || api.sessionId != sid) return@thread
                rtmpUrl.value = url
                rtmp.getStreamClient().addCertificates(mediaTrustManager(uri.host))
                activity?.runOnUiThread {
                    if (monitoringActive && api.sessionId == sid) runCatching { rtmp.startStream(url) }.onFailure { publishStarting = false; status = "加密推流启动失败" }
                    else publishStarting = false
                }
            } catch (e: Exception) {
                if (e is SessionRevokedException) activity?.runOnUiThread { stopPush(); onExit() }
                status = "加密推流暂不可用，请检查网络与服务器证书"
                publishStarting = false
            }
        }
    }


    // 心跳
    fun heartbeat(initial: Boolean) {
        thread {
            try {
                val data = api.postJson(
                    "/api/client/heartbeat",
                    JSONObject().apply {
                        put("sessionId", api.sessionId)
                        put("deviceId", api.deviceId)
                        put("side", "MINIPROGRAM")
                        put("capture", JSONObject().put("mobileCameraOk", rtmpConnected))
                    }
                )
                val session = data.optJSONObject("session") ?: return@thread
                if (!monitoringActive || api.sessionId != session.optString("id")) return@thread
                if (!data.optString("miniProgramSessionToken").isNullOrBlank()) {
                    api.saveSession(data, session.getString("id"), data.getString("miniProgramSessionToken"))
                }
                if (!rtmpConnected) startPush()
                val s = session.optString("status", "")
                if (s == "FINISHED") {
                    status = "考试已结束，返回登录页"
                    kotlin.run { stopPush(); api.clearSession(); onExit() }
                    return@thread
                }
                if (s == "LOCKED" || session.optBoolean("lockdown")) {
                    status = "已锁定：${session.optString("lockdownReason", "等待管理员处理")}"
                } else if (initial) {
                    status = "监考中 · 正在推流"
                }
                if (session.optBoolean("lockdown")) {
                    status = "已锁定：${session.optString("lockdownReason", "等待管理员处理")}"
                }
            } catch (e: Exception) {
                if (e is SessionRevokedException) {
                    activity?.runOnUiThread { stopPush(); onExit() }
                    return@thread
                }
                status = "心跳上报失败：${e.message}"
            }
        }
    }

    // 语音轮询
    fun pollVoice() {
        thread {
            try {
                val after = lastVoiceAt.value
                val q = if (after.isBlank()) arrayOf("sessionId" to api.sessionId)
                else arrayOf("sessionId" to api.sessionId, "after" to after)
                val arr = api.getArray("/api/client/voice", *q)
                for (i in 0 until arr.length()) {
                    val msg = arr.getJSONObject(i)
                    lastVoiceAt.value = msg.optString("createdAt")
                    val path = msg.optString("objectPath", "")
                    if (path.isNotBlank()) {
                        val url = if (path.startsWith("http")) path else api.serverUrl + path
                        voiceStatus = "正在播放监考老师语音"
                        runCatching {
                            player.value?.release()
                            val mp = MediaPlayer().apply {
                                setDataSource(context, android.net.Uri.parse(url), api.mediaHeaders(url))
                                setOnPreparedListener { start() }
                                setOnCompletionListener {
                                    release()
                                    player.value = null
                                    voiceStatus = "等待监考老师语音"
                                }
                                setOnErrorListener { _, _, _ -> voiceStatus = "语音播放失败"; true }
                                prepareAsync()
                            }
                            player.value = mp
                        }
                    }
                }
            } catch (e: Exception) {
                // 语音轮询失败不打断主流程
            }
        }
    }

    // 录音上传（录到固定文件，停止后上传）
    val voiceFile = remember { File(context.cacheDir, "last_voice.m4a") }

    fun startVoiceRecord() {
        runCatching {
            voiceFile.delete()
            val r = MediaRecorder().apply {
                setAudioSource(MediaRecorder.AudioSource.MIC)
                setOutputFormat(MediaRecorder.OutputFormat.MPEG_4)
                setAudioEncoder(MediaRecorder.AudioEncoder.AAC)
                setAudioSamplingRate(16000)
                setAudioEncodingBitRate(24000)
                setOutputFile(voiceFile.absolutePath)
                prepare()
                start()
            }
            recorder.value = r
            recordingVoice = true
            voiceStatus = "正在录音"
        }.onFailure { voiceStatus = "录音启动失败：${it.message}" }
    }

    fun stopVoiceRecord() {
        val r = recorder.value ?: return
        recordingVoice = false
        runCatching { r.stop() }
        runCatching { r.release() }
        recorder.value = null
        thread {
            try {
                api.upload("/api/client/voice", voiceFile, "VOICE", mapOf("sessionId" to api.sessionId, "durationMs" to "0"), "audio/mp4")
                voiceStatus = "语音已发送给监考老师"
            } catch (e: Exception) {
                voiceStatus = "语音发送失败：${e.message}"
            }
        }
    }

    // 定时器
    LaunchedEffect(Unit) {
        heartbeat(true)
        while (true) {
            delay(5000)
            heartbeat(false)
        }
    }
    LaunchedEffect(Unit) {
        while (true) {
            delay(3000)
            pollVoice()
        }
    }

    DisposableEffect(Unit) {
        onDispose {
            stopPush()
            runCatching { recorder.value?.release() }
            runCatching { player.value?.release() }
            activity?.requestedOrientation = android.content.pm.ActivityInfo.SCREEN_ORIENTATION_UNSPECIFIED
            // 上报切后台
            thread {
                runCatching {
                    api.postJson(
                        "/api/client/alerts",
                        JSONObject().apply {
                            put("sessionId", api.sessionId)
                            put("type", "SCREEN_SWITCH")
                            put("severity", 4)
                            put("message", "第二机位 App 离开监考页面")
                        }
                    )
                }
            }
        }
    }

    fun preparePreview() {
        if (ContextCompat.checkSelfPermission(context, android.Manifest.permission.CAMERA) != android.content.pm.PackageManager.PERMISSION_GRANTED) return
        runCatching {
            check(rtmp.prepareVideo(1280, 720, 20, 1_200_000, 90))
            check(rtmp.prepareAudio())
            rtmp.startPreview(CameraHelper.Facing.BACK, 1280, 720, 90)
            rtmpReady = true
            startPush()
        }.onFailure { rtmpReady = false; status = "第二机位摄像头初始化失败" }
    }

    // 请求权限
    val permissionLauncher = rememberLauncherForActivityResult(
        androidx.activity.result.contract.ActivityResultContracts.RequestMultiplePermissions()
    ) {
        if (it[android.Manifest.permission.CAMERA] == true) {
            status = "权限已就绪"
            preparePreview()
        } else {
            status = "缺少相机权限"
        }
    }
    LaunchedEffect(Unit) {
        permissionLauncher.launch(arrayOf(android.Manifest.permission.CAMERA, android.Manifest.permission.RECORD_AUDIO))
    }

    Box(Modifier.fillMaxSize().background(Color.Black)) {
        AndroidView(
            factory = { ctx ->
                preview.also { sv ->
                    sv.holder.addCallback(object : SurfaceHolder.Callback {
                        override fun surfaceCreated(holder: SurfaceHolder) {
                            preparePreview()
                        }
                        override fun surfaceChanged(holder: SurfaceHolder, format: Int, width: Int, height: Int) {}
                        override fun surfaceDestroyed(holder: SurfaceHolder) {
                            rtmpReady = false
                        }
                    })
                }
            },
            modifier = Modifier.fillMaxSize()
        )

        Column(
            modifier = Modifier
                .fillMaxSize()
                .padding(16.dp),
            verticalArrangement = Arrangement.SpaceBetween
        ) {
            Row(
                modifier = Modifier.fillMaxWidth(),
                horizontalArrangement = Arrangement.SpaceBetween,
                verticalAlignment = Alignment.CenterVertically
            ) {
                Surface(color = Color(0xAA000000)) {
                    Text(status, color = Color.White, modifier = Modifier.padding(8.dp))
                }
                Row(horizontalArrangement = Arrangement.spacedBy(8.dp)) {
                    Button(onClick = { runCatching { rtmp.switchCamera() } }) { Text("翻转摄像头") }
                    OutlinedButton(onClick = {
                        stopPush(); api.clearSession(); onExit()
                    }) { Text("退出") }
                }
            }
            Column(
                modifier = Modifier.align(Alignment.CenterHorizontally),
                horizontalAlignment = Alignment.CenterHorizontally
            ) {
                Text("请横屏放置手机，对准桌面、键盘、显示器与本人侧后方", color = Color.White)
                Spacer(Modifier.height(8.dp))
                Text("推流：${rtmpUrl.value.substringBefore("?token=").ifBlank { "地址就绪后自动推流" }}", color = Color(0xFF9CA3AF), style = MaterialTheme.typography.bodySmall)
            }
            Surface(color = Color(0xAA000000)) {
                Row(
                    modifier = Modifier.fillMaxWidth().padding(12.dp),
                    horizontalArrangement = Arrangement.SpaceBetween,
                    verticalAlignment = Alignment.CenterVertically
                ) {
                    Text(voiceStatus, color = Color.White)
                    if (!recordingVoice) {
                        Button(onClick = { startVoiceRecord() }) { Text("开始语音回复") }
                    } else {
                        Button(onClick = { stopVoiceRecord() }) { Text("停止并发送语音") }
                    }
                }
            }
        }
    }
}
