import Foundation
import UIKit
import Security

private final class RejectRedirects: NSObject, URLSessionTaskDelegate {
    func urlSession(_ session: URLSession, task: URLSessionTask, willPerformHTTPRedirection response: HTTPURLResponse, newRequest request: URLRequest, completionHandler: @escaping (URLRequest?) -> Void) { completionHandler(nil) }
}

/// 后端 API 客户端：App 扮演原小程序"第二机位"角色。
/// 所有请求带 x-proctor-client: app；登录后带 x-proctor-session-token。
final class ApiClient {

    static let shared = ApiClient()

    private let sessionLock = NSRecursiveLock()
    private let defaults = UserDefaults.standard
    private let session = URLSession(configuration: .default, delegate: RejectRedirects(), delegateQueue: nil)
    private let keychainService = "org.cwnupaa.proctor.session"
    private init() { defaults.removeObject(forKey: "token") }

    private func secureOrigin(_ value: String) throws -> String {
        guard var components = URLComponents(string: value.trimmingCharacters(in: .whitespacesAndNewlines)), components.scheme == "https", let host = components.host, !host.isEmpty,
              components.user == nil, components.password == nil, components.query == nil, components.fragment == nil, components.path.isEmpty || components.path == "/" else {
            throw NSError(domain: "Api", code: 400, userInfo: [NSLocalizedDescriptionKey: "监考服务器必须使用 HTTPS 域名或地址"])
        }
        components.host = host.lowercased(); components.path = ""
        if components.port == 443 { components.port = nil }
        guard let origin = components.url?.absoluteString else { throw URLError(.badURL) }
        return origin.trimmingCharacters(in: CharacterSet(charactersIn: "/"))
    }
    func configureServer(_ value: String) throws {
        sessionLock.lock(); defer { sessionLock.unlock() }
        let next = try secureOrigin(value)
        if next != serverUrl { clearSession() }
        defaults.set(next, forKey: "serverUrl")
    }

    private(set) var token: String {
        get {
            guard defaults.string(forKey: "tokenOrigin") == serverUrl else { return "" }
            var result: CFTypeRef?
            let status = SecItemCopyMatching([kSecClass: kSecClassGenericPassword, kSecAttrService: keychainService, kSecAttrAccount: "session", kSecReturnData: true] as CFDictionary, &result)
            guard status == errSecSuccess, let data = result as? Data else { return "" }
            return String(data: data, encoding: .utf8) ?? ""
        }
        set {
            SecItemDelete([kSecClass: kSecClassGenericPassword, kSecAttrService: keychainService, kSecAttrAccount: "session"] as CFDictionary)
            guard !newValue.isEmpty else { defaults.removeObject(forKey: "tokenOrigin"); return }
            SecItemAdd([kSecClass: kSecClassGenericPassword, kSecAttrService: keychainService, kSecAttrAccount: "session", kSecAttrAccessible: kSecAttrAccessibleWhenUnlockedThisDeviceOnly, kSecValueData: Data(newValue.utf8)] as CFDictionary, nil)
            defaults.set(serverUrl, forKey: "tokenOrigin")
        }
    }
    func saveSession(_ response: [String: Any], id: String, credential: String) throws {
        sessionLock.lock(); defer { sessionLock.unlock() }
        guard response["_clientServerOrigin"] as? String == serverUrl, !id.isEmpty, !credential.isEmpty else {
            throw NSError(domain: "Api", code: 409, userInfo: [NSLocalizedDescriptionKey: "服务器已切换，请重新登录"])
        }
        sessionId = id; token = credential
    }
    var serverUrl: String {
        get { (try? secureOrigin(defaults.string(forKey: "serverUrl") ?? "")) ?? "https://proctoring.example.org" }
        set { try? configureServer(newValue) }
    }
    var sessionId: String {
        get { defaults.string(forKey: "sessionId") ?? "" }
        set { defaults.set(newValue, forKey: "sessionId") }
    }
    var deviceId: String {
        if let id = defaults.string(forKey: "deviceId"), !id.isEmpty { return id }
        let id = "ios_\(Int(Date().timeIntervalSince1970 * 1000))_\(UIDevice.current.identifierForVendor?.uuidString.prefix(8) ?? "")"
        defaults.set(id, forKey: "deviceId")
        return id
    }

    func clearSession() {
        sessionLock.lock(); defer { sessionLock.unlock() }
        defaults.removeObject(forKey: "token")
        token = ""
        defaults.removeObject(forKey: "sessionId")
    }

    private func headers(_ origin: String) -> [String: String] {
        var h = [
            "content-type": "application/json",
            "x-proctor-client": "app"
        ]
        if origin == serverUrl && !token.isEmpty { h["x-proctor-session-token"] = token; h["authorization"] = "Bearer " + token }
        return h
    }

    private func urlEncode(_ s: String) -> String {
        s.addingPercentEncoding(withAllowedCharacters: .urlQueryAllowed) ?? s
    }

    /// GET 返回 data（对象或数组）
    func get(_ path: String, query: [String: String] = [:]) async throws -> Any {
        let origin = serverUrl
        var urlStr = origin + path
        if !query.isEmpty {
            urlStr += "?" + query.map { "\(urlEncode($0.key))=\(urlEncode($0.value))" }.joined(separator: "&")
        }
        guard let url = URL(string: urlStr) else { throw URLError(.badURL) }
        var req = URLRequest(url: url)
        req.httpMethod = "GET"
        req.allHTTPHeaderFields = headers(origin)
        return try await send(req)
    }

    /// POST JSON 返回 data（对象或数组）
    func post(_ path: String, body: [String: Any]) async throws -> Any {
        let origin = serverUrl
        var req = URLRequest(url: URL(string: origin + path)!)
        req.httpMethod = "POST"
        req.allHTTPHeaderFields = headers(origin)
        req.httpBody = try JSONSerialization.data(withJSONObject: body)
        return try await send(req)
    }

    /// multipart 上传文件
    func upload(_ path: String, fileURL: URL, channel: String, fields: [String: String], mime: String, uploadTicket: String? = nil) async throws -> Any {
        let boundary = "Boundary-\(UUID().uuidString)"
        let origin = serverUrl
        var req = URLRequest(url: URL(string: origin + path)!)
        req.httpMethod = "POST"
        var h = headers(origin)
        if let uploadTicket = uploadTicket { h["x-proctor-upload-ticket"] = uploadTicket }
        h["content-type"] = "multipart/form-data; boundary=\(boundary)"
        req.allHTTPHeaderFields = h

        var data = Data()
        func addField(_ name: String, _ value: String) {
            data.append("--\(boundary)\r\n".data(using: .utf8)!)
            data.append("Content-Disposition: form-data; name=\"\(name)\"\r\n\r\n".data(using: .utf8)!)
            data.append("\(value)\r\n".data(using: .utf8)!)
        }
        addField("channel", channel)
        for (k, v) in fields { addField(k, v) }
        data.append("--\(boundary)\r\n".data(using: .utf8)!)
        data.append("Content-Disposition: form-data; name=\"file\"; filename=\"\(fileURL.lastPathComponent)\"\r\n".data(using: .utf8)!)
        data.append("Content-Type: \(mime)\r\n\r\n".data(using: .utf8)!)
        data.append(try Data(contentsOf: fileURL))
        data.append("\r\n--\(boundary)--\r\n".data(using: .utf8)!)
        req.httpBody = data
        return try await send(req)
    }

    func download(_ value: String) async throws -> Data {
        let origin = serverUrl
        guard let url = URL(string: value), var components = URLComponents(url: url, resolvingAgainstBaseURL: false) else { throw URLError(.badURL) }
        components.path = ""; components.query = nil; components.fragment = nil
        guard try secureOrigin(components.url?.absoluteString ?? "") == origin else { throw URLError(.badURL) }
        var request = URLRequest(url: url); request.allHTTPHeaderFields = headers(origin)
        let (data, response) = try await session.data(for: request)
        guard origin == serverUrl, let http = response as? HTTPURLResponse, (200..<300).contains(http.statusCode) else { throw URLError(.badServerResponse) }
        return data
    }

    private func send(_ req: URLRequest) async throws -> Any {
        guard let url = req.url, try secureOrigin(URLComponents(url: url, resolvingAgainstBaseURL: false).map { c in var x = c; x.path = ""; x.query = nil; x.fragment = nil; return x.url?.absoluteString ?? "" } ?? "") == serverUrl else { throw URLError(.badURL) }
        let requestOrigin = serverUrl
        let (data, resp) = try await session.data(for: req)
        guard requestOrigin == serverUrl else { throw NSError(domain: "Api", code: 409, userInfo: [NSLocalizedDescriptionKey: "服务器已切换，请重新登录"]) }
        let json = try JSONSerialization.jsonObject(with: data) as? [String: Any] ?? [:]
        if json["code"] as? String == "CLIENT_SESSION_REVOKED" {
            clearSession()
            throw NSError(domain: "ClientSessionRevoked", code: 410, userInfo: [NSLocalizedDescriptionKey: "会话已注销，请重新登录"])
        }
        guard let http = resp as? HTTPURLResponse, (200..<300).contains(http.statusCode), json["ok"] as? Bool == true else {
            throw NSError(domain: "Api", code: (resp as? HTTPURLResponse)?.statusCode ?? 0,
                          userInfo: [NSLocalizedDescriptionKey: json["message"] as? String ?? "请求失败"])
        }
        if var result = json["data"] as? [String: Any] { result["_clientServerOrigin"] = requestOrigin; return result }
        return json["data"] ?? NSNull()
    }
}
