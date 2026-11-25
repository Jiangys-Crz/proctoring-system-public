#include "local_http.hpp"

#include <algorithm>
#include <array>
#include <cctype>
#include <cerrno>
#include <charconv>
#include <chrono>
#include <fstream>
#include <sstream>
#include <stdexcept>
#include <string_view>

#include <arpa/inet.h>
#include <fcntl.h>
#include <netinet/in.h>
#include <poll.h>
#include <sys/socket.h>
#include <unistd.h>

namespace proctor {
namespace {
namespace fs = std::filesystem;
constexpr std::string_view framePath = "/capture-frame/";
constexpr std::string_view reject = "HTTP/1.1 404 Not Found\r\nContent-Length: 0\r\nConnection: close\r\n\r\n";

bool Send(int client, std::string_view bytes) {
    while (!bytes.empty()) {
        const auto count = send(client, bytes.data(), bytes.size(), 0);
        if (count < 0 && errno == EINTR) continue;
        if (count <= 0) return false;
        bytes.remove_prefix(static_cast<std::size_t>(count));
    }
    return true;
}

const char* Mime(const fs::path& file) {
    const auto extension = file.extension();
    if (extension == ".html") return "text/html; charset=utf-8";
    if (extension == ".js") return "text/javascript; charset=utf-8";
    if (extension == ".css") return "text/css; charset=utf-8";
    if (extension == ".json") return "application/json";
    if (extension == ".svg") return "image/svg+xml";
    if (extension == ".png") return "image/png";
    if (extension == ".jpg" || extension == ".jpeg") return "image/jpeg";
    if (extension == ".ico") return "image/x-icon";
    if (extension == ".woff2") return "font/woff2";
    if (extension == ".mp3") return "audio/mpeg";
    if (extension == ".wav") return "audio/wav";
    return "application/octet-stream";
}

bool IsLocalAsset(std::string_view path) {
    if (!path.starts_with('/') || path.size() < 2 || path.size() > 240) return false;
    if (path.find("..") != std::string::npos || path.find("//") != std::string::npos) return false;
    return std::all_of(path.begin(), path.end(), [](unsigned char ch) {
        return (ch >= 'a' && ch <= 'z') || (ch >= 'A' && ch <= 'Z') ||
            (ch >= '0' && ch <= '9') || ch == '/' || ch == '.' || ch == '-' || ch == '_';
    });
}

bool Within(const fs::path& root, const fs::path& file) {
    const auto relative = file.lexically_relative(root);
    return !relative.empty() && !relative.is_absolute() && *relative.begin() != "..";
}

bool IsCaptureLease(std::string_view lease) {
    if (lease.size() != 36) return false;
    for (std::size_t i = 0; i < lease.size(); ++i) {
        const char ch = lease[i];
        if (i == 8 || i == 13 || i == 18 || i == 23) {
            if (ch != '-') return false;
        } else if (!std::isxdigit(static_cast<unsigned char>(ch))) return false;
    }
    return true;
}
}

LocalHttp::LocalHttp(const fs::path& renderer, const fs::path& data, DesktopMedia& media)
    : renderer_(fs::canonical(renderer)), media_(media) {
    const auto portFile = data / "wk-shell-port";
    unsigned port = 0;
    std::ifstream(portFile) >> port;
    if (port > 65535 || (port && port < 1024)) throw std::runtime_error("客户端本地页面端口配置无效");
    listener_ = socket(AF_INET, SOCK_STREAM, 0);
    if (listener_ < 0) throw std::runtime_error("无法启动客户端本地页面");
    try {
        if (fcntl(listener_, F_SETFD, FD_CLOEXEC) < 0 || fcntl(listener_, F_SETFL, O_NONBLOCK) < 0)
            throw std::runtime_error("无法启动客户端本地页面");
        const int enabled = 1;
        setsockopt(listener_, SOL_SOCKET, SO_REUSEADDR, &enabled, sizeof(enabled));
        sockaddr_in address{};
        address.sin_family = AF_INET;
        address.sin_port = htons(static_cast<unsigned short>(port));
        address.sin_addr.s_addr = htonl(INADDR_LOOPBACK);
        socklen_t size = sizeof(address);
        if (bind(listener_, reinterpret_cast<sockaddr*>(&address), size) || listen(listener_, 32) ||
            getsockname(listener_, reinterpret_cast<sockaddr*>(&address), &size)) {
            throw std::runtime_error("客户端本地页面端口不可用");
        }
        if (!port) {
            const auto temporary = data / "wk-shell-port.tmp";
            std::ofstream output(temporary, std::ios::trunc);
            output << ntohs(address.sin_port) << '\n';
            output.close();
            if (!output) throw std::runtime_error("无法保存客户端本地页面端口");
            fs::rename(temporary, portFile);
        }
        host_ = "127.0.0.1:" + std::to_string(ntohs(address.sin_port));
        origin_ = "http://" + host_;
        // WebKit can open several connections before issuing its requests.
        // A pending request on one connection should not delay other assets.
        for (std::size_t worker = 0; worker < workers_.size(); ++worker)
            workers_[worker] = std::thread([this, worker] { Serve(worker); });
    } catch (...) {
        Stop();
        throw;
    }
}

LocalHttp::~LocalHttp() { Stop(); }

void LocalHttp::Stop() {
    stopping_ = true;
    if (listener_ >= 0) shutdown(listener_, SHUT_RDWR);
    {
        const std::lock_guard lock(clientsMutex_);
        for (const int client : clients_) if (client >= 0) shutdown(client, SHUT_RDWR);
    }
    for (auto& worker : workers_) if (worker.joinable()) worker.join();
    if (listener_ >= 0) {
        close(listener_);
        listener_ = -1;
    }
}

void LocalHttp::Serve(std::size_t worker) {
    while (!stopping_) {
        pollfd watch{listener_, POLLIN, 0};
        if (poll(&watch, 1, 150) <= 0 || !(watch.revents & POLLIN)) continue;
        const int client = accept(listener_, nullptr, nullptr);
        if (client < 0) continue;
        {
            const std::lock_guard lock(clientsMutex_);
            if (stopping_) { close(client); return; }
            clients_[worker] = client;
        }
        const int enabled = 1;
        const timeval timeout{1, 0};
        setsockopt(client, SOL_SOCKET, SO_NOSIGPIPE, &enabled, sizeof(enabled));
        setsockopt(client, SOL_SOCKET, SO_SNDTIMEO, &timeout, sizeof(timeout));
        if (fcntl(client, F_SETFD, FD_CLOEXEC) >= 0 && fcntl(client, F_SETFL, 0) >= 0) {
            try { Reply(client); } catch (...) {}
        }
        {
            const std::lock_guard lock(clientsMutex_);
            close(client);
            clients_[worker] = -1;
        }
    }
}

void LocalHttp::Reply(int client) const {
    std::string request;
    std::array<char, 16 * 1024> buffer;
    using Clock = std::chrono::steady_clock;
    const auto deadline = Clock::now() + std::chrono::seconds(2);
    while (request.size() < 8192 && request.find("\r\n\r\n") == std::string::npos) {
        const auto remaining = std::chrono::duration_cast<std::chrono::milliseconds>(deadline - Clock::now()).count();
        if (remaining <= 0 || stopping_) return;
        pollfd watch{client, POLLIN, 0};
        const int ready = poll(&watch, 1, static_cast<int>(remaining));
        if (ready < 0 && errno == EINTR) continue;
        if (ready <= 0 || !(watch.revents & POLLIN)) return;
        const auto bytes = recv(client, buffer.data(), 8192 - request.size(), 0);
        if (bytes < 0 && errno == EINTR) continue;
        if (bytes <= 0) return;
        request.append(buffer.data(), static_cast<std::size_t>(bytes));
    }
    const auto end = request.find("\r\n\r\n");
    if (end == std::string::npos || end >= 8192) return;
    std::istringstream headers(request.substr(0, end));
    std::string line, method, path, protocol;
    std::getline(headers, line);
    std::istringstream start(line);
    start >> method >> path >> protocol;
    if ((method != "GET" && method != "HEAD") || !IsLocalAsset(path)) {
        Send(client, reject);
        return;
    }
    std::string host, referer, lease;
    while (std::getline(headers, line)) {
        const auto colon = line.find(':');
        if (colon == std::string::npos) continue;
        auto name = line.substr(0, colon);
        std::transform(name.begin(), name.end(), name.begin(), [](unsigned char ch) { return std::tolower(ch); });
        const auto first = line.find_first_not_of(" \t", colon + 1);
        if (first == std::string::npos) continue;
        const auto value = line.substr(first, line.find_last_not_of(" \r\t") - first + 1);
        if (name == "host") host = value;
        else if (name == "referer") referer = value;
        else if (name == "x-proctor-capture-lease") lease = value;
        if ((name == "sec-fetch-site" && value != "same-origin" && value != "none") ||
            (name == "origin" && value != origin_)) {
            Send(client, reject);
            return;
        }
    }
    if (host != host_) { Send(client, reject); return; }
    if (path.starts_with(framePath)) {
        // The private shell receives the lease over the trusted native bridge.
        // A navigation or a cross-origin page cannot read frames through this route.
        if (method != "GET" || referer != origin_ + "/index.html" || !IsCaptureLease(lease)) {
            Send(client, reject);
            return;
        }
        ReplyFrame(client, lease, std::string_view(path).substr(framePath.size()));
        return;
    }
    std::error_code error;
    const auto file = fs::canonical(renderer_ / path.substr(1), error);
    if (error || !Within(renderer_, file) || !fs::is_regular_file(file, error)) {
        Send(client, reject);
        return;
    }
    const auto size = fs::file_size(file, error);
    std::ifstream stream(file, std::ios::binary);
    if (error || !stream) { Send(client, reject); return; }
    if (!Send(client, std::string("HTTP/1.1 200 OK\r\nContent-Type: ") + Mime(file) +
        "\r\nContent-Length: " + std::to_string(size) +
        "\r\nCache-Control: no-store\r\nCross-Origin-Resource-Policy: same-origin\r\n"
        "X-Frame-Options: DENY\r\nX-Content-Type-Options: nosniff\r\nConnection: close\r\n\r\n")) return;
    if (method == "HEAD") return;
    while (!stopping_ && (stream.read(buffer.data(), buffer.size()) || stream.gcount())) {
        if (!Send(client, std::string_view(buffer.data(), static_cast<std::size_t>(stream.gcount())))) return;
    }
}

void LocalHttp::ReplyFrame(int client, const std::string& lease, std::string_view sequence) const {
    std::uint64_t after = 0;
    if (sequence.empty()) { Send(client, reject); return; }
    const auto end = sequence.data() + sequence.size();
    const auto parsed = std::from_chars(sequence.data(), end, after);
    if (parsed.ec != std::errc{} || parsed.ptr != end || after > 9007199254740991ULL) {
        Send(client, reject);
        return;
    }
    struct Reader {
        std::atomic_uint& count;
        unsigned previous;
        ~Reader() { --count; }
    } reader{frameReaders_, frameReaders_.fetch_add(1)};
    // At most two reads can wait for ScreenCaptureKit while WK loads assets.
    if (reader.previous >= 2) {
        Send(client, "HTTP/1.1 503 Service Unavailable\r\nContent-Length: 0\r\nConnection: close\r\n\r\n");
        return;
    }
    constexpr std::string_view policy = "Cache-Control: no-store\r\nCross-Origin-Resource-Policy: same-origin\r\n"
        "X-Content-Type-Options: nosniff\r\nConnection: close\r\n\r\n";
    try {
        auto frame = media_.ReadFrame(lease, after);
        if (stopping_) return;
        if (frame.jpeg.empty()) {
            Send(client, std::string("HTTP/1.1 204 No Content\r\n") + std::string(policy));
            return;
        }
        if (Send(client, std::string("HTTP/1.1 200 OK\r\nContent-Type: image/jpeg\r\nContent-Length: ") +
            std::to_string(frame.jpeg.size()) + "\r\nX-Proctor-Frame-Sequence: " +
            std::to_string(frame.sequence) + "\r\n" + std::string(policy))) {
            Send(client, frame.jpeg);
        }
    } catch (const std::exception& error) {
        const std::string_view reason(error.what());
        if (Send(client, std::string("HTTP/1.1 500 Internal Server Error\r\nContent-Type: text/plain; charset=utf-8\r\n"
            "Content-Length: ") + std::to_string(reason.size()) + "\r\n" + std::string(policy))) Send(client, reason);
    }
}
} // namespace proctor
