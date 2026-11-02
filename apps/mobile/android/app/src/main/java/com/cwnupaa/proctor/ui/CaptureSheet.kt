package com.cwnupaa.proctor.ui

import androidx.activity.compose.rememberLauncherForActivityResult
import androidx.camera.video.FileOutputOptions
import android.Manifest
import android.content.pm.PackageManager
import androidx.camera.core.CameraSelector
import androidx.camera.core.ImageCapture
import androidx.camera.core.ImageCaptureException
import androidx.camera.core.Preview
import androidx.camera.lifecycle.ProcessCameraProvider
import androidx.camera.video.FallbackStrategy
import androidx.camera.video.Quality
import androidx.camera.video.QualitySelector
import androidx.camera.video.Recorder
import androidx.camera.video.VideoCapture
import androidx.camera.video.VideoRecordEvent
import androidx.camera.view.PreviewView
import androidx.compose.foundation.layout.*
import androidx.compose.material3.*
import androidx.compose.runtime.*
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.platform.LocalContext
import androidx.compose.ui.platform.LocalLifecycleOwner
import androidx.compose.ui.unit.dp
import androidx.core.content.ContextCompat
import kotlinx.coroutines.delay
import kotlinx.coroutines.launch
import java.io.File

/** 相机采集面板：mode=photo 拍一张（返回 File），mode=video 录 15 秒（自动停止） */
@Composable
fun CaptureSheet(mode: String, useFront: Boolean, onDone: (File) -> Unit, onCancel: () -> Unit) {
    val context = LocalContext.current
    val lifecycleOwner = LocalLifecycleOwner.current
    val previewView = remember { PreviewView(context) }
    val scope = rememberCoroutineScope()
    var status by remember { mutableStateOf("") }
    var recording by remember { mutableStateOf(false) }

    val imageCaptureRef = remember { mutableStateOf<ImageCapture?>(null) }
    val videoCaptureRef = remember { mutableStateOf<VideoCapture<Recorder>?>(null) }
    val recordingRef = remember { mutableStateOf<androidx.camera.video.Recording?>(null) }
    val doneRef = remember { mutableStateOf(false) }

    fun captureFile() = File(context.cacheDir, "capture_${System.currentTimeMillis()}_${mode}.${if (mode == "photo") "jpg" else "mp4"}")

    fun bindCamera() {
        val providerFuture = ProcessCameraProvider.getInstance(context)
        providerFuture.addListener({
            try {
                val provider = providerFuture.get()
                val selector = CameraSelector.Builder()
                    .requireLensFacing(if (useFront) CameraSelector.LENS_FACING_FRONT else CameraSelector.LENS_FACING_BACK)
                    .build()
                val preview = Preview.Builder().build().also { it.setSurfaceProvider(previewView.surfaceProvider) }
                if (mode == "photo") {
                    val imageCapture = ImageCapture.Builder().build()
                    provider.unbindAll()
                    provider.bindToLifecycle(lifecycleOwner, selector, preview, imageCapture)
                    imageCaptureRef.value = imageCapture
                    status = "对准本人与身份证拍摄"
                } else {
                    val recorder = Recorder.Builder()
                        .setQualitySelector(QualitySelector.from(Quality.HD, FallbackStrategy.higherQualityOrLowerThan(Quality.HD)))
                        .build()
                    val videoCapture = VideoCapture.withOutput(recorder)
                    provider.unbindAll()
                    provider.bindToLifecycle(lifecycleOwner, selector, preview, videoCapture)
                    videoCaptureRef.value = videoCapture
                    status = "对准考场环境，将自动录制 15 秒"
                }
            } catch (e: Exception) {
                status = "相机初始化失败：${e.message}"
            }
        }, ContextCompat.getMainExecutor(context))
    }

    val permissionLauncher = rememberLauncherForActivityResult(
        androidx.activity.result.contract.ActivityResultContracts.RequestMultiplePermissions()
    ) { result ->
        val ok = result[Manifest.permission.CAMERA] == true && (mode != "video" || result[Manifest.permission.RECORD_AUDIO] == true)
        if (ok) bindCamera() else status = "缺少相机/麦克风权限"
    }

    fun startCapture() {
        if (doneRef.value) return
        when (mode) {
            "photo" -> {
                val imageCapture = imageCaptureRef.value ?: return
                val file = captureFile()
                imageCapture.takePicture(
                    ImageCapture.OutputFileOptions.Builder(file).build(),
                    ContextCompat.getMainExecutor(context),
                    object : ImageCapture.OnImageSavedCallback {
                        override fun onImageSaved(output: ImageCapture.OutputFileResults) {
                            if (!doneRef.value) { doneRef.value = true; onDone(file) }
                        }
                        override fun onError(exception: ImageCaptureException) {
                            status = "拍照失败：${exception.message}"
                        }
                    }
                )
            }
            "video" -> {
                val videoCapture = videoCaptureRef.value ?: return
                val file = captureFile()
                val rec = videoCapture.output
                    .prepareRecording(context, FileOutputOptions.Builder(file).build())
                    .withAudioEnabled()
                    .start(ContextCompat.getMainExecutor(context)) { event ->
                        if (event is VideoRecordEvent.Finalize) {
                            recordingRef.value = null
                            if (!doneRef.value) { doneRef.value = true; onDone(file) }
                        }
                    }
                recordingRef.value = rec
                recording = true
                scope.launch {
                    delay(15_000)
                    recordingRef.value?.stop()
                }
            }
        }
    }

    // 首次显示请求权限
    LaunchedEffect(Unit) {
        val cameraGranted = ContextCompat.checkSelfPermission(context, Manifest.permission.CAMERA) == PackageManager.PERMISSION_GRANTED
        val micGranted = ContextCompat.checkSelfPermission(context, Manifest.permission.RECORD_AUDIO) == PackageManager.PERMISSION_GRANTED
        if (cameraGranted && (mode != "video" || micGranted)) bindCamera()
        else permissionLauncher.launch(
            arrayOf(
                Manifest.permission.CAMERA,
                Manifest.permission.RECORD_AUDIO
            )
        )
    }

    DisposableEffect(Unit) {
        onDispose {
            try {
                recordingRef.value?.stop()
            } catch (_: Exception) {
            }
        }
    }

    Box(Modifier.fillMaxSize()) {
        AndroidViewPreview(previewView)
        Column(
            modifier = Modifier
                .align(Alignment.BottomCenter)
                .fillMaxWidth()
                .padding(24.dp),
            horizontalAlignment = Alignment.CenterHorizontally
        ) {
            if (status.isNotBlank()) Text(status, color = androidx.compose.ui.graphics.Color.White)
            Spacer(Modifier.height(12.dp))
            Row(horizontalArrangement = Arrangement.spacedBy(16.dp)) {
                OutlinedButton(onClick = onCancel) { Text("取消") }
                Button(onClick = { startCapture() }, enabled = !recording || mode == "photo") {
                    Text(if (mode == "photo") "拍摄" else if (recording) "录制中…" else "开始录制(15秒)")
                }
            }
        }
    }
}

@androidx.compose.runtime.Composable
private fun AndroidViewPreview(previewView: PreviewView) {
    androidx.compose.ui.viewinterop.AndroidView(
        factory = { previewView },
        modifier = Modifier.fillMaxSize()
    )
}
