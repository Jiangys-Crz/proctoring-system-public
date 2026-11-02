import UIKit
import AVFoundation
import UniformTypeIdentifiers

/// 登录页：服务器连接 → 选考试 → 身份校验 → 手持身份证照片 → 环境视频 → 扫码配对 → 提交登录请求
final class LoginViewController: UIViewController, UIPickerViewDataSource, UIPickerViewDelegate, QRScannerDelegate,
    UIImagePickerControllerDelegate, UINavigationControllerDelegate {

    private let api = ApiClient.shared

    private var exams: [[String: Any]] = []
    private var examIndex = 0
    private var photoObjectPath = ""
    private var photoFileURL: URL?
    private var videoFileURL: URL?
    private var credentialTicket = ""
    private var roomVideoObjectPath = ""
    private var lastExamId = ""

    private var serverField = UITextField()
    private var examLabel = UILabel()
    private var examPicker = UIPickerView()
    private var teamField = UITextField()
    private var schoolField = UITextField()
    private var collegeField = UITextField()
    private var nameField = UITextField()
    private var studentField = UITextField()
    private var examNumberField = UITextField()
    private var passwordField = UITextField()
    private var pairField = UITextField()
    private var statusLabel = UILabel()
    private var photoLabel = UILabel()
    private var videoLabel = UILabel()
    private var scroll = UIScrollView()

    override func viewDidLoad() {
        super.viewDidLoad()
        title = "CWNU PAA 第二机位"
        view.backgroundColor = .white
        buildUI()
        serverField.text = api.serverUrl
    }

    // MARK: UI

    private func buildUI() {
        scroll.frame = view.bounds
        scroll.autoresizingMask = [.flexibleWidth, .flexibleHeight]
        view.addSubview(scroll)

        var y: CGFloat = 20
        let width = view.bounds.width - 40

        y = addLabel("监考服务器地址", y: y, width: width)
        y = addField(serverField, placeholder: "https://监考域名", y: y, width: width)

        let connectBtn = UIButton(type: .system)
        connectBtn.setTitle("连接并加载考试", for: .normal)
        connectBtn.backgroundColor = UIColor.systemBlue
        connectBtn.setTitleColor(.white, for: .normal)
        connectBtn.layer.cornerRadius = 8
        connectBtn.frame = CGRect(x: 20, y: y, width: width, height: 44)
        connectBtn.addTarget(self, action: #selector(loadExams), for: .touchUpInside)
        scroll.addSubview(connectBtn)
        y += 54

        y = addLabel("选择考试", y: y, width: width)
        examLabel.text = "点击上方按钮加载考试"
        examLabel.font = .systemFont(ofSize: 14)
        examLabel.textColor = .darkGray
        examLabel.frame = CGRect(x: 20, y: y, width: width, height: 22)
        scroll.addSubview(examLabel)
        y += 26

        examPicker.dataSource = self
        examPicker.delegate = self
        examPicker.frame = CGRect(x: 20, y: y, width: width, height: 100)
        scroll.addSubview(examPicker)
        y += 104

        y = addLabel("身份信息", y: y, width: width)
        y = addField(teamField, placeholder: "队伍名称（团队赛）", y: y, width: width)
        y = addField(schoolField, placeholder: "学校", y: y, width: width)
        y = addField(collegeField, placeholder: "学院", y: y, width: width)
        y = addField(nameField, placeholder: "姓名", y: y, width: width)
        y = addField(studentField, placeholder: "学号", y: y, width: width)
        y = addField(examNumberField, placeholder: "考号", y: y, width: width)
        y = addField(passwordField, placeholder: "密码", y: y, width: width)
        passwordField.isSecureTextEntry = true

        let verifyBtn = UIButton(type: .system)
        verifyBtn.setTitle("校验身份", for: .normal)
        verifyBtn.backgroundColor = UIColor.systemIndigo
        verifyBtn.setTitleColor(.white, for: .normal)
        verifyBtn.layer.cornerRadius = 8
        verifyBtn.frame = CGRect(x: 20, y: y, width: width, height: 44)
        verifyBtn.addTarget(self, action: #selector(verifyIdentity), for: .touchUpInside)
        scroll.addSubview(verifyBtn)
        y += 54

        let photoBtn = UIButton(type: .system)
        photoBtn.setTitle("拍摄手持身份证照片", for: .normal)
        photoBtn.backgroundColor = UIColor.systemGreen
        photoBtn.setTitleColor(.white, for: .normal)
        photoBtn.layer.cornerRadius = 8
        photoBtn.frame = CGRect(x: 20, y: y, width: width, height: 44)
        photoBtn.addTarget(self, action: #selector(takePhoto), for: .touchUpInside)
        scroll.addSubview(photoBtn)
        y += 50
        photoLabel.frame = CGRect(x: 20, y: y, width: width, height: 20)
        photoLabel.font = .systemFont(ofSize: 13)
        photoLabel.textColor = .darkGray
        scroll.addSubview(photoLabel)
        y += 24

        let videoBtn = UIButton(type: .system)
        videoBtn.setTitle("录制环境视频（3–15秒）", for: .normal)
        videoBtn.backgroundColor = UIColor.systemOrange
        videoBtn.setTitleColor(.white, for: .normal)
        videoBtn.layer.cornerRadius = 8
        videoBtn.frame = CGRect(x: 20, y: y, width: width, height: 44)
        videoBtn.addTarget(self, action: #selector(takeVideo), for: .touchUpInside)
        scroll.addSubview(videoBtn)
        y += 50
        videoLabel.frame = CGRect(x: 20, y: y, width: width, height: 20)
        videoLabel.font = .systemFont(ofSize: 13)
        videoLabel.textColor = .darkGray
        scroll.addSubview(videoLabel)
        y += 24

        let scanBtn = UIButton(type: .system)
        scanBtn.setTitle("扫码配对", for: .normal)
        scanBtn.backgroundColor = UIColor.systemTeal
        scanBtn.setTitleColor(.white, for: .normal)
        scanBtn.layer.cornerRadius = 8
        scanBtn.frame = CGRect(x: 20, y: y, width: width, height: 44)
        scanBtn.addTarget(self, action: #selector(scanQR), for: .touchUpInside)
        scroll.addSubview(scanBtn)
        y += 54

        y = addField(pairField, placeholder: "配对码（扫码自动填入）", y: y, width: width)

        let submitBtn = UIButton(type: .system)
        submitBtn.setTitle("提交登录请求", for: .normal)
        submitBtn.backgroundColor = UIColor.systemRed
        submitBtn.setTitleColor(.white, for: .normal)
        submitBtn.layer.cornerRadius = 8
        submitBtn.frame = CGRect(x: 20, y: y, width: width, height: 48)
        submitBtn.addTarget(self, action: #selector(submitLogin), for: .touchUpInside)
        scroll.addSubview(submitBtn)
        y += 58

        statusLabel.numberOfLines = 0
        statusLabel.frame = CGRect(x: 20, y: y, width: width, height: 60)
        statusLabel.font = .systemFont(ofSize: 14)
        statusLabel.textColor = .systemRed
        scroll.addSubview(statusLabel)
        y += 70

        scroll.contentSize = CGSize(width: view.bounds.width, height: y)
    }

    @discardableResult
    private func addLabel(_ text: String, y: CGFloat, width: CGFloat) -> CGFloat {
        let label = UILabel()
        label.text = text
        label.font = .boldSystemFont(ofSize: 15)
        label.frame = CGRect(x: 20, y: y, width: width, height: 22)
        scroll.addSubview(label)
        return y + 26
    }

    @discardableResult
    private func addField(_ field: UITextField, placeholder: String, y: CGFloat, width: CGFloat) -> CGFloat {
        field.placeholder = placeholder
        field.borderStyle = .roundedRect
        field.autocapitalizationType = .none
        field.frame = CGRect(x: 20, y: y, width: width, height: 40)
        scroll.addSubview(field)
        return y + 48
    }

    // MARK: 网络

    @objc private func loadExams() {
        do { try api.configureServer(serverField.text ?? api.serverUrl) }
        catch { status(error.localizedDescription); return }
        status("连接检测中…")
        Task {
            do {
                let data = try await api.get("/api/client/exams")
                exams = (data as? [[String: Any]]) ?? []
                examIndex = 0
                examPicker.reloadAllComponents()
                status("已连接：\(api.serverUrl)")
                if let first = exams.first {
                    examLabel.text = (first["name"] as? String) ?? "考试"
                }
            } catch {
                status("连接失败：\(error.localizedDescription)")
            }
        }
    }

    private var currentExam: [String: Any]? {
        exams.indices.contains(examIndex) ? exams[examIndex] : nil
    }

    @objc private func verifyIdentity() {
        guard let exam = currentExam else { status("请先加载并选择考试"); return }
        status("身份校验中…")
        var body: [String: Any] = [
            "examId": exam["id"] ?? "",
            "examCode": exam["examCode"] ?? "",
            "examNumber": examNumberField.text ?? "",
            "password": passwordField.text ?? "",
            "studentId": studentField.text ?? "",
            "name": nameField.text ?? "",
            "school": schoolField.text ?? "",
            "college": collegeField.text ?? "",
            "teamName": (exam["contestType"] as? String) == "TEAM" ? (teamField.text ?? "") : ""
        ]
        Task {
            do {
                try await api.post("/api/client/candidate-verify", body: body)
                status("身份校验通过，请拍摄手持身份证照片并录制环境视频")
            } catch {
                status("校验失败：\(error.localizedDescription)")
            }
        }
    }

    // MARK: 拍摄

    @objc private func takePhoto() {
        presentCamera(mediaType: UTType.image.identifier, device: .front)
    }

    @objc private func takeVideo() {
        presentCamera(mediaType: UTType.movie.identifier, device: .rear)
    }

    private func presentCamera(mediaType: String, device: UIImagePickerController.CameraDevice) {
        guard UIImagePickerController.isSourceTypeAvailable(.camera) else {
            status("当前设备没有相机"); return
        }
        let picker = UIImagePickerController()
        picker.sourceType = .camera
        picker.cameraDevice = device
        picker.mediaTypes = [mediaType]
        if mediaType == UTType.movie.identifier {
            picker.videoMaximumDuration = 15
        }
        picker.delegate = self
        present(picker, animated: true)
    }

    func imagePickerController(_ picker: UIImagePickerController,
                               didFinishPickingMediaWithInfo info: [UIImagePickerController.InfoKey: Any]) {
        picker.dismiss(animated: true)
        if let image = info[.originalImage] as? UIImage {
            uploadPhoto(image)
        } else if let url = info[.mediaURL] as? URL {
            uploadVideo(url)
        }
    }

    private func uploadPhoto(_ image: UIImage) {
        let file = FileManager.default.temporaryDirectory.appendingPathComponent("identity-" + UUID().uuidString + ".jpg")
        do {
            try image.jpegData(compressionQuality: 0.8)?.write(to: file)
            photoFileURL = file
            photoLabel.text = "✓ 身份照片已拍摄"
            status("材料已保存，提交登录时将安全上传")
        } catch { status("照片保存失败") }
    }

    private func uploadVideo(_ url: URL) {
        let file = FileManager.default.temporaryDirectory.appendingPathComponent("room-" + UUID().uuidString + ".mov")
        do {
            try FileManager.default.copyItem(at: url, to: file)
            videoFileURL = file
            videoLabel.text = "✓ 环境视频已录制"
            status("材料已保存，提交登录时将安全上传")
        } catch { status("视频保存失败") }
    }

    private func objectPath(from data: Any) -> String {
        guard let dict = data as? [String: Any] else { return "" }
        if let seg = dict["segment"] as? [String: Any], let p = seg["objectPath"] as? String, !p.isEmpty { return p }
        if let stored = dict["stored"] as? [String: Any] {
            if let p = stored["objectPath"] as? String, !p.isEmpty { return p }
        }
        return ""
    }

    // MARK: 配对

    @objc private func scanQR() {
        let scanner = QRScannerViewController()
        scanner.delegate = self
        navigationController?.pushViewController(scanner, animated: true)
    }

    func qrScanner(_ scanner: QRScannerViewController, didScan text: String) {
        do {
            var payload: [String: Any]
            if let components = URLComponents(string: text), components.scheme == "https", let host = components.host, !host.isEmpty {
                let query = Dictionary(components.queryItems?.map { ($0.name, $0.value ?? "") } ?? [], uniquingKeysWith: { _, last in last })
                let fragment = URLComponents(string: "https://qr.invalid/?" + (components.fragment ?? ""))
                let secrets = Dictionary(fragment?.queryItems?.map { ($0.name, $0.value ?? "") } ?? [], uniquingKeysWith: { _, last in last })
                payload = ["type": "CWNU_PAA_PROCTOR_PAIR", "serverUrl": query["apiBase"] ?? "", "pairCode": query["pairCode"] ?? "", "recoverySecret": secrets["recoverySecret"] ?? query["recoverySecret"] ?? "", "credentialTicket": secrets["credentialTicket"] ?? ""]
            } else {
                guard let decoded = try JSONSerialization.jsonObject(with: Data(text.utf8)) as? [String: Any] else { throw URLError(.badURL) }
                payload = decoded
            }
            guard payload["type"] as? String == "CWNU_PAA_PROCTOR_PAIR", let code = payload["pairCode"] as? String,
                  code.range(of: "^[0-9]{6}$", options: .regularExpression) != nil, let server = payload["serverUrl"] as? String else { throw URLError(.badURL) }
            try api.configureServer(server)
            serverField.text = api.serverUrl
            pairField.text = code
            credentialTicket = payload["credentialTicket"] as? String ?? ""
            let recoverySecret = payload["recoverySecret"] as? String ?? ""
            if !recoverySecret.isEmpty {
                guard recoverySecret.range(of: "^[A-Za-z0-9_-]{32,128}$", options: .regularExpression) != nil else { throw URLError(.badURL) }
                api.clearSession()
                status("正在验证第二机位恢复凭证…")
                Task {
                    do {
                        guard let result = try await api.post("/api/client/reconnect", body: ["pairCode": code, "recoverySecret": recoverySecret, "deviceId": api.deviceId]) as? [String: Any],
                              let session = result["session"] as? [String: Any], let sid = session["id"] as? String, let token = result["miniProgramSessionToken"] as? String, !token.isEmpty else { throw URLError(.badServerResponse) }
                        try api.saveSession(result, id: sid, credential: token)
                        navigationController?.pushViewController(MonitorViewController(), animated: true)
                    } catch { status("恢复失败：\(error.localizedDescription)") }
                }
            } else if !credentialTicket.isEmpty {
                let ticket = credentialTicket
                api.clearSession()
                Task {
                    do {
                        guard let result = try await api.post("/api/client/credential-login", body: ["credentialTicket": ticket, "action": "inspect"]) as? [String: Any], let exam = result["exam"] as? [String: Any] else { throw URLError(.badServerResponse) }
                        exams = [exam]; examIndex = 0; examPicker.reloadAllComponents()
                        examLabel.text = exam["name"] as? String
                        nameField.text = result["name"] as? String; studentField.text = result["studentId"] as? String; examNumberField.text = result["examNumber"] as? String
                        pairField.text = result["pairCode"] as? String
                        status("电脑身份已验证，请拍摄并提交第二机位材料")
                    } catch { credentialTicket = ""; status("二维码已失效：\(error.localizedDescription)") }
                }
            } else { status("已读取配对二维码，请选择考试并验证身份") }
        } catch { status("二维码无效：\(error.localizedDescription)") }
    }

    // MARK: 提交

    @objc private func submitLogin() {
        guard let exam = currentExam else { status("请先加载并选择考试"); return }
        guard let photoFile = photoFileURL else { status("请先拍摄手持身份证照片"); return }
        guard let videoFile = videoFileURL else { status("请先录制环境视频"); return }
        guard let code = pairField.text, code.count >= 6 else { status("请扫码配对或输入配对码"); return }
        status("提交登录请求中…")
        var body: [String: Any] = [
            "examId": exam["id"] ?? "",
            "examCode": exam["examCode"] ?? "",
            "examNumber": examNumberField.text ?? "",
            "password": passwordField.text ?? "",
            "studentId": studentField.text ?? "",
            "name": nameField.text ?? "",
            "school": schoolField.text ?? "",
            "college": collegeField.text ?? "",
            "teamName": (exam["contestType"] as? String) == "TEAM" ? (teamField.text ?? "") : "",
            "pairCode": code,
            "miniProgramDeviceId": api.deviceId,
            "identityPhotoPath": photoObjectPath,
            "roomVideoPath": roomVideoObjectPath
        ]
        Task {
            do {
                api.clearSession()
                var materialIdentity = body
                if !credentialTicket.isEmpty { materialIdentity = ["credentialTicket": credentialTicket, "pairCode": code, "miniProgramDeviceId": api.deviceId] }
                let issued = try await api.post("/api/client/material-upload-ticket", body: materialIdentity) as? [String: Any]
                guard let uploadTicket = issued?["uploadTicket"] as? String else { throw URLError(.badServerResponse) }
                let photo = try await api.upload("/api/client/upload", fileURL: photoFile, channel: "IDENTITY_PHOTO", fields: ["examId": exam["id"] as? String ?? ""], mime: "image/jpeg", uploadTicket: uploadTicket)
                let video = try await api.upload("/api/client/upload", fileURL: videoFile, channel: "ROOM_VIDEO", fields: ["examId": exam["id"] as? String ?? ""], mime: "video/quicktime", uploadTicket: uploadTicket)
                body["uploadTicket"] = uploadTicket
                body["identityPhotoPath"] = objectPath(from: photo)
                body["roomVideoPath"] = objectPath(from: video)
                let submitBody: [String: Any] = credentialTicket.isEmpty ? body : ["credentialTicket": credentialTicket, "miniProgramDeviceId": api.deviceId, "uploadTicket": uploadTicket, "identityPhotoPath": body["identityPhotoPath"] ?? "", "roomVideoPath": body["roomVideoPath"] ?? ""]
                let data = try await api.post(credentialTicket.isEmpty ? "/api/login-requests" : "/api/client/credential-login", body: submitBody)
                guard let dict = data as? [String: Any],
                      let sid = dict["sessionId"] as? String,
                      let tok = dict["miniProgramSessionToken"] as? String,
                      !sid.isEmpty, !tok.isEmpty else {
                    throw NSError(domain: "App", code: 0, userInfo: [NSLocalizedDescriptionKey: "响应缺少会话信息"])
                }
                try api.saveSession(dict, id: sid, credential: tok)
                try? FileManager.default.removeItem(at: photoFile)
                try? FileManager.default.removeItem(at: videoFile)
                status("登录请求已提交，进入第二机位监考")
                navigationController?.pushViewController(MonitorViewController(), animated: true)
            } catch {
                status("提交失败：\(error.localizedDescription)")
            }
        }
    }

    private func status(_ text: String) {
        DispatchQueue.main.async { self.statusLabel.text = text }
    }

    // MARK: Picker

    func numberOfComponents(in pickerView: UIPickerView) -> Int { 1 }
    func pickerView(_ pickerView: UIPickerView, numberOfRowsInComponent component: Int) -> Int { exams.count }
    func pickerView(_ pickerView: UIPickerView, titleForRow row: Int, forComponent component: Int) -> String? {
        let e = exams[row]
        let team = (e["contestType"] as? String) == "TEAM" ? "（团队赛）" : ""
        return "\((e["name"] as? String) ?? "")\(team)"
    }
    func pickerView(_ pickerView: UIPickerView, didSelectRow row: Int, inComponent component: Int) {
        examIndex = row
    }
}
