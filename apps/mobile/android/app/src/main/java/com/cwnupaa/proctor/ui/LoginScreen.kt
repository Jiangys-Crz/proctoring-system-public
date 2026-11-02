package com.cwnupaa.proctor.ui

import android.net.Uri
import android.Manifest
import android.content.pm.PackageManager
import android.graphics.Bitmap
import android.graphics.BitmapFactory
import androidx.activity.compose.rememberLauncherForActivityResult
import androidx.activity.result.contract.ActivityResultContracts
import androidx.compose.foundation.Image
import androidx.compose.foundation.layout.*
import androidx.compose.foundation.rememberScrollState
import androidx.compose.foundation.verticalScroll
import androidx.compose.material3.*
import androidx.compose.runtime.*
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.graphics.asImageBitmap
import androidx.compose.ui.platform.LocalContext
import androidx.compose.ui.text.font.FontWeight
import androidx.compose.ui.unit.dp
import androidx.core.content.ContextCompat
import com.cwnupaa.proctor.api.ApiClient
import com.journeyapps.barcodescanner.ScanContract
import com.journeyapps.barcodescanner.ScanOptions
import org.json.JSONObject
import java.io.File
import java.io.FileOutputStream
import kotlin.concurrent.thread

/** 登录页：服务器连接 → 选考试 → 身份校验 → 拍照/录环境视频 → 扫码配对 → 提交登录请求 */
@Composable
fun LoginScreen(api: ApiClient, onEnterMonitor: () -> Unit) {
    val context = LocalContext.current
    var serverUrl by remember { mutableStateOf(api.serverUrl) }
    var exams by remember { mutableStateOf(listOf<JSONObject>()) }
    var examIndex by remember { mutableStateOf(-1) }
    var school by remember { mutableStateOf("") }
    var college by remember { mutableStateOf("") }
    var name by remember { mutableStateOf("") }
    var studentId by remember { mutableStateOf("") }
    var examNumber by remember { mutableStateOf("") }
    var password by remember { mutableStateOf("") }
    var teamName by remember { mutableStateOf("") }
    var pairCode by remember { mutableStateOf("") }
    var credentialTicket by remember { mutableStateOf("") }
    var status by remember { mutableStateOf("") }
    var busy by remember { mutableStateOf(false) }
    var verified by remember { mutableStateOf(false) }
    var photoPath by remember { mutableStateOf<String?>(null) }
    var photoBitmap by remember { mutableStateOf<Bitmap?>(null) }
    var roomVideoPath by remember { mutableStateOf<String?>(null) }
    var showCapture by remember { mutableStateOf(false) }
    var captureMode by remember { mutableStateOf("photo") }
    var useFront by remember { mutableStateOf(true) }

    val scanLauncher = rememberLauncherForActivityResult(ScanContract()) { result ->
        result?.contents?.let { raw ->
            try {
                val payload = if (raw.trim().startsWith("https://")) {
                    val uri = Uri.parse(raw.trim())
                    val fragment = Uri.parse("https://qr.invalid/?" + (uri.encodedFragment ?: ""))
                    JSONObject().apply {
                        put("type", "CWNU_PAA_PROCTOR_PAIR")
                        put("serverUrl", uri.getQueryParameter("apiBase") ?: "")
                        put("pairCode", uri.getQueryParameter("pairCode") ?: "")
                        put("recoverySecret", fragment.getQueryParameter("recoverySecret") ?: uri.getQueryParameter("recoverySecret") ?: "")
                        put("credentialTicket", fragment.getQueryParameter("credentialTicket") ?: "")
                    }
                } else JSONObject(raw)
                require(payload.optString("type") == "CWNU_PAA_PROCTOR_PAIR") { "二维码类型不正确" }
                val code = payload.optString("pairCode")
                require(Regex("^[0-9]{6}$").matches(code)) { "二维码配对码无效" }
                api.serverUrl = payload.getString("serverUrl")
                serverUrl = api.serverUrl
                pairCode = code
                credentialTicket = payload.optString("credentialTicket")
                val recoverySecret = payload.optString("recoverySecret")
                if (recoverySecret.isNotBlank()) {
                    require(Regex("^[A-Za-z0-9_-]{32,128}$").matches(recoverySecret)) { "恢复凭证无效" }
                    api.clearSession()
                    busy = true
                    thread {
                        try {
                            val result = api.postJson("/api/client/reconnect", JSONObject().put("pairCode", code).put("recoverySecret", recoverySecret).put("deviceId", api.deviceId))
                            api.saveSession(result, result.getJSONObject("session").getString("id"), result.getString("miniProgramSessionToken"))
                            onEnterMonitor()
                        } catch (e: Exception) { status = "恢复失败：${e.message}" }
                        finally { busy = false }
                    }
                } else if (credentialTicket.isNotBlank()) {
                    api.clearSession()
                    val ticket = credentialTicket
                    busy = true
                    thread {
                        try {
                            val result = api.postJson("/api/client/credential-login", JSONObject().put("credentialTicket", ticket).put("action", "inspect"))
                            exams = listOf(result.getJSONObject("exam")); examIndex = 0
                            name = result.optString("name"); studentId = result.optString("studentId"); examNumber = result.optString("examNumber")
                            pairCode = result.getString("pairCode"); verified = true
                            status = "电脑身份已验证，请拍摄并提交第二机位材料"
                        } catch (e: Exception) { credentialTicket = ""; status = "二维码已失效：${e.message}" }
                        finally { busy = false }
                    }
                } else {
                    verified = false
                    status = "已读取配对二维码，请选择考试并验证身份"
                }
            } catch (e: Exception) {
                status = "二维码无效：${e.message}"
            }
        }
    }

    fun loadExams() {
        busy = true
        status = "连接检测中…"
        thread {
            try {
                api.serverUrl = serverUrl
                val arr = api.getArray("/api/client/exams")
                exams = (0 until arr.length()).map { arr.getJSONObject(it) }
                status = "已连接：${serverUrl}"
            } catch (e: Exception) {
                status = "连接失败：${e.message}"
            } finally {
                busy = false
            }
        }
    }

    fun verifyIdentity() {
        busy = true
        status = ""
        thread {
            try {
                val exam = exams.getOrNull(examIndex) ?: throw RuntimeException("请选择考试")
                val payload = JSONObject().apply {
                    put("examId", exam.getString("id"))
                    put("examCode", exam.optString("examCode"))
                    put("examNumber", examNumber.trim())
                    put("password", password)
                    put("studentId", studentId.trim())
                    put("name", name.trim())
                    put("school", school.trim())
                    put("college", college.trim())
                    if (exam.optString("contestType") == "TEAM" && teamName.isNotBlank()) put("teamName", teamName.trim())
                }
                api.postJson("/api/client/candidate-verify", payload)
                verified = true
                status = "身份校验通过，请拍摄手持身份证照片并录制环境视频"
            } catch (e: Exception) {
                status = "校验失败：${e.message}"
            } finally {
                busy = false
            }
        }
    }

    fun submitLogin() {
        busy = true
        status = ""
        thread {
            try {
                val exam = exams.getOrNull(examIndex) ?: throw RuntimeException("请选择考试")
                val p = photoPath ?: throw RuntimeException("请先拍摄手持身份证照片")
                val v = roomVideoPath ?: throw RuntimeException("请先录制环境视频")
                if (pairCode.isBlank()) throw RuntimeException("请扫描电脑二维码或手动输入配对码")
                val payload = JSONObject().apply {
                    put("examId", exam.getString("id"))
                    put("examCode", exam.optString("examCode"))
                    put("examNumber", examNumber.trim())
                    put("password", password)
                    put("studentId", studentId.trim())
                    put("name", name.trim())
                    put("school", school.trim())
                    put("college", college.trim())
                    if (exam.optString("contestType") == "TEAM" && teamName.isNotBlank()) put("teamName", teamName.trim())
                    put("pairCode", pairCode.trim())
                    put("miniProgramDeviceId", api.deviceId)
                }
                api.clearSession()
                val materialIdentity = if (credentialTicket.isBlank()) payload else JSONObject().put("credentialTicket", credentialTicket).put("pairCode", pairCode).put("miniProgramDeviceId", api.deviceId)
                val ticket = api.postJson("/api/client/material-upload-ticket", materialIdentity).getString("uploadTicket")
                fun pathOf(data: JSONObject): String = data.optJSONObject("stored")?.optString("objectPath")?.takeIf { it.isNotBlank() }
                    ?: data.optJSONObject("segment")?.optString("objectPath")?.takeIf { it.isNotBlank() }
                    ?: throw RuntimeException("材料上传响应缺少路径")
                val photo = api.upload("/api/client/upload", File(p), "IDENTITY_PHOTO", mapOf("examId" to exam.getString("id")), "image/jpeg", ticket)
                val video = api.upload("/api/client/upload", File(v), "ROOM_VIDEO", mapOf("examId" to exam.getString("id")), "video/mp4", ticket)
                payload.put("uploadTicket", ticket)
                payload.put("identityPhotoPath", pathOf(photo))
                payload.put("roomVideoPath", pathOf(video))
                val submit = if (credentialTicket.isBlank()) payload else JSONObject().put("credentialTicket", credentialTicket).put("miniProgramDeviceId", api.deviceId).put("uploadTicket", ticket).put("identityPhotoPath", pathOf(photo)).put("roomVideoPath", pathOf(video))
                val data = api.postJson(if (credentialTicket.isBlank()) "/api/login-requests" else "/api/client/credential-login", submit)
                val sid = data.optString("sessionId", "")
                val tok = data.optString("miniProgramSessionToken", "")
                if (sid.isBlank() || tok.isBlank()) throw RuntimeException("登录请求响应缺少会话信息")
                api.saveSession(data, sid, tok)
                File(p).delete(); File(v).delete()
                status = "登录请求已提交，等待监考审核"
                onEnterMonitor()
            } catch (e: Exception) {
                status = "提交失败：${e.message}"
            } finally {
                busy = false
            }
        }
    }

    if (showCapture) {
        CaptureSheet(
            mode = captureMode,
            useFront = useFront,
            onDone = { file ->
                showCapture = false
                if (captureMode == "photo") {
                    photoPath = file.absolutePath
                    photoBitmap = BitmapFactory.decodeFile(file.absolutePath)
                } else {
                    roomVideoPath = file.absolutePath
                }
                status = "材料已保存，提交登录时将安全上传"
            },
            onCancel = { showCapture = false }
        )
        return
    }

    val exam = exams.getOrNull(examIndex)

    Column(
        modifier = Modifier
            .fillMaxSize()
            .verticalScroll(rememberScrollState())
            .padding(16.dp),
        verticalArrangement = Arrangement.spacedBy(10.dp)
    ) {
        Text("CWNU PAA 第二机位", style = MaterialTheme.typography.headlineSmall, fontWeight = FontWeight.Bold)
        OutlinedTextField(value = serverUrl, onValueChange = { serverUrl = it }, label = { Text("监考服务器地址") }, modifier = Modifier.fillMaxWidth())
        Row(horizontalArrangement = Arrangement.spacedBy(10.dp)) {
            Button(onClick = { loadExams() }, enabled = !busy) { Text("连接并加载考试") }
            OutlinedButton(onClick = { scanLauncher.launch(ScanOptions().apply { setDesiredBarcodeFormats(ScanOptions.QR_CODE); setPrompt("扫描电脑端二维码") }) }) {
                Text("扫码配对")
            }
        }
        exams.takeIf { it.isNotEmpty() }?.let {
            exams.forEachIndexed { index, e ->
                val isTeam = e.optString("contestType") == "TEAM"
                val label = "${e.optString("name")}（${if (isTeam) "团队赛" else "个人赛"}）"
                if (index == examIndex) {
                    Button(onClick = { examIndex = -1 }, modifier = Modifier.fillMaxWidth()) { Text("✓ $label") }
                } else {
                    OutlinedButton(onClick = { examIndex = index }, modifier = Modifier.fillMaxWidth()) { Text(label) }
                }
            }
        }
        if (exam != null && exam.optString("contestType") == "TEAM") {
            OutlinedTextField(value = teamName, onValueChange = { teamName = it }, label = { Text("队伍名称") }, modifier = Modifier.fillMaxWidth())
        }
        OutlinedTextField(value = school, onValueChange = { school = it }, label = { Text("学校") }, modifier = Modifier.fillMaxWidth())
        OutlinedTextField(value = college, onValueChange = { college = it }, label = { Text("学院") }, modifier = Modifier.fillMaxWidth())
        OutlinedTextField(value = name, onValueChange = { name = it }, label = { Text("姓名") }, modifier = Modifier.fillMaxWidth())
        OutlinedTextField(value = studentId, onValueChange = { studentId = it }, label = { Text(if (exam?.optString("contestType") == "TEAM") "队员学号" else "学号") }, modifier = Modifier.fillMaxWidth())
        OutlinedTextField(value = examNumber, onValueChange = { examNumber = it }, label = { Text("考号") }, modifier = Modifier.fillMaxWidth())
        OutlinedTextField(value = password, onValueChange = { password = it }, label = { Text("密码") }, modifier = Modifier.fillMaxWidth())

        if (!verified) {
            Button(onClick = { verifyIdentity() }, enabled = !busy && exam != null, modifier = Modifier.fillMaxWidth()) {
                Text("校验身份")
            }
        } else {
            photoBitmap?.let {
                Image(bitmap = it.asImageBitmap(), contentDescription = "手持身份证照片", modifier = Modifier.fillMaxWidth().height(160.dp))
            }
            Row(horizontalArrangement = Arrangement.spacedBy(10.dp)) {
                Button(onClick = {
                    captureMode = "photo"; useFront = true; showCapture = true
                }) { Text(if (photoPath != null) "重拍身份证照片" else "拍摄手持身份证照片") }
                Button(onClick = {
                    captureMode = "video"; useFront = false; showCapture = true
                }) { Text(if (roomVideoPath != null) "重录环境视频" else "录制环境视频（3–15秒）") }
            }
            OutlinedTextField(value = pairCode, onValueChange = { pairCode = it }, label = { Text("配对码（或扫码自动填入）") }, modifier = Modifier.fillMaxWidth())
            Button(onClick = { submitLogin() }, enabled = !busy, modifier = Modifier.fillMaxWidth()) {
                Text("提交登录请求")
            }
        }

        if (status.isNotBlank()) {
            Text(status, color = MaterialTheme.colorScheme.error, style = MaterialTheme.typography.bodyMedium)
        }
    }
}
