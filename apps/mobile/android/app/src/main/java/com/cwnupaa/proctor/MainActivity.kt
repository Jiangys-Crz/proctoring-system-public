package com.cwnupaa.proctor

import android.os.Bundle
import androidx.activity.ComponentActivity
import androidx.activity.compose.setContent
import androidx.compose.runtime.*
import com.cwnupaa.proctor.api.ApiClient
import com.cwnupaa.proctor.ui.LoginScreen
import com.cwnupaa.proctor.ui.MonitorScreen

class MainActivity : ComponentActivity() {

    private lateinit var api: ApiClient

    override fun onCreate(savedInstanceState: Bundle?) {
        super.onCreate(savedInstanceState)
        api = ApiClient(this)
        setContent {
            var screen by remember { mutableStateOf(if (api.sessionId.isNotBlank() && api.token.isNotBlank()) "monitor" else "login") }
            when (screen) {
                "monitor" -> MonitorScreen(api = api, onExit = { screen = "login" })
                else -> LoginScreen(api = api, onEnterMonitor = { screen = "monitor" })
            }
        }
    }
}
