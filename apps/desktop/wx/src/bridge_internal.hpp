#pragma once

#include "bridge.hpp"

#include <atomic>
#include <chrono>
#include <mutex>
#include <optional>
#include <stdexcept>
#include <vector>

namespace proctor::bridge_detail {

namespace fs = std::filesystem;
using Clock = std::chrono::steady_clock;
using StatusPublisher = std::function<void(const Json&)>;
#ifdef __APPLE__
inline constexpr std::string_view kRuntime = "wx-wkwebview";
#ifdef __aarch64__
inline constexpr std::string_view kUpdateTarget = "mac-arm64";
#else
inline constexpr std::string_view kUpdateTarget = "mac-x64";
#endif
#else
inline constexpr std::string_view kRuntime = "wx-webview2-109";
inline constexpr std::string_view kUpdateTarget = "windows";
#endif

#ifdef _WIN32
std::string_view UpdateTarget();
std::wstring Wide(std::string_view value);
std::string Utf8(std::wstring_view value);
std::wstring Quote(std::wstring_view argument);
fs::path SystemDirectory();
#else
inline constexpr std::string_view UpdateTarget() { return kUpdateTarget; }
#endif
std::string Text(const Json& value, std::string_view key);
std::string Lower(std::string value);
Json Parse(std::string_view value);
std::string Base64(std::string_view input);
std::string DecodeBase64(std::string_view input, bool urlEncoded = false);
std::string Hash(std::string_view input, bool sha512);
std::string RandomHex();
std::optional<std::uint64_t> PositiveId(std::string_view value);

// Keep application errors distinct from transport failures. Retrying an HTTP
// write whose response was lost could submit the same operation twice.
class ResponseError : public std::runtime_error {
    using std::runtime_error::runtime_error;
};

enum class Transport { SystemProxy, Direct, SystemCurl };
class NetworkFailure : public std::runtime_error {
    using std::runtime_error::runtime_error;
};
#ifdef _WIN32
HttpResponse RequestUpdateManifest(const HttpUrl& target, int timeoutMs, std::size_t maxBytes,
                                   const std::atomic<bool>* stopping);
#endif
Json RequestResponse(const HttpResponse& response);
Json RequestJsonVia(const HttpUrl& target, const Json& options, Transport transport,
                   const std::atomic<bool>* stopping = nullptr);
Json RequestJsonWithFallback(const HttpUrl& target, const Json& options, const std::atomic<bool>* stopping);
Json Diagnose(const HttpUrl& target, const std::atomic<bool>* stopping = nullptr);
void DownloadVerified(const HttpUrl& target, std::uint64_t size, std::string_view sha512,
                      const fs::path& destination, const std::function<void(double)>& progress,
                      const std::atomic<bool>& stopping);
#ifdef __APPLE__
bool MatchesUpdateFile(const fs::path& path, std::uint64_t size, std::string_view sha512,
                       const std::atomic<bool>& stopping);
#endif

class Updater {
public:
    Updater(Bridge::Config config, StatusPublisher publish, const std::atomic<bool>& stopping);
    Json Status() const;
    Json Check(bool startup = false);
    void RequireBackend(std::string_view origin) const;
    fs::path Download();
    void Installed();
#ifdef __APPLE__
    void Deferred();
#endif
    void Failed(std::string message);

private:
    Json CheckUnlocked();
    void Set(Json patch);

    Bridge::Config config_;
    StatusPublisher publish_;
    const std::atomic<bool>& stopping_;
    std::string origin_, channel_, backendOrigin_;
    mutable std::mutex stateMutex_;
    std::mutex operationMutex_;
    bool startupChecked_ = false;
    Json status_, release_;
};

class Submit {
public:
    Submit(fs::path resources, StatusPublisher publish, const std::atomic<bool>& stopping);
    Json Status() const;
    void Initialize();
    std::uint64_t SelectLogin(Bridge::NovaJudgeLogin login);
    std::uint64_t PrepareRetry();
    void Connect(std::uint64_t generation);
    void Reset();
    void DrainRevocations();
    void ClearNow();

private:
    void SetLocked(Json value);
    void ResetLocked(bool forgetLogin);
    void Revoke(std::string_view origin, std::string_view token) const;
    void RemoveOwned(const Json& config) const;
    Json ReadOwned() const;
    void WriteOwned(const Json& config) const;

    fs::path resources_, configFile_;
    StatusPublisher publish_;
    const std::atomic<bool>& stopping_;
    std::atomic<std::uint64_t> generation_{0};
    std::string instance_;
    mutable std::mutex mutex_;
    std::mutex initializationMutex_;
    std::mutex operationMutex_;
    bool initialized_ = false;
    Json status_, owned_;
    std::vector<Json> revocations_;
    std::optional<Bridge::NovaJudgeLogin> login_;
};

}  // namespace proctor::bridge_detail
