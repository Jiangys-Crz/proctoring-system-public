#import "browser.hpp"
#import <AppKit/AppKit.h>
#import <QuartzCore/QuartzCore.h>
#import <objc/runtime.h>

#include <wx/filedlg.h>
#include <wx/frame.h>
#include <wx/msgdlg.h>
#include <wx/weakref.h>
#include <wx/window.h>

#include <algorithm>
#include <array>
#include <filesystem>
#include <optional>
#include <regex>
#include <stdexcept>
#include <tuple>
#include <utility>

using namespace proctor;

@interface ProctorClip : NSView
@property(nonatomic, copy) NSArray<NSValue*>* covers;
@end
@implementation ProctorClip
- (BOOL)isFlipped { return YES; }
- (NSView*)hitTest:(NSPoint)point {
    const auto local = [self convertPoint:point fromView:self.superview];
    for (NSValue* cover in self.covers) {
        if (NSPointInRect(local, cover.rectValue)) return nil;
    }
    return [super hitTest:point];
}
@end

@interface ProctorDownload : NSObject<WKDownloadDelegate> {
@public
    std::function<NSURL*(NSString*)> choose;
    std::function<bool(std::string_view)> allowed;
    std::function<void()> finished;
    NSURL* destination;
    NSURL* temporary;
}
@end
@implementation ProctorDownload
- (void)notifyFinished {
    auto callback = std::exchange(finished, {});
    if (callback) dispatch_async(dispatch_get_main_queue(), ^{ callback(); });
}
- (void)download:(WKDownload*)download decideDestinationUsingResponse:(NSURLResponse*)response
    suggestedFilename:(NSString*)name completionHandler:(void (^)(NSURL*))completion {
    destination = choose && allowed(Address(response.URL)) ? choose(name) : nil;
    if (destination) {
        auto* directory = destination.URLByDeletingLastPathComponent;
        NSString* filename = [@".proctor-download-" stringByAppendingString:NSUUID.UUID.UUIDString];
        temporary = [directory URLByAppendingPathComponent:filename isDirectory:NO];
    }
    completion(temporary);
    if (!temporary) [self notifyFinished];
}
- (void)download:(WKDownload*)download willPerformHTTPRedirection:(NSHTTPURLResponse*)response newRequest:(NSURLRequest*)request
    decisionHandler:(void (^)(WKDownloadRedirectPolicy))decision {
    const bool permitted = allowed && allowed(Address(request.URL));
    decision(permitted ? WKDownloadRedirectPolicyAllow : WKDownloadRedirectPolicyCancel);
    if (!permitted) [self notifyFinished];
}
- (void)download:(WKDownload*)download didReceiveAuthenticationChallenge:(NSURLAuthenticationChallenge*)challenge
    completionHandler:(void (^)(NSURLSessionAuthChallengeDisposition, NSURLCredential*))completion {
    const bool serverTrust = [challenge.protectionSpace.authenticationMethod isEqualToString:NSURLAuthenticationMethodServerTrust];
    completion(serverTrust ? NSURLSessionAuthChallengePerformDefaultHandling : NSURLSessionAuthChallengeCancelAuthenticationChallenge, nil);
}
- (void)downloadDidFinish:(WKDownload*)download {
    auto* files = NSFileManager.defaultManager;
    bool saved = false;
    if (temporary && destination) {
        if ([files fileExistsAtPath:destination.path]) {
            saved = [files replaceItemAtURL:destination withItemAtURL:temporary backupItemName:nil
                options:0 resultingItemURL:nullptr error:nullptr];
        } else {
            saved = [files moveItemAtURL:temporary toURL:destination error:nullptr];
        }
    }
    if (!saved && temporary) [files removeItemAtURL:temporary error:nullptr];
    if (!saved && destination) wxMessageBox(wxString::FromUTF8("保存考试文件失败"));
    [self notifyFinished];
}
- (void)download:(WKDownload*)download didFailWithError:(NSError*)error resumeData:(NSData*)resume {
    if (temporary) [NSFileManager.defaultManager removeItemAtURL:temporary error:nullptr];
    [self notifyFinished];
}
@end

namespace proctor {
namespace {
char downloadDelegate;
std::string String(const Json& args, std::size_t index) {
    return args.is_array() && args.size() > index && args[index].is_string() ? args[index].get<std::string>() : "";
}

bool IsAttachment(NSURLResponse* response) {
    if (![response isKindOfClass:NSHTTPURLResponse.class]) return false;
    auto* http = (NSHTTPURLResponse*)response;
    const auto disposition = Utf8([http valueForHTTPHeaderField:@"Content-Disposition"].lowercaseString);
    const auto kind = disposition.substr(0, disposition.find_first_of("; \t"));
    return kind == "attachment";
}

constexpr std::array<std::string_view, 3> socketPaths{"/websocket", "/record-conn", "/record-detail-conn"};

std::array<std::string, 5> HttpPaths(const ContestPolicy& scope) {
    return {scope.basePath + "/contest/" + scope.contestId, scope.basePath + "/p",
        scope.basePath + "/record", "/resource", "/fs"};
}

struct ContestLease {
    int seconds = 0;
    std::vector<std::tuple<std::string, std::string, std::string>> cookies;
};

bool HydroContest(const ContestPolicy& scope) { return scope.platform == "HYDRO_BROWSER"; }

std::string_view SessionCookieName(const ContestPolicy& scope) {
    return HydroContest(scope) ? "sid" : "user_token";
}

ContestLease ReadHydroLease(const ContestPolicy& scope, std::string_view sid, std::string_view key, const std::atomic_bool& cancel) {
    const auto url = scope.origin + scope.basePath + "/api/proctor/browser-contest/" + scope.contestId;
    const auto response = RequestHttp(url, "POST", {{"Accept", "application/json"}, {"Content-Type", "application/json"},
        {"Origin", scope.origin}, {"Cookie", "sid=" + std::string(sid)}, {"x-hydro-proctor-key", key}},
        Json{{"action", "socket-lease"}, {"transport", "wkwebview"}, {"basePath", scope.basePath}}.dump(),
        6000, 8192, true, &cancel);
    const auto value = Json::parse(response.body, nullptr, false);
    if (response.status != 200 || !value.is_object() || value.value("ok", Json(false)) != true) return {};
    const auto& data = value.at("data");
    const auto seconds = data.value("expiresInSeconds", 0);
    if (seconds <= 0 || seconds > 90) return {};
    ContestLease lease;
    lease.seconds = seconds;
    const auto read = [&](const auto& paths, const Json& cookies, std::string_view name) {
        if (!cookies.is_array() || cookies.size() != paths.size()) return false;
        std::set<std::string> seen;
        static const std::regex token(R"([A-Za-z0-9_-]{43})");
        for (const auto& cookie : cookies) {
            const auto path = cookie.value("path", ""), value = cookie.value("value", "");
            if (cookie.value("name", "") != name || !std::regex_match(value, token) ||
                std::find(paths.begin(), paths.end(), path) == paths.end() || !seen.insert(path).second) return false;
            lease.cookies.emplace_back(name, path, value);
            // The default domain has two spellings for each contest, problem and record path.
            if (name == "proctor_http" && path != "/resource" && path != "/fs") {
                if (scope.basePath.empty()) lease.cookies.emplace_back(name, "/d/system" + path, value);
                else if (scope.basePath == "/d/system") lease.cookies.emplace_back(name, path.substr(scope.basePath.size()), value);
            }
        }
        return true;
    };
    if (!read(socketPaths, data.at("cookies"), "proctor_ws") ||
        !read(HttpPaths(scope), data.at("httpCookies"), "proctor_http")) return {};
    return lease;
}

ContestLease ReadNovaLease(const ContestPolicy& scope, std::string_view session, std::string_view key,
        const std::atomic_bool& cancel) {
    const auto url = scope.origin + "/api/contests/" + scope.contestId + "/proctoring-wk-lease";
    const auto response = RequestHttp(url, "POST", {{"Accept", "application/json"},
        {"Origin", scope.origin}, {"Cookie", "user_token=" + std::string(session)}, {"x-novajudge-proctor-key", key}},
        {}, 6000, 8192, true, &cancel);
    const auto value = Json::parse(response.body, nullptr, false);
    if (response.status != 200 || !value.is_object() || value.value("ok", Json(false)) != true) return {};
    const auto& data = value.at("data");
    const auto seconds = data.value("expiresInSeconds", 0);
    const auto& cookies = data.at("cookies");
    if (seconds <= 0 || seconds > 90 || !cookies.is_array() || cookies.size() != 1) return {};
    const auto& cookie = cookies.at(0);
    const auto proof = cookie.value("value", "");
    static const std::regex token(R"(v1\.[0-9]{10}\.[A-Za-z0-9_-]{43})");
    if (cookie.value("name", "") != "novajudge_proctor_wk" || cookie.value("path", "") != "/" ||
        !std::regex_match(proof, token)) return {};
    return {seconds, {{"novajudge_proctor_wk", "/", proof}}};
}

NSHTTPCookie* MakeContestCookie(NSURL* origin, std::string_view name, std::string_view path,
        const std::string& value, std::optional<NSInteger> age = {}) {
    auto header = std::string(name) + "=" + value + "; Path=" + std::string(path) + "; Secure; HttpOnly; SameSite=Lax";
    if (age) header += "; Max-Age=" + std::to_string(*age);
    auto* cookie = [NSHTTPCookie cookiesWithResponseHeaderFields:@{@"Set-Cookie": Ns(header)} forURL:origin].firstObject;
    if (!cookie.isHTTPOnly || !cookie.isSecure || Utf8(cookie.path) != path) return nil;
    return cookie;
}

std::vector<std::string> CandidateRules(const ContestPolicy& scope) {
    std::vector<std::string> rules{"^about:blank$", "^data:", "^blob:"};
    if (scope.External() && !ParseHttpUrl(scope.origin).secure) return rules;
    if (scope.platform == "NOVAJUDGE") {
        rules.push_back(UrlExpression(scope.origin) + "/");
        rules.push_back(UrlExpression("wss" + scope.origin.substr(5)) + "/");
        return rules;
    }
    if (HydroContest(scope)) {
        const auto origin = UrlExpression(scope.origin);
        const auto domain = scope.basePath.empty() || scope.basePath == "/d/system" ? origin + "(/d/system)?" : UrlExpression(scope.origin + scope.basePath);
        rules.push_back(domain + "/contest/" + scope.contestId + "([/?#].*)?$");
        rules.push_back(domain + "/p/");
        rules.push_back(domain + "/record([/?#].*)?$");
        rules.push_back(origin + "/resource/");
        rules.push_back(origin + "/fs/");
        rules.push_back(origin + "/hydro-league-xcpcio/index(-[A-Za-z0-9_.-]+)?\\.html\\?source=");
        rules.push_back(origin + "/hydro-league-xcpcio/asset-manifest(-[A-Za-z0-9_.-]+)?\\.json([?#].*)?$");
        for (const auto* extension : {"js", "css", "woff", "woff2", "ttf", "otf", "png", "jpg", "jpeg", "webp", "svg", "gif", "ico", "avif", "mp4"})
            rules.push_back(origin + "/.*\\." + extension + "([?#].*)?$");
        for (const auto path : socketPaths) rules.push_back(UrlExpression("wss" + scope.origin.substr(5) + std::string(path)) + "([?#].*)?$");
        return rules;
    }
    if (scope.External()) return rules;
    if (!scope.clientOrigin.empty()) {
        const auto origin = UrlExpression(scope.clientOrigin);
        rules.push_back(origin + "/contest([/?#].*)?$");
        rules.push_back(origin + "/api/client/");
        rules.push_back(origin + "/_next/static/");
        rules.push_back(origin + "/candidate-assets/_next/static/");
        rules.push_back(origin + "/brand/logo\\.png([?#].*)?$");
        rules.push_back(origin + "/candidate-assets/brand/logo\\.png([?#].*)?$");
    }
    if (!scope.backendOrigin.empty()) rules.push_back(UrlExpression(scope.backendOrigin) + "/api/client/");
    if (!scope.origin.empty() && scope.origin != scope.clientOrigin) {
        const auto origin = UrlExpression(scope.origin);
        rules.push_back(UrlExpression(scope.origin + "/contest/" + scope.contestId) + "([/?#].*)?$");
        for (const auto* path : {"/api/", "/fs/", "/file/"}) rules.push_back(origin + path);
    }
    return rules;
}

NSRect Rect(const Json& value) {
    if (!value.is_array() || value.size() != 4 ||
        !std::all_of(value.begin(), value.end(), [](const Json& n) { return n.is_number(); })) return NSZeroRect;
    const auto number = [&value](std::size_t index) { return std::clamp(value[index].get<double>(), -32768.0, 32768.0); };
    return NSMakeRect(number(0), number(1), std::max(0.0, number(2)), std::max(0.0, number(3)));
}

void Mask(ProctorClip* clip, const Json& list, NSRect guest) {
    NSMutableArray<NSValue*>* covers = [NSMutableArray array];
    if (list.is_array()) {
        for (std::size_t i = 0; i < std::min<std::size_t>(list.size(), 64); ++i) {
            const auto cover = NSIntersectionRect(guest, Rect(list[i]));
            if (!NSIsEmptyRect(cover)) {
                [covers addObject:[NSValue valueWithRect:NSOffsetRect(cover, -guest.origin.x, -guest.origin.y)]];
            }
        }
    }
    clip.covers = covers;
    if (!covers.count) {
        clip.layer.mask = nil;
        return;
    }
    // The nonzero fill rule makes overlapping covers one excluded region.
    // Use the same rectangles for both drawing and mouse hit testing.
    auto* hidden = CGPathCreateMutable();
    for (NSValue* cover in covers) {
        CGPathAddRect(hidden, nullptr, NSRectToCGRect(cover.rectValue));
    }
    auto* full = CGPathCreateWithRect(NSRectToCGRect(clip.bounds), nullptr);
    auto* path = CGPathCreateCopyBySubtractingPath(full, hidden, false);
    CGPathRelease(full);
    CGPathRelease(hidden);
    auto* layer = [CAShapeLayer layer];
    layer.frame = clip.bounds;
    layer.path = path;
    clip.layer.mask = layer;
    if (path) CGPathRelease(path);
}
} // namespace

MacBrowser::MacBrowser(wxWindow& frame, NSView* parent, Bridge& bridge, Push push, std::function<bool()> blocked,
                       Queue queue, DraftLoader draftLoader)
    : frame_(frame), parent_(parent), bridge_(bridge), push_(std::move(push)), blocked_(std::move(blocked)),
      queue_(std::move(queue)), draftLoader_(std::move(draftLoader)) {
    clip_ = [[ProctorClip alloc] initWithFrame:NSZeroRect];
    clip_.wantsLayer = YES;
    clip_.hidden = YES;
    [parent_ addSubview:clip_ positioned:NSWindowAbove relativeTo:nil];
    auto* config = Configuration(Profile(@"9DB6532E-9EED-4868-A2EF-726D73CCC9D4"));
    ViewHooks hooks;
    hooks.action = [this](WKNavigationAction* action) { return Action(action); };
    hooks.response = [this](WKNavigationResponse* response) { return Response(response); };
    hooks.finished = [this](WKNavigation* navigation, std::string url, int error) {
        if (pending_ && navigation == pending_) {
            CancelDraftRestore();
            const auto request = std::exchange(request_, 0);
            pending_ = nil;
            Reply(request, nullptr, error ? "考试页面加载失败" : "");
        }
        if (error) {
            if (error != NSURLErrorCancelled) Event("did-fail-load", url, error);
        } else {
            lastUrl_ = url;
            Event("did-navigate", url);
            Event("dom-ready", url);
            Event("did-finish-load", url);
        }
    };
    hooks.changed = [this] {
        const auto url = Address(view_.URL);
        if (!view_.loading && !url.empty() && url != lastUrl_ && scope_.Allows(url, "mainFrame")) {
            lastUrl_ = url;
            Event("did-navigate-in-page", url);
        }
    };
    hooks.crashed = [this] {
        CancelDraftRestore();
        pending_ = nil;
        Reply(std::exchange(request_, 0), nullptr, "考试页面加载失败");
        const auto url = Address(view_.URL);
        Event("did-fail-load", url, NSURLErrorNetworkConnectionLost);
    };
    hooks.download = [this](WKDownload* download) { Download(download); };
    hooks.dialogs = [this](std::string_view url) {
        return ready_ && (!scope_.External() || browserAuthorized_) && !blocked_() && scope_.Allows(url, "mainFrame");
    };
    hooks.fileSelection = [this](std::string_view url) {
        return attached_ && !clip_.hidden && !clearing_ && ready_ && (!scope_.External() || browserAuthorized_) &&
            !blocked_() && scope_.Allows(url, "mainFrame");
    };
    view_ = CreateView(config, clip_, std::move(hooks));
    credentialTimer_.SetOwner(this);
    Bind(wxEVT_TIMER, [this](wxTimerEvent&) { RenewContestCredentials(); }, credentialTimer_.GetId());
}

MacBrowser::~MacBrowser() {
    CancelDraftRestore();
    StopContestCredentials();
    alive_.reset();
    CloseReference();
    DetachView(view_);
    [clip_ removeFromSuperview];
}

bool MacBrowser::Dispatch(std::string_view channel, const Json& args, Bridge::Reply reply) {
    if (channel == "browser:setAllowedHosts") {
        hosts_.clear();
        if (!args.empty() && args[0].is_array()) {
            for (const auto& entry : args[0]) {
                if (!entry.is_string()) continue;
                auto host = entry.get<std::string>();
                try {
                    if (host.find("://") == std::string::npos) host = "https://" + host;
                    hosts_.insert(ParseHttpUrl(host).host);
                } catch (...) {}
            }
        }
        bridge_.SetAllowedHosts(Json(hosts_));
        reply(nullptr, {});
    } else if (channel == "browser:setContestScope") Scope(args, std::move(reply));
    else if (channel == "browser:installHydroBrowserLogin" || channel == "browser:installNovaJudgeLogin")
        InstallContestLogin(channel == "browser:installHydroBrowserLogin", args.at(0), std::move(reply));
    else return false;
    return true;
}

bool MacBrowser::ApiAllowed(std::string_view raw) const {
    try {
        const auto url = ParseHttpUrl(raw);
        if (!hosts_.count(url.host)) return false;
        if (url.path == "/api/health") return true;
        if (scope_.External()) return url.origin == scope_.origin
            ? scope_.Allows(raw, "xhr") : url.path.starts_with("/api/client/");
        if (!scope_.clientOrigin.empty() && url.origin == scope_.clientOrigin) return scope_.Allows(raw, "xhr");
        if (!scope_.clientOrigin.empty() && url.host != scope_.host) return url.path.starts_with("/api/client/");
        return scope_.host.empty() || url.host != scope_.host || scope_.Allows(raw, "xhr");
    } catch (...) { return false; }
}

Json MacBrowser::SnapshotHosts(Json hosts) {
    if (!hosts.is_array()) hosts = Json::array();
    const auto now = std::chrono::steady_clock::now();
    for (auto entry = referenceHosts_.begin(); entry != referenceHosts_.end();) {
        if (entry->second <= now) entry = referenceHosts_.erase(entry);
        else { hosts.push_back(entry->first); ++entry; }
    }
    return hosts;
}

void MacBrowser::InstallContestLogin(bool hydro, const Json& login, Bridge::Reply reply) {
    const std::string platform = hydro ? "HydroOJ" : "NovaJudge";
    if (scope_.platform != (hydro ? "HYDRO_BROWSER" : "NOVAJUDGE") || !ready_ || clearing_ || blocked_()) {
        reply(nullptr, "当前不能登录 " + platform);
        return;
    }
    if (!ParseHttpUrl(scope_.origin).secure) {
        reply(nullptr, "WKWebView 的 " + platform + " 监考鉴权需要 HTTPS 地址");
        return;
    }
    const auto& cookie = login.at("cookie");
    const auto session = cookie.value("value", "");
    const auto key = login.value("proctoringKey", "");
    NSDate* expiration = nil;
    if (hydro) {
        auto* formatter = [NSISO8601DateFormatter new];
        auto* value = Ns(login.value("expiresAt", ""));
        expiration = [formatter dateFromString:value];
        if (!expiration) {
            formatter.formatOptions = NSISO8601DateFormatWithInternetDateTime | NSISO8601DateFormatWithFractionalSeconds;
            expiration = [formatter dateFromString:value];
        }
    }
    static const std::regex sidPattern(R"([A-Za-z0-9_-]{16,256})");
    static const std::regex jwtPattern(R"([A-Za-z0-9_-]+\.[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+)");
    static const std::regex keyPattern(R"([A-Za-z0-9_-]{43})");
    if (login.value("loginUrl", "") != scope_.Home() || cookie.value("name", "") != SessionCookieName(scope_) ||
        session.size() > 8192 || !std::regex_match(session, hydro ? sidPattern : jwtPattern) || !std::regex_match(key, keyPattern) ||
        (hydro && (login.value("platform", "") != "HYDRO_BROWSER" || !expiration || expiration.timeIntervalSinceNow < 1)) ||
        (!hydro && login.value("loginSource", "") != "PROCTORING")) {
        reply(nullptr, platform + " 登录凭据与当前考试不匹配");
        return;
    }
    StopContestCredentials(false);
    if (!hydro) bridge_.ResetNovaJudge();
    sessionCookie_ = session;
    proctoringKey_ = key;
    sessionExpires_ = expiration;
    if (!hydro) novaContestAccess_ = login.value("contestAccessToken", Json());
    credentialRequest_ = std::make_shared<std::atomic_bool>(false);
    RenewContestCredentials(std::move(reply));
}

void MacBrowser::RenewContestCredentials(Bridge::Reply first) {
    const std::string failed = HydroContest(scope_) ? "HydroOJ 监考页面与实时判题鉴权失败，请稍后重试"
        : "NovaJudge 监考页面鉴权失败，请稍后重试";
    if (!credentialRequest_ || sessionCookie_.empty() || !ready_) {
        if (first) first(nullptr, failed);
        return;
    }
    const auto cancel = credentialRequest_;
    const auto weak = std::weak_ptr<int>(alive_);
    const auto scope = scope_;
    const auto sid = sessionCookie_;
    const auto key = proctoringKey_;
    if (!queue_([this, cancel, weak, scope, sid, key, failed, first] {
        ContestLease lease;
        try {
            lease = HydroContest(scope) ? ReadHydroLease(scope, sid, key, *cancel) : ReadNovaLease(scope, sid, key, *cancel);
        } catch (...) {}
        dispatch_async(dispatch_get_main_queue(), ^{
            if (weak.expired() || cancel->load()) {
                if (first) first(nullptr, "考试状态已变化，请重新登录");
                return;
            }
            auto* origin = [NSURL URLWithString:Ns(scope.origin)];
            auto* store = view_.configuration.websiteDataStore.httpCookieStore;
            NSMutableArray<NSHTTPCookie*>* all = [NSMutableArray array];
            const auto retry = [this, first, failed] {
                if (first) { StopContestCredentials(); first(nullptr, failed); }
                else credentialTimer_.StartOnce(3000);
            };
            const auto remaining = sessionExpires_ ? sessionExpires_.timeIntervalSinceNow : static_cast<double>(lease.seconds);
            if (sessionExpires_ && remaining < 1) {
                StopContestCredentials();
                if (first) first(nullptr, failed);
                return;
            }
            if (!lease.seconds || (first && blocked_())) { retry(); return; }
            const auto age = static_cast<NSInteger>(std::min(remaining, static_cast<double>(lease.seconds)));
            if (first) {
                const auto lifetime = sessionExpires_ ? std::optional(static_cast<NSInteger>(remaining)) : std::nullopt;
                auto* session = MakeContestCookie(origin, SessionCookieName(scope), "/", sid, lifetime);
                if (!session) { retry(); return; }
                [all addObject:session];
            }
            for (const auto& [name, path, token] : lease.cookies) {
                auto* cookie = MakeContestCookie(origin, name, path, token, age);
                if (!cookie) { retry(); return; }
                [all addObject:cookie];
            }
            proofCookies_ = [all copy];
            auto group = dispatch_group_create();
            for (NSHTTPCookie* cookie in all) {
                dispatch_group_enter(group);
                [store setCookie:cookie completionHandler:^{ dispatch_group_leave(group); }];
            }
            dispatch_group_notify(group, dispatch_get_main_queue(), ^{
                if (weak.expired() || cancel->load()) {
                    if (first) first(nullptr, "考试状态已变化，请重新登录");
                    return;
                }
                [store getAllCookies:^(NSArray<NSHTTPCookie*>* installed) {
                    if (weak.expired() || cancel->load()) {
                        if (first) first(nullptr, "考试状态已变化，请重新登录");
                        return;
                    }
                    for (NSHTTPCookie* target in all) {
                        bool found = false;
                        for (NSHTTPCookie* cookie in installed) {
                            if ([target.name isEqualToString:cookie.name] && [target.path isEqualToString:cookie.path] &&
                                [target.domain isEqualToString:cookie.domain] && [target.value isEqualToString:cookie.value] &&
                                cookie.isHTTPOnly && cookie.isSecure) { found = true; break; }
                        }
                        if (!found) { retry(); return; }
                    }
                    if (first && blocked_()) { retry(); return; }
                    credentialTimer_.StartOnce(static_cast<int>(std::max<NSInteger>(3, age / 2) * 1000));
                    if (first) {
                        browserAuthorized_ = true;
                        if (!HydroContest(scope)) {
                            bridge_.ConnectNovaJudge({scope.origin, scope.contestId, scope.backendOrigin, sid, key,
                                std::move(novaContestAccess_)});
                        }
                        first(scope.Home(), {});
                    }
                }];
            });
        });
    })) {
        if (first) { StopContestCredentials(); first(nullptr, failed); }
        else credentialTimer_.StartOnce(3000);
    }
}

void MacBrowser::StopContestCredentials(bool eraseCookies) {
    credentialTimer_.Stop();
    browserAuthorized_ = false;
    if (credentialRequest_) credentialRequest_->store(true);
    credentialRequest_.reset();
    if (eraseCookies && !sessionCookie_.empty()) {
        auto* store = view_.configuration.websiteDataStore.httpCookieStore;
        const auto host = ParseHttpUrl(scope_.origin).host;
        const auto sessionName = SessionCookieName(scope_);
        const auto sid = sessionCookie_;
        auto* proofs = proofCookies_;
        [store getAllCookies:^(NSArray<NSHTTPCookie*>* cookies) {
            for (NSHTTPCookie* cookie in cookies) {
                if (Utf8(cookie.domain) != host) continue;
                if (Utf8(cookie.name) == sessionName && Utf8(cookie.value) == sid) {
                    [store deleteCookie:cookie completionHandler:nil];
                    continue;
                }
                for (NSHTTPCookie* proof in proofs) {
                    if ([proof.name isEqualToString:cookie.name] && [proof.path isEqualToString:cookie.path] &&
                        [proof.value isEqualToString:cookie.value]) {
                        [store deleteCookie:cookie completionHandler:nil];
                        break;
                    }
                }
            }
        }];
    }
    sessionCookie_.clear();
    proctoringKey_.clear();
    novaContestAccess_ = nullptr;
    sessionExpires_ = nil;
    proofCookies_ = nil;
}

void MacBrowser::Scope(const Json& args, Bridge::Reply reply) {
    if (blocked_() || clearing_) { reply(nullptr, "考试页面状态已变化，请稍后重试"); return; }
    auto policy = MakeContestPolicy(args);
    const bool clear = scope_.External() || policy.External();
    Reset(false);
    clearing_ = true;
    bridge_.ResetNovaJudge();
    const auto generation = generation_;
    auto* data = view_.configuration.websiteDataStore;
    const auto weak = std::weak_ptr<int>(alive_);
    void (^configure)(void) = ^{
        if (weak.expired() || generation != generation_) { reply(nullptr, "考试页面状态已变化，请稍后重试"); return; }
        CompileRules(view_, BlockExcept(CandidateRules(policy)), [this, weak, generation, policy, reply](bool compiled) {
            if (weak.expired() || generation != generation_) { reply(nullptr, "考试页面状态已变化，请稍后重试"); return; }
            clearing_ = false;
            if (!compiled || blocked_()) { reply(nullptr, "考试页面请求策略加载失败"); return; }
            scope_ = policy;
            for (const auto& address : {scope_.origin, scope_.clientOrigin, scope_.backendOrigin}) {
                if (!address.empty()) hosts_.insert(ParseHttpUrl(address).host);
            }
            bridge_.SetAllowedHosts(Json(hosts_));
            ready_ = true;
            Resize();
            reply(nullptr, {});
        });
    };
    if (clear) {
        // The Electron contest reset clears site state and keeps the HTTP cache.
        // Disk and memory responses remain scoped to this isolated contest store.
        auto* siteData = [WKWebsiteDataStore.allWebsiteDataTypes mutableCopy];
        [siteData removeObject:WKWebsiteDataTypeDiskCache];
        [siteData removeObject:WKWebsiteDataTypeMemoryCache];
        [data removeDataOfTypes:siteData modifiedSince:NSDate.distantPast completionHandler:configure];
    } else configure();
}

void MacBrowser::Reset(bool resetLayout) {
    ++generation_;
    CancelDraftRestore();
    StopContestCredentials();
    CloseReference();
    clearing_ = false;
    ready_ = false;
    if (resetLayout) {
        geometry_ = nullptr;
        attached_ = false;
    }
    lastUrl_.clear();
    [view_ stopLoading];
    pending_ = nil;
    Reply(std::exchange(request_, 0), nullptr, "考试页面加载已取消");
    Load(view_, "about:blank");
    Resize();
}

void MacBrowser::SetVisible(bool visible) {
    visible_ = visible;
    if (referenceFrame_) referenceFrame_->Show(visible && !blocked_());
    Resize();
}

void MacBrowser::Resize() {
    const auto rect = geometry_.is_array() && geometry_.size() == 2 ? Rect(geometry_[0]) : NSZeroRect;
    const bool blocked = blocked_();
    if (blocked && (draftRead_ || draftScript_)) {
        const bool preparing = static_cast<bool>(draftRead_);
        CancelDraftRestore();
        if (preparing) Reply(std::exchange(request_, 0), nullptr, "考试页面加载已取消");
    }
    clip_.hidden = !visible_ || blocked || !attached_ || !ready_ || NSIsEmptyRect(rect);
    if (clip_.hidden) {
        CancelFileSelection(view_);
        return;
    }
    auto frame = rect;
    if (!parent_.isFlipped) frame.origin.y = NSHeight(parent_.bounds) - NSMaxY(rect);
    if (!NSEqualRects(clip_.frame, frame)) clip_.frame = frame;
    if (geometry_ != appliedGeometry_) {
        Mask((ProctorClip*)clip_, geometry_[1], rect);
        appliedGeometry_ = geometry_;
    }
}

void MacBrowser::Event(std::string_view event, std::string url, int error, bool main) {
    if (!attached_) return;
    push_({{"guest", "event"}, {"event", event}, {"url", std::move(url)}, {"canGoForward", view_.canGoForward == YES},
           {"errorCode", error}, {"isMainFrame", main}});
}
void MacBrowser::Reply(std::uint64_t request, Json value, std::string error) {
    if (request) push_({{"guest", "reply"}, {"request", request}, {"value", std::move(value)}, {"error", std::move(error)}});
}

void MacBrowser::Message(const Json& message) {
    const auto action = message.value("guest", "");
    const auto request = message.value("request", std::uint64_t{});
    try {
        const auto& args = message.at("args");
        if (action == "attach") { attached_ = true; Event("attached"); return; }
        if (action == "bounds") { geometry_ = args; Resize(); return; }
        if (action == "load") { Navigate(String(args, 0), request, args.size() > 1 ? args[1] : Json::object()); return; }
        if (action == "forward" && !blocked_()) [view_ goForward];
        else if (action == "reload" && !blocked_()) [view_ reload];
        else if (action == "stop") {
            CancelDraftRestore();
            [view_ stopLoading];
            pending_ = nil;
            Reply(std::exchange(request_, 0), nullptr, "考试页面加载已取消");
        } else if (action == "zoom") {
            view_.pageZoom = std::clamp(args.at(0).get<double>(), 0.5, 2.0);
        } else if (action == "focus") [view_.window makeFirstResponder:view_];
        else if (action == "script" && String(args, 0) == "Boolean(document.querySelector('input[name=\"password\"]'))") {
            const auto weak = std::weak_ptr<int>(alive_);
            const auto generation = generation_;
            [view_ evaluateJavaScript:Ns(String(args, 0)) completionHandler:^(id value, NSError* error) {
                if (!weak.expired() && generation == generation_) {
                    Reply(request, [value respondsToSelector:@selector(boolValue)] && [value boolValue],
                          error ? "考试页面调用失败" : "");
                }
            }];
            return;
        } else throw std::runtime_error("未知的考试页面操作");
        Reply(request);
    } catch (const std::exception& error) { Reply(request, nullptr, error.what()); }
}

void MacBrowser::Navigate(const std::string& url, std::uint64_t request, const Json& options) {
    const bool blank = url == "about:blank";
    if (!blank && (!ready_ || clearing_ || (scope_.External() && !browserAuthorized_) ||
        !scope_.Allows(url, "mainFrame") || blocked_())) {
        throw std::runtime_error("当前不允许访问该地址：" + url);
    }
    NSURL* address = [NSURL URLWithString:Ns(url)];
    if (!address) throw std::runtime_error("无效的考试页面地址");
    auto* target = [NSMutableURLRequest requestWithURL:address];
    if (!blank && ParseHttpUrl(url).origin == scope_.clientOrigin && options.is_object()) {
        const auto raw = options.value("extraHeaders", "");
        static const std::regex tokenPattern(R"((?:^|\r\n)X-Proctor-Session-Token: ([^\r\n]{1,8192})(?:\r\n|$))");
        std::smatch match;
        if (std::regex_search(raw, match, tokenPattern)) {
            [target setValue:@"desktop" forHTTPHeaderField:@"X-Proctor-Client"];
            [target setValue:Ns(match[1].str()) forHTTPHeaderField:@"X-Proctor-Session-Token"];
        }
    }
    CancelDraftRestore();
    Reply(std::exchange(request_, request), nullptr, "考试页面加载已取消");
    const auto migration = LegacyDraftTargetFor(scope_, url, options);
    if (migration && draftLoader_) {
        pending_ = nil;
        [view_ stopLoading];
        const auto cancelled = draftRead_ = std::make_shared<std::atomic_bool>(false);
        const auto weak = std::weak_ptr<int>(alive_);
        const auto prepare = draftLoader_;
        if (queue_([this, weak, cancelled, prepare, migration = *migration, target] {
            std::string script;
            try {
                const auto encoded = prepare(migration, *cancelled);
                if (!encoded.empty() && !cancelled->load())
                    script = LegacyDraftInstallScript(migration, Json::parse(encoded, nullptr, false));
            } catch (...) {}
            dispatch_async(dispatch_get_main_queue(), ^{
                if (weak.expired() || cancelled->load()) return;
                draftRead_.reset();
                if (!ready_ || clearing_ || blocked_()) {
                    Reply(std::exchange(request_, 0), nullptr, "考试页面加载已取消");
                    return;
                }
                BeginNavigation(target, script);
            });
        })) return;
        draftRead_.reset();
    }
    BeginNavigation(target);
}

void MacBrowser::BeginNavigation(NSURLRequest* target, const std::string& script) {
    if (!script.empty()) {
        auto* source = [[WKUserScript alloc] initWithSource:Ns(script) injectionTime:WKUserScriptInjectionTimeAtDocumentStart
            forMainFrameOnly:YES inContentWorld:WKContentWorld.defaultClientWorld];
        [view_.configuration.userContentController addUserScript:source];
        draftScript_ = true;
    }
    pending_ = [view_ loadRequest:target];
    if (!pending_) {
        CancelDraftRestore();
        Reply(std::exchange(request_, 0), nullptr, "考试页面加载失败");
    }
}

void MacBrowser::CancelDraftRestore() {
    if (draftRead_) draftRead_->store(true);
    draftRead_.reset();
    if (std::exchange(draftScript_, false)) [view_.configuration.userContentController removeAllUserScripts];
}

WKNavigationActionPolicy MacBrowser::Action(WKNavigationAction* action) {
    const auto url = Address(action.request.URL);
    if (url == "about:blank" && action.targetFrame.isMainFrame) return WKNavigationActionPolicyAllow;
    if (!ready_ || clearing_ || blocked_() || (scope_.External() && !browserAuthorized_)) return WKNavigationActionPolicyCancel;
    if (!action.targetFrame) {
        if (scope_.IsFile(url) && !scope_.IsInlinePdf(url) && scope_.AllowsDownload(Address(view_.URL), url)) {
            const auto weak = std::weak_ptr<int>(alive_);
            const auto generation = generation_;
            [view_ startDownloadUsingRequest:action.request completionHandler:^(WKDownload* download) {
                if (weak.expired() || generation != generation_) [download cancel:nil]; else Download(download);
            }];
        } else if (scope_.External() && scope_.Allows(url, "mainFrame")) Load(view_, url);
        else if (!scope_.External()) OpenReference(url);
        return WKNavigationActionPolicyCancel;
    }
    const bool allowed = scope_.Allows(url, action.targetFrame.isMainFrame ? "mainFrame" : "subFrame");
    if ((action.shouldPerformDownload || (scope_.IsFile(url) && !scope_.IsInlinePdf(url))) && scope_.AllowsDownload(Address(view_.URL), url))
        return WKNavigationActionPolicyDownload;
    if (!allowed) {
        if (!scope_.External() && action.targetFrame.isMainFrame && action.navigationType == WKNavigationTypeLinkActivated)
            OpenReference(url);
        else Event(action.targetFrame.isMainFrame ? "will-navigate" : "will-frame-navigate", url, 0, action.targetFrame.isMainFrame);
    }
    return allowed ? WKNavigationActionPolicyAllow : WKNavigationActionPolicyCancel;
}

WKNavigationResponsePolicy MacBrowser::Response(WKNavigationResponse* response) {
    const auto url = Address(response.response.URL);
    if (url == "about:blank" && response.isForMainFrame) return WKNavigationResponsePolicyAllow;
    if (!ready_ || clearing_ || blocked_() || (scope_.External() && !browserAuthorized_)) return WKNavigationResponsePolicyCancel;
    if ((!response.canShowMIMEType || IsAttachment(response.response)) &&
        scope_.AllowsDownload(Address(view_.URL), url)) return WKNavigationResponsePolicyDownload;
    return response.canShowMIMEType && scope_.Allows(url, response.isForMainFrame ? "mainFrame" : "subFrame")
        ? WKNavigationResponsePolicyAllow : WKNavigationResponsePolicyCancel;
}

void MacBrowser::Download(WKDownload* download) {
    const auto source = Address(view_.URL);
    SaveDownload(download, frame_, [this, source](std::string_view url) { return scope_.AllowsDownload(source, url); });
}

void MacBrowser::SaveDownload(WKDownload* download, wxWindow& owner, std::function<bool(std::string_view)> allowed,
                              std::function<void()> finished) {
    if (blocked_() || !allowed(Address(download.originalRequest.URL))) {
        [download cancel:^(NSData*) { if (finished) finished(); }];
        return;
    }
    auto* delegate = [ProctorDownload new];
    const auto weak = std::weak_ptr<int>(alive_);
    const auto generation = generation_;
    delegate->allowed = [this, weak, generation, allowed = std::move(allowed)](std::string_view url) {
        return !weak.expired() && generation == generation_ && !blocked_() && allowed(url);
    };
    delegate->choose = [this, weak, generation, owner = wxWeakRef<wxWindow>(&owner)](NSString* name) -> NSURL* {
        if (weak.expired() || !owner.get() || generation != generation_ || blocked_()) return nil;
        auto* directory = [NSFileManager.defaultManager URLsForDirectory:NSDownloadsDirectory inDomains:NSUserDomainMask].firstObject;
        wxFileDialog dialog(owner.get(), wxString::FromUTF8("保存考试文件"), wxString::FromUTF8(Utf8(directory.path)),
            wxString::FromUTF8(DownloadName(Utf8(name))), "*.*", wxFD_SAVE | wxFD_OVERWRITE_PROMPT);
        if (dialog.ShowModal() != wxID_OK || weak.expired() || !owner.get() || generation != generation_ || blocked_()) return nil;
        const auto path = dialog.GetPath().utf8_string();
        return [NSURL fileURLWithPath:Ns(path)];
    };
    delegate->finished = std::move(finished);
    objc_setAssociatedObject(download, &downloadDelegate, delegate, OBJC_ASSOCIATION_RETAIN_NONATOMIC);
    download.delegate = delegate;
}

void MacBrowser::OpenReference(std::string raw) {
    if (reference_ || blocked_() || scope_.External()) return;
    HttpUrl url;
    try { url = ParseHttpUrl(raw); } catch (...) { return; }
    if (url.host == "127.0.0.1") return;
    const auto target = url.Url() + url.fragment;
    const auto file = ReferenceFile(target);
    referenceFrame_ = new wxFrame(&frame_, wxID_ANY, wxString::FromUTF8("链接预览（仅允许访问当前链接）"),
        wxDefaultPosition, wxSize(1080, 760), wxDEFAULT_FRAME_STYLE | wxFRAME_FLOAT_ON_PARENT);
    referenceFrame_->SetMinSize(wxSize(720, 520));
    referenceFrame_->Bind(wxEVT_CLOSE_WINDOW, [this](wxCloseEvent&) { CloseReference(); });
    auto* host = NativeView(*referenceFrame_);
    if (!host) { CloseReference(); return; }
    auto* config = Configuration(WKWebsiteDataStore.nonPersistentDataStore);
    const auto weak = std::weak_ptr<int>(alive_);
    const auto window = referenceFrame_;
    const auto same = [target](std::string_view address) {
        try { const auto next = ParseHttpUrl(address); return next.Url() + next.fragment == target; }
        catch (...) { return false; }
    };
    ViewHooks hooks;
    hooks.action = [this, same](WKNavigationAction* action) {
        const auto method = Utf8(action.request.HTTPMethod);
        if (blocked_() || !action.targetFrame.isMainFrame || (method != "GET" && method != "HEAD") ||
            !same(Address(action.request.URL))) return WKNavigationActionPolicyCancel;
        return action.shouldPerformDownload ? WKNavigationActionPolicyDownload : WKNavigationActionPolicyAllow;
    };
    hooks.response = [this, same](WKNavigationResponse* response) {
        if (blocked_() || !response.isForMainFrame || !same(Address(response.response.URL))) return WKNavigationResponsePolicyCancel;
        return response.canShowMIMEType && !IsAttachment(response.response)
            ? WKNavigationResponsePolicyAllow : WKNavigationResponsePolicyDownload;
    };
    hooks.changed = [this, same, target] {
        if (reference_ && reference_.URL && !same(Address(reference_.URL))) Load(reference_, target);
    };
    hooks.finished = [this, file](WKNavigation*, std::string, int error) {
        if (!file && error == NSURLErrorCancelled) return;
        if (error) CloseReference();
        else if (referenceFrame_) referenceFrame_->Show();
    };
    hooks.download = [this, weak, window, same](WKDownload* download) {
        if (weak.expired() || referenceFrame_ != window) { [download cancel:nil]; return; }
        SaveDownload(download, *window, same, [this, weak, window] {
            if (!weak.expired() && referenceFrame_ == window) CloseReference();
        });
    };
    reference_ = CreateView(config, host, std::move(hooks));
    frame_.Disable();
    auto* view = reference_;
    CompileRules(view, BlockExcept({"^https?:"}), [this, weak, window, view, target, hostName = url.host, file](bool ok) {
        if (weak.expired() || referenceFrame_ != window || reference_ != view) return;
        if (!ok || blocked_()) { CloseReference(); return; }
        referenceHosts_[hostName] = std::chrono::steady_clock::now() + std::chrono::seconds(35);
        if (!file) { Load(view, target); return; }
        [view startDownloadUsingRequest:[NSURLRequest requestWithURL:[NSURL URLWithString:Ns(target)]] completionHandler:^(WKDownload* download) {
            if (weak.expired() || referenceFrame_ != window) { [download cancel:nil]; return; }
            SaveDownload(download, *window, [](std::string_view address) {
                try { return ParseHttpUrl(address).host != "127.0.0.1"; } catch (...) { return false; }
            }, [this, weak, window] { if (!weak.expired() && referenceFrame_ == window) CloseReference(); });
        }];
    });
}

void MacBrowser::CloseReference() {
    if (!referenceFrame_) return;
    auto* frame = std::exchange(referenceFrame_, nullptr);
    DetachView(reference_);
    reference_ = nil;
    frame->Destroy();
    frame_.Enable();
}

} // namespace proctor
