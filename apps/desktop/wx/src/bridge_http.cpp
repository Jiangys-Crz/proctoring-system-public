#include "bridge_internal.hpp"
#include "bridge_http_policy.hpp"

#include <windows.h>
#include <bcrypt.h>
#include <wincrypt.h>
#include <winhttp.h>

#include <algorithm>
#include <array>
#include <charconv>
#include <cctype>
#include <fstream>
#include <future>
#include <limits>
#include <system_error>
#include <utility>
#include <vector>

namespace proctor::bridge_detail {
namespace {

using namespace std::chrono_literals;

struct InternetHandle {
    HINTERNET value = nullptr;
    explicit InternetHandle(HINTERNET handle) : value(handle) {}
    ~InternetHandle() { if (value) WinHttpCloseHandle(value); }
    InternetHandle(const InternetHandle&) = delete;
};
struct WinHandle {
    HANDLE value = nullptr;
    ~WinHandle() { Close(); }
    void Close() { if (value && value != INVALID_HANDLE_VALUE) CloseHandle(std::exchange(value, nullptr)); }
};
struct AlgoHandle {
    BCRYPT_ALG_HANDLE value = nullptr;
    ~AlgoHandle() { if (value) BCryptCloseAlgorithmProvider(value, 0); }
};
struct HashHandle {
    BCRYPT_HASH_HANDLE value = nullptr;
    ~HashHandle() { if (value) BCryptDestroyHash(value); }
};

DWORD Dword(std::size_t value) {
    if (value > std::numeric_limits<DWORD>::max()) throw std::runtime_error("数据过大");
    return static_cast<DWORD>(value);
}

[[noreturn]] void RaiseNetwork(DWORD error, int timeoutMs, DWORD secureFlags = 0) {
    if (error == ERROR_WINHTTP_TIMEOUT) throw NetworkFailure("请求超时：" + std::to_string(timeoutMs) + "ms");
    std::string reason;
    if (error == ERROR_WINHTTP_NAME_NOT_RESOLVED) reason = "域名无法解析";
    else if (error == ERROR_WINHTTP_CANNOT_CONNECT) reason = "无法连接服务器";
    else if (error == ERROR_WINHTTP_SECURE_FAILURE) {
        reason = "HTTPS 证书或 TLS 协商失败";
        if (secureFlags & WINHTTP_CALLBACK_STATUS_FLAG_INVALID_CA) reason += "：证书根未受信任，请管理员核对当前 Windows 账户的证书信任";
        if (secureFlags & WINHTTP_CALLBACK_STATUS_FLAG_CERT_DATE_INVALID) reason += "：证书时间无效，请检查系统时间";
        if (secureFlags & WINHTTP_CALLBACK_STATUS_FLAG_CERT_CN_INVALID) reason += "：证书域名不匹配";
        if (secureFlags & WINHTTP_CALLBACK_STATUS_FLAG_CERT_REV_FAILED) reason += "：无法检查证书吊销信息";
        if (secureFlags & WINHTTP_CALLBACK_STATUS_FLAG_INVALID_CERT) reason += "：证书链无效";
        if (secureFlags & WINHTTP_CALLBACK_STATUS_FLAG_CERT_REVOKED) reason += "：证书已被吊销";
        if (secureFlags & WINHTTP_CALLBACK_STATUS_FLAG_CERT_WRONG_USAGE) reason += "：证书用途无效";
        if (secureFlags & WINHTTP_CALLBACK_STATUS_FLAG_SECURITY_CHANNEL_ERROR) reason += "：系统 TLS 安全通道协商失败";
        reason += "，安全状态 " + std::to_string(secureFlags);
    } else reason = "HTTP 连接失败";
    throw NetworkFailure(reason + "（WinHTTP " + std::to_string(error) + "）");
}

void CheckNetwork(bool success, int timeoutMs) {
    if (!success) RaiseNetwork(GetLastError(), timeoutMs);
}

struct RequestState {
    WinHandle event{ CreateEventW(nullptr, FALSE, FALSE, nullptr) };
    std::atomic<DWORD> error{0};
    std::atomic<DWORD> secureFlags{0};
    std::atomic<DWORD> bytes{0};
    std::array<char, 64 * 1024> chunk{};
    std::wstring headers;
    std::string body;
};

using RequestReference = std::shared_ptr<RequestState>;

void CALLBACK RequestStatus(HINTERNET, DWORD_PTR context, DWORD status, LPVOID data, DWORD size) {
    if (!context) return;
    auto* reference = reinterpret_cast<RequestReference*>(context);
    if (status == WINHTTP_CALLBACK_STATUS_HANDLE_CLOSING) {
        delete reference;
        return;
    }
    const auto state = *reference;
    switch (status) {
    case WINHTTP_CALLBACK_STATUS_SECURE_FAILURE:
        if (data && size >= sizeof(DWORD)) state->secureFlags = *static_cast<const DWORD*>(data);
        return;
    case WINHTTP_CALLBACK_STATUS_REQUEST_ERROR:
        state->error = static_cast<const WINHTTP_ASYNC_RESULT*>(data)->dwError;
        break;
    case WINHTTP_CALLBACK_STATUS_READ_COMPLETE:
        state->bytes = size;
        break;
    case WINHTTP_CALLBACK_STATUS_SENDREQUEST_COMPLETE:
    case WINHTTP_CALLBACK_STATUS_HEADERS_AVAILABLE:
        break;
    default:
        return;
    }
    SetEvent(state->event.value);
}

class Hasher {
public:
    explicit Hasher(bool sha512) {
        if (BCryptOpenAlgorithmProvider(&algorithm_.value, sha512 ? BCRYPT_SHA512_ALGORITHM : BCRYPT_SHA256_ALGORITHM,
                                        nullptr, 0) != 0) throw std::runtime_error("无法初始化文件校验");
        DWORD objectBytes = 0, returned = 0;
        if (BCryptGetProperty(algorithm_.value, BCRYPT_OBJECT_LENGTH, reinterpret_cast<PUCHAR>(&objectBytes),
                              sizeof(objectBytes), &returned, 0) != 0) throw std::runtime_error("无法初始化文件校验");
        object_.resize(objectBytes);
        if (BCryptCreateHash(algorithm_.value, &hash_.value, object_.data(), objectBytes, nullptr, 0, 0) != 0)
            throw std::runtime_error("无法初始化文件校验");
        digest_.resize(sha512 ? 64 : 32);
    }

    void Add(std::string_view data) {
        if (BCryptHashData(hash_.value, reinterpret_cast<PUCHAR>(const_cast<char*>(data.data())), Dword(data.size()), 0) != 0)
            throw std::runtime_error("文件校验失败");
    }
    std::string Finish() {
        if (BCryptFinishHash(hash_.value, reinterpret_cast<PUCHAR>(digest_.data()), Dword(digest_.size()), 0) != 0)
            throw std::runtime_error("文件校验失败");
        return digest_;
    }
private:
    AlgoHandle algorithm_;
    std::vector<unsigned char> object_;
    HashHandle hash_;
    std::string digest_;
};

#include "bridge_http_validation.inc"

void ApplyProxy(HINTERNET session, HINTERNET request, const HttpUrl& url) {
    WINHTTP_CURRENT_USER_IE_PROXY_CONFIG settings{};
    if (!WinHttpGetIEProxyConfigForCurrentUser(&settings)) return;
    WINHTTP_PROXY_INFO proxy{};
    if (settings.fAutoDetect || settings.lpszAutoConfigUrl) {
        WINHTTP_AUTOPROXY_OPTIONS options{};
        if (settings.fAutoDetect) {
            options.dwFlags |= WINHTTP_AUTOPROXY_AUTO_DETECT;
            options.dwAutoDetectFlags = WINHTTP_AUTO_DETECT_TYPE_DHCP | WINHTTP_AUTO_DETECT_TYPE_DNS_A;
        }
        if (settings.lpszAutoConfigUrl) {
            options.dwFlags |= WINHTTP_AUTOPROXY_CONFIG_URL;
            options.lpszAutoConfigUrl = settings.lpszAutoConfigUrl;
        }
        if (WinHttpGetProxyForUrl(session, Wide(url.Url()).c_str(), &options, &proxy)) {
            WinHttpSetOption(request, WINHTTP_OPTION_PROXY, &proxy, sizeof(proxy));
            GlobalFree(proxy.lpszProxy);
            GlobalFree(proxy.lpszProxyBypass);
            GlobalFree(settings.lpszProxy);
            GlobalFree(settings.lpszProxyBypass);
            GlobalFree(settings.lpszAutoConfigUrl);
            return;
        }
    }
    if (settings.lpszProxy) {
        proxy = { WINHTTP_ACCESS_TYPE_NAMED_PROXY, settings.lpszProxy, settings.lpszProxyBypass };
        WinHttpSetOption(request, WINHTTP_OPTION_PROXY, &proxy, sizeof(proxy));
    }
    GlobalFree(settings.lpszProxy);
    GlobalFree(settings.lpszProxyBypass);
    GlobalFree(settings.lpszAutoConfigUrl);
}

struct HttpSession {
    bool manualProxy = false;
    InternetHandle handle;

    HttpSession(bool useProxy, int timeoutMs) : handle(Open(useProxy, manualProxy)) {
        CheckNetwork(handle.value != nullptr, timeoutMs);
        DWORD protocols = WINHTTP_FLAG_SECURE_PROTOCOL_TLS1_2;
#ifdef WINHTTP_FLAG_SECURE_PROTOCOL_TLS1_3
        // Schannel TLS 1.3 starts with Windows 11 / Server 2022. Win7/10
        // must not be asked to enable a protocol their provider cannot use.
        OSVERSIONINFOW version{};
        version.dwOSVersionInfoSize = sizeof(version);
        using ReadVersion = LONG (WINAPI*)(OSVERSIONINFOW*);
        const auto ntdll = GetModuleHandleW(L"ntdll.dll");
        const auto readVersion = reinterpret_cast<ReadVersion>(ntdll ? GetProcAddress(ntdll, "RtlGetVersion") : nullptr);
        if (readVersion && readVersion(&version) == 0 &&
            (version.dwMajorVersion > 10 || (version.dwMajorVersion == 10 && version.dwBuildNumber >= 20348)))
            protocols |= WINHTTP_FLAG_SECURE_PROTOCOL_TLS1_3;
#endif
        if (!WinHttpSetOption(handle.value, WINHTTP_OPTION_SECURE_PROTOCOLS, &protocols, sizeof(protocols))) {
            protocols = WINHTTP_FLAG_SECURE_PROTOCOL_TLS1_2;
            CheckNetwork(WinHttpSetOption(handle.value, WINHTTP_OPTION_SECURE_PROTOCOLS, &protocols, sizeof(protocols)) != FALSE, timeoutMs);
        }
    }

    static HINTERNET Open(bool useProxy, bool& manual) {
#ifdef WINHTTP_ACCESS_TYPE_AUTOMATIC_PROXY
        if (useProxy) {
            if (const auto automatic = WinHttpOpen(L"ProctorDesktop", WINHTTP_ACCESS_TYPE_AUTOMATIC_PROXY,
                WINHTTP_NO_PROXY_NAME, WINHTTP_NO_PROXY_BYPASS, WINHTTP_FLAG_ASYNC)) return automatic;
        }
#endif
        manual = useProxy;
        return WinHttpOpen(L"ProctorDesktop", useProxy ? WINHTTP_ACCESS_TYPE_DEFAULT_PROXY : WINHTTP_ACCESS_TYPE_NO_PROXY,
                           WINHTTP_NO_PROXY_NAME, WINHTTP_NO_PROXY_BYPASS, WINHTTP_FLAG_ASYNC);
    }
};

const HttpSession& RequestSession(bool systemProxy, int timeoutMs) {
    // Keep proxy modes isolated while allowing WinHTTP to reuse connections,
    // TLS sessions, and proxy discovery across heartbeats and other requests.
    // All mutable timeouts, cookies, and credentials belong to each request.
    if (systemProxy) {
        static const HttpSession proxied(true, timeoutMs);
        return proxied;
    }
    static const HttpSession direct(false, timeoutMs);
    return direct;
}

HttpResponse Exchange(const HttpUrl& url, std::string_view method, const Json& headers, std::string_view body,
                      int timeoutMs, bool systemProxy,
                      const std::function<void(std::string_view)>& receive, std::size_t maxBytes,
                      const std::atomic<bool>* stopping = nullptr, bool expectDownload = false) {
    if (!ValidMethod(method)) throw std::runtime_error("请求方法无效");
    CheckHeaders(headers);
    const auto deadline = Clock::now() + std::chrono::milliseconds(timeoutMs);
    const auto remaining = [&] {
        if (stopping && *stopping) throw NetworkFailure("请求已取消");
        const auto ms = std::chrono::duration_cast<std::chrono::milliseconds>(deadline - Clock::now()).count();
        if (ms <= 0) throw NetworkFailure("请求超时：" + std::to_string(timeoutMs) + "ms");
        return static_cast<int>(expectDownload ? std::min<std::int64_t>(ms, 15000) : ms);
    };
    (void)remaining();
    const auto& session = RequestSession(systemProxy, timeoutMs);
    const InternetHandle connection(WinHttpConnect(session.handle.value, Wide(url.host).c_str(), url.port, 0));
    CheckNetwork(connection.value != nullptr, timeoutMs);
    const InternetHandle request(WinHttpOpenRequest(connection.value, Wide(method).c_str(), Wide(url.Target()).c_str(),
                                                   nullptr, WINHTTP_NO_REFERER, WINHTTP_DEFAULT_ACCEPT_TYPES,
                                                   url.secure ? WINHTTP_FLAG_SECURE : 0));
    CheckNetwork(request.value != nullptr, timeoutMs);
    if (session.manualProxy) ApplyProxy(session.handle.value, request.value, url);
    DWORD disabled = WINHTTP_DISABLE_REDIRECTS | WINHTTP_DISABLE_COOKIES;
    CheckNetwork(WinHttpSetOption(request.value, WINHTTP_OPTION_DISABLE_FEATURE, &disabled, sizeof(disabled)) != FALSE, timeoutMs);
    DWORD autoLogon = WINHTTP_AUTOLOGON_SECURITY_LEVEL_HIGH;
    WinHttpSetOption(request.value, WINHTTP_OPTION_AUTOLOGON_POLICY, &autoLogon, sizeof(autoLogon));
    auto state = std::make_shared<RequestState>();
    CheckNetwork(state->event.value != nullptr, timeoutMs);
    state->body = body;
    for (const auto& [key, value] : headers.items()) state->headers += Wide(key + ": " + value.get<std::string>() + "\r\n");

    const DWORD notifications = WINHTTP_CALLBACK_STATUS_SENDREQUEST_COMPLETE | WINHTTP_CALLBACK_STATUS_HEADERS_AVAILABLE |
        WINHTTP_CALLBACK_STATUS_READ_COMPLETE | WINHTTP_CALLBACK_STATUS_REQUEST_ERROR |
        WINHTTP_CALLBACK_STATUS_SECURE_FAILURE | WINHTTP_CALLBACK_FLAG_HANDLES;
    CheckNetwork(WinHttpSetStatusCallback(request.value, RequestStatus, notifications, 0) != WINHTTP_INVALID_STATUS_CALLBACK, timeoutMs);
    // WinHTTP may deliver cancellation callbacks and still hold the request
    // buffers after the handle closes. The last callback owns this reference.
    auto handleReference = std::make_unique<RequestReference>(state);
    auto context = reinterpret_cast<DWORD_PTR>(handleReference.get());
    CheckNetwork(WinHttpSetOption(request.value, WINHTTP_OPTION_CONTEXT_VALUE, &context, sizeof(context)) != FALSE, timeoutMs);
    handleReference.release();

    const auto await = [&](BOOL started) {
        if (started == FALSE && GetLastError() != ERROR_IO_PENDING) RaiseNetwork(GetLastError(), timeoutMs, state->secureFlags);
        for (;;) {
            const auto wait = WaitForSingleObject(state->event.value, static_cast<DWORD>(std::min(remaining(), 100)));
            if (wait == WAIT_OBJECT_0) break;
            if (wait != WAIT_TIMEOUT) RaiseNetwork(GetLastError(), timeoutMs);
        }
        if (const DWORD error = state->error; error) RaiseNetwork(error, timeoutMs, state->secureFlags);
    };
    const DWORD bodySize = Dword(state->body.size());
    const int sendTimeout = remaining();
    CheckNetwork(WinHttpSetTimeouts(request.value, sendTimeout, sendTimeout, sendTimeout, sendTimeout) != FALSE, timeoutMs);
    await(WinHttpSendRequest(request.value, state->headers.empty() ? WINHTTP_NO_ADDITIONAL_HEADERS : state->headers.c_str(),
                             Dword(state->headers.size()), bodySize ? state->body.data() : WINHTTP_NO_REQUEST_DATA,
                             bodySize, bodySize, context));
    DWORD incomingTimeout = static_cast<DWORD>(remaining());
    WinHttpSetOption(request.value, WINHTTP_OPTION_RECEIVE_TIMEOUT, &incomingTimeout, sizeof(incomingTimeout));
    await(WinHttpReceiveResponse(request.value, nullptr));
    DWORD status = 0, statusSize = sizeof(status);
    CheckNetwork(WinHttpQueryHeaders(request.value, WINHTTP_QUERY_STATUS_CODE | WINHTTP_QUERY_FLAG_NUMBER,
                                     WINHTTP_HEADER_NAME_BY_INDEX, &status, &statusSize, WINHTTP_NO_HEADER_INDEX) != FALSE, timeoutMs);
    if (status >= 300 && status < 400) throw NetworkFailure("请求不允许重定向");
    if (expectDownload && status != 200) throw std::runtime_error("下载连接中断，请重试");
    DWORD headerSize = 0;
    std::string contentType;
    if (!WinHttpQueryHeaders(request.value, WINHTTP_QUERY_CONTENT_TYPE, WINHTTP_HEADER_NAME_BY_INDEX,
                             nullptr, &headerSize, WINHTTP_NO_HEADER_INDEX) && GetLastError() == ERROR_INSUFFICIENT_BUFFER &&
        headerSize <= 4096) {
        std::wstring header(headerSize / sizeof(wchar_t), L'\0');
        if (WinHttpQueryHeaders(request.value, WINHTTP_QUERY_CONTENT_TYPE, WINHTTP_HEADER_NAME_BY_INDEX,
                                header.data(), &headerSize, WINHTTP_NO_HEADER_INDEX))
            contentType = Utf8(std::wstring_view(header.c_str()));
    }
    std::size_t received = 0;
    for (;;) {
        incomingTimeout = static_cast<DWORD>(remaining());
        WinHttpSetOption(request.value, WINHTTP_OPTION_RECEIVE_TIMEOUT, &incomingTimeout, sizeof(incomingTimeout));
        await(WinHttpReadData(request.value, state->chunk.data(), static_cast<DWORD>(state->chunk.size()), nullptr));
        const DWORD bytes = state->bytes;
        if (bytes == 0) break;
        received += bytes;
        if (received > maxBytes) throw NetworkFailure(expectDownload ? "更新文件超出声明大小" : "服务器响应过大，请联系监考老师");
        receive(std::string_view(state->chunk.data(), bytes));
    }
    return { status, {}, std::move(contentType) };
}

std::string CurlQuoted(std::string_view value) {
    std::string out = "\"";
    for (const char byte : value) {
        if (byte == '"' || byte == '\\') out += '\\';
        out += byte;
    }
    return out + '"';
}

HttpResponse Curl(const HttpUrl& target, std::string_view method, const Json& headers,
                  std::string_view body, int timeoutMs, const std::atomic<bool>* stopping) {
    if (stopping && *stopping) throw NetworkFailure("请求已取消");
    if (!ValidMethod(method)) throw std::runtime_error("请求方法无效");
    CheckHeaders(headers);
    const auto executable = SystemDirectory() / L"curl.exe";
    if (!fs::is_regular_file(executable)) throw NetworkFailure("系统未安装 curl");
    std::string input = "url = " + CurlQuoted(target.Url()) + "\nrequest = " + CurlQuoted(method) + "\n";
    for (const auto& [key, value] : headers.items()) input += "header = " + CurlQuoted(key + ": " + value.get<std::string>()) + "\n";
    if (!body.empty()) input += "data-raw = " + CurlQuoted(body) + "\n";
    if (input.size() > 48 * 1024) throw NetworkFailure("curl 请求过大");

    // Auth headers go over stdin, leaving credentials out of the child argv.
    SECURITY_ATTRIBUTES attributes{ sizeof(SECURITY_ATTRIBUTES), nullptr, TRUE };
    WinHandle inRead, inWrite, outRead, outWrite, nul;
    if (!CreatePipe(&inRead.value, &inWrite.value, &attributes, 64 * 1024) ||
        !CreatePipe(&outRead.value, &outWrite.value, &attributes, 64 * 1024) ||
        !SetHandleInformation(inWrite.value, HANDLE_FLAG_INHERIT, 0) ||
        !SetHandleInformation(outRead.value, HANDLE_FLAG_INHERIT, 0)) throw NetworkFailure("无法初始化系统 curl");
    nul.value = CreateFileW(L"NUL", GENERIC_WRITE, FILE_SHARE_READ | FILE_SHARE_WRITE, &attributes, OPEN_EXISTING, 0, nullptr);
    if (nul.value == INVALID_HANDLE_VALUE) throw NetworkFailure("无法初始化系统 curl");
    SIZE_T attributeBytes = 0;
    InitializeProcThreadAttributeList(nullptr, 1, 0, &attributeBytes);
    if (!attributeBytes) throw NetworkFailure("无法初始化系统 curl");
    std::vector<std::byte> attributeStorage(attributeBytes);
    auto* list = reinterpret_cast<LPPROC_THREAD_ATTRIBUTE_LIST>(attributeStorage.data());
    if (!InitializeProcThreadAttributeList(list, 1, 0, &attributeBytes)) throw NetworkFailure("无法初始化系统 curl");
    auto attributesGuard = std::unique_ptr<std::remove_pointer_t<LPPROC_THREAD_ATTRIBUTE_LIST>, decltype(&DeleteProcThreadAttributeList)>(list, &DeleteProcThreadAttributeList);
    std::array<HANDLE, 3> inherited{ inRead.value, outWrite.value, nul.value };
    if (!UpdateProcThreadAttribute(list, 0, PROC_THREAD_ATTRIBUTE_HANDLE_LIST, inherited.data(),
                                   sizeof(inherited), nullptr, nullptr)) throw NetworkFailure("无法初始化系统 curl");

    STARTUPINFOEXW startup{};
    startup.StartupInfo.cb = sizeof(startup);
    startup.StartupInfo.dwFlags = STARTF_USESTDHANDLES;
    startup.StartupInfo.hStdInput = inRead.value;
    startup.StartupInfo.hStdOutput = outWrite.value;
    startup.StartupInfo.hStdError = nul.value;
    startup.lpAttributeList = list;
    auto command = Quote(executable.wstring()) + L" -q --silent --proto =http,https --max-time " +
                   std::to_wstring((timeoutMs + 999) / 1000) +
                   (PreferDirectHttp(target.host) ? L" --noproxy " + Quote(Wide(target.host)) : L"") +
                   LR"( --config - --write-out "\n%{http_code}")";
    PROCESS_INFORMATION process{};
    if (!CreateProcessW(executable.c_str(), command.data(), nullptr, nullptr, TRUE,
                        CREATE_NO_WINDOW | EXTENDED_STARTUPINFO_PRESENT,
                        nullptr, nullptr, &startup.StartupInfo, &process)) throw NetworkFailure("无法启动系统 curl");
    WinHandle processHandle{ process.hProcess };
    WinHandle threadHandle{ process.hThread };
    inRead.Close();
    outWrite.Close();
    const auto fail = [&](const char* message) {
        TerminateProcess(processHandle.value, 1);
        throw NetworkFailure(message);
    };
    DWORD written = 0;
    if (!WriteFile(inWrite.value, input.data(), Dword(input.size()), &written, nullptr) || written != input.size())
        fail("无法向系统 curl 提交请求");
    inWrite.Close();
    std::string raw;
    std::array<char, 8192> chunk{};
    const auto deadline = Clock::now() + std::chrono::milliseconds(timeoutMs + 1000);
    for (;;) {
        DWORD available = 0, bytes = 0;
        if (!PeekNamedPipe(outRead.value, nullptr, 0, nullptr, &available, nullptr)) {
            if (GetLastError() != ERROR_BROKEN_PIPE) fail("系统 curl 读取失败");
            break;
        }
        if (available != 0) {
            if (!ReadFile(outRead.value, chunk.data(), std::min(available, static_cast<DWORD>(chunk.size())), &bytes, nullptr))
                fail("系统 curl 读取失败");
            raw.append(chunk.data(), bytes);
            if (raw.size() > 16 * 1024 * 1024 + 4) fail("服务器响应过大，请联系监考老师");
        } else {
            if (WaitForSingleObject(processHandle.value, 20) == WAIT_OBJECT_0) {
                if (!PeekNamedPipe(outRead.value, nullptr, 0, nullptr, &available, nullptr) || !available) break;
            }
        }
        if (stopping && *stopping) fail("请求已取消");
        if (Clock::now() > deadline) fail("系统 curl 请求超时");
    }
    const auto remaining = std::max<std::int64_t>(0, std::chrono::duration_cast<std::chrono::milliseconds>(deadline - Clock::now()).count());
    if (WaitForSingleObject(processHandle.value, static_cast<DWORD>(remaining)) != WAIT_OBJECT_0)
        fail("系统 curl 请求超时");
    DWORD code = 1;
    GetExitCodeProcess(processHandle.value, &code);
    if (code != 0) throw NetworkFailure("系统 curl 请求失败（" + std::to_string(code) + "）");
    unsigned status = 0;
    if (raw.size() < 4 || raw[raw.size() - 4] != '\n') throw NetworkFailure("系统 curl 响应无效");
    const auto parsed = std::from_chars(raw.data() + raw.size() - 3, raw.data() + raw.size(), status);
    if (parsed.ec != std::errc() || status < 100) throw NetworkFailure("系统 curl 响应无效");
    raw.resize(raw.size() - 4);
    if (status >= 300 && status < 400) throw NetworkFailure("请求不允许重定向");
    return { status, std::move(raw), {} };
}

}  // namespace

std::wstring Wide(std::string_view value) {
    if (value.empty()) return {};
    if (value.size() > std::numeric_limits<int>::max()) throw std::runtime_error("字符串过长");
    const int length = static_cast<int>(value.size());
    const int count = MultiByteToWideChar(CP_UTF8, MB_ERR_INVALID_CHARS, value.data(), length, nullptr, 0);
    if (count <= 0) throw std::runtime_error("字符串编码无效");
    std::wstring result(count, L'\0');
    if (!MultiByteToWideChar(CP_UTF8, MB_ERR_INVALID_CHARS, value.data(), length, result.data(), count))
        throw std::runtime_error("字符串编码无效");
    return result;
}

std::string Utf8(std::wstring_view value) {
    if (value.empty()) return {};
    if (value.size() > std::numeric_limits<int>::max()) throw std::runtime_error("字符串过长");
    const int length = static_cast<int>(value.size());
    const int count = WideCharToMultiByte(CP_UTF8, WC_ERR_INVALID_CHARS, value.data(), length, nullptr, 0, nullptr, nullptr);
    if (count <= 0) throw std::runtime_error("字符串编码无效");
    std::string result(count, '\0');
    if (!WideCharToMultiByte(CP_UTF8, WC_ERR_INVALID_CHARS, value.data(), length, result.data(), count, nullptr, nullptr))
        throw std::runtime_error("字符串编码无效");
    return result;
}

std::string Base64(std::string_view input) {
    const auto* data = reinterpret_cast<const BYTE*>(input.data());
    const DWORD length = Dword(input.size());
    const DWORD flags = CRYPT_STRING_BASE64 | CRYPT_STRING_NOCRLF;
    DWORD size = 0;
    if (!CryptBinaryToStringA(data, length, flags, nullptr, &size)) throw std::runtime_error("编码失败");
    std::string output(size, '\0');
    if (!CryptBinaryToStringA(data, length, flags, output.data(), &size)) throw std::runtime_error("编码失败");
    output.resize(size);
    return output;
}

std::string DecodeBase64(std::string_view input, bool urlEncoded) {
    std::string encoded(input);
    if (urlEncoded) {
        std::replace(encoded.begin(), encoded.end(), '-', '+');
        std::replace(encoded.begin(), encoded.end(), '_', '/');
        while (encoded.size() % 4 != 0) encoded += '=';
    }
    DWORD size = 0;
    const DWORD length = Dword(encoded.size());
    if (!CryptStringToBinaryA(encoded.data(), length, CRYPT_STRING_BASE64, nullptr, &size, nullptr, nullptr))
        throw std::runtime_error("编码无效");
    std::string output(size, '\0');
    if (!CryptStringToBinaryA(encoded.data(), length, CRYPT_STRING_BASE64, reinterpret_cast<BYTE*>(output.data()), &size, nullptr, nullptr))
        throw std::runtime_error("编码无效");
    output.resize(size);
    return output;
}

std::string Hash(std::string_view input, bool sha512) {
    Hasher hash(sha512);
    hash.Add(input);
    return hash.Finish();
}

std::wstring Quote(std::wstring_view argument) {
    std::wstring quoted = L"\"";
    std::size_t slashes = 0;
    for (const wchar_t ch : argument) {
        if (ch == L'\\') { ++slashes; continue; }
        quoted.append(slashes * (ch == L'"' ? 2 : 1) + (ch == L'"' ? 1 : 0), L'\\');
        quoted += ch;
        slashes = 0;
    }
    quoted.append(slashes * 2, L'\\');
    return quoted + L'"';
}

fs::path SystemDirectory() {
    std::array<wchar_t, MAX_PATH> buffer{};
    const auto length = GetSystemDirectoryW(buffer.data(), static_cast<UINT>(buffer.size()));
    if (!length || length >= buffer.size()) throw std::runtime_error("无法读取 Windows 系统目录");
    return fs::path(buffer.data());
}

std::string RandomHex() {
    std::array<unsigned char, 16> bytes{};
    if (BCryptGenRandom(nullptr, bytes.data(), static_cast<ULONG>(bytes.size()), BCRYPT_USE_SYSTEM_PREFERRED_RNG) != 0)
        throw std::runtime_error("无法生成随机标识");
    std::string text;
    for (const auto byte : bytes) {
        text += "0123456789abcdef"[byte >> 4];
        text += "0123456789abcdef"[byte & 15];
    }
    return text;
}

#include "bridge_http_request.inc"

}  // namespace proctor::bridge_detail

namespace proctor {

HttpUrl ParseHttpUrl(std::string_view url) {
    using namespace bridge_detail;
    if (url.empty() || url.size() > 32768 || url.find_first_of("\\\r\n\t\0", 0, 5) != std::string_view::npos)
        throw std::runtime_error("服务器地址无效");
    const auto source = Wide(url);
    URL_COMPONENTS pieces{};
    pieces.dwStructSize = sizeof(pieces);
    pieces.dwSchemeLength = pieces.dwHostNameLength = pieces.dwUserNameLength = pieces.dwPasswordLength =
        pieces.dwUrlPathLength = pieces.dwExtraInfoLength = static_cast<DWORD>(-1);
    if (!WinHttpCrackUrl(source.c_str(), static_cast<DWORD>(source.size()), 0, &pieces) ||
        (pieces.nScheme != INTERNET_SCHEME_HTTP && pieces.nScheme != INTERNET_SCHEME_HTTPS) ||
        !pieces.dwHostNameLength || pieces.dwUserNameLength || pieces.dwPasswordLength || !pieces.nPort)
        throw std::runtime_error("服务器地址无效");
    const auto part = [&](const wchar_t* value, DWORD length) {
        return length ? Utf8(std::wstring_view(value, length)) : std::string{};
    };
    const bool secure = pieces.nScheme == INTERNET_SCHEME_HTTPS;
    auto host = Lower(part(pieces.lpszHostName, pieces.dwHostNameLength));
    if (host.find_first_of(" %/@?#") != std::string::npos) throw std::runtime_error("服务器地址无效");
    if (host.find(':') != std::string::npos && host.front() != '[') host = '[' + host + ']';
    auto origin = (secure ? "https://" : "http://") + host;
    if (pieces.nPort != (secure ? 443 : 80)) origin += ':' + std::to_string(pieces.nPort);
    auto path = part(pieces.lpszUrlPath, pieces.dwUrlPathLength);
    auto query = part(pieces.lpszExtraInfo, pieces.dwExtraInfoLength);
    std::string fragment;
    if (const auto hash = query.find('#'); hash != std::string::npos) {
        fragment = query.substr(hash);
        query.resize(hash);
    }
    return { std::move(origin), std::move(host), NormalizePath(path), std::move(query),
             std::move(fragment), pieces.nPort, secure };
}

#include "bridge_http_entry.inc"

}  // namespace proctor
