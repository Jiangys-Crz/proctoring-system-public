#pragma once

#include <nlohmann/json.hpp>

#include <atomic>
#include <cstddef>
#include <filesystem>
#include <functional>
#include <memory>
#include <string>
#include <string_view>

namespace proctor {

using Json = nlohmann::json;

struct HttpUrl {
    std::string origin;
    std::string host;
    std::string path;
    std::string query;
    std::string fragment;
    unsigned short port;
    bool secure;

    std::string Target() const { return path + query; }
    std::string Url() const { return origin + Target(); }
};

HttpUrl ParseHttpUrl(std::string_view url);
HttpUrl ResolveHttpUrl(std::string_view base, std::string_view target);

struct HttpResponse {
    unsigned status;
    std::string body;
    std::string contentType;
};

HttpResponse RequestHttp(std::string_view url, std::string_view method, const Json& headers,
                         std::string_view body, int timeoutMs, std::size_t maxBytes,
                         bool systemProxy = true, const std::atomic_bool* stopping = nullptr);
Json RequestJson(std::string_view absoluteUrl, const Json& options = Json::object());

// HandleMessage is called only for messages from the trusted local main document.
// The shell must apply that source check before the bridge sees the payload.
class Bridge {
public:
    using Reply = std::function<void(Json value, std::string error)>;
    using Dispatch = std::function<void(std::string_view channel, const Json& args, Reply reply)>;
    using Publish = std::function<void(const Json& message)>;
#ifdef __APPLE__
    using Install = std::function<bool(const std::filesystem::path& path)>;
#else
    using Install = std::function<void(const std::filesystem::path& path)>;
#endif
    using OnUi = std::function<void(std::function<void()>)>;

    struct Config {
        std::string version;
        std::filesystem::path rendererDirectory;
        std::filesystem::path userDataDirectory;
        bool packaged;
        std::filesystem::path resourcesDirectory;
    };
    struct NovaJudgeLogin {
        std::string origin, contestId, backendOrigin, cookieToken, proctoringKey;
        Json contestAccessToken;
    };

    Bridge(Config config, Dispatch dispatch, Publish publish, Install install, OnUi onUi);
    ~Bridge();
    Bridge(const Bridge&) = delete;
    Bridge& operator=(const Bridge&) = delete;

    void HandleMessage(std::string_view webMessage);
    void HandleParsedMessage(const Json& message);
    void Push(std::string_view channel, const Json& value = nullptr);
    void NewDocument();
    bool BeginRendererRecovery(bool active);
    void SetAllowedHosts(const Json& hosts);
    void SetApiPolicy(std::function<bool(std::string_view)> predicate);
    void SetInstallAllowed(std::function<bool()> predicate);
    void SetSubmitAllowed(std::function<bool()> predicate);

    void ConnectNovaJudge(NovaJudgeLogin login);
    void ResetNovaJudge();
    void Shutdown();

private:
    struct Impl;
    std::shared_ptr<Impl> impl_;
};

}  // namespace proctor
