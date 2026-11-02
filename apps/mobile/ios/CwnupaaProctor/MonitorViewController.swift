import UIKit
import AVFoundation
import HaishinKit

/// 第二机位监考页：RTMP 推流、心跳、语音、摄像头翻转、会话结束退回登录
final class MonitorViewController: UIViewController {

    private let api = ApiClient.shared
    private let rtmpConnection = RTMPConnection()
    private lazy var rtmpStream = RTMPStream(connection: rtmpConnection)

    private var hkView: MTHKView!
    private var statusLabel = UILabel()
    private var voiceLabel = UILabel()
    private var urlLabel = UILabel()
    private var heartbeatTimer: Timer?
    private var voiceTimer: Timer?
    private var recorder: AVAudioRecorder?
    private var player: AVAudioPlayer?
    private var lastVoiceAt = ""
    private var recordingVoice = false
    private var useBack = true
    private var isPublishing = false
    private var publishStarting = false
    private var captureAttached = false
    private var monitoringActive = true
    private var voiceFileURL: URL!

    override func viewDidLoad() {
        super.viewDidLoad()
        view.backgroundColor = .black
        voiceFileURL = FileManager.default.temporaryDirectory.appendingPathComponent("last_voice.m4a")
        try? AVAudioSession.sharedInstance().setCategory(.playAndRecord, mode: .default, options: [.defaultToSpeaker, .allowBluetooth])
        try? AVAudioSession.sharedInstance().setActive(true)

        buildUI()
        startPush()

        heartbeatTimer = Timer.scheduledTimer(withTimeInterval: 5, repeats: true) { [weak self] _ in self?.heartbeat(initial: false) }
        voiceTimer = Timer.scheduledTimer(withTimeInterval: 3, repeats: true) { [weak self] _ in self?.pollVoice() }
        heartbeat(initial: true)
    }

    override func viewWillDisappear(_ animated: Bool) {
        super.viewWillDisappear(animated)
        stopAll()
    }

    deinit {
        stopAll()
    }

    // MARK: UI

    private func buildUI() {
        hkView = MTHKView(frame: view.bounds)
        hkView.videoGravity = .resizeAspectFill
        hkView.autoresizingMask = [.flexibleWidth, .flexibleHeight]
        view.addSubview(hkView)

        statusLabel.text = "正在启动第二机位…"
        statusLabel.textColor = .white
        statusLabel.backgroundColor = UIColor.black.withAlphaComponent(0.55)
        statusLabel.font = .systemFont(ofSize: 15)
        statusLabel.layer.cornerRadius = 6
        statusLabel.clipsToBounds = true
        statusLabel.frame = CGRect(x: 16, y: 16, width: view.bounds.width - 180, height: 40)
        view.addSubview(statusLabel)

        let flipBtn = UIButton(type: .system)
        flipBtn.setTitle("翻转摄像头", for: .normal)
        flipBtn.backgroundColor = .white
        flipBtn.layer.cornerRadius = 6
        flipBtn.frame = CGRect(x: view.bounds.width - 120, y: 16, width: 104, height: 36)
        flipBtn.addTarget(self, action: #selector(flipCamera), for: .touchUpInside)
        view.addSubview(flipBtn)

        let exitBtn = UIButton(type: .system)
        exitBtn.setTitle("退出", for: .normal)
        exitBtn.backgroundColor = .systemRed
        exitBtn.setTitleColor(.white, for: .normal)
        exitBtn.layer.cornerRadius = 6
        exitBtn.frame = CGRect(x: view.bounds.width - 120, y: 58, width: 104, height: 36)
        exitBtn.addTarget(self, action: #selector(exit), for: .touchUpInside)
        view.addSubview(exitBtn)

        urlLabel.text = "推流地址就绪后自动开始"
        urlLabel.textColor = UIColor(white: 0.8, alpha: 1)
        urlLabel.font = .systemFont(ofSize: 12)
        urlLabel.textAlignment = .center
        urlLabel.frame = CGRect(x: 16, y: view.bounds.height - 100, width: view.bounds.width - 32, height: 20)
        view.addSubview(urlLabel)

        let tip = UILabel()
        tip.text = "请横屏放置手机，对准桌面、键盘、显示器与本人侧后方"
        tip.textColor = .white
        tip.font = .systemFont(ofSize: 15)
        tip.textAlignment = .center
        tip.frame = CGRect(x: 16, y: view.bounds.height - 76, width: view.bounds.width - 32, height: 22)
        view.addSubview(tip)

        voiceLabel.text = "等待监考老师语音"
        voiceLabel.textColor = .white
        voiceLabel.backgroundColor = UIColor.black.withAlphaComponent(0.55)
        voiceLabel.layer.cornerRadius = 6
        voiceLabel.clipsToBounds = true
        voiceLabel.font = .systemFont(ofSize: 14)
        voiceLabel.frame = CGRect(x: 16, y: view.bounds.height - 48, width: view.bounds.width - 180, height: 36)
        view.addSubview(voiceLabel)

        let voiceBtn = UIButton(type: .system)
        voiceBtn.setTitle("开始语音回复", for: .normal)
        voiceBtn.backgroundColor = .white
        voiceBtn.layer.cornerRadius = 6
        voiceBtn.frame = CGRect(x: view.bounds.width - 120, y: view.bounds.height - 48, width: 104, height: 36)
        voiceBtn.addTarget(self, action: #selector(toggleVoice), for: .touchUpInside)
        voiceBtn.tag = 1
        view.addSubview(voiceBtn)
    }

    // MARK: RTMP

    private func startPush() {
        guard monitoringActive, !api.sessionId.isEmpty, !publishStarting, !isPublishing else { return }
        publishStarting = true
        let sessionId = api.sessionId
        Task {
            do {
                let data = try await api.get("/api/client/media-publish", query: ["sessionId": sessionId, "channel": "MOBILE_CAMERA"]) as? [String: Any]
                guard let value = data?["url"] as? String, let token = data?["token"] as? String, !token.isEmpty, token != api.token,
                      var url = URLComponents(string: value), url.scheme == "rtmps", url.host != nil, url.user == nil, url.password == nil, url.fragment == nil, url.path == "/" + sessionId + "/MOBILE_CAMERA", url.queryItems?.filter({ $0.name == "token" }).map({ $0.value ?? "" }) == [token] else {
                    throw NSError(domain: "Media", code: 400, userInfo: [NSLocalizedDescriptionKey: "服务器尚未配置加密第二机位推流"])
                }
                guard monitoringActive, sessionId == api.sessionId else { publishStarting = false; return }
                let parts = url.percentEncodedPath.split(separator: "/")
                guard let last = parts.last, parts.count == 2 else { throw URLError(.badServerResponse) }
                let streamName = String(last) + (url.percentEncodedQuery.map { "?" + $0 } ?? "")
                url.percentEncodedPath = "/" + parts.dropLast().joined(separator: "/")
                url.query = nil
                guard let connectionURL = url.url?.absoluteString else { throw URLError(.badServerResponse) }
                if !captureAttached {
                    rtmpStream.attachCamera(AVCaptureDevice.default(.builtInWideAngleCamera, for: .video, position: .back), track: 0)
                    rtmpStream.attachAudio(AVCaptureDevice.default(for: .audio), track: 0)
                    hkView.attachStream(rtmpStream)
                    rtmpConnection.addEventListener(.rtmpStatus, selector: #selector(rtmpStatusHandler(_:)))
                    rtmpStream.addEventListener(.rtmpStatus, selector: #selector(rtmpStatusHandler(_:)))
                    captureAttached = true
                }
                urlLabel.text = "第二机位加密推流"
                rtmpConnection.connect(connectionURL)
                rtmpStream.publish(streamName)
            } catch {
                publishStarting = false
                if (error as NSError).domain == "ClientSessionRevoked" { exit(); return }
                statusLabel.text = "加密推流暂不可用：" + error.localizedDescription
            }
        }
    }

    @objc private func rtmpStatusHandler(_ notification: Notification) {
        let e = Event.from(notification)
        guard let data = e.data as? [String: Any], let code = data["code"] as? String else { return }
        DispatchQueue.main.async {
            self.publishStarting = false
            switch code {
            case RTMPConnection.Code.connectSuccess.rawValue:
                self.statusLabel.text = "已连接推流服务器"
            case RTMPConnection.Code.connectFailed.rawValue, RTMPConnection.Code.connectClosed.rawValue:
                self.isPublishing = false
                self.statusLabel.text = "推流连接异常，正在重试…"
            case RTMPStream.Code.publishStart.rawValue:
                self.isPublishing = true
                self.statusLabel.text = "第二机位加密推流中"
            case RTMPStream.Code.failed.rawValue:
                self.isPublishing = false
                self.statusLabel.text = "媒体发布失败，正在重试…"
            case RTMPStream.Code.publishBadName.rawValue:
                self.isPublishing = false
                self.statusLabel.text = "推流名称不被接受"
            default:
                break
            }
        }
    }

    @objc private func flipCamera() {
        useBack.toggle()
        rtmpStream.attachCamera(AVCaptureDevice.default(.builtInWideAngleCamera, for: .video, position: useBack ? .back : .front), track: 0)
    }

    // MARK: 心跳

    private func heartbeat(initial: Bool) {
        let body: [String: Any] = [
            "sessionId": api.sessionId,
            "deviceId": api.deviceId,
            "side": "MINIPROGRAM",
            "capture": ["mobileCameraOk": isPublishing]
        ]
        Task {
            do {
                let data = try await api.post("/api/client/heartbeat", body: body)
                guard let dict = data as? [String: Any],
                      let session = dict["session"] as? [String: Any], monitoringActive, api.sessionId == session["id"] as? String else { return }
                if let tok = dict["miniProgramSessionToken"] as? String, !tok.isEmpty {
                    try api.saveSession(dict, id: session["id"] as? String ?? api.sessionId, credential: tok)
                }
                if !isPublishing { DispatchQueue.main.async { self.startPush() } }
                let status = session["status"] as? String ?? ""
                if status == "FINISHED" {
                    DispatchQueue.main.async { self.exit() }
                    return
                }
                let locked = session["lockdown"] as? Bool == true
                DispatchQueue.main.async {
                    if locked {
                        self.statusLabel.text = "已锁定：\(session["lockdownReason"] as? String ?? "等待管理员处理")"
                    } else if initial {
                        self.statusLabel.text = "监考中 · 正在推流"
                    }
                }
            } catch {
                if (error as NSError).domain == "ClientSessionRevoked" { DispatchQueue.main.async { self.exit() }; return }
                DispatchQueue.main.async { self.statusLabel.text = "心跳上报失败：\(error.localizedDescription)" }
            }
        }
    }

    // MARK: 语音

    private func pollVoice() {
        let q = lastVoiceAt.isEmpty ? ["sessionId": api.sessionId] : ["sessionId": api.sessionId, "after": lastVoiceAt]
        Task {
            do {
                let data = try await api.get("/api/client/voice", query: q)
                guard let msgs = data as? [[String: Any]] else { return }
                for msg in msgs {
                    if let at = msg["createdAt"] as? String { lastVoiceAt = at }
                    guard let path = msg["objectPath"] as? String, !path.isEmpty else { continue }
                    let url = path.hasPrefix("http") ? path : api.serverUrl + path
                    let audio = try await api.download(url)
                    guard monitoringActive else { return }
                    DispatchQueue.main.async {
                        guard self.monitoringActive else { return }
                        self.voiceLabel.text = "正在播放监考老师语音"
                        try? self.player?.stop()
                        if let p = try? AVAudioPlayer(data: audio) {
                            p.play()
                            self.player = p
                            self.voiceLabel.text = "正在播放监考老师语音"
                        }
                    }
                }
            } catch {
                // 轮询失败不打断主流程
            }
        }
    }

    @objc private func toggleVoice() {
        if recordingVoice {
            stopVoiceRecord()
        } else {
            startVoiceRecord()
        }
    }

    private func startVoiceRecord() {
        let settings: [String: Any] = [
            AVFormatIDKey: Int(kAudioFormatMPEG4AAC),
            AVSampleRateKey: 16000,
            AVNumberOfChannelsKey: 1,
            AVEncoderAudioQualityKey: AVAudioQuality.medium.rawValue
        ]
        try? FileManager.default.removeItem(at: voiceFileURL)
        recorder = try? AVAudioRecorder(url: voiceFileURL, settings: settings)
        guard recorder?.record() == true else {
            voiceLabel.text = "录音启动失败"; return
        }
        recordingVoice = true
        voiceLabel.text = "正在录音…（点按钮停止并发送）"
    }

    private func stopVoiceRecord() {
        recorder?.stop()
        recorder = nil
        recordingVoice = false
        voiceLabel.text = "语音发送中…"
        Task {
            do {
                _ = try await api.upload("/api/client/voice", fileURL: voiceFileURL,
                                         channel: "VOICE",
                                         fields: ["sessionId": api.sessionId, "durationMs": "0"],
                                         mime: "audio/mp4")
                voiceLabel.text = "语音已发送给监考老师"
            } catch {
                voiceLabel.text = "语音发送失败：\(error.localizedDescription)"
            }
        }
    }

    // MARK: 退出

    @objc private func exit() {
        stopAll()
        api.clearSession()
        navigationController?.popToRootViewController(animated: true)
    }

    private func stopAll() {
        monitoringActive = false
        heartbeatTimer?.invalidate(); heartbeatTimer = nil
        voiceTimer?.invalidate(); voiceTimer = nil
        recorder?.stop(); recorder = nil
        player?.stop(); player = nil
        isPublishing = false; publishStarting = false
        rtmpStream.close()
        rtmpConnection.close()
    }
}
