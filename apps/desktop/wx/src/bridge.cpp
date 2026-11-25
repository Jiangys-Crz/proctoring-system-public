#include "bridge_internal.hpp"

#include <algorithm>
#include <condition_variable>
#include <deque>
#include <regex>
#include <set>
#include <thread>
#include <vector>

namespace proctor {

using namespace bridge_detail;
namespace {

const Json& Argument(const Json& args, std::size_t index) {
    static const Json missing;
    return index < args.size() ? args[index] : missing;
}

std::string StringArgument(const Json& args, std::size_t index) {
    const auto& value = Argument(args, index);
    return value.is_string() ? value.get<std::string>() : std::string{};
}

Json SelectFields(const Json& source, std::initializer_list<const char*> fields) {
    Json result = Json::object();
    if (source.is_object()) {
        for (const char* field : fields) {
            if (source.contains(field)) result[field] = source.at(field);
        }
    }
    return result;
}

void RemoveSecrets(Json& value) {
    if (value.is_array()) {
        for (auto& item : value) RemoveSecrets(item);
    } else if (value.is_object()) {
        constexpr std::string_view secretKeys[] = {"password", "tokenhash", "apikey", "cookie", "secret"};
        for (auto item = value.begin(); item != value.end();) {
            const auto key = Lower(item.key());
            if (std::ranges::any_of(secretKeys, [&](auto part) { return key.find(part) != std::string::npos; })) item = value.erase(item);
            else { RemoveSecrets(*item); ++item; }
        }
    }
}

Json FilterRecovery(const Json& input, const std::string& origin) {
    static const std::regex idPattern(R"(^[A-Za-z0-9_-]{1,128}$)");
    if (!input.is_object() || !input.contains("session") || !input.contains("exam") || !input.contains("candidate"))
        throw std::runtime_error("无效的考试恢复状态");
    const auto sessionToken = Text(input, "sessionToken");
    const auto& session = input.at("session");
    const auto& exam = input.at("exam");
    const auto& candidate = input.at("candidate");
    if (origin != Text(input, "sessionServerOrigin") || sessionToken.empty() || sessionToken.size() > 8192 ||
        sessionToken.find_first_of("\r\n") != std::string::npos || !std::regex_match(Text(session, "id"), idPattern) ||
        Text(session, "examId").empty() || Text(session, "candidateId").empty() ||
        Text(session, "examId") != Text(exam, "id") || Text(session, "candidateId") != Text(candidate, "id") ||
        Text(session, "status") == "FINISHED") throw std::runtime_error("无效的考试恢复状态");

    auto result = SelectFields(input, { "baselineFingerprint", "pairCode", "pairPollToken" });
    result["serverUrl"] = origin;
    result["sessionServerOrigin"] = origin;
    result["sessionToken"] = sessionToken;
    result["session"] = SelectFields(session, { "id", "examId", "candidateId", "status", "approvedAt", "startedAt",
        "effectiveEndAt", "endedAt", "revokedAt", "lockdown", "lockdownReason", "memberName", "miniProgramOfflineAt",
        "peripheralsBaselineFingerprint", "lastPeripheralsFingerprint", "unlockNonce", "updatedAt" });
    result["candidate"] = SelectFields(candidate, { "id", "name", "examNumber", "teamName", "teamMembers", "seatNo" });
    result["exam"] = SelectFields(exam, { "id", "name", "platform", "platformBaseUrl", "platformContestId",
        "rules", "startAt", "endAt", "durationMinutes", "contestRule", "flexible" });
    const auto& requirements = input.value("requirements", Json());
    result["requirements"] = requirements.is_null() ? Json() : SelectFields(requirements, {
        "roomName", "requireFrontCamera", "requireSecondCamera", "isPublicTest", "saveFullRecording", "saveIncidentRecording" });
    RemoveSecrets(result);
    if (result.dump().size() > 1024 * 1024) throw std::runtime_error("考试恢复状态过大");
    return result;
}

bool RequiresCurrentClient(const HttpUrl& target, const Json& options) {
    if (target.path == "/api/client/credential-login") return true;
    if (target.path != "/api/client/pair" || Lower(Text(options, "method")) != "post") return false;
    const auto initial = options.value("body", Json());
    return Text(initial, "sessionId").empty();
}

}  // namespace

struct Bridge::Impl : std::enable_shared_from_this<Bridge::Impl> {
    using Task = std::function<void()>;

    Impl(Config config, Dispatch external, Publish message, Install updaterInstall, OnUi ui)
        : dispatch(std::move(external)), publish(std::move(message)), install(std::move(updaterInstall)), onUi(std::move(ui)),
          updater(config, [this](const Json& value) { PublishUpdate(value); }, stopping),
          submit(config.resourcesDirectory / "novajudge-submit",
                 [this](const Json& value) { Post([value](Impl& bridge) { bridge.Push("novajudge-submit:status", value); }); }, stopping) {}

    void Start() {
        try {
            workers.reserve(4);
            for (int i = 0; i != 4; ++i) workers.emplace_back([this] { Work(); });
            Queue([this] { updater.Check(true); });
            Queue([this] { submit.Initialize(); });
        } catch (...) {
            // Startup can fail while creating a thread or allocating its first
            // tasks. Do not allocate shutdown tasks on this failure path: a
            // second allocation failure would destroy joinable threads and
            // terminate the process before the native error UI can be shown.
            {
                std::lock_guard lock(tasksMutex);
                stopping = true;
                tasks.clear();
            }
            ready.notify_all();
            for (auto& worker : workers) if (worker.joinable()) worker.join();
            throw;
        }
    }

    void Stop() {
        {
            std::lock_guard lock(tasksMutex);
            if (stopping.exchange(true)) return;
            tasks.clear();
            tasks.emplace_back([this] { submit.DrainRevocations(); });
            submit.Reset();
        }
        ready.notify_all();
        for (auto& worker : workers) if (worker.joinable()) worker.join();
        submit.ClearNow();
    }

    void Queue(Task task) {
        {
            std::lock_guard lock(tasksMutex);
            if (stopping) return;
            tasks.push_back(std::move(task));
        }
        ready.notify_one();
    }

    void Work() {
        for (;;) {
            Task task;
            {
                std::unique_lock lock(tasksMutex);
                ready.wait(lock, [this] { return stopping || !tasks.empty(); });
                if (tasks.empty()) return;
                task = std::move(tasks.front());
                tasks.pop_front();
            }
            try { task(); } catch (...) { /* Each IPC task reports its own errors. */ }
        }
    }

    template<class Function>
    void Post(Function operation) {
        if (stopping) return;
        onUi([weak = weak_from_this(), operation = std::move(operation)]() mutable {
            if (const auto self = weak.lock(); self && !self->stopping) operation(*self);
        });
    }

    void Push(std::string_view channel, const Json& value) {
        if (!stopping) publish({ { "channel", channel }, { "value", value } });
    }

    void PublishUpdate(const Json& patch) {
        Post([patch](Impl& bridge) {
            if (!bridge.submitBackend.empty() &&
                (Text(patch, "releaseChannel") != "intranet" || Text(patch, "serverOrigin") != bridge.submitBackend))
                bridge.ResetSubmit();
            bridge.Push("client-update:status", patch);
        });
    }

    void ConnectSubmit(NovaJudgeLogin login) {
        const auto state = updater.Status();
        if (Text(state, "releaseChannel") != "intranet" || login.backendOrigin.empty() ||
            Text(state, "serverOrigin") != login.backendOrigin) {
            ResetSubmit();
            return;
        }
        submitBackend = login.backendOrigin;
        const auto generation = submit.SelectLogin(std::move(login));
        Queue([this, generation] { submit.Connect(generation); });
    }

    void ResetSubmit() {
        submitBackend.clear();
        submit.Reset();
        Queue([this] { submit.DrainRevocations(); });
    }

    void HandleMessage(std::string_view raw) {
        if (stopping || raw.size() > 20 * 1024 * 1024) return;
        HandleParsedMessage(Parse(raw));
    }

    void HandleParsedMessage(const Json& message) {
        if (stopping || !message.is_object() || !message.contains("id") || !message.contains("args") ||
            !message.at("args").is_array()) return;
        const auto id = message.at("id");
        if (!(id.is_number_unsigned() && id.get<std::uint64_t>() > 0 && id.get<std::uint64_t>() <= 9007199254740991ULL) &&
            !(id.is_string() && id.get_ref<const std::string&>().size() <= 64 &&
              id.get_ref<const std::string&>().starts_with("capture-"))) return;
        const auto channel = Text(message, "channel");
        if (channel.empty() || channel.size() > 64 || message.at("args").size() > 8) return;
        auto completed = std::make_shared<std::atomic<bool>>(false);
        Reply reply = [weak = weak_from_this(), id, current = document, completed](Json value, std::string error) {
            if (completed->exchange(true)) return;
            if (auto self = weak.lock()) self->Post([id, current, value = std::move(value), error = std::move(error)](Impl& bridge) {
                if (current != bridge.document) return;
                auto result = Json{ { "id", id }, { "ok", error.empty() } };
                if (error.empty()) result["value"] = std::move(value);
                else result["error"] = std::move(error);
                bridge.publish(result);
            });
        };
        try { Invoke(channel, message.at("args"), reply); }
        catch (const std::exception& failure) { reply(nullptr, failure.what()); }
        catch (...) { reply(nullptr, "本地操作失败"); }
    }

    template<class Function>
    void Async(Reply reply, Function operation) {
        Queue([reply = std::move(reply), operation = std::move(operation)]() mutable {
            try { reply(operation(), {}); }
            catch (const std::exception& error) { reply(nullptr, error.what()); }
            catch (...) { reply(nullptr, "本地操作失败"); }
        });
    }

    void ConfigureHosts(const Json& hosts) {
        allowedHosts.clear();
        if (!hosts.is_array()) return;
        for (const auto& host : hosts) {
            if (!host.is_string()) continue;
            const auto& text = host.get_ref<const std::string&>();
            if (text.empty()) continue;
            try { allowedHosts.insert(ParseHttpUrl(text).host); }
            catch (const std::exception&) { allowedHosts.insert(Lower(text)); }
        }
    }

    HttpUrl BuildTarget(std::string_view base, std::string_view path, bool diagnose = false) {
        const auto origin = ParseHttpUrl(base);
        if (diagnose) allowedHosts.insert(origin.host);
        const auto target = ResolveHttpUrl(origin.origin, path);
        if (target.origin != origin.origin) throw std::runtime_error("请求地址不属于当前服务器");
        if (target.path.starts_with("/api/client/")) updater.RequireBackend(target.origin);
        const bool allowedHost = allowedHosts.contains(target.host);
        const bool health = target.path == "/api/health" && allowedHost;
        if (!health && !(apiPolicy ? apiPolicy(target.Url()) : allowedHost))
            throw std::runtime_error("当前不允许访问该地址：" + target.Url());
        return target;
    }

    void SaveRecovery(const Json& input) {
        if (input.is_null()) {
            ResetSubmit();
            recovery = nullptr;
            recovering = false;
            return;
        }
        // Keep the original snapshot if the server URL is no longer permitted.
        // After this check the candidate's former credentials must be discarded.
        const auto target = BuildTarget(Text(input, "serverUrl"), "/api/client/heartbeat");
        recovery = nullptr;
        recovery = FilterRecovery(input, target.origin);
    }

    bool BeginRecovery(bool active) {
        const auto now = Clock::now();
        std::erase_if(failures, [&](auto failure) { return failure <= now - std::chrono::minutes(2); });
        if (failures.size() >= (active ? 3 : 1) || (active && recovery.is_null())) return false;
        failures.push_back(now);
        recovering = !recovery.is_null();
        return true;
    }

    void CompleteDownload(const fs::path& path, std::string error) {
        if (error.empty() && !path.empty()) {
            try {
                if (installAllowed && !installAllowed())
                    throw std::runtime_error("当前有考试或屏幕展示，暂不能安装更新");
                if (!install) throw std::runtime_error("无法打开安装向导");
                updater.Installed();
#ifdef __APPLE__
                if (!install(path)) updater.Deferred();
#else
                install(path);
#endif
            } catch (const std::exception& failure) {
                error = failure.what();
                updater.Failed(error);
#ifndef __APPLE__
                std::error_code ignored;
                fs::remove(path, ignored);
                fs::remove(path.parent_path(), ignored);
#endif
            }
        }
        auto replies = std::exchange(downloadReplies, {});
        for (const auto& reply : replies) reply(nullptr, error);
    }

    void Download(Reply reply) {
        if (installAllowed && !installAllowed())
            throw std::runtime_error("请先结束当前考试或屏幕展示，再更新客户端");
        downloadReplies.push_back(std::move(reply));
        if (downloadReplies.size() != 1) return;
        Queue([this] {
            fs::path path;
            std::string error;
            try { path = updater.Download(); }
            catch (const std::exception& failure) { error = failure.what(); }
            Post([path = std::move(path), error = std::move(error)](Impl& bridge) mutable {
                bridge.CompleteDownload(path, std::move(error));
            });
        });
    }

    void Invoke(std::string_view channel, const Json& args, Reply reply) {
        if (channel == "net:json") {
            const auto path = StringArgument(args, 1);
            auto options = Argument(args, 2).is_object() ? Argument(args, 2) : Json::object();
            const auto target = BuildTarget(StringArgument(args, 0), path);
            const bool requiresCurrent = RequiresCurrentClient(target, options);
            if (requiresCurrent && target.path == "/api/client/pair") {
                auto headers = options.value("headers", Json::object());
                if (!headers.is_object()) headers = Json::object();
                for (auto item = headers.begin(); item != headers.end();) {
                    const auto key = Lower(item.key());
                    if (key == "x-proctor-desktop-runtime" || key == "x-proctor-desktop-target") item = headers.erase(item);
                    else ++item;
                }
                headers["x-proctor-desktop-runtime"] = kRuntime;
                const auto updateTarget = UpdateTarget();
                if (updateTarget.starts_with("windows-")) headers["x-proctor-desktop-target"] = updateTarget;
                options["headers"] = std::move(headers);
            }
            Async(std::move(reply), [this, target, options = std::move(options), requiresCurrent] {
                if (requiresCurrent) {
                    const auto state = updater.Check(true);
                    if (Text(state, "phase") != "current") throw std::runtime_error("请先将监考客户端更新至最新版");
                    const auto origin = Text(state, "serverOrigin");
                    if (!origin.empty() && target.origin != origin)
                        throw std::runtime_error("连接后台已切换，请重新生成登录二维码");
                }
                return RequestJsonWithFallback(target, options, &stopping);
            });
        } else if (channel == "net:diagnose") {
            const auto path = StringArgument(args, 1);
            const auto target = BuildTarget(StringArgument(args, 0), path.empty() ? "/api/health" : path, true);
            Async(std::move(reply), [this, target] { return Diagnose(target, &stopping); });
        } else if (channel == "client-update:status") {
            reply(updater.Status(), {});
        } else if (channel == "client-update:check") {
            if (!downloadReplies.empty() || (installAllowed && !installAllowed())) reply(updater.Status(), {});
            else Async(std::move(reply), [this, startup = Argument(args, 0) == true] { return updater.Check(startup); });
        } else if (channel == "client-update:download") {
            Download(std::move(reply));
        } else if (channel == "renderer-recovery:save") {
            SaveRecovery(Argument(args, 0));
            reply(nullptr, {});
        } else if (channel == "renderer-recovery:get") {
            reply(recovering ? recovery : Json(), {});
        } else if (channel == "renderer-recovery:complete") {
            recovering = false;
            reply(nullptr, {});
#ifdef _WIN32
        } else if (channel == "permissions:getMacMediaAccessStatus") {
            reply(nullptr, {});
        } else if (channel == "permissions:openMacPrivacyPane") {
            reply(false, {});
        } else if (channel == "permissions:askMacMediaAccess" || channel == "permissions:promptMacAccessibility") {
            reply(true, {});
#endif
        } else if (channel == "novajudge-submit:status") {
            reply(submit.Status(), {});
        } else if (channel == "novajudge-submit:retry") {
            if (!submitAllowed || submitAllowed()) {
                const auto generation = submit.PrepareRetry();
                if (generation) Queue([this, generation] { submit.Connect(generation); });
            }
            reply(nullptr, {});
        } else if (channel == "rtmp:stop" || channel == "rtmp:stopPipes") {
            // There are no native RTMP producer IPC entry points in the
            // existing renderer. The current renderer stops its own WHIP.
            reply(nullptr, {});
        } else {
            if (channel == "browser:setAllowedHosts") ConfigureHosts(Argument(args, 0));
            if (dispatch) dispatch(channel, args, std::move(reply));
            else reply(nullptr, "未知的本地操作");
        }
    }

    Dispatch dispatch;
    Publish publish;
    Install install;
    OnUi onUi;
    std::function<bool(std::string_view)> apiPolicy;
    std::function<bool()> installAllowed, submitAllowed;
    std::set<std::string, std::less<>> allowedHosts;
    std::uint64_t document = 0;
    std::string submitBackend;
    Json recovery;
    bool recovering = false;
    std::vector<Clock::time_point> failures;
    std::vector<Reply> downloadReplies;

    std::atomic<bool> stopping{false};
    std::mutex tasksMutex;
    std::condition_variable ready;
    std::deque<Task> tasks;
    std::vector<std::thread> workers;
    Updater updater;
    Submit submit;
};

Bridge::Bridge(Config config, Dispatch dispatch, Publish publish, Install install, OnUi onUi)
    : impl_(std::make_shared<Impl>(std::move(config), std::move(dispatch), std::move(publish),
                                  std::move(install), std::move(onUi))) {
    impl_->Start();
}

Bridge::~Bridge() { Shutdown(); }

void Bridge::Shutdown() { impl_->Stop(); }

void Bridge::HandleMessage(std::string_view webMessage) { impl_->HandleMessage(webMessage); }

void Bridge::HandleParsedMessage(const Json& message) { impl_->HandleParsedMessage(message); }

void Bridge::Push(std::string_view channel, const Json& value) { impl_->Push(channel, value); }

void Bridge::NewDocument() { ++impl_->document; }

bool Bridge::BeginRendererRecovery(bool active) { return impl_->BeginRecovery(active); }

void Bridge::SetAllowedHosts(const Json& hosts) { impl_->ConfigureHosts(hosts); }

void Bridge::SetApiPolicy(std::function<bool(std::string_view)> predicate) { impl_->apiPolicy = std::move(predicate); }

void Bridge::SetInstallAllowed(std::function<bool()> predicate) { impl_->installAllowed = std::move(predicate); }

void Bridge::SetSubmitAllowed(std::function<bool()> predicate) { impl_->submitAllowed = std::move(predicate); }

void Bridge::ConnectNovaJudge(NovaJudgeLogin login) { impl_->ConnectSubmit(std::move(login)); }

void Bridge::ResetNovaJudge() { impl_->ResetSubmit(); }

}  // namespace proctor
