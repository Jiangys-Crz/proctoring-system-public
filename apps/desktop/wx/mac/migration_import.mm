#import "migration_import.hpp"
#import "webview.hpp"
#import <AppKit/AppKit.h>

#include <CommonCrypto/CommonDigest.h>
#include <algorithm>
#include <array>
#include <cerrno>
#include <cmath>
#include <limits>
#include <regex>
#include <set>
#include <stdexcept>
#include <utility>

#include <fcntl.h>
#include <sys/stat.h>
#include <unistd.h>

namespace proctor {
namespace {
namespace fs = std::filesystem;

constexpr auto markerName = "legacy-electron-import-v1";
constexpr std::size_t maxManifest = 16 * 1024 * 1024;
constexpr std::int64_t maxBody = 512 * 1024 * 1024;
constexpr std::size_t block = 256 * 1024;
constexpr auto watchdogTimeout = 60;

class File {
public:
    explicit File(int fd = -1) : fd_(fd) {}
    ~File() { reset(); }
    File(const File&) = delete;
    File& operator=(const File&) = delete;
    int get() const { return fd_; }
    void reset(int fd = -1) {
        if (fd_ >= 0) close(fd_);
        fd_ = fd;
    }
private:
    int fd_;
};

bool Private(const struct stat& status) {
    return status.st_uid == geteuid() && (status.st_mode & (S_IRWXG | S_IRWXO)) == 0;
}

std::size_t SizeOf(int fd) {
    struct stat status{};
    if (fd < 0 || fstat(fd, &status) != 0 || !S_ISREG(status.st_mode) || !Private(status) ||
        status.st_nlink != 1 || status.st_size < 0) throw std::runtime_error("invalid migration file");
    return static_cast<std::size_t>(status.st_size);
}

std::size_t ReadExactly(int fd, char* buffer, std::size_t size) {
    std::size_t received = 0;
    while (received < size) {
        const auto amount = read(fd, buffer + received, size - received);
        if (amount < 0 && errno == EINTR) continue;
        if (amount <= 0) throw std::runtime_error("incomplete migration file");
        received += static_cast<std::size_t>(amount);
    }
    return received;
}

std::string ManifestText(int directory) {
    File file(openat(directory, "manifest.json", O_RDONLY | O_CLOEXEC | O_NOFOLLOW | O_NONBLOCK));
    const auto size = SizeOf(file.get());
    if (!size || size > maxManifest) throw std::runtime_error("invalid legacy manifest size");
    std::string text(size, '\0');
    ReadExactly(file.get(), text.data(), text.size());
    return text;
}

std::string Digest(const std::string& text) {
    unsigned char bytes[CC_SHA256_DIGEST_LENGTH];
    CC_SHA256(text.data(), static_cast<CC_LONG>(text.size()), bytes);
    constexpr std::string_view hex = "0123456789abcdef";
    std::string digest;
    digest.reserve(CC_SHA256_DIGEST_LENGTH * 2);
    for (const auto byte : bytes) {
        digest += hex[byte >> 4];
        digest += hex[byte & 15];
    }
    return digest;
}

bool Completed(const fs::path& marker) {
    struct stat status{};
    return lstat(marker.c_str(), &status) == 0 && S_ISREG(status.st_mode) && Private(status);
}

bool SaveMarker(const fs::path& marker) {
    auto pattern = (marker.parent_path() / ".legacy-electron-import.XXXXXX").string();
    const int file = mkstemp(pattern.data());
    if (file < 0) return false;
    constexpr std::string_view contents = "1\n";
    const bool wrote = write(file, contents.data(), contents.size()) == static_cast<ssize_t>(contents.size()) && fsync(file) == 0;
    const bool closed = close(file) == 0;
    const bool saved = wrote && closed && (link(pattern.c_str(), marker.c_str()) == 0 || Completed(marker));
    unlink(pattern.c_str());
    return saved;
}

std::string Text(const Json& value, std::string_view key) {
    if (!value.is_object()) return {};
    const auto item = value.find(key);
    return item != value.end() && item->is_string() ? item->get<std::string>() : "";
}

bool Flag(const Json& value, std::string_view key) {
    const auto item = value.find(key);
    if (item == value.end() || !item->is_boolean()) throw std::runtime_error("invalid legacy cookie flag");
    return item->get<bool>();
}

bool CookieText(std::string_view text, std::string_view forbidden) {
    return std::all_of(text.begin(), text.end(), [forbidden](unsigned char ch) {
        return ch >= 32 && ch != 127 && forbidden.find(static_cast<char>(ch)) == std::string_view::npos;
    });
}

NSHTTPCookie* DecodeCookie(const Json& source) {
    const auto name = Text(source, "name");
    const auto value = Text(source, "value");
    const auto path = Text(source, "path");
    auto domain = Text(source, "domain");
    const bool hostOnly = Flag(source, "hostOnly");
    const bool secure = Flag(source, "secure");
    const bool httpOnly = Flag(source, "httpOnly");
    const bool session = Flag(source, "session");
    if (domain.starts_with('.')) domain.erase(0, 1);
    const auto sameSite = Text(source, "sameSite");
    if ((name.empty() && value.empty()) || name.size() > 4096 || value.size() > 8192 ||
        !CookieText(name, "()<>@,;:\\\"/[]?={} \t") || !CookieText(value, ";") || domain.empty() || domain.size() > 253 ||
        path.empty() || path[0] != '/' || path.size() > 4096 || !CookieText(path, ";")) {
        throw std::runtime_error("invalid legacy cookie shape");
    }
    if ((name.starts_with("__Secure-") && !secure) ||
        (name.starts_with("__Host-") && (!secure || !hostOnly || path != "/"))) {
        throw std::runtime_error("invalid legacy cookie prefix");
    }
    std::string hostname = domain;
    if (hostname.find(':') != std::string::npos && !hostname.starts_with('[')) hostname = '[' + hostname + ']';
    const auto address = std::string(secure ? "https://" : "http://") + hostname + '/';
    // The URL parser rejects authority changes such as credentials or paths.
    const auto parsed = ParseHttpUrl(address);
    if (parsed.path != "/" || !parsed.query.empty() || !parsed.fragment.empty() || parsed.Url() != address) {
        throw std::runtime_error("invalid legacy cookie domain");
    }

    std::string header = name + '=' + value + "; Path=" + path;
    if (!hostOnly) header += "; Domain=" + domain;
    if (secure) header += "; Secure";
    if (httpOnly) header += "; HttpOnly";
    if (sameSite == "strict") header += "; SameSite=Strict";
    else if (sameSite == "lax") header += "; SameSite=Lax";
    else if (sameSite == "no_restriction") header += "; SameSite=None";
    else if (sameSite != "unspecified") throw std::runtime_error("invalid legacy cookie same-site mode");
    if (!session) {
        const auto expiration = source.find("expirationDate");
        if (expiration == source.end() || !expiration->is_number()) throw std::runtime_error("invalid legacy cookie expiry");
        const double seconds = expiration->get<double>() - NSDate.date.timeIntervalSince1970;
        if (!std::isfinite(seconds) || seconds > 1e10) throw std::runtime_error("invalid legacy cookie expiry");
        if (seconds <= 0) return nil;
        header += "; Max-Age=" + std::to_string(static_cast<std::int64_t>(std::ceil(seconds)));
    }
    auto* cookie = [NSHTTPCookie cookiesWithResponseHeaderFields:@{@"Set-Cookie": Ns(header)}
        forURL:[NSURL URLWithString:Ns(address)]].firstObject;
    const auto policy = Utf8(cookie.sameSitePolicy);
    if (!cookie || Utf8(cookie.name) != name || Utf8(cookie.value) != value || Utf8(cookie.path) != path ||
        (cookie.isSecure == YES) != secure || (cookie.isHTTPOnly == YES) != httpOnly ||
        (cookie.isSessionOnly == YES) != session || [cookie.domain hasPrefix:@"."] == hostOnly ||
        (sameSite == "strict" && policy != "strict") || (sameSite == "lax" && policy != "lax")) {
        throw std::runtime_error("legacy cookie cannot be represented");
    }
    return cookie;
}

NSString* CookieKey(NSHTTPCookie* cookie) {
    auto* domain = cookie.domain.lowercaseString;
    return [NSString stringWithFormat:@"%@\n%@\n%@", domain, cookie.path, cookie.name];
}

void RestoreCookies(WKHTTPCookieStore* store, NSArray<NSHTTPCookie*>* cookies, std::function<void(bool)> done) {
    if (cookies.count == 0) { done(true); return; }
    [store getAllCookies:^(NSArray<NSHTTPCookie*>* existing) {
        NSMutableSet<NSString*>* keys = [NSMutableSet setWithCapacity:existing.count + cookies.count];
        for (NSHTTPCookie* cookie in existing) [keys addObject:CookieKey(cookie)];
        NSMutableArray<NSHTTPCookie*>* added = [NSMutableArray array];
        auto group = dispatch_group_create();
        for (NSHTTPCookie* cookie in cookies) {
            auto* key = CookieKey(cookie);
            if ([keys containsObject:key]) continue;
            [keys addObject:key];
            [added addObject:cookie];
            dispatch_group_enter(group);
            [store setCookie:cookie completionHandler:^{ dispatch_group_leave(group); }];
        }
        dispatch_group_notify(group, dispatch_get_main_queue(), ^{
            [store getAllCookies:^(NSArray<NSHTTPCookie*>* verified) {
                NSMutableDictionary<NSString*, NSHTTPCookie*>* byKey = [NSMutableDictionary dictionaryWithCapacity:verified.count];
                for (NSHTTPCookie* cookie in verified) byKey[CookieKey(cookie)] = cookie;
                for (NSHTTPCookie* cookie in added) {
                    auto* actual = byKey[CookieKey(cookie)];
                    if (cookie.expiresDate && [cookie.expiresDate timeIntervalSinceNow] <= 0) continue;
                    if (!actual || ![actual.value isEqualToString:cookie.value] ||
                        actual.isHTTPOnly != cookie.isHTTPOnly || actual.isSecure != cookie.isSecure ||
                        actual.isSessionOnly != cookie.isSessionOnly ||
                        Utf8(actual.sameSitePolicy) != Utf8(cookie.sameSitePolicy) ||
                        (cookie.expiresDate && (!actual.expiresDate ||
                            std::fabs([actual.expiresDate timeIntervalSinceDate:cookie.expiresDate]) > 2))) {
                        done(false);
                        return;
                    }
                }
                done(true);
            }];
        });
    }];
}

NSArray<NSHTTPCookie*>* PartitionCookies(const Json& partition, bool& complete) {
    if (!partition.is_array() || partition.size() > 4096) throw std::runtime_error("invalid legacy cookie list");
    NSMutableArray<NSHTTPCookie*>* cookies = [NSMutableArray arrayWithCapacity:partition.size()];
    for (const auto& item : partition) {
        try {
            if (auto* cookie = DecodeCookie(item)) [cookies addObject:cookie];
        } catch (...) {
            complete = false;
        }
    }
    return cookies;
}

} // namespace

struct MacLegacyImport::State : std::enable_shared_from_this<State> {
    enum class Step { Ready, Init, Entry, Body, Save, Stopped };
    const fs::path stage, marker;
    const std::string address;
    NSView* host;
    std::function<void(bool)> completion;
    WKWebView* view = nil;
    dispatch_source_t watchdog = nil;
    File directory, body;
    Json manifest;
    std::string hash;
    std::size_t index = 0, remaining = 0;
    Step step = Step::Ready;
    bool complete = true;

    State(fs::path source, const fs::path& data, std::string origin, NSView* parent, std::function<void(bool)> done)
        : stage(std::move(source)), marker(data / markerName), address(std::move(origin) + "/mac-migration.html"),
          host(parent), completion(std::move(done)) {}

    void Prepare() {
        if (step == Step::Stopped) return;
        if (Completed(marker)) { Finish(true); return; }
        try {
            directory.reset(open(stage.c_str(), O_DIRECTORY | O_RDONLY | O_NOFOLLOW | O_CLOEXEC));
            struct stat info{};
            if (directory.get() < 0 || fstat(directory.get(), &info) || !Private(info) || !S_ISDIR(info.st_mode)) {
                throw std::runtime_error("invalid legacy stage directory");
            }
            const auto text = ManifestText(directory.get());
            manifest = Json::parse(text);
            if (manifest.at("version") != 1 || !manifest.at("preferences").is_object() ||
                !manifest.at("records").is_array() || !manifest.at("cache").is_array() ||
                manifest.at("records").size() + manifest.at("cache").size() > 30000 || !manifest.at("cookies").is_object()) {
                throw std::runtime_error("invalid legacy manifest");
            }
            hash = Digest(Json::array({manifest.at("records"), manifest.at("cache")}).dump());
            auto* client = Profile(@"94FF00CB-DF32-4727-B7E9-B4F8ABC11228");
            auto* contest = Profile(@"9DB6532E-9EED-4868-A2EF-726D73CCC9D4");
            const auto& exportedCookies = manifest.at("cookies");
            const auto status = manifest.value("cookieStatus", Json::object());
            complete = manifest.value("cacheStatus", "complete") == "complete" &&
                manifest.value("preferenceStatus", "complete") == "complete" &&
                manifest.value("evidenceStatus", "complete") == "complete";
            const auto clientMarker = marker.string() + ".client-cookies";
            const auto contestMarker = marker.string() + ".contest-cookies";
            const bool clientDone = Completed(clientMarker);
            const bool contestDone = Completed(contestMarker);
            bool clientComplete = status.value("client", "complete") == "complete";
            bool contestComplete = status.value("contest", "complete") == "complete";
            auto* clientCookies = clientDone ? @[] : PartitionCookies(exportedCookies.at("client"), clientComplete);
            auto* contestCookies = contestDone ? @[] : PartitionCookies(exportedCookies.at("contest"), contestComplete);
            const auto weak = weak_from_this();
            watchdog = dispatch_source_create(DISPATCH_SOURCE_TYPE_TIMER, 0, 0, dispatch_get_main_queue());
            dispatch_source_set_event_handler(watchdog, ^{ if (const auto self = weak.lock()) self->Finish(false); });
            dispatch_activate(watchdog);
            Touch();
            RestoreCookies(client.httpCookieStore, clientCookies,
                [weak, client, contest, contestCookies, clientComplete, contestComplete, clientMarker, contestMarker](bool clientOk) {
                if (const auto self = weak.lock(); self && self->step != Step::Stopped) {
                    if (!Completed(clientMarker) && (!clientOk || !clientComplete || !SaveMarker(clientMarker))) self->complete = false;
                    self->Touch();
                    RestoreCookies(contest.httpCookieStore, contestCookies, [weak, client, contestComplete, contestMarker](bool contestOk) {
                        if (const auto current = weak.lock(); current && current->step != Step::Stopped) {
                            if (!Completed(contestMarker) && (!contestOk || !contestComplete || !SaveMarker(contestMarker)))
                                current->complete = false;
                            current->StartView(client);
                        }
                    });
                }
            });
        } catch (...) { Finish(false); }
    }

    void StartView(WKWebsiteDataStore* data) {
        Touch();
        const auto weak = weak_from_this();
        ViewHooks hooks;
        hooks.trusted = address;
        hooks.message = [weak](Json message) { if (const auto self = weak.lock()) self->Receive(message); };
        hooks.finished = [weak](WKNavigation*, std::string, int error) { if (error) if (const auto self = weak.lock()) self->Finish(false); };
        hooks.crashed = [weak] { if (const auto self = weak.lock()) self->Finish(false); };
        auto* config = Configuration(data);
        config.preferences.inactiveSchedulingPolicy = WKInactiveSchedulingPolicyNone;
        view = CreateView(config, host, std::move(hooks));
        Load(view, address);
    }

    void Touch() const {
        dispatch_source_set_timer(watchdog, dispatch_time(DISPATCH_TIME_NOW, watchdogTimeout * NSEC_PER_SEC),
                                  DISPATCH_TIME_FOREVER, NSEC_PER_SEC);
    }

    void Receive(const Json& message) {
        if (step == Step::Stopped) return;
        Touch();
        try {
            const auto kind = Text(message, "migration");
            if (step == Step::Ready && kind == "ready") {
                step = Step::Init;
                const auto preferences = manifest.value("preferenceStatus", "complete") == "complete"
                    ? manifest.at("preferences") : Json(nullptr);
                Send(view, {{"migration", "initialize"}, {"id", hash}, {"preferences", preferences}});
            } else if (step == Step::Init && kind == "initialized") {
                index = Progress(message);
                if (!message.value("complete", false)) complete = false;
                Next();
            } else if (step == Step::Body && kind == "continue") {
                Continue();
            } else if (step == Step::Body && (kind == "skipped" || kind == "unsupported") && Progress(message) == index + 1) {
                if (kind == "unsupported") complete = false;
                ++index;
                Next();
            } else if (step == Step::Save && kind == "committed" && Progress(message) == index + 1) {
                ++index;
                Next();
            } else Finish(false);
        } catch (...) { Finish(false); }
    }

    std::size_t Progress(const Json& message) const {
        const auto& value = message.at("progress");
        if (!value.is_number_unsigned() || value.get<std::uint64_t>() >
            manifest.at("records").size() + manifest.at("cache").size()) throw std::runtime_error("invalid migration index");
        return static_cast<std::size_t>(value.get<std::uint64_t>());
    }

    void Next() {
        body.reset();
        const auto count = manifest.at("records").size();
        const bool recording = index < count;
        if (!recording && index - count >= manifest.at("cache").size()) {
            Finish(complete && SaveMarker(marker));
            return;
        }
        auto entry = recording ? manifest.at("records").at(index) : manifest.at("cache").at(index - count);
        const auto& size = entry.at("size");
        if (!size.is_number_unsigned() || size.get<std::uint64_t>() > maxBody) throw std::runtime_error("invalid migration body length");
        remaining = static_cast<std::size_t>(size.get<std::uint64_t>());
        const auto filename = Text(entry, "blob");
        if (!filename.empty() || remaining) {
            static const std::regex recordFile(R"([0-9]{1,10}\.blob)"), cacheFile(R"(cache-[0-9]{1,10}\.blob)");
            if (!std::regex_match(filename, recording ? recordFile : cacheFile)) throw std::runtime_error("invalid migration body name");
            body.reset(openat(directory.get(), filename.c_str(), O_RDONLY | O_CLOEXEC | O_NOFOLLOW | O_NONBLOCK));
            if (SizeOf(body.get()) != remaining) throw std::runtime_error("legacy migration body size mismatch");
        }
        entry.erase("blob");
        entry["migration"] = "entry";
        entry["kind"] = recording ? "record" : "cache";
        entry["index"] = index;
        step = Step::Body;
        Send(view, entry);
    }

    void Continue() {
        if (remaining == 0) {
            body.reset();
            step = Step::Save;
            Send(view, {{"migration", "commit"}});
            return;
        }
        std::string buffer(std::min(block, remaining), '\0');
        ReadExactly(body.get(), buffer.data(), buffer.size());
        remaining -= buffer.size();
        auto* data = [NSData dataWithBytes:buffer.data() length:buffer.size()];
        Send(view, {{"migration", "chunk"}, {"bytes", Utf8([data base64EncodedStringWithOptions:0])}});
    }

    void Finish(bool success, bool notify = true) {
        if (step == Step::Stopped) return;
        step = Step::Stopped;
        if (watchdog) dispatch_source_cancel(watchdog);
        watchdog = nil;
        if (view) DetachView(view);
        view = nil;
        body.reset();
        directory.reset();
        manifest.clear();
        auto done = std::exchange(completion, {});
        if (notify && done) dispatch_async(dispatch_get_main_queue(), ^{ done(success); });
    }
};

std::shared_ptr<MacLegacyImport> MacLegacyImport::Begin(const fs::path& stage, const fs::path& userData,
    std::string origin, NSView* host, std::function<void(bool)> completion) {
    auto state = std::make_shared<State>(stage, userData, std::move(origin), host, std::move(completion));
    dispatch_async(dispatch_get_main_queue(), ^{ state->Prepare(); });
    return std::shared_ptr<MacLegacyImport>(new MacLegacyImport(std::move(state)));
}
MacLegacyImport::MacLegacyImport(std::shared_ptr<State> state) : state_(std::move(state)) {}
MacLegacyImport::~MacLegacyImport() { Cancel(); }
void MacLegacyImport::Cancel() { state_->Finish(false, false); }

} // namespace proctor
