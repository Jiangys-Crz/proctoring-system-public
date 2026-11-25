#include "native.hpp"
#include "native_process.hpp"
#include "bridge.hpp"

#include <algorithm>
#include <cctype>
#include <chrono>
#include <condition_variable>
#include <cstdio>
#include <ctime>
#include <future>
#include <mutex>
#include <optional>
#include <regex>
#include <set>
#include <thread>

namespace proctor {
namespace {
using namespace mac;
constexpr auto unscheduled = Clock::time_point::max();

struct Identity {
    std::string origin, sessionId, token;
    std::shared_ptr<std::atomic_bool> cancelled = std::make_shared<std::atomic_bool>(false);
};
struct Image { std::string id, name, url; double order; };
struct Active {
    std::string id, groupName;
    std::int64_t startsAt;
    std::optional<std::int64_t> endsAt;
    std::vector<Image> images;
};
struct Status {
    std::int64_t serverNow;
    std::optional<std::int64_t> nextStartsAt;
    std::optional<Active> active;
};

bool ValidId(const std::string& id) {
    static const std::regex pattern("[A-Za-z0-9_-]{1,128}");
    return std::regex_match(id, pattern);
}

Identity GetIdentity(const Json& value) {
    try {
        auto url = ParseHttpUrl(value.at("baseUrl").get<std::string>());
        auto session = value.at("sessionId").get<std::string>();
        auto token = value.at("token").get<std::string>();
        if (ValidId(session) && !token.empty() && Utf16LengthAtMost(token, 8192) && token.find_first_of("\r\n\0", 0, 3) == std::string::npos)
            return {std::move(url.origin), std::move(session), std::move(token)};
    } catch (...) { }
    throw std::runtime_error("无效的屏幕控制会话");
}

std::string DecodeQuery(std::string_view text) {
    std::string decoded;
    const auto hex = [](char ch) {
        if (ch >= '0' && ch <= '9') return ch - '0';
        if (ch >= 'A' && ch <= 'F') return ch - 'A' + 10;
        if (ch >= 'a' && ch <= 'f') return ch - 'a' + 10;
        return -1;
    };
    for (std::size_t i = 0; i < text.size(); ++i) {
        if (text[i] == '%' && i + 2 < text.size()) {
            const auto high = hex(text[i + 1]), low = hex(text[i + 2]);
            if (high >= 0 && low >= 0) {
                decoded.push_back(static_cast<char>(16 * high + low));
                i += 2;
                continue;
            }
        }
        decoded.push_back(text[i] == '+' ? ' ' : text[i]);
    }
    return decoded;
}

std::string ImageUrl(const Identity& identity, const Image& image) {
    const auto url = ResolveHttpUrl(identity.origin + "/", image.url);
    bool firstSessionMatches = false, found = false;
    if (url.origin == identity.origin && url.fragment.empty() && url.path == "/api/client/screen-control/images/" + image.id && url.query.starts_with('?')) {
        for (const auto& item : Split(std::string_view(url.query).substr(1), '&')) {
            if (item.empty()) continue;
            const auto separator = item.find('=');
            if (DecodeQuery(std::string_view(item).substr(0, separator)) != "sessionId") throw std::runtime_error("屏幕控制图片地址不属于当前会话");
            if (!found && separator != std::string::npos) {
                firstSessionMatches = DecodeQuery(std::string_view(item).substr(separator + 1)) == identity.sessionId;
            }
            found = true;
        }
    }
    if (!firstSessionMatches) throw std::runtime_error("屏幕控制图片地址不属于当前会话");
    return url.Url();
}

std::optional<std::int64_t> Timestamp(const Json& value, bool required = false) {
    if (value.is_null()) {
        if (required) throw std::runtime_error("屏幕控制缺少服务器时间");
        return std::nullopt;
    }
    const auto text = value.get<std::string>();
    static const std::regex iso(R"((\d{4})-(\d{2})-(\d{2})T(\d{2}):(\d{2}):(\d{2})(?:\.(\d+))?(Z|([+-])(\d{2}):(\d{2})))");
    std::smatch match;
    if (!std::regex_match(text, match, iso)) throw std::runtime_error("无效的屏幕控制时间");
    std::tm time{};
    time.tm_year = std::stoi(match[1]) - 1900;
    time.tm_mon = std::stoi(match[2]) - 1;
    time.tm_mday = std::stoi(match[3]);
    time.tm_hour = std::stoi(match[4]);
    time.tm_min = std::stoi(match[5]);
    time.tm_sec = std::stoi(match[6]);
    const auto original = time;
    const auto seconds = timegm(&time);
    if (time.tm_year != original.tm_year || time.tm_mon != original.tm_mon || time.tm_mday != original.tm_mday ||
        time.tm_hour != original.tm_hour || time.tm_min != original.tm_min || time.tm_sec != original.tm_sec)
        throw std::runtime_error("无效的屏幕控制时间");
    auto milliseconds = static_cast<std::int64_t>(seconds) * 1000 + std::stoi((match[7].str() + "000").substr(0, 3));
    if (match[9].matched) {
        const auto hours = std::stoi(match[10]), minutes = std::stoi(match[11]);
        if (hours > 23 || minutes > 59) throw std::runtime_error("无效的屏幕控制时间");
        const auto offset = (60 * hours + minutes) * 60000LL;
        milliseconds += match[9] == "+" ? -offset : offset;
    }
    return milliseconds;
}

Status ParseStatus(const Json& value, const Identity& identity) {
    if (!value.is_object()) throw std::runtime_error("无效的屏幕控制状态");
    Status status{*Timestamp(value.value("serverNow", Json()), true), Timestamp(value.value("nextStartsAt", Json())), std::nullopt};
    const auto& raw = value.at("active");
    if (raw.is_null()) return status;
    Active active{raw.at("id").get<std::string>(), raw.at("groupName").get<std::string>(),
                  *Timestamp(raw.value("startsAt", Json()), true), Timestamp(raw.value("endsAt", Json())), {}};
    const auto& images = raw.at("images");
    if (!ValidId(active.id) || !Utf16LengthAtMost(active.groupName, 200) || raw.value("intervalMs", Json()) != 5000 || !images.is_array() || images.empty() || images.size() > 30)
        throw std::runtime_error("无效的屏幕控制展示");
    if (active.startsAt > status.serverNow || (active.endsAt && (*active.endsAt <= active.startsAt || *active.endsAt <= status.serverNow)))
        throw std::runtime_error("屏幕控制展示不在有效时间内");
    std::set<std::string> ids;
    for (const auto& info : images) {
        const auto order = info.value("order", Json());
        Image image{info.at("id").get<std::string>(), info.at("name").get<std::string>(), info.at("url").get<std::string>(),
                    order.is_number() ? order.get<double>() : static_cast<double>(active.images.size())};
        if (!ValidId(image.id) || !ids.insert(image.id).second || !Utf16LengthAtMost(image.name, 512))
            throw std::runtime_error("无效的屏幕控制图片列表");
        image.url = ImageUrl(identity, image);
        active.images.push_back(std::move(image));
    }
    std::stable_sort(active.images.begin(), active.images.end(), [](const auto& a, const auto& b) { return a.order < b.order; });
    status.active = std::move(active);
    return status;
}

HttpResponse Request(const Identity& identity, const std::string& url, std::size_t maxSize) {
    const Json headers{{"x-proctor-client", "desktop"}, {"x-proctor-session-token", identity.token}};
    HttpResponse response;
    try { response = RequestHttp(url, "GET", headers, {}, 8000, maxSize, true, identity.cancelled.get()); }
    catch (...) {
        if (identity.cancelled->load()) throw;
        response = RequestHttp(url, "GET", headers, {}, 8000, maxSize, false, identity.cancelled.get());
    }
    if (response.status < 200 || response.status >= 300)
        throw std::runtime_error("屏幕控制请求失败：HTTP " + std::to_string(response.status));
    return response;
}

Status ReadStatus(const Identity& identity) {
    const auto response = Request(identity, identity.origin + "/api/client/screen-control?sessionId=" + identity.sessionId, 2 * 1024 * 1024);
    const auto body = Json::parse(response.body);
    if (!body.value("ok", false) || !body.contains("data"))
        throw std::runtime_error(body.value("message", "屏幕控制状态读取失败"));
    return ParseStatus(body.at("data"), identity);
}

MacScreenImage ReadImage(const Identity& identity, const Image& image) {
    auto response = Request(identity, image.url, 10 * 1024 * 1024);
    auto type = Trim(response.contentType.substr(0, response.contentType.find(';')));
    std::transform(type.begin(), type.end(), type.begin(), [](unsigned char c) { return static_cast<char>(std::tolower(c)); });
    const auto& buffer = response.body;
    const bool png = type == "image/png" && buffer.starts_with("\x89PNG\r\n\x1a\n");
    const bool jpeg = type == "image/jpeg" && buffer.starts_with("\xff\xd8\xff");
    const bool gif = type == "image/gif" && (buffer.starts_with("GIF87a") || buffer.starts_with("GIF89a"));
    const bool webp = type == "image/webp" && buffer.starts_with("RIFF") && buffer.size() >= 12 && buffer.compare(8, 4, "WEBP") == 0;
    if (!png && !jpeg && !gif && !webp) throw std::runtime_error("屏幕控制仅允许 PNG、JPEG、GIF、WebP 图片");
    return {std::move(type), std::move(response.body)};
}

void Log(std::string_view message) noexcept {
    std::fprintf(stderr, "[screen-control] %.*s\n", static_cast<int>(message.size()), message.data());
}
}

struct MacScreenControl::State {
    std::function<void(Json, std::vector<MacScreenImage>)> display;
    mutable std::mutex mutex;
    std::condition_variable changed;
    std::vector<std::future<void>> requests;
    std::optional<Identity> identity;
    Clock::time_point nextPoll = unscheduled, expiry = unscheduled;
    std::uint64_t generation = 0, firstPollDone = 0;
    bool shutdown = false, releaseAfterDisplay = false, polling = false;
    Json current;
    std::string loadedImages, loadingImages;
    std::thread pollWorker;

    explicit State(std::function<void(Json, std::vector<MacScreenImage>)> show)
        : display(std::move(show)), pollWorker([this] { Poll(); }) {}

    void Shutdown() {
        {
            const std::lock_guard lock(mutex);
            shutdown = true;
            if (identity) identity->cancelled->store(true);
        }
        changed.notify_all();
        pollWorker.join();
        for (auto& worker : requests) worker.wait();
    }

    void Publish(Json value, std::vector<MacScreenImage> images = {}) {
        if (!value.is_null()) value["guardError"] = nullptr;
        display(std::move(value), std::move(images));
    }
    void ClearDisplay() {
        expiry = unscheduled;
        loadedImages.clear();
        loadingImages.clear();
        if (!current.is_null()) {
            current = nullptr;
            Publish(nullptr);
            changed.notify_all();
        }
        if (releaseAfterDisplay) Stop();
    }
    void Stop() {
        ++generation;
        if (identity) identity->cancelled->store(true);
        identity.reset();
        polling = false;
        releaseAfterDisplay = false;
        nextPoll = expiry = unscheduled;
        ClearDisplay();
        changed.notify_all();
    }

    void Download(Identity target, std::vector<Image> images, std::string key, std::uint64_t serial) {
        auto valid = [&] { return !shutdown && generation == serial && loadingImages == key && !current.is_null(); };
        try {
            std::vector<MacScreenImage> downloaded;
            downloaded.reserve(images.size());
            for (std::size_t offset = 0; offset < images.size(); offset += 4) {
                {
                    const std::lock_guard lock(mutex);
                    if (!valid()) return;
                }
                std::vector<std::future<MacScreenImage>> batch;
                for (std::size_t index = offset; index < images.size() && index < offset + 4; ++index) {
                    batch.push_back(std::async(std::launch::async, [&, index] { return ReadImage(target, images[index]); }));
                }
                for (auto& request : batch) downloaded.push_back(request.get());
            }
            const std::lock_guard lock(mutex);
            if (!valid()) return;
            loadedImages = key;
            loadingImages.clear();
            auto value = current;
            for (const auto& image : images) value["images"].push_back({{"id", image.id}, {"name", image.name}});
            Publish(std::move(value), std::move(downloaded));
        } catch (const std::exception& error) {
            const std::lock_guard lock(mutex);
            if (valid()) {
                loadingImages.clear();
                Log(error.what());
            }
        }
    }

    std::chrono::milliseconds Apply(const Status& status, const Identity& target, std::uint64_t serial) {
        auto delay = 2000ms;
        if (status.nextStartsAt && *status.nextStartsAt > status.serverNow)
            delay = (std::min)(delay, std::chrono::milliseconds((std::max)(100LL, static_cast<long long>(*status.nextStartsAt - status.serverNow))));
        if (!status.active) {
            ClearDisplay();
            return delay;
        }
        const auto now = std::chrono::duration_cast<std::chrono::milliseconds>(std::chrono::system_clock::now().time_since_epoch()).count();
        const auto& active = *status.active;
        const bool same = !current.is_null() && current.at("id") == active.id;
        current = {{"id", active.id}, {"groupName", active.groupName}, {"intervalMs", 5000},
                   {"startsAtLocal", now + active.startsAt - status.serverNow},
                   {"endsAtLocal", active.endsAt ? Json(now + *active.endsAt - status.serverNow) : Json()},
                   {"images", Json::array()}};
        expiry = active.endsAt ? Clock::now() + std::chrono::milliseconds((std::min<std::int64_t>)(2147483647, *active.endsAt - status.serverNow)) : unscheduled;
        if (!same) Publish(current);
        auto key = active.id + ':';
        for (const auto& image : active.images) key += image.id + ',';
        if (loadedImages == key || loadingImages == key) return delay;
        loadingImages = key;
        DiscardFinishedRequests();
        try {
            requests.reserve(requests.size() + 1);
            requests.push_back(std::async(std::launch::async, [this, target, images = active.images, key, serial] {
                Download(target, images, key, serial);
            }));
        } catch (...) {
            loadingImages.clear();
            throw;
        }
        return delay;
    }

    void DiscardFinishedRequests() {
        std::erase_if(requests, [](auto& worker) { return worker.wait_for(0ms) == std::future_status::ready; });
    }
    void PollOnce(const Identity& target, std::uint64_t serial) {
        std::optional<Status> status;
        std::string error;
        try { status = ReadStatus(target); }
        catch (const std::exception& failure) { error = failure.what(); }
        const std::lock_guard lock(mutex);
        if (shutdown || serial != generation) return;
        auto delay = 2000ms;
        try {
            // Expiry triggers a server poll. Only a successful response may
            // release an overlay that is already visible.
            if (status) delay = Apply(*status, target, serial);
            else Log(error);
        } catch (const std::exception& failure) { Log(failure.what()); }
        if (serial == generation) {
            polling = false;
            firstPollDone = serial;
            nextPoll = Clock::now() + delay;
        }
        changed.notify_all();
    }

    void Poll() {
        std::unique_lock lock(mutex);
        while (!shutdown) {
            const auto when = (std::min)(nextPoll, expiry);
            if (!identity || when == unscheduled) {
                changed.wait(lock);
                continue;
            }
            if (Clock::now() < when) {
                changed.wait_until(lock, when);
                continue;
            }
            if (Clock::now() >= expiry) expiry = unscheduled;
            nextPoll = unscheduled;
            if (polling) continue;
            polling = true;
            DiscardFinishedRequests();
            try {
                requests.reserve(requests.size() + 1);
                requests.push_back(std::async(std::launch::async, [this, target = *identity, serial = generation] {
                    PollOnce(target, serial);
                }));
            } catch (const std::exception& failure) {
                Log(failure.what());
                polling = false;
                firstPollDone = generation;
                nextPoll = Clock::now() + 2s;
                changed.notify_all();
            }
        }
    }

};

MacScreenControl::MacScreenControl(std::function<void(Json, std::vector<MacScreenImage>)> display)
    : state_(std::make_shared<State>(std::move(display))) {}

MacScreenControl::~MacScreenControl() { state_->Shutdown(); }

std::function<void()> MacScreenControl::PrepareWatch(const Json& value) {
    auto identity = GetIdentity(value);
    auto& watch = *state_;
    const std::lock_guard lock(watch.mutex);
    const auto& old = watch.identity;
    const bool sameSession = old && old->origin == identity.origin && old->sessionId == identity.sessionId;
    if (!watch.current.is_null() && !sameSession) throw std::runtime_error("屏幕展示期间不能切换登录会话");
    watch.releaseAfterDisplay = false;
    if (sameSession && old->token == identity.token) return [] {};
    if (!sameSession) watch.Stop();
    else old->cancelled->store(true);
    watch.identity = std::move(identity);
    watch.loadingImages.clear();
    watch.polling = false;
    const auto serial = ++watch.generation;
    watch.nextPoll = Clock::now();
    watch.changed.notify_all();
    return [pending = std::weak_ptr<State>(state_), serial] {
        auto state = pending.lock();
        if (!state) return;
        std::unique_lock lock(state->mutex);
        state->changed.wait(lock, [&] { return state->shutdown || state->generation != serial || state->firstPollDone >= serial; });
    };
}

void MacScreenControl::Release() {
    const std::lock_guard lock(state_->mutex);
    if (state_->current.is_null()) state_->Stop();
    else state_->releaseAfterDisplay = true;
}

bool MacScreenControl::IsDisplaying() const {
    const std::lock_guard lock(state_->mutex);
    return !state_->current.is_null();
}

}  // namespace proctor
