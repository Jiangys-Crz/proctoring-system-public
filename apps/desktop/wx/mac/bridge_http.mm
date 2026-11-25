#include "bridge_internal.hpp"

#import <Foundation/Foundation.h>
#import <objc/runtime.h>
#include <CommonCrypto/CommonDigest.h>
#include <Security/SecRandom.h>
#include <curl/curl.h>

#include <algorithm>
#include <array>
#include <cerrno>
#include <charconv>
#include <cctype>
#include <condition_variable>
#include <exception>
#include <fstream>
#include <future>
#include <fcntl.h>
#include <sys/stat.h>
#include <unistd.h>

namespace proctor::bridge_detail {
namespace {

using namespace std::chrono_literals;

NSString* String(std::string_view value) {
    NSString* result = [[NSString alloc] initWithBytes:value.data() length:value.size() encoding:NSUTF8StringEncoding];
    if (!result) throw std::runtime_error("字符串编码无效");
    return result;
}

std::string Bytes(NSData* data) {
    return data.length ? std::string(static_cast<const char*>(data.bytes), data.length) : std::string{};
}

std::string Utf8(NSString* value) {
    return Bytes([value dataUsingEncoding:NSUTF8StringEncoding]);
}

class Hasher {
public:
    explicit Hasher(bool sha512) : sha512_(sha512) {
        if (sha512_) CC_SHA512_Init(&sha512Context_);
        else CC_SHA256_Init(&sha256Context_);
    }

    void Add(std::string_view bytes) {
        while (!bytes.empty()) {
            const auto count = static_cast<CC_LONG>(std::min<std::size_t>(bytes.size(), 1024 * 1024));
            if (sha512_) CC_SHA512_Update(&sha512Context_, bytes.data(), count);
            else CC_SHA256_Update(&sha256Context_, bytes.data(), count);
            bytes.remove_prefix(count);
        }
    }

    std::string Finish() {
        std::string digest(sha512_ ? CC_SHA512_DIGEST_LENGTH : CC_SHA256_DIGEST_LENGTH, '\0');
        if (sha512_) CC_SHA512_Final(reinterpret_cast<unsigned char*>(digest.data()), &sha512Context_);
        else CC_SHA256_Final(reinterpret_cast<unsigned char*>(digest.data()), &sha256Context_);
        return digest;
    }

private:
    bool sha512_;
    CC_SHA512_CTX sha512Context_{};
    CC_SHA256_CTX sha256Context_{};
};

#include "bridge_http_validation.inc"

struct ResponseStream {
    std::function<void(std::string_view)> receive;
    std::size_t maxBytes;
    bool download;
    std::size_t received = 0;
    std::exception_ptr failure;

    bool Add(const char* bytes, std::size_t count) {
        try {
            if (count > maxBytes - received)
                throw NetworkFailure(download ? "更新文件超出声明大小" : "服务器响应过大，请联系监考老师");
            received += count;
            receive({bytes, count});
            return true;
        } catch (...) {
            failure = std::current_exception();
            return false;
        }
    }
};

struct SessionState {
    ResponseStream stream;
    std::mutex mutex;
    std::condition_variable changed;
    bool done = false;
    HttpResponse response{};
};

} // namespace
} // namespace proctor::bridge_detail

@interface ProctorBridgeTaskState : NSObject {
@public
    std::shared_ptr<proctor::bridge_detail::SessionState> value;
}
@end

@implementation ProctorBridgeTaskState
@end

namespace {
char bridgeTaskKey;

std::shared_ptr<proctor::bridge_detail::SessionState> StateForTask(NSURLSessionTask* task) {
    auto* holder = (ProctorBridgeTaskState*)objc_getAssociatedObject(task, &bridgeTaskKey);
    return holder ? holder->value : nullptr;
}
}

@interface ProctorBridgeSessionDelegate : NSObject <NSURLSessionDataDelegate>
@end

@implementation ProctorBridgeSessionDelegate

- (void)URLSession:(NSURLSession*)session task:(NSURLSessionTask*)task
    willPerformHTTPRedirection:(NSHTTPURLResponse*)response newRequest:(NSURLRequest*)request
    completionHandler:(void (^)(NSURLRequest*))completion {
    if (const auto state = StateForTask(task)) {
        std::lock_guard lock(state->mutex);
        if (!state->done) {
            state->stream.failure = std::make_exception_ptr(proctor::bridge_detail::NetworkFailure("请求不允许重定向"));
            state->done = true;
            state->changed.notify_one();
        }
    }
    completion(nil);
}

- (void)URLSession:(NSURLSession*)session dataTask:(NSURLSessionDataTask*)task
    didReceiveResponse:(NSURLResponse*)response
    completionHandler:(void (^)(NSURLSessionResponseDisposition))completion {
    using namespace proctor::bridge_detail;
    bool receive = false;
    if (const auto state = StateForTask(task)) {
        std::lock_guard lock(state->mutex);
        if (!state->done) {
            try {
                if (![response isKindOfClass:[NSHTTPURLResponse class]]) throw NetworkFailure("HTTP 连接失败");
                auto* http = (NSHTTPURLResponse*)response;
                const auto status = static_cast<unsigned>(http.statusCode);
                if (status >= 300 && status < 400) throw NetworkFailure("请求不允许重定向");
                if (state->stream.download && status != 200) throw std::runtime_error("下载连接中断，请重试");
                state->response = {status, {}, Utf8([http valueForHTTPHeaderField:@"Content-Type"])};
                receive = true;
            } catch (...) {
                state->stream.failure = std::current_exception();
                state->done = true;
                state->changed.notify_one();
            }
        }
    }
    completion(receive ? NSURLSessionResponseAllow : NSURLSessionResponseCancel);
}

- (void)URLSession:(NSURLSession*)session dataTask:(NSURLSessionDataTask*)task didReceiveData:(NSData*)data {
    bool failed = false;
    if (const auto state = StateForTask(task)) {
        std::lock_guard lock(state->mutex);
        if (!state->done && !state->stream.Add(static_cast<const char*>(data.bytes), data.length)) {
            state->done = failed = true;
            state->changed.notify_one();
        }
    }
    if (failed) [task cancel];
}

- (void)URLSession:(NSURLSession*)session task:(NSURLSessionTask*)task
    didCompleteWithError:(NSError*)error {
    using namespace proctor::bridge_detail;
    const auto state = StateForTask(task);
    if (!state) return;
    objc_setAssociatedObject(task, &bridgeTaskKey, nil, OBJC_ASSOCIATION_RETAIN_NONATOMIC);
    std::lock_guard lock(state->mutex);
    if (state->done) return;
    if (error) {
        const auto message = error.code == NSURLErrorTimedOut ? "请求超时" :
            "HTTP 连接失败（macOS " + std::to_string(error.code) + "）";
        state->stream.failure = std::make_exception_ptr(NetworkFailure(message));
    }
    state->done = true;
    state->changed.notify_one();
}

@end

namespace proctor::bridge_detail {
namespace {

NSURLSession* CreateBridgeSession() {
    auto* config = [NSURLSessionConfiguration ephemeralSessionConfiguration];
    config.URLCache = nil;
    config.URLCredentialStorage = nil;
    config.HTTPCookieStorage = nil;
    config.HTTPShouldSetCookies = NO;
    return [NSURLSession sessionWithConfiguration:config delegate:[ProctorBridgeSessionDelegate new] delegateQueue:nil];
}

NSURLSession* BridgeSession(bool download) {
    // Each task keeps its own deadlines, credentials and byte limits. Reuse
    // the transport, and keep disk-writing download callbacks off the API queue.
    if (download) {
        static NSURLSession* updates = CreateBridgeSession();
        return updates;
    }
    static NSURLSession* requests = CreateBridgeSession();
    return requests;
}

std::size_t CurlReceive(char* bytes, std::size_t size, std::size_t count, void* context) {
    auto& stream = *static_cast<ResponseStream*>(context);
    const auto length = size * count;
    return stream.Add(bytes, length) ? length : 0;
}

int CurlProgress(void* context, curl_off_t, curl_off_t, curl_off_t, curl_off_t) {
    const auto* stopping = static_cast<const std::atomic<bool>*>(context);
    return stopping && *stopping ? 1 : 0;
}

HttpResponse ExchangeCurl(const HttpUrl& url, std::string_view method, const Json& headers,
                          std::string_view body, int timeoutMs, bool useEnvironment,
                          ResponseStream stream, const std::atomic<bool>* stopping) {
    if (stopping && *stopping) throw NetworkFailure("请求已取消");
    static const auto initialized = curl_global_init(CURL_GLOBAL_DEFAULT);
    if (initialized != CURLE_OK) throw NetworkFailure("无法初始化系统 curl");
    const std::unique_ptr<CURL, decltype(&curl_easy_cleanup)> handle(curl_easy_init(), curl_easy_cleanup);
    if (!handle) throw NetworkFailure("无法初始化系统 curl");

    struct HeaderList {
        curl_slist* list = nullptr;
        ~HeaderList() { curl_slist_free_all(list); }
    } requestHeaders;
    const auto append = [&](std::string header) {
        auto* next = curl_slist_append(requestHeaders.list, header.c_str());
        if (!next) throw NetworkFailure("无法初始化请求标头");
        requestHeaders.list = next;
    };
    for (const auto& [key, value] : headers.items()) {
        const auto& text = value.get_ref<const std::string&>();
        append(text.empty() ? key + ";" : key + ": " + text);
    }
    const auto set = [&](CURLoption option, auto value) {
        if (curl_easy_setopt(handle.get(), option, value) != CURLE_OK)
            throw NetworkFailure("无法初始化系统 curl");
    };
    const auto methodString = std::string(method);
    const auto address = url.Url();
    set(CURLOPT_URL, address.c_str());
    set(CURLOPT_CUSTOMREQUEST, methodString.c_str());
    set(CURLOPT_HTTPHEADER, requestHeaders.list);
    set(CURLOPT_NOSIGNAL, 1L);
    set(CURLOPT_TIMEOUT_MS, static_cast<long>(timeoutMs));
    set(CURLOPT_FOLLOWLOCATION, 0L);
    set(CURLOPT_NETRC, static_cast<long>(CURL_NETRC_IGNORED));
    if (!useEnvironment) set(CURLOPT_PROXY, "");
    if (method == "HEAD") set(CURLOPT_NOBODY, 1L);
    else if (!body.empty()) {
        set(CURLOPT_POSTFIELDS, body.data());
        set(CURLOPT_POSTFIELDSIZE_LARGE, static_cast<curl_off_t>(body.size()));
    }
    set(CURLOPT_WRITEFUNCTION, &CurlReceive);
    set(CURLOPT_WRITEDATA, &stream);
    set(CURLOPT_NOPROGRESS, 0L);
    set(CURLOPT_XFERINFOFUNCTION, &CurlProgress);
    set(CURLOPT_XFERINFODATA, static_cast<void*>(const_cast<std::atomic<bool>*>(stopping)));
    const auto result = curl_easy_perform(handle.get());
    if (stream.failure) std::rethrow_exception(stream.failure);
    if (stopping && *stopping) throw NetworkFailure("请求已取消");
    if (result == CURLE_OPERATION_TIMEDOUT) throw NetworkFailure("请求超时：" + std::to_string(timeoutMs) + "ms");
    if (result != CURLE_OK) throw NetworkFailure("HTTP 连接失败（curl " + std::to_string(result) + "）");
    long status = 0;
    char* type = nullptr;
    curl_easy_getinfo(handle.get(), CURLINFO_RESPONSE_CODE, &status);
    curl_easy_getinfo(handle.get(), CURLINFO_CONTENT_TYPE, &type);
    if (status >= 300 && status < 400) throw NetworkFailure("请求不允许重定向");
    if (stream.download && status != 200) throw std::runtime_error("下载连接中断，请重试");
    return {static_cast<unsigned>(status), {}, type ? type : ""};
}

HttpResponse Exchange(const HttpUrl& url, std::string_view method, const Json& headers, std::string_view body,
                      int timeoutMs, bool systemProxy, const std::function<void(std::string_view)>& receive,
                      std::size_t maxBytes, const std::atomic<bool>* stopping = nullptr, bool expectDownload = false) {
    if (stopping && *stopping) throw NetworkFailure("请求已取消");
    if (!ValidMethod(method)) throw std::runtime_error("请求方法无效");
    CheckHeaders(headers);
    if (!systemProxy)
        return ExchangeCurl(url, method, headers, body, timeoutMs, false, {receive, maxBytes, expectDownload}, stopping);

    @autoreleasepool {
        NSURL* address = [NSURL URLWithString:String(url.Url())];
        if (!address) throw std::runtime_error("服务器地址无效");
        auto* request = [NSMutableURLRequest requestWithURL:address cachePolicy:NSURLRequestReloadIgnoringLocalCacheData
                                           timeoutInterval:expectDownload ? 15 : timeoutMs / 1000.0];
        request.HTTPShouldHandleCookies = NO;
        request.HTTPMethod = String(method);
        if (!body.empty()) request.HTTPBody = [NSData dataWithBytes:body.data() length:body.size()];
        for (const auto& [name, value] : headers.items())
            [request setValue:String(value.get_ref<const std::string&>()) forHTTPHeaderField:String(name)];

        auto state = std::make_shared<SessionState>();
        state->stream = {receive, maxBytes, expectDownload};
        auto* task = [BridgeSession(expectDownload) dataTaskWithRequest:request];
        auto* holder = [ProctorBridgeTaskState new];
        holder->value = state;
        objc_setAssociatedObject(task, &bridgeTaskKey, holder, OBJC_ASSOCIATION_RETAIN_NONATOMIC);
        [task resume];

        const auto deadline = Clock::now() + std::chrono::milliseconds(timeoutMs);
        HttpResponse result{};
        std::exception_ptr failure;
        bool timeout;
        bool cancelled;
        {
            std::unique_lock lock(state->mutex);
            while (!state->done && !(stopping && *stopping) && Clock::now() < deadline)
                state->changed.wait_until(lock, std::min(deadline, Clock::now() + 100ms));
            timeout = !state->done;
            cancelled = stopping && *stopping;
            state->done = true;
            state->stream.receive = {}; // No late callback may use borrowed buffers.
            failure = state->stream.failure;
            result = std::move(state->response);
        }
        if (timeout || cancelled) [task cancel];
        if (cancelled) throw NetworkFailure("请求已取消");
        if (timeout) throw NetworkFailure("请求超时：" + std::to_string(timeoutMs) + "ms");
        if (failure) std::rethrow_exception(failure);
        return result;
    }
}

HttpResponse Curl(const HttpUrl& target, std::string_view method, const Json& headers,
                  std::string_view body, int timeoutMs, const std::atomic<bool>* stopping) {
    if (!ValidMethod(method)) throw std::runtime_error("请求方法无效");
    CheckHeaders(headers);
    std::string raw;
    ResponseStream stream{[&raw](std::string_view bytes) { raw.append(bytes); }, 16 * 1024 * 1024, false};
    auto result = ExchangeCurl(target, method, headers, body, timeoutMs, true, std::move(stream), stopping);
    result.body = std::move(raw);
    return result;
}

} // namespace

std::string Base64(std::string_view input) {
    @autoreleasepool {
        auto* data = [NSData dataWithBytes:input.data() length:input.size()];
        return Utf8([data base64EncodedStringWithOptions:0]);
    }
}

std::string DecodeBase64(std::string_view input, bool urlEncoded) {
    @autoreleasepool {
        std::string encoded(input);
        if (urlEncoded) {
            std::replace(encoded.begin(), encoded.end(), '-', '+');
            std::replace(encoded.begin(), encoded.end(), '_', '/');
            while (encoded.size() % 4 != 0) encoded += '=';
        }
        auto* data = [[NSData alloc] initWithBase64EncodedString:String(encoded) options:0];
        if (!data) throw std::runtime_error("编码无效");
        return Bytes(data);
    }
}

std::string Hash(std::string_view input, bool sha512) {
    Hasher hash(sha512);
    hash.Add(input);
    return hash.Finish();
}

bool MatchesUpdateFile(const fs::path& path, std::uint64_t size, std::string_view sha512,
                       const std::atomic<bool>& stopping) {
    struct File {
        int descriptor;
        ~File() { if (descriptor >= 0) close(descriptor); }
    } file{open(path.c_str(), O_RDONLY | O_NOFOLLOW | O_NONBLOCK | O_CLOEXEC)};
    struct stat info{};
    if (file.descriptor < 0 || fstat(file.descriptor, &info) || !S_ISREG(info.st_mode) ||
        info.st_size < 0 || static_cast<std::uint64_t>(info.st_size) != size) return false;
    std::array<char, 64 * 1024> bytes;
    Hasher hash(true);
    std::uint64_t remaining = size;
    while (remaining) {
        if (stopping) throw std::runtime_error("请求已取消");
        const auto requested = std::min<std::uint64_t>(remaining, bytes.size());
        const auto count = read(file.descriptor, bytes.data(), static_cast<std::size_t>(requested));
        if (count < 0 && errno == EINTR) continue;
        if (count <= 0) return false;
        hash.Add({bytes.data(), static_cast<std::size_t>(count)});
        remaining -= static_cast<std::uint64_t>(count);
    }
    char extra;
    ssize_t trailing;
    do { trailing = read(file.descriptor, &extra, 1); } while (trailing < 0 && errno == EINTR);
    return trailing == 0 && Base64(hash.Finish()) == sha512;
}

std::string RandomHex() {
    std::array<unsigned char, 16> bytes{};
    if (SecRandomCopyBytes(kSecRandomDefault, bytes.size(), bytes.data()) != errSecSuccess)
        throw std::runtime_error("无法生成随机标识");
    std::string result;
    for (const auto byte : bytes) {
        result += "0123456789abcdef"[byte >> 4];
        result += "0123456789abcdef"[byte & 15];
    }
    return result;
}

#include "bridge_http_request.inc"

} // namespace proctor::bridge_detail

namespace proctor {

HttpUrl ParseHttpUrl(std::string_view url) {
    using namespace bridge_detail;
    if (url.empty() || url.size() > 32768 || url.find_first_of("\\\r\n\t\0", 0, 5) != std::string_view::npos)
        throw std::runtime_error("服务器地址无效");
    @autoreleasepool {
        auto* parts = [NSURLComponents componentsWithString:String(url)];
        const auto scheme = Lower(Utf8(parts.scheme));
        const bool secure = scheme == "https";
        auto host = Lower(Utf8(parts.percentEncodedHost));
        if ((!secure && scheme != "http") || host.empty() || parts.user || parts.password ||
            host.find_first_of(" %/@?#") != std::string::npos)
            throw std::runtime_error("服务器地址无效");
        if (host.find(':') != std::string::npos && host.front() != '[') host = '[' + host + ']';
        const auto port = parts.port ? parts.port.longLongValue : secure ? 443 : 80;
        if (port < 1 || port > 65535) throw std::runtime_error("服务器地址无效");
        auto origin = scheme + "://" + host;
        if (port != (secure ? 443 : 80)) origin += ':' + std::to_string(port);
        auto query = parts.percentEncodedQuery ? '?' + Utf8(parts.percentEncodedQuery) : std::string{};
        auto fragment = parts.percentEncodedFragment ? '#' + Utf8(parts.percentEncodedFragment) : std::string{};
        return {std::move(origin), std::move(host), NormalizePath(Utf8(parts.percentEncodedPath)),
                std::move(query), std::move(fragment), static_cast<unsigned short>(port), secure};
    }
}

#include "bridge_http_entry.inc"

} // namespace proctor
