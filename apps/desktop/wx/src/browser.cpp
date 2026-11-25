#include "browser.hpp"

#include <wx/app.h>
#include <wx/filedlg.h>
#include <wx/frame.h>
#include <wx/msgdlg.h>
#include <wx/stdpaths.h>
#include <wx/timer.h>
#include <shlobj.h>
#include <winhttp.h>

#include <algorithm>
#include <array>
#include <cctype>
#include <cstdio>
#include <ctime>
#include <cmath>
#include <future>
#include <regex>
#include <stdexcept>
#include <utility>

namespace proctor {
namespace {

constexpr auto noError = COREWEBVIEW2_WEB_ERROR_STATUS_UNKNOWN;
constexpr char hydroHeader[] = "x-hydro-proctor-key";
constexpr wchar_t hydroRequestHeader[] = L"x-hydro-proctor-key";
constexpr wchar_t novaRequestHeader[] = L"x-novajudge-proctor-key";
constexpr char hydroSocketCookie[] = "proctor_ws";
constexpr std::array hydroSocketPaths{"/record-conn", "/record-detail-conn", "/websocket"};

class SocketLeaseTimer final : public wxTimer {
public:
    explicit SocketLeaseTimer(std::function<void()> refresh) : refresh_(std::move(refresh)) {}
private:
    void Notify() override { refresh_(); }
    std::function<void()> refresh_;
};

std::string StringAt(const Json& args, std::size_t index) {
    return index < args.size() && args[index].is_string() ? args[index].get<std::string>() : std::string();
}
std::string Field(const Json& json, const char* field) {
    return json.contains(field) && json[field].is_string() ? json[field].get<std::string>() : std::string();
}
bool Match(std::string_view value, const char* pattern) {
    return std::regex_match(value.begin(), value.end(), std::regex(pattern));
}
std::string Source(ICoreWebView2* view) {
    LPWSTR url = nullptr;
    return view && SUCCEEDED(view->get_Source(&url)) ? Utf8(TakeString(url)) : "";
}
template<class Interface>
ComPtr<Interface> Version(ICoreWebView2* core) {
    ComPtr<Interface> result;
    if (core) core->QueryInterface(IID_PPV_ARGS(&result));
    return result;
}
ComPtr<ICoreWebView2CookieManager> CookieManager(ICoreWebView2* core) {
    ComPtr<ICoreWebView2CookieManager> manager;
    const auto view = Version<ICoreWebView2_2>(core);
    Check(view ? view->get_CookieManager(&manager) : E_NOINTERFACE, "WebView2 cookie manager");
    return manager;
}

void InstallCookie(ICoreWebView2CookieManager* manager, const HttpUrl& origin, std::string_view name,
    std::string_view value, std::string_view path, double expiry = 0) {
    ComPtr<ICoreWebView2Cookie> cookie;
    Check(manager->CreateCookie(Wide(name).c_str(), Wide(value).c_str(), Wide(origin.host).c_str(), Wide(path).c_str(), &cookie),
        "CreateCookie");
    Check(cookie->put_IsHttpOnly(TRUE), "Cookie HttpOnly");
    Check(cookie->put_IsSecure(origin.secure), "Cookie Secure");
    Check(cookie->put_SameSite(COREWEBVIEW2_COOKIE_SAME_SITE_KIND_LAX), "Cookie SameSite");
    if (expiry) Check(cookie->put_Expires(expiry), "Cookie expiration");
    Check(manager->AddOrUpdateCookie(cookie.Get()), "AddOrUpdateCookie");
}

struct HydroSocketLease {
    std::array<std::string, hydroSocketPaths.size()> tokens;
    int expiresSeconds = 0;
};

HydroSocketLease GetHydroSocketLease(const ContestPolicy& scope, std::string_view sid, std::string_view key,
    const std::atomic_bool& cancel) {
    const auto address = scope.origin + scope.basePath + "/api/proctor/browser-contest/" + scope.contestId;
    const auto response = RequestHttp(address, "POST",
        {{"Accept", "application/json"}, {"Content-Type", "application/json"}, {"Origin", scope.origin},
         {"Cookie", "sid=" + std::string(sid)}, {hydroHeader, key}},
        R"({"action":"socket-lease"})", 6000, 8192, true, &cancel);
    const auto json = Json::parse(response.body, nullptr, false);
    if (response.status != 200 || !json.is_object() || json.value("ok", Json(false)) != true
        || !json.contains("data") || !json["data"].is_object()) return {};
    const auto& data = json["data"];
    const auto expires = data.value("expiresInSeconds", Json());
    const auto cookies = data.value("cookies", Json());
    if (!expires.is_number_integer() || expires.get<long long>() < 1 || expires.get<long long>() > 90
        || !cookies.is_array() || cookies.size() != hydroSocketPaths.size()) return {};
    HydroSocketLease lease;
    lease.expiresSeconds = expires.get<int>();
    for (const auto& cookie : cookies) {
        const auto path = Field(cookie, "path");
        const auto it = std::find(hydroSocketPaths.begin(), hydroSocketPaths.end(), path);
        const auto value = Field(cookie, "value");
        if (it == hydroSocketPaths.end() || Field(cookie, "name") != hydroSocketCookie
            || !Match(value, R"([A-Za-z0-9_-]{43})")) return {};
        auto& target = lease.tokens[static_cast<size_t>(std::distance(hydroSocketPaths.begin(), it))];
        if (!target.empty()) return {};
        target = value;
    }
    return lease;
}

bool HasHydroLeaseCookies(ICoreWebView2CookieList* cookies, const HttpUrl& origin,
    const HydroSocketLease& lease, std::string_view sid) {
    UINT count = 0;
    if (!cookies || FAILED(cookies->get_Count(&count))) return false;
    std::array<bool, hydroSocketPaths.size()> paths{};
    bool session = false;
    const auto host = Wide(origin.host);
    for (UINT i = 0; i < count; ++i) {
        ComPtr<ICoreWebView2Cookie> cookie;
        if (FAILED(cookies->GetValueAtIndex(i, &cookie)) || !cookie) continue;
        LPWSTR name = nullptr, domain = nullptr, path = nullptr, value = nullptr;
        BOOL httpOnly = FALSE, secure = FALSE, transient = FALSE;
        cookie->get_Name(&name);
        cookie->get_Domain(&domain);
        cookie->get_Path(&path);
        cookie->get_Value(&value);
        cookie->get_IsHttpOnly(&httpOnly);
        cookie->get_IsSecure(&secure);
        cookie->get_IsSession(&transient);
        const auto key = TakeString(name), matchHost = TakeString(domain);
        const auto matchPath = Utf8(TakeString(path)), matchValue = Utf8(TakeString(value));
        if (matchHost != host || !httpOnly || bool(secure) != origin.secure) continue;
        if (key == L"sid" && matchPath == "/" && matchValue == sid) session = true;
        if (key != L"proctor_ws" || !transient) continue;
        for (size_t route = 0; route < hydroSocketPaths.size(); ++route) {
            if (matchPath == hydroSocketPaths[route] && matchValue == lease.tokens[route]) paths[route] = true;
        }
    }
    return session && std::all_of(paths.begin(), paths.end(), [](bool present) { return present; });
}

auto IgnoreCdp() {
    return On<ICoreWebView2CallDevToolsProtocolMethodCompletedHandler, HRESULT, LPCWSTR>([](HRESULT, LPCWSTR) {});
}
std::string ReferenceTarget(std::string_view raw) {
    const auto url = ParseHttpUrl(raw);
    return url.Url() + url.fragment;
}
fs::path DownloadDirectory() {
    LPWSTR saved = nullptr;
    if (SUCCEEDED(SHGetKnownFolderPath(FOLDERID_Downloads, 0, nullptr, &saved))) {
        return fs::path(TakeString(saved));
    }
    return fs::path(wxStandardPaths::Get().GetDocumentsDir().ToStdWstring());
}
double Expiry(std::string_view raw) {
    SYSTEMTIME time{};
    unsigned y, m, d, h, minute, second;
    if (!Match(raw, R"(\d{4}-\d\d-\d\dT\d\d:\d\d:\d\d(\.\d+)?Z)")
        || std::sscanf(std::string(raw).c_str(), "%4u-%2u-%2uT%2u:%2u:%2u", &y, &m, &d, &h, &minute, &second) != 6) return 0;
    time.wYear = y; time.wMonth = m; time.wDay = d;
    time.wHour = h; time.wMinute = minute; time.wSecond = second;
    FILETIME file{};
    if (!SystemTimeToFileTime(&time, &file)) return 0;
    ULARGE_INTEGER ticks{};
    ticks.LowPart = file.dwLowDateTime;
    ticks.HighPart = file.dwHighDateTime;
    return static_cast<double>(ticks.QuadPart) / 10000000.0 - 11644473600.0;
}
RECT Rectangle(const Json& value) {
    if (!value.is_array() || value.size() != 4) return {};
    long n[4]{};
    for (int i = 0; i < 4; ++i) {
        if (!value[i].is_number()) return {};
        n[i] = static_cast<long>(std::clamp(value[i].get<double>(), -65536.0, 65536.0));
    }
    return {n[0], n[1], n[0] + n[2], n[1] + n[3]};
}

} // namespace

bool TrustedLocal(std::wstring_view url, std::wstring_view expected) {
    return url == expected;
}

void InstallGuard(ICoreWebView2Controller* controller, std::function<bool(ICoreWebView2AcceleratorKeyPressedEventArgs*)> guard) {
    EventRegistrationToken token{};
    auto callback = On<ICoreWebView2AcceleratorKeyPressedEventHandler, ICoreWebView2Controller*, ICoreWebView2AcceleratorKeyPressedEventArgs*>(
        [guard = std::move(guard)](ICoreWebView2Controller*, ICoreWebView2AcceleratorKeyPressedEventArgs* args) {
            if (guard(args)) args->put_Handled(TRUE);
        });
    Check(controller->add_AcceleratorKeyPressed(callback.Get(), &token), "WebView2 accelerator handling");
}

// Use WebView2's editing actions on the focused field or text selection.
void InstallTextEditingMenu(ICoreWebView2* core, std::function<bool()> allowed) {
    EventRegistrationToken event{};
    ComPtr<ICoreWebView2_11> editMenus;
    if (SUCCEEDED(core->QueryInterface(IID_PPV_ARGS(&editMenus)))) {
        auto editMenu = On<ICoreWebView2ContextMenuRequestedEventHandler, ICoreWebView2*, ICoreWebView2ContextMenuRequestedEventArgs*>(
            [allowed = std::move(allowed)](ICoreWebView2*, ICoreWebView2ContextMenuRequestedEventArgs* args) {
                if (FAILED(args->put_Handled(TRUE)) || !allowed()) return;
                ComPtr<ICoreWebView2ContextMenuTarget> target;
                ComPtr<ICoreWebView2ContextMenuItemCollection> items;
                BOOL editable = FALSE;
                BOOL selected = FALSE;
                UINT32 count = 0;
                if (FAILED(args->get_ContextMenuTarget(&target)) || !target || FAILED(target->get_IsEditable(&editable))
                    || FAILED(target->get_HasSelection(&selected)) || (!editable && !selected)
                    || FAILED(args->get_MenuItems(&items)) || !items || FAILED(items->get_Count(&count))) return;
                bool hasEditingItem = false;
                while (count) {
                    --count;
                    ComPtr<ICoreWebView2ContextMenuItem> item;
                    LPWSTR name = nullptr;
                    if (FAILED(items->GetValueAtIndex(count, &item)) || !item || FAILED(item->get_Name(&name))) return;
                    const auto command = TakeString(name);
                    const bool permitted = command == L"copy" || command == L"selectAll"
                        || (editable && (command == L"cut" || command == L"paste"));
                    if (permitted) hasEditingItem = true;
                    else if (FAILED(items->RemoveValueAtIndex(count))) return;
                }
                if (hasEditingItem) args->put_Handled(FALSE);
            });
        if (SUCCEEDED(editMenus->add_ContextMenuRequested(editMenu.Get(), &event))) {
            ComPtr<ICoreWebView2Settings> settings;
            if (SUCCEEDED(core->get_Settings(&settings)) && settings) settings->put_AreDefaultContextMenusEnabled(TRUE);
        }
    }
}

void DenyResource(ICoreWebView2Environment* environment, ICoreWebView2WebResourceRequestedEventArgs* args) {
    ComPtr<ICoreWebView2WebResourceResponse> response;
    if (SUCCEEDED(environment->CreateWebResourceResponse(nullptr, 403, L"Forbidden", L"Cache-Control: no-store", &response))) {
        args->put_Response(response.Get());
    }
}

std::string ResourceType(COREWEBVIEW2_WEB_RESOURCE_CONTEXT context) {
    switch (context) {
    case COREWEBVIEW2_WEB_RESOURCE_CONTEXT_DOCUMENT: return "mainFrame";
    case COREWEBVIEW2_WEB_RESOURCE_CONTEXT_STYLESHEET: return "stylesheet";
    case COREWEBVIEW2_WEB_RESOURCE_CONTEXT_IMAGE: return "image";
    case COREWEBVIEW2_WEB_RESOURCE_CONTEXT_MEDIA: return "media";
    case COREWEBVIEW2_WEB_RESOURCE_CONTEXT_FONT: return "font";
    case COREWEBVIEW2_WEB_RESOURCE_CONTEXT_SCRIPT: return "script";
    case COREWEBVIEW2_WEB_RESOURCE_CONTEXT_XML_HTTP_REQUEST: return "xhr";
    case COREWEBVIEW2_WEB_RESOURCE_CONTEXT_FETCH: return "fetch";
    case COREWEBVIEW2_WEB_RESOURCE_CONTEXT_WEBSOCKET: return "webSocket";
    default: return "other";
    }
}

Browser::Browser(wxFrame& frame, HWND parent, const Runtime& runtime, fs::path data, Bridge& bridge,
    std::function<bool()> displaying, std::function<bool()> locked, std::function<void(std::string)> failed,
    std::function<void(ICoreWebView2*)> attachContest)
    : frame_(frame), runtime_(runtime), data_(std::move(data)), bridge_(bridge),
      displaying_(std::move(displaying)), locked_(std::move(locked)), failed_(std::move(failed)),
      attachContest_(std::move(attachContest)),
      hydroSocketTimer_(std::make_unique<SocketLeaseTimer>([this] { RefreshHydroSocketLease(); })) {
    guestWindow_ = CreateWindowExW(0, L"STATIC", nullptr, WS_CHILD | WS_CLIPCHILDREN | WS_CLIPSIBLINGS,
        0, 0, 0, 0, parent, nullptr, GetModuleHandleW(nullptr), nullptr);
    if (!guestWindow_) throw std::runtime_error("无法创建考试页面容器");
}

Browser::~Browser() {
    *alive_ = false;
    Cleanup();
    guest_.reset();
    if (guestWindow_) DestroyWindow(guestWindow_);
}

void Browser::SetDraftReader(std::function<void(LegacyDraftTarget, std::function<void(Json)>)> reader) {
    draftReader_ = std::move(reader);
}

void Browser::Start() {
    if (guest_) return;
    attached_ = false;
    responseFilterActive_ = false;
    responseFilterReady_ = false;
    guest_ = std::make_shared<WebView>(guestWindow_);
    const auto weak = std::weak_ptr<bool>(alive_);
    const auto fail = [this, weak](std::string error) {
        if (!weak.lock()) return;
        attached_ = false;
        guest_.reset();
        ApplyBounds();
        if (pendingScope_) {
            auto reply = std::move(pendingScope_->second);
            pendingScope_.reset();
            reply(nullptr, "考试页面容器未能启动");
        }
        failed_(std::move(error));
    };
    const auto ready = [this] {
        Configure();
        if (attachContest_) attachContest_(guest_->core());
        ConfigureGuestResponseFilter([this](Json, std::string error) {
            attached_ = true;
            GuestEvent("attached");
            ApplyBounds();
            if (!error.empty()) failed_(std::move(error));
            if (pendingScope_) {
                auto [args, reply] = *std::exchange(pendingScope_, std::nullopt);
                const auto reject = reply;
                try { ChangeContest(args, std::move(reply)); }
                catch (const std::exception& failure) { reject(nullptr, failure.what()); }
            }
        });
    };
    try {
        guest_->Start(runtime_, data_ / L"contest", {}, false, L"", ready, fail);
    } catch (const std::exception& e) {
        fail(e.what());
    }
}

void Browser::Cleanup() {
    StopHydroSocketLease();
    bridge_.ResetNovaJudge();
    if (referenceFrame_) {
        auto frame = referenceFrame_;
        referenceFrame_ = nullptr;
        reference_.reset();
        frame->Destroy();
        frame_.Enable();
    }
}

void Browser::ResetDocument() {
    CancelRecordChecks();
    ClearDraftScript();
    draftPreparing_ = false;
    pendingScope_.reset();
    publish_ = {};
    geometry_ = {};
    request_ = 0;
    navigationId_ = 0;
    requestUrl_.clear();
    requestToken_.clear();
    fileNavigation_.clear();
    if (guest_ && guest_->core()) {
        guest_->core()->Stop();
        guest_->Navigate(L"about:blank");
    }
    ApplyBounds();
}

bool Browser::ApiAllowed(std::string_view raw) const {
    try {
        const auto url = ParseHttpUrl(raw);
        if (!hosts_.count(url.host)) return false;
        if (url.path == "/api/health") return true;
        if (scope_.External()) return url.origin == scope_.origin
            ? scope_.Allows(raw, "xhr") : url.path.rfind("/api/client/", 0) == 0;
        if (!scope_.clientOrigin.empty() && url.origin == scope_.clientOrigin) return scope_.Allows(raw, "xhr");
        if (!scope_.clientOrigin.empty() && url.host != scope_.host) return url.path.rfind("/api/client/", 0) == 0;
        if (scope_.host.empty() || url.host != scope_.host) return true;
        return scope_.Allows(raw, "xhr");
    } catch (...) { return false; }
}

bool Browser::MainRequestAllowed(std::string_view url, COREWEBVIEW2_WEB_RESOURCE_CONTEXT context) const {
    if (url.rfind("https://proctor-client.invalid/", 0) == 0) return true;
    if (url.rfind("blob:", 0) == 0 || url.rfind("data:", 0) == 0) return context != COREWEBVIEW2_WEB_RESOURCE_CONTEXT_DOCUMENT;
    if (context == COREWEBVIEW2_WEB_RESOURCE_CONTEXT_DOCUMENT) return false;
    if (context == COREWEBVIEW2_WEB_RESOURCE_CONTEXT_XML_HTTP_REQUEST || context == COREWEBVIEW2_WEB_RESOURCE_CONTEXT_FETCH) {
        return ApiAllowed(url);
    }
    return true;
}

Json Browser::SnapshotHosts(Json hosts) {
    if (!hosts.is_array()) hosts = Json::array();
    const auto now = std::chrono::steady_clock::now();
    for (auto it = referenceHosts_.begin(); it != referenceHosts_.end();) {
        if (it->second < now) it = referenceHosts_.erase(it);
        else { hosts.push_back(it->first); ++it; }
    }
    return hosts;
}

bool Browser::Handle(std::string_view channel, const Json& args, Bridge::Reply reply) {
    if (channel.rfind("browser:", 0) != 0) return false;
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
            bridge_.SetAllowedHosts(Json(hosts_));
        }
        reply(nullptr, {});
    } else if (channel == "browser:setContestScope") ChangeContest(args, std::move(reply));
    else if (channel == "browser:installNovaJudgeLogin" || channel == "browser:installHydroBrowserLogin") {
        InstallLogin(channel == "browser:installHydroBrowserLogin", args.at(0), std::move(reply));
    } else return false;
    return true;
}

void Browser::ChangeContest(const Json& args, Bridge::Reply reply) {
    if (clearing_) { reply(nullptr, "考试状态正在切换，请稍后重试"); return; }
    const auto next = MakeContestPolicy(args);
    const bool clear = next.External() || scope_.External();
    if ((!attached_ || !guest_ || !guest_->core()) && (clear || !next.origin.empty())) {
        if (pendingScope_) pendingScope_->second(nullptr, "考试状态已变化，请稍后重试");
        pendingScope_ = std::pair(args, std::move(reply));
        Start();
        return;
    }
    if (pendingScope_) {
        pendingScope_->second(nullptr, "考试状态已变化，请稍后重试");
        pendingScope_.reset();
    }
    if (draftPreparing_ || !draftScript_.empty()) CompleteNavigation("考试状态已变化，请稍后重试");
    ++generation_;
    responseFilterReady_ = false;
    StopHydroSocketLease();
    bridge_.ResetNovaJudge();
    scope_ = next;
    credential_.clear();
    sid_.clear();
    requestToken_.clear();
    fileNavigation_.clear();
    for (const auto& address : {scope_.origin, scope_.clientOrigin, scope_.backendOrigin}) {
        if (!address.empty()) hosts_.insert(ParseHttpUrl(address).host);
    }
    bridge_.SetAllowedHosts(Json(hosts_));
    if (!clear) { reply(nullptr, {}); return; }
    ComPtr<ICoreWebView2Profile> profile;
    auto view = Version<ICoreWebView2_13>(guest_->core());
    Check(view ? view->get_Profile(&profile) : E_NOINTERFACE, "WebView2 contest profile");
    ComPtr<ICoreWebView2Profile2> storage;
    Check(profile.As(&storage), "WebView2 profile storage");
    if (guest_->core()) { guest_->core()->Stop(); guest_->Navigate(L"about:blank"); }
    clearing_ = true;
    // ClearBrowsingDataCompletedHandler has no sender or argument other than HRESULT.
    struct Finished final : ICoreWebView2ClearBrowsingDataCompletedHandler {
        std::atomic<ULONG> references{1};
        std::function<void(HRESULT)> callback;
        HRESULT STDMETHODCALLTYPE QueryInterface(REFIID iid, void** value) override {
            if (!value) return E_POINTER;
            *value = nullptr;
            if (iid != __uuidof(ICoreWebView2ClearBrowsingDataCompletedHandler) && iid != IID_IUnknown) return E_NOINTERFACE;
            *value = this; AddRef(); return S_OK;
        }
        ULONG STDMETHODCALLTYPE AddRef() override { return ++references; }
        ULONG STDMETHODCALLTYPE Release() override { const auto count = --references; if (!count) delete this; return count; }
        HRESULT STDMETHODCALLTYPE Invoke(HRESULT status) override { callback(status); return S_OK; }
    };
    auto callback = new Finished;
    callback->callback = [this, weak = std::weak_ptr<bool>(alive_), current = generation_, reply](HRESULT status) {
        if (!weak.lock()) return;
        if (current != generation_) { reply(nullptr, "考试状态已变化，请稍后重试"); return; }
        if (FAILED(status)) {
            clearing_ = false;
            reply(nullptr, "清理考试 Cookie 与缓存失败");
            return;
        }
        ConfigureGuestResponseFilter([this, reply](Json value, std::string error) {
            clearing_ = false;
            reply(std::move(value), std::move(error));
        });
    };
    ComPtr<ICoreWebView2ClearBrowsingDataCompletedHandler> handler;
    handler.Attach(callback);
    // Electron cleared site state during scope changes. Keep the separate HTTP
    // disk cache warm so switching scope does not refetch all immutable assets.
    const auto status = storage->ClearBrowsingData(COREWEBVIEW2_BROWSING_DATA_KINDS_ALL_SITE, handler.Get());
    if (FAILED(status)) {
        clearing_ = false;
        reply(nullptr, "清理考试 Cookie 与缓存失败");
    }
}

void Browser::InstallLogin(bool hydro, const Json& login, Bridge::Reply reply) {
    if (!attached_ || !responseFilterReady_ || scope_.platform != (hydro ? "HYDRO_BROWSER" : "NOVAJUDGE")
        || displaying_() || locked_() || clearing_) {
        reply(nullptr, hydro ? "当前不能登录 HydroOJ" : "当前不能登录 NovaJudge"); return;
    }
    const auto token = login.is_object() && login.contains("cookie") ? Field(login["cookie"], "value") : "";
    const auto cookieName = hydro ? "sid" : "user_token";
    const auto expiration = hydro ? Expiry(Field(login, "expiresAt")) : 0.0;
    const auto key = Field(login, "proctoringKey");
    const auto home = scope_.Home();
    const auto error = hydro ? "HydroOJ 登录凭据与当前考试不匹配" : "NovaJudge 登录凭据与当前考试不匹配";
    if (Field(login, "loginUrl") != home || !login.contains("cookie") || Field(login["cookie"], "name") != cookieName
        || token.size() > 8192 || !Match(token, hydro ? R"([A-Za-z0-9_-]{16,256})" : R"([A-Za-z0-9_-]+\.[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+)")
        || (hydro && (Field(login, "platform") != "HYDRO_BROWSER" || expiration <= std::time(nullptr)))) {
        reply(nullptr, error); return;
    }
    if (!Match(key, R"([A-Za-z0-9_-]{43})") || (!hydro && Field(login, "loginSource") != "PROCTORING")) {
        reply(nullptr, hydro ? "HydroOJ 未返回监考专用访问凭据" : "NovaJudge 未返回监考专用访问凭据，请更新 NovaJudge 与监考后台"); return;
    }
    StopHydroSocketLease();
    const auto manager = CookieManager(guest_->core());
    InstallCookie(manager.Get(), ParseHttpUrl(scope_.origin), cookieName, token, "/", expiration);
    ++generation_;
    credential_ = key;
    sid_ = hydro ? token : "";
    if (hydro) {
        RefreshHydroSocketLease(std::move(reply));
        return;
    }
    bridge_.ConnectNovaJudge({scope_.origin, scope_.contestId, scope_.backendOrigin, token, key,
        login.contains("contestAccessToken") ? login["contestAccessToken"] : Json(nullptr)});
    reply(home, {});
}

void Browser::ClearCompletedChecks() {
    for (auto it = checks_.begin(); it != checks_.end();) {
        if (it->wait_for(std::chrono::seconds(0)) == std::future_status::ready) it = checks_.erase(it); else ++it;
    }
}

void Browser::RefreshHydroSocketLease(Bridge::Reply firstLogin) {
    constexpr auto unavailable = "HydroOJ 实时判题鉴权失败，请稍后重试";
    if (scope_.platform != "HYDRO_BROWSER" || clearing_ || sid_.empty() || credential_.empty()
        || !guest_ || !guest_->core()) {
        if (firstLogin) firstLogin(nullptr, unavailable);
        return;
    }
    if (hydroSocketCancel_) {
        if (firstLogin) firstLogin(nullptr, "考试状态已变化，请稍后重试");
        return;
    }
    ClearCompletedChecks();
    const auto cancel = std::make_shared<std::atomic_bool>(false);
    const auto weak = std::weak_ptr<bool>(alive_);
    const auto current = generation_;
    const auto scope = scope_;
    const auto cookie = sid_;
    const auto key = credential_;
    auto ui = wxTheApp;
    hydroSocketCancel_ = cancel;
    try {
        checks_.push_back(std::async(std::launch::async, [this, weak, cancel, current, scope, cookie, key, firstLogin, ui] {
            HydroSocketLease lease;
            try { lease = GetHydroSocketLease(scope, cookie, key, *cancel); } catch (...) {}
            ui->CallAfter([this, weak, cancel, current, scope, firstLogin, lease = std::move(lease)] {
                if (!weak.lock()) return;
                if (cancel->load() || generation_ != current || hydroSocketCancel_ != cancel) {
                    if (firstLogin) firstLogin(nullptr, "考试状态已变化，请稍后重试");
                    return;
                }
                const auto finish = [this, weak, cancel, current, scope, firstLogin, seconds = lease.expiresSeconds](bool success) {
                    if (!weak.lock()) return;
                    if (cancel->load() || generation_ != current || hydroSocketCancel_ != cancel) {
                        if (firstLogin) firstLogin(nullptr, "考试状态已变化，请稍后重试");
                        return;
                    }
                    hydroSocketCancel_.reset();
                    if (success && !(firstLogin && (displaying_() || locked_()))) {
                        hydroSocketTimer_->StartOnce(std::max(500, seconds * 1000 / 3));
                        if (firstLogin) firstLogin(scope.Home(), {});
                    } else if (firstLogin) {
                        StopHydroSocketLease();
                        firstLogin(nullptr, "HydroOJ 实时判题鉴权失败，请稍后重试");
                    } else {
                        hydroSocketTimer_->StartOnce(3000);
                    }
                };
                if (!lease.expiresSeconds || !guest_ || !guest_->core()
                    || (firstLogin && (displaying_() || locked_()))) { finish(false); return; }
                try {
                    const auto manager = CookieManager(guest_->core());
                    const auto origin = ParseHttpUrl(scope.origin);
                    for (size_t i = 0; i < hydroSocketPaths.size(); ++i) {
                        InstallCookie(manager.Get(), origin, hydroSocketCookie, lease.tokens[i], hydroSocketPaths[i]);
                    }
                    // Ensure the isolated browser store can see all cookies
                    // before allowing the first page to construct its sockets.
                    if (!firstLogin) { finish(true); return; }
                    const auto verify = On<ICoreWebView2GetCookiesCompletedHandler, HRESULT, ICoreWebView2CookieList*>(
                        [finish, lease, origin, sid = sid_](HRESULT result, ICoreWebView2CookieList* cookies) {
                            bool found = false;
                            try { found = SUCCEEDED(result) && HasHydroLeaseCookies(cookies, origin, lease, sid); } catch (...) {}
                            finish(found);
                        });
                    Check(manager->GetCookies(L"", verify.Get()), "Verify contest socket cookies");
                } catch (...) { finish(false); }
            });
        }));
    } catch (...) {
        hydroSocketCancel_.reset();
        if (firstLogin) {
            StopHydroSocketLease();
            firstLogin(nullptr, unavailable);
        } else hydroSocketTimer_->StartOnce(3000);
    }
}

void Browser::StopHydroSocketLease() {
    CancelRecordChecks();
    hydroSocketTimer_->Stop();
    if (hydroSocketCancel_) hydroSocketCancel_->store(true);
    hydroSocketCancel_.reset();
    if (scope_.platform != "HYDRO_BROWSER") return;
    const bool hadSession = !sid_.empty();
    sid_.clear();
    credential_.clear();
    if (!hadSession || !guest_ || !guest_->core()) return;
    try {
        const auto manager = CookieManager(guest_->core());
        const auto host = Wide(ParseHttpUrl(scope_.origin).host);
        for (const auto path : hydroSocketPaths) {
            manager->DeleteCookiesWithDomainAndPath(Wide(hydroSocketCookie).c_str(), host.c_str(), Wide(path).c_str());
        }
        manager->DeleteCookiesWithDomainAndPath(L"sid", host.c_str(), L"/");
    } catch (...) {}
}

void Browser::SetVisible(bool visible) {
    visible_ = visible;
    if (!visible && referenceFrame_) referenceFrame_->Hide();
    else if (visible && referenceFrame_) referenceFrame_->Show();
    ApplyBounds();
}
void Browser::NotifyPosition(bool force) { if (guest_) guest_->Resize(force); }

void Browser::ApplyBounds() {
    if (!guestWindow_) return;
    const auto hide = [this] {
        if (guestWindowVisible_) ShowWindow(guestWindow_, SW_HIDE);
        guestWindowVisible_ = false;
        if (guest_) guest_->Visible(false);
    };
    RECT bounds{};
    if (geometry_.is_array() && geometry_.size() == 2) bounds = Rectangle(geometry_[0]);
    const bool show = attached_ && visible_ && !displaying_() && !locked_()
        && bounds.right > bounds.left && bounds.bottom > bounds.top;
    if (!show) {
        hide();
        return;
    }
    const int width = bounds.right - bounds.left, height = bounds.bottom - bounds.top;
    std::vector<std::array<LONG, 4>> cuts;
    if (geometry_[1].is_array()) {
        for (const auto& obstruction : geometry_[1]) {
            const auto rectangle = Rectangle(obstruction);
            RECT cut{};
            if (IntersectRect(&cut, &bounds, &rectangle)) {
                // A full-page dialog can suspend painting without creating a
                // window region that clips the entire child WebView.
                if (EqualRect(&cut, &bounds)) { hide(); return; }
                cuts.push_back({cut.left - bounds.left, cut.top - bounds.top, cut.right - bounds.left, cut.bottom - bounds.top});
            }
        }
    }
    std::sort(cuts.begin(), cuts.end());
    cuts.erase(std::unique(cuts.begin(), cuts.end()), cuts.end());
    const auto previousWidth = appliedBounds_.right - appliedBounds_.left;
    const auto previousHeight = appliedBounds_.bottom - appliedBounds_.top;
    if ((!guestWindowVisible_ || !EqualRect(&appliedBounds_, &bounds)) &&
        SetWindowPos(guestWindow_, HWND_TOP, bounds.left, bounds.top, width, height, SWP_NOACTIVATE)) {
        appliedBounds_ = bounds;
    }
    const bool clipped = !cuts.empty();
    if (cuts != appliedCuts_ || (clipped && (previousWidth != width || previousHeight != height))) {
        auto region = cuts.empty() ? nullptr : CreateRectRgn(0, 0, width, height);
        for (const auto& cut : cuts) {
            if (!region) break;
            auto clipped = CreateRectRgn(cut[0], cut[1], cut[2], cut[3]);
            if (clipped) { CombineRgn(region, region, clipped, RGN_DIFF); DeleteObject(clipped); }
        }
        if ((region || !clipped) && SetWindowRgn(guestWindow_, region, TRUE)) appliedCuts_ = std::move(cuts);
        else if (region) DeleteObject(region);
    }
    if (!guestWindowVisible_) ShowWindow(guestWindow_, SW_SHOWNA);
    guestWindowVisible_ = true;
    if (guest_) { guest_->Resize(); guest_->Visible(true); }
}

void Browser::GuestEvent(std::string_view event, std::string url, int error, bool main) {
    if (!publish_) return;
    BOOL forward = FALSE;
    if (guest_ && guest_->core()) guest_->core()->get_CanGoForward(&forward);
    publish_({{"guest", "event"}, {"event", event}, {"url", url}, {"canGoForward", forward != FALSE},
        {"errorCode", error}, {"isMainFrame", main}});
}
void Browser::GuestReply(std::uint64_t request, Json value, std::string error) {
    if (request && publish_) publish_({{"guest", "reply"}, {"request", request}, {"value", std::move(value)}, {"error", std::move(error)}});
}

void Browser::CompleteNavigation(std::string error) {
    ClearDraftScript();
    draftPreparing_ = false;
    const auto request = std::exchange(request_, 0);
    navigationId_ = 0;
    if (!error.empty()) {
        requestUrl_.clear();
        requestToken_.clear();
    }
    GuestReply(request, nullptr, std::move(error));
}

void Browser::GuestMessage(const Json& message, std::function<void(const Json&)> publish) {
    const auto action = Field(message, "guest");
    const auto request = message.value("request", std::uint64_t{});
    const auto& args = message.at("args");
    publish_ = std::move(publish);
    try {
        if (action == "attach") { if (attached_) GuestEvent("attached"); return; }
        if (action == "bounds") { geometry_ = args; ApplyBounds(); return; }
        if (!attached_ || !guest_ || !guest_->core()) throw std::runtime_error("考试页面容器尚未准备完成");
        auto core = guest_->core();
        if (action == "load") { Navigate(StringAt(args, 0), request, args.size() > 1 ? args[1] : Json::object()); return; }
        if (action == "forward") Check(core->GoForward(), "WebView2 GoForward");
        else if (action == "reload") Check(core->Reload(), "WebView2 Reload");
        else if (action == "stop") { core->Stop(); CompleteNavigation("考试页面加载已取消"); }
        else if (action == "zoom") guest_->controller()->put_ZoomFactor(std::clamp(args[0].get<double>(), 0.5, 2.0));
        else if (action == "focus") guest_->Focus();
        else if (action == "script") {
            if (StringAt(args, 0) != "Boolean(document.querySelector('input[name=\"password\"]'))") throw std::runtime_error("不允许的页面调用");
            const auto generation = generation_;
            auto callback = On<ICoreWebView2ExecuteScriptCompletedHandler, HRESULT, LPCWSTR>(
                [this, weak = std::weak_ptr<bool>(alive_), request, generation](HRESULT status, LPCWSTR value) {
                    if (!weak.lock() || generation_ != generation) return;
                    GuestReply(request, value && std::wstring_view(value) == L"true", FAILED(status) ? "考试页面调用失败" : "");
                });
            Check(core->ExecuteScript(Wide(StringAt(args, 0)).c_str(), callback.Get()), "WebView2 guest script");
            return;
        } else throw std::runtime_error("未知的考试页面操作");
        GuestReply(request);
    } catch (const std::exception& e) {
        if (request && request_ == request) CompleteNavigation(e.what());
        else GuestReply(request, nullptr, e.what());
    }
}

void Browser::Navigate(std::string raw, std::uint64_t request, const Json& options) {
    if (raw != "about:blank" && (!scope_.Allows(raw, "mainFrame") || displaying_() || locked_()
        || clearing_ || (scope_.External() && !responseFilterReady_))) {
        throw std::runtime_error("当前不允许访问该地址：" + raw);
    }
    CompleteNavigation("考试页面加载已取消");
    request_ = request;
    const auto extra = Field(options, "extraHeaders");
    static const std::regex tokenPattern(R"((?:^|\r\n)X-Proctor-Session-Token: ([^\r\n]{1,8192})(?:\r\n|$))");
    std::smatch match;
    if (!scope_.External() && !scope_.clientOrigin.empty() && raw != "about:blank"
        && ParseHttpUrl(raw).origin == scope_.clientOrigin && std::regex_search(extra, match, tokenPattern)) {
        requestUrl_ = ParseHttpUrl(raw).Url();
        requestToken_ = match[1].str();
    }
    if (draftReader_ && request && !requestToken_.empty()) {
        if (auto target = LegacyDraftTargetFor(scope_, raw, options)) {
            const auto attempt = target->backend + "\n" + target->origin + "\n" + target->sessionId;
            if (draftAttempts_.insert(attempt).second) {
                NavigateWithDrafts(std::move(raw), request, std::move(*target));
                return;
            }
        }
    }
    guest_->Navigate(Wide(raw));
}

void Browser::NavigateWithDrafts(std::string raw, std::uint64_t request, LegacyDraftTarget target) {
    draftPreparing_ = true;
    const auto current = [this, alive = std::weak_ptr<bool>(alive_), generation = generation_, request] {
        return !alive.expired() && generation == generation_ && request_ == request;
    };
    const auto view = std::weak_ptr<WebView>(guest_);
    const auto load = [this, current, view, raw = std::move(raw)](std::wstring scriptId) {
        const auto guest = view.lock();
        if (!guest || !guest->core()) return;
        if (!current() || displaying_() || locked_()) {
            if (!scriptId.empty()) guest->core()->RemoveScriptToExecuteOnDocumentCreated(scriptId.c_str());
            if (current()) CompleteNavigation("当前考试页面暂不可用");
            return;
        }
        draftPreparing_ = false;
        draftScript_ = std::move(scriptId);
        try { guest->Navigate(Wide(raw)); }
        catch (const std::exception& error) { CompleteNavigation(error.what()); }
    };
    auto lookup = target;
    target.token.clear();
    draftReader_(std::move(lookup), [current, view, load, target = std::move(target)](Json result) {
        if (!current()) return;
        const auto guest = view.lock();
        if (!guest || !guest->core()) return;
        try {
            const auto script = LegacyDraftInstallScript(target, result);
            if (!script.empty()) {
                auto registered = On<ICoreWebView2AddScriptToExecuteOnDocumentCreatedCompletedHandler, HRESULT, LPCWSTR>(
                    [load](HRESULT status, LPCWSTR scriptId) {
                        load(SUCCEEDED(status) && scriptId ? scriptId : L"");
                    });
                if (SUCCEEDED(guest->core()->AddScriptToExecuteOnDocumentCreated(Wide(script).c_str(), registered.Get()))) return;
            }
        } catch (...) { /* Migration cannot prevent the original navigation. */ }
        load({});
    });
}

void Browser::ClearDraftScript() {
    if (draftScript_.empty()) return;
    if (guest_ && guest_->core()) guest_->core()->RemoveScriptToExecuteOnDocumentCreated(draftScript_.c_str());
    draftScript_.clear();
}

bool Browser::Key(ICoreWebView2AcceleratorKeyPressedEventArgs* args, bool reference) const {
    if (displaying_()) return true;
    COREWEBVIEW2_KEY_EVENT_KIND kind{};
    UINT key = 0;
    args->get_KeyEventKind(&kind);
    args->get_VirtualKey(&key);
    if (kind != COREWEBVIEW2_KEY_EVENT_KIND_KEY_DOWN && kind != COREWEBVIEW2_KEY_EVENT_KIND_SYSTEM_KEY_DOWN) return false;
    const bool control = (GetKeyState(VK_CONTROL) & 0x8000) != 0;
    const bool shift = (GetKeyState(VK_SHIFT) & 0x8000) != 0;
    COREWEBVIEW2_PHYSICAL_KEY_STATUS status{};
    args->get_PhysicalKeyStatus(&status);
    if (key == VK_F12 || (control && shift && (key == 'I' || key == 'J' || key == 'C'))) return true;
    if (reference) return false;
    if (key == VK_F5 || (control && key == 'R')) { bridge_.Push("browser:refresh-shortcut"); return true; }
    return key == VK_F11 || (control && (key == 'W' || key == 'Q'))
        || (status.IsMenuKeyDown && (key == VK_F4 || key == VK_LEFT || key == VK_RIGHT || key == VK_SPACE));
}

void Browser::BlockResource(ICoreWebView2WebResourceRequestedEventArgs* args) {
    DenyResource(guest_->environment(), args);
}

void Browser::ApplyResource(ICoreWebView2WebResourceRequestedEventArgs* args) {
    ComPtr<ICoreWebView2WebResourceRequest> request;
    args->get_Request(&request);
    LPWSTR raw = nullptr;
    if (!request || FAILED(request->get_Uri(&raw))) { BlockResource(args); return; }
    const auto url = Utf8(TakeString(raw));
    if (url == "about:blank") return;
    COREWEBVIEW2_WEB_RESOURCE_CONTEXT context{};
    args->get_ResourceContext(&context);
    const auto type = ResourceType(context);
    if (clearing_ || (scope_.External() && !responseFilterReady_)) {
        BlockResource(args); return;
    }
    LPWSTR method = nullptr;
    if (FAILED(request->get_Method(&method))) { BlockResource(args); return; }
    // WebView2 reports child and top documents identically here. The separate
    // NavigationStarting hook still checks every top-level navigation.
    const auto documentType = scope_.platform == "HYDRO_BROWSER" && context == COREWEBVIEW2_WEB_RESOURCE_CONTEXT_DOCUMENT
        ? "subFrame" : type;
    const auto resource = scope_.InspectResource(url, documentType, Utf8(TakeString(method)));
    if (!resource.allowed && !(resource.target && url == fileNavigation_ && scope_.IsFile(url))) {
        BlockResource(args); return;
    }
    if (!resource.target) return; // Blob and data resources do not send HTTP headers.
    const auto& parsed = *resource.target;
    ComPtr<ICoreWebView2HttpRequestHeaders> headers;
    if (FAILED(request->get_Headers(&headers)) || !headers) { BlockResource(args); return; }
    headers->RemoveHeader(hydroRequestHeader);
    headers->RemoveHeader(novaRequestHeader);
    headers->RemoveHeader(L"X-Proctor-Session-Token");
    if (!credential_.empty() && parsed.origin == scope_.origin && scope_.External()) {
        headers->SetHeader(scope_.platform == "HYDRO_BROWSER" ? hydroRequestHeader : novaRequestHeader, Wide(credential_).c_str());
    }
    if (!requestToken_.empty() && type == "mainFrame" && parsed.origin == scope_.clientOrigin && parsed.Url() == requestUrl_) {
        headers->SetHeader(L"X-Proctor-Client", L"desktop");
        headers->SetHeader(L"X-Proctor-Session-Token", Wide(requestToken_).c_str());
    }

    const auto record = scope_.RecordId(parsed);
    if (record.empty()) return;
    if (sid_.empty() || credential_.empty()) { BlockResource(args); return; }
    ComPtr<ICoreWebView2Deferral> deferral;
    if (FAILED(args->GetDeferral(&deferral))) { BlockResource(args); return; }
    const RecordRequest requestToCheck{ComPtr<ICoreWebView2WebResourceRequestedEventArgs>(args), deferral};
    const auto reject = [&] { BlockResource(args); deferral->Complete(); };
    if (const auto active = recordChecks_.find(record); active != recordChecks_.end()) {
        if (active->second.requests.size() >= 32) {
            reject();
        } else {
            try { active->second.requests.push_back(requestToCheck); }
            catch (...) { reject(); }
        }
        return;
    }
    ClearCompletedChecks();
    if (checks_.size() >= 12 || recordChecks_.size() >= 12) { reject(); return; }
    try {
        auto cancellation = std::make_shared<std::atomic_bool>(false);
        recordChecks_.emplace(record, RecordCheck{ComPtr<ICoreWebView2Environment>(guest_->environment()), cancellation, {requestToCheck}});
        const auto path = scope_.origin + scope_.basePath + "/record/" + record;
        const auto contest = scope_.contestId;
        const auto cookie = sid_;
        const auto key = credential_;
        const auto weak = std::weak_ptr<bool>(alive_);
        auto ui = wxTheApp;
        checks_.reserve(checks_.size() + 1);
        checks_.push_back(std::async(std::launch::async, [this, weak, record, path, contest, cookie, key, ui, cancellation] {
            bool allowed = false;
            try {
                const auto response = RequestHttp(path, "GET", {{"Accept", "application/json"}, {"Cookie", "sid=" + cookie},
                    {hydroHeader, key}}, {}, 8000, 4 * 1024 * 1024, true, cancellation.get());
                const auto body = Json::parse(response.body, nullptr, false);
                allowed = response.status == 200 && body.is_object() && body.contains("rdoc") && Field(body["rdoc"], "contest") == contest;
            } catch (...) {}
            if (!cancellation->load()) ui->CallAfter([this, weak, record, allowed, cancellation] {
                if (weak.lock() && !cancellation->load()) CompleteRecordCheck(record, allowed);
            });
        }));
    } catch (...) {
        if (recordChecks_.contains(record)) CompleteRecordCheck(record, false);
        else reject();
    }
}

void Browser::CompleteRecordCheck(const std::string& record, bool allowed) {
    auto pending = recordChecks_.extract(record);
    if (pending.empty()) return;
    auto& check = pending.mapped();
    for (auto& request : check.requests) {
        if (!allowed) DenyResource(check.environment.Get(), request.args.Get());
        request.deferral->Complete();
    }
}

void Browser::CancelRecordChecks() {
    for (auto& [_, check] : recordChecks_) check.cancelled->store(true);
    while (!recordChecks_.empty()) {
        const auto record = recordChecks_.begin()->first;
        CompleteRecordCheck(record, false);
    }
}

void Browser::Configure() {
    const auto core = guest_->core();
    const auto target = std::weak_ptr<WebView>(guest_);
    EventRegistrationToken event{};
    auto navigation = On<ICoreWebView2NavigationStartingEventHandler, ICoreWebView2*, ICoreWebView2NavigationStartingEventArgs*>(
        [this](ICoreWebView2*, ICoreWebView2NavigationStartingEventArgs* args) {
            LPWSTR raw = nullptr;
            args->get_Uri(&raw);
            const auto url = Utf8(TakeString(raw));
            UINT64 id = 0;
            BOOL redirect = FALSE, user = FALSE;
            args->get_NavigationId(&id);
            args->get_IsRedirected(&redirect);
            args->get_IsUserInitiated(&user);
            if (url == "about:blank" || (!clearing_ && (!scope_.External() || responseFilterReady_) && !displaying_() && !locked_()
                && (scope_.Allows(url, "mainFrame") || (url == fileNavigation_ && scope_.IsFile(url))))) {
                if (!draftPreparing_ && request_ && !navigationId_) navigationId_ = id;
                return;
            }
            args->put_Cancel(TRUE);
            if (request_ && (!navigationId_ || navigationId_ == id)) {
                CompleteNavigation("当前不允许访问该地址：" + url);
            } else if (user && !redirect && scope_.IsFile(url)) {
                wxTheApp->CallAfter([this, weak = std::weak_ptr<bool>(alive_), url] {
                    if (!weak.lock() || !scope_.IsFile(url) || displaying_() || locked_()) return;
                    fileNavigation_ = url;
                    guest_->Navigate(Wide(url));
                });
                return;
            } else if (user && !redirect && !scope_.External()) {
                wxTheApp->CallAfter([this, weak = std::weak_ptr<bool>(alive_), url] {
                    if (weak.lock()) OpenReference(url);
                });
            }
            GuestEvent("will-navigate", url);
        });
    Check(core->add_NavigationStarting(navigation.Get(), &event), "Contest navigation");
    auto frame = On<ICoreWebView2NavigationStartingEventHandler, ICoreWebView2*, ICoreWebView2NavigationStartingEventArgs*>(
        [this](ICoreWebView2*, ICoreWebView2NavigationStartingEventArgs* args) {
            LPWSTR raw = nullptr;
            args->get_Uri(&raw);
            const auto url = Utf8(TakeString(raw));
            if (url != "about:blank" && (clearing_ || !scope_.Allows(url, "subFrame"))) {
                args->put_Cancel(TRUE);
                GuestEvent("will-frame-navigate", url, 0, false);
            }
        });
    Check(core->add_FrameNavigationStarting(frame.Get(), &event), "Contest frame navigation");
    auto completed = On<ICoreWebView2NavigationCompletedEventHandler, ICoreWebView2*, ICoreWebView2NavigationCompletedEventArgs*>(
        [this, target](ICoreWebView2* sender, ICoreWebView2NavigationCompletedEventArgs* args) {
            if (target.lock() != guest_) return;
            BOOL ok = FALSE;
            UINT64 id = 0;
            COREWEBVIEW2_WEB_ERROR_STATUS code = noError;
            args->get_IsSuccess(&ok);
            args->get_NavigationId(&id);
            args->get_WebErrorStatus(&code);
            url_ = Source(sender);
            if (request_ && id == navigationId_) {
                CompleteNavigation(ok ? "" : "考试页面加载失败 (" + std::to_string(code) + ")");
            }
            if (ok) GuestEvent("did-navigate", url_);
            else GuestEvent("did-fail-load", url_, code == COREWEBVIEW2_WEB_ERROR_STATUS_OPERATION_CANCELED ? -3 : -2);
        });
    Check(core->add_NavigationCompleted(completed.Get(), &event), "Contest navigation completion");
    auto sourceChanged = On<ICoreWebView2SourceChangedEventHandler, ICoreWebView2*, ICoreWebView2SourceChangedEventArgs*>(
        [this](ICoreWebView2* sender, ICoreWebView2SourceChangedEventArgs* args) {
            BOOL newDocument = TRUE;
            args->get_IsNewDocument(&newDocument);
            if (newDocument) return;
            const auto url = Source(sender);
            if (url != "about:blank" && !scope_.Allows(url, "mainFrame")) {
                GuestEvent("will-navigate", url);
                const auto prior = Wide(url_);
                wxTheApp->CallAfter([this, weak = std::weak_ptr<bool>(alive_), prior] {
                    if (weak.lock() && guest_ && guest_->core()) guest_->Navigate(prior);
                });
                return;
            }
            url_ = url;
            GuestEvent("did-navigate-in-page", url_);
        });
    Check(core->add_SourceChanged(sourceChanged.Get(), &event), "Contest in-page navigation");
    auto dom = On<ICoreWebView2DOMContentLoadedEventHandler, ICoreWebView2*, ICoreWebView2DOMContentLoadedEventArgs*>(
        [this](ICoreWebView2* sender, ICoreWebView2DOMContentLoadedEventArgs*) { GuestEvent("dom-ready", Source(sender)); });
    auto v2 = Version<ICoreWebView2_2>(core);
    Check(v2 ? v2->add_DOMContentLoaded(dom.Get(), &event) : E_NOINTERFACE, "Contest DOM ready");

    auto popup = On<ICoreWebView2NewWindowRequestedEventHandler, ICoreWebView2*, ICoreWebView2NewWindowRequestedEventArgs*>(
        [this](ICoreWebView2*, ICoreWebView2NewWindowRequestedEventArgs* args) {
            args->put_Handled(TRUE);
            LPWSTR raw = nullptr;
            args->get_Uri(&raw);
            const auto url = Utf8(TakeString(raw));
            wxTheApp->CallAfter([this, weak = std::weak_ptr<bool>(alive_), url] {
                if (!weak.lock() || displaying_() || locked_()) return;
                if (scope_.External()) {
                    if (scope_.IsFile(url) && !scope_.IsInlinePdf(url)) {
                        fileNavigation_ = url;
                        guest_->Navigate(Wide(url));
                    } else if (scope_.Allows(url, "mainFrame")) Navigate(url, 0, Json::object());
                } else OpenReference(url);
            });
        });
    Check(core->add_NewWindowRequested(popup.Get(), &event), "Contest popup policy");
    auto permission = On<ICoreWebView2PermissionRequestedEventHandler, ICoreWebView2*, ICoreWebView2PermissionRequestedEventArgs*>(
        [](ICoreWebView2*, ICoreWebView2PermissionRequestedEventArgs* args) { args->put_State(COREWEBVIEW2_PERMISSION_STATE_DENY); });
    Check(core->add_PermissionRequested(permission.Get(), &event), "Contest permission policy");
    InstallTextEditingMenu(core, [this] { return !locked_() && !displaying_() && !clearing_ && guestWindowVisible_; });
    auto resource = On<ICoreWebView2WebResourceRequestedEventHandler, ICoreWebView2*, ICoreWebView2WebResourceRequestedEventArgs*>(
        [this](ICoreWebView2*, ICoreWebView2WebResourceRequestedEventArgs* args) {
            try { ApplyResource(args); } catch (...) { BlockResource(args); }
        });
    Check(core->AddWebResourceRequestedFilter(L"*", COREWEBVIEW2_WEB_RESOURCE_CONTEXT_ALL), "Contest request filter");
    Check(core->add_WebResourceRequested(resource.Get(), &event), "Contest request policy");
    // Requests served by a page's service worker bypass the ordinary request
    // event in this SDK. Always direct page fetches through the network.
    const auto ignored = IgnoreCdp();
    core->CallDevToolsProtocolMethod(L"Network.setBypassServiceWorker", LR"({"bypass":true})", ignored.Get());
    InstallGuard(guest_->controller(), [this](auto args) { return Key(args); });
    FilterResponses(guest_);
    ConfigureDownloads(guest_);

    auto failed = On<ICoreWebView2ProcessFailedEventHandler, ICoreWebView2*, ICoreWebView2ProcessFailedEventArgs*>(
        [this, target](ICoreWebView2*, ICoreWebView2ProcessFailedEventArgs* args) {
            COREWEBVIEW2_PROCESS_FAILED_KIND kind{};
            if (FAILED(args->get_ProcessFailedKind(&kind)) ||
                (kind != COREWEBVIEW2_PROCESS_FAILED_KIND_RENDER_PROCESS_EXITED && kind != COREWEBVIEW2_PROCESS_FAILED_KIND_BROWSER_PROCESS_EXITED)) return;
            wxTheApp->CallAfter([this, weak = std::weak_ptr<bool>(alive_), target, kind] {
                const auto view = target.lock();
                if (!weak.lock() || !view || view != guest_) return;
                CancelRecordChecks();
                CompleteNavigation("考试页面进程异常，正在等待重连");
                if (kind == COREWEBVIEW2_PROCESS_FAILED_KIND_BROWSER_PROCESS_EXITED) {
                    if (clearing_) {
                        ++generation_;
                        clearing_ = false;
                    }
                    attached_ = false;
                    view->Close();
                    guest_.reset();
                    ApplyBounds();
                    Start();
                }
                GuestEvent("did-fail-load", url_, -2);
            });
        });
    Check(core->add_ProcessFailed(failed.Get(), &event), "Contest renderer recovery");
}

void Browser::ConfigureGuestResponseFilter(Bridge::Reply reply) {
    const auto active = scope_.External();
    if (!active && !responseFilterActive_) { reply(nullptr, {}); return; }
    Json patterns = Json::array();
    if (active) {
        const auto pattern = scope_.origin + "/*";
        if (scope_.platform == "HYDRO_BROWSER") patterns.push_back({{"urlPattern", pattern}, {"requestStage", "Response"}});
        else for (const auto* type : {"Document", "Script", "Other"}) {
            patterns.push_back({{"urlPattern", pattern}, {"requestStage", "Response"}, {"resourceType", type}});
        }
    }
    const auto finished = On<ICoreWebView2CallDevToolsProtocolMethodCompletedHandler, HRESULT, LPCWSTR>(
        [this, target = std::weak_ptr<WebView>(guest_), life = std::weak_ptr<bool>(alive_), reply, active](HRESULT status, LPCWSTR) {
            if (!life.lock()) return;
            if (target.lock() != guest_) { reply(nullptr, "考试页面容器已变化"); return; }
            if (FAILED(status)) { reply(nullptr, "考试页面响应限制未能启动"); return; }
            responseFilterActive_ = active;
            responseFilterReady_ = active;
            reply(nullptr, {});
        });
    const auto json = active ? Wide(Json{{"patterns", patterns}}.dump()) : L"{}";
    if (FAILED(guest_->core()->CallDevToolsProtocolMethod(active ? L"Fetch.enable" : L"Fetch.disable", json.c_str(), finished.Get()))) {
        reply(nullptr, "考试页面响应限制未能启动");
    }
}

void Browser::FilterResponses(const std::shared_ptr<WebView>& view, const std::string& reference, bool file) {
    // The SDK's ordinary response event is observational. CDP response-stage
    // interception is available in Chromium 109 and keeps the browser's body,
    // streaming, redirect and download handling unchanged.
    ComPtr<ICoreWebView2DevToolsProtocolEventReceiver> receiver;
    auto core = view->core();
    Check(core->GetDevToolsProtocolEventReceiver(L"Fetch.requestPaused", &receiver), "Response filter receiver");
    auto resumed = On<ICoreWebView2DevToolsProtocolEventReceivedEventHandler, ICoreWebView2*, ICoreWebView2DevToolsProtocolEventReceivedEventArgs*>(
        [this, reference, file](ICoreWebView2* sender, ICoreWebView2DevToolsProtocolEventReceivedEventArgs* args) {
            LPWSTR raw = nullptr;
            if (FAILED(args->get_ParameterObjectAsJson(&raw))) return;
            const auto event = Json::parse(Utf8(TakeString(raw)), nullptr, false);
            if (!event.is_object()) return;
            const auto requestId = Field(event, "requestId");
            if (requestId.empty()) return;
            Json parameters = {{"requestId", requestId}};
            const auto callback = IgnoreCdp();
            if (!event.contains("responseStatusCode") || !event["responseStatusCode"].is_number_integer()) {
                sender->CallDevToolsProtocolMethod(L"Fetch.continueRequest", Wide(parameters.dump()).c_str(), callback.Get());
                return;
            }
            const auto responseCode = event["responseStatusCode"].get<int>();
            const auto address = event.contains("request") ? Field(event["request"], "url") : "";
            bool restrictedJudge = false;
            try {
                restrictedJudge = reference.empty() && scope_.External() && ParseHttpUrl(address).origin == scope_.origin;
            } catch (...) {}
            const bool stripSession = restrictedJudge && scope_.platform == "HYDRO_BROWSER";
            bool forceAttachment = responseCode >= 200 && responseCode < 300 && Field(event, "resourceType") == "Document"
                && (file || (!fileNavigation_.empty() && address == fileNavigation_));
            bool changed = false;
            Json headers = Json::array();
            if (event.contains("responseHeaders") && event["responseHeaders"].is_array()) {
                for (const auto& header : event["responseHeaders"]) {
                    std::string name = Field(header, "name"), value = Field(header, "value");
                    std::transform(name.begin(), name.end(), name.begin(), [](unsigned char c) { return static_cast<char>(std::tolower(c)); });
                    if (stripSession && name == "set-cookie" && (_strnicmp(value.c_str(), "sid=", 4) == 0
                        || _strnicmp(value.c_str(), "proctor_ws=", 11) == 0)) {
                        changed = true;
                        continue;
                    }
                    if (name == "content-disposition") {
                        if (value.size() >= 10 && _strnicmp(value.c_str(), "attachment", 10) == 0) forceAttachment = false;
                        else if (forceAttachment) continue;
                    }
                    headers.push_back(header);
                }
            }
            if (forceAttachment) {
                headers.push_back({{"name", "Content-Disposition"}, {"value", "attachment"}});
                changed = true;
            }
            const auto resourceType = Field(event, "resourceType");
            if (responseCode >= 200 && responseCode < 300 && !forceAttachment
                && (resourceType == "Document" || resourceType == "Script" || resourceType == "Other")
                && (restrictedJudge || !reference.empty())) {
                // Chromium 109 does not report WebSocket handshakes to the host's
                // resource filter. Intersect the judge's CSP with the socket
                // paths the old guest permitted; HTTP keeps its native checks.
                std::string policy = "connect-src http: https:";
                if (restrictedJudge) {
                    policy = "connect-src " + scope_.origin + " data: blob:";
                    const auto origin = ParseHttpUrl(scope_.origin);
                    const auto wsOrigin = std::string(origin.secure ? "wss" : "ws") + origin.origin.substr(origin.secure ? 5 : 4);
                    if (stripSession) for (const auto route : hydroSocketPaths) policy += " " + wsOrigin + route;
                    else policy += " " + wsOrigin;
                }
                headers.push_back({{"name", "Content-Security-Policy"}, {"value", policy}});
                changed = true;
            }
            if (changed) {
                parameters["responseCode"] = responseCode;
                parameters["responseHeaders"] = std::move(headers);
            }
            sender->CallDevToolsProtocolMethod(L"Fetch.continueResponse", Wide(parameters.dump()).c_str(), callback.Get());
        });
    EventRegistrationToken token{};
    Check(receiver->add_DevToolsProtocolEventReceived(resumed.Get(), &token), "Response filter handler");
    if (!reference.empty()) {
        Json patterns = Json::array({{{"requestStage", "Response"}, {"resourceType", "Document"}}});
        if (!file) for (const auto* type : {"Script", "Other"}) {
            patterns.push_back({{"requestStage", "Response"}, {"resourceType", type}});
        }
        const auto parameters = Wide(Json{{"patterns", patterns}}.dump());
        const auto ignored = IgnoreCdp();
        Check(core->CallDevToolsProtocolMethod(L"Fetch.enable", parameters.c_str(), ignored.Get()), "Response filter");
    }
}

void Browser::ConfigureDownloads(const std::shared_ptr<WebView>& view, const std::string& reference, bool file) {
    EventRegistrationToken event{};
    auto v4 = Version<ICoreWebView2_4>(view->core());
    auto download = On<ICoreWebView2DownloadStartingEventHandler, ICoreWebView2*, ICoreWebView2DownloadStartingEventArgs*>(
        [this, weak = std::weak_ptr<WebView>(view), reference, file](ICoreWebView2*, ICoreWebView2DownloadStartingEventArgs* args) {
            args->put_Handled(TRUE);
            ComPtr<ICoreWebView2DownloadOperation> operation;
            args->get_DownloadOperation(&operation);
            LPWSTR raw = nullptr;
            if (operation) operation->get_Uri(&raw);
            const auto url = Utf8(TakeString(raw));
            bool permitted = false;
            try {
                permitted = reference.empty() ? scope_.AllowsDownload(url_, url)
                    : (file || ReferenceTarget(url) == reference);
                if (!reference.empty() && permitted) ParseHttpUrl(url);
            } catch (...) { permitted = false; }
            if (!permitted || displaying_() || locked_()) { args->put_Cancel(TRUE); return; }
            LPWSTR path = nullptr;
            args->get_ResultFilePath(&path);
            const auto name = DownloadName(Utf8(fs::path(TakeString(path)).filename().wstring()));
            ComPtr<ICoreWebView2Deferral> deferred;
            if (FAILED(args->GetDeferral(&deferred))) { args->put_Cancel(TRUE); return; }
            ComPtr<ICoreWebView2DownloadStartingEventArgs> held(args);
            wxTheApp->CallAfter([this, life = std::weak_ptr<bool>(alive_), weak, held, deferred, name, reference] {
                const auto view = weak.lock();
                if (!life.lock() || !view || displaying_() || locked_()) {
                    held->put_Cancel(TRUE);
                } else {
                    wxFileDialog dialog(reference.empty() ? &frame_ : referenceFrame_, L"保存考试文件",
                        DownloadDirectory().wstring(), Wide(name), L"*.*", wxFD_SAVE | wxFD_OVERWRITE_PROMPT);
                    if (dialog.ShowModal() == wxID_OK && !displaying_() && !locked_()) held->put_ResultFilePath(dialog.GetPath().wc_str());
                    else held->put_Cancel(TRUE);
                }
                deferred->Complete();
            });
            if (!reference.empty() && operation) {
                auto changed = On<ICoreWebView2StateChangedEventHandler, ICoreWebView2DownloadOperation*, IUnknown*>(
                    [this, weak, life = std::weak_ptr<bool>(alive_)](ICoreWebView2DownloadOperation* op, IUnknown*) {
                        COREWEBVIEW2_DOWNLOAD_STATE state{};
                        if (FAILED(op->get_State(&state)) || state == COREWEBVIEW2_DOWNLOAD_STATE_IN_PROGRESS) return;
                        wxTheApp->CallAfter([this, weak, life] {
                            if (life.lock() && weak.lock() && referenceFrame_) referenceFrame_->Close();
                        });
                    });
                EventRegistrationToken token{};
                operation->add_StateChanged(changed.Get(), &token);
            }
        });
    Check(v4 ? v4->add_DownloadStarting(download.Get(), &event) : E_NOINTERFACE, "Contest download policy");
}

void Browser::OpenReference(std::string raw) {
    if (scope_.External() || displaying_() || locked_() || referenceFrame_) return;
    std::string reference;
    try { reference = ReferenceTarget(raw); } catch (...) { return; }
    const bool file = ReferenceFile(reference);
    auto frame = new wxFrame(&frame_, wxID_ANY, L"链接预览（仅允许访问当前链接）", wxDefaultPosition,
        frame_.FromDIP(wxSize(1080, 760)), wxDEFAULT_FRAME_STYLE | wxFRAME_FLOAT_ON_PARENT);
    frame->SetMinSize(frame->FromDIP(wxSize(720, 520)));
    frame->SetIcons(frame_.GetIcons());
    frame->CentreOnParent();
    referenceFrame_ = frame;
    reference_ = std::make_shared<WebView>(reinterpret_cast<HWND>(frame->GetHandle()));
    const auto profile = data_ / L"references" / (std::to_wstring(GetCurrentProcessId()) + L"-" + std::to_wstring(GetTickCount64()));
    frame->Bind(wxEVT_CLOSE_WINDOW, [this, frame](wxCloseEvent&) {
        if (referenceFrame_ != frame) return;
        reference_.reset();
        referenceFrame_ = nullptr;
        frame->Destroy();
        frame_.Enable();
        frame_.Raise();
    });
    frame->Bind(wxEVT_SIZE, [this](wxSizeEvent& event) { if (reference_) reference_->Resize(); event.Skip(); });
    frame->Bind(wxEVT_MOVE, [this](wxMoveEvent& event) { if (reference_) reference_->Resize(); event.Skip(); });
    reference_->Start(runtime_, profile, {}, false, L"", [this, frame, reference, file] {
        const auto core = reference_->core();
        EventRegistrationToken event{};
        auto navigate = On<ICoreWebView2NavigationStartingEventHandler, ICoreWebView2*, ICoreWebView2NavigationStartingEventArgs*>(
            [this, reference, file](ICoreWebView2*, ICoreWebView2NavigationStartingEventArgs* args) {
                LPWSTR raw = nullptr;
                args->get_Uri(&raw);
                try {
                    const auto next = ReferenceTarget(Utf8(TakeString(raw)));
                    BOOL redirect = FALSE;
                    args->get_IsRedirected(&redirect);
                    if (!displaying_() && (next == reference || (file && redirect))) return;
                } catch (...) {}
                args->put_Cancel(TRUE);
            });
        Check(core->add_NavigationStarting(navigate.Get(), &event), "Reference navigation");
        auto denyFrame = On<ICoreWebView2NavigationStartingEventHandler, ICoreWebView2*, ICoreWebView2NavigationStartingEventArgs*>(
            [](ICoreWebView2*, ICoreWebView2NavigationStartingEventArgs* args) { args->put_Cancel(TRUE); });
        Check(core->add_FrameNavigationStarting(denyFrame.Get(), &event), "Reference frame policy");
        auto popup = On<ICoreWebView2NewWindowRequestedEventHandler, ICoreWebView2*, ICoreWebView2NewWindowRequestedEventArgs*>(
            [](ICoreWebView2*, ICoreWebView2NewWindowRequestedEventArgs* args) { args->put_Handled(TRUE); });
        Check(core->add_NewWindowRequested(popup.Get(), &event), "Reference popup policy");
        auto permission = On<ICoreWebView2PermissionRequestedEventHandler, ICoreWebView2*, ICoreWebView2PermissionRequestedEventArgs*>(
            [](ICoreWebView2*, ICoreWebView2PermissionRequestedEventArgs* args) { args->put_State(COREWEBVIEW2_PERMISSION_STATE_DENY); });
        Check(core->add_PermissionRequested(permission.Get(), &event), "Reference permission policy");
        InstallTextEditingMenu(core, [this] { return !locked_() && !displaying_(); });
        auto resource = On<ICoreWebView2WebResourceRequestedEventHandler, ICoreWebView2*, ICoreWebView2WebResourceRequestedEventArgs*>(
            [this, reference, file](ICoreWebView2*, ICoreWebView2WebResourceRequestedEventArgs* args) {
                try {
                    ComPtr<ICoreWebView2WebResourceRequest> request;
                    COREWEBVIEW2_WEB_RESOURCE_CONTEXT context{};
                    args->get_ResourceContext(&context);
                    args->get_Request(&request);
                    LPWSTR raw = nullptr, methodValue = nullptr;
                    request->get_Uri(&raw);
                    request->get_Method(&methodValue);
                    const auto url = ReferenceTarget(Utf8(TakeString(raw)));
                    const auto method = TakeString(methodValue);
                    const auto type = ResourceType(context);
                    const bool asset = type == "script" || type == "stylesheet" || type == "image" || type == "font"
                        || type == "media" || type == "xhr" || type == "fetch";
                    const bool allowed = file ? (type == "mainFrame" || type == "other") && (method == L"GET" || method == L"HEAD")
                        : (url == reference && (method == L"GET" || method == L"HEAD")) || asset;
                    if (allowed && !displaying_()) {
                        referenceHosts_[ParseHttpUrl(url).host] = std::chrono::steady_clock::now() + std::chrono::seconds(35);
                        return;
                    }
                } catch (...) {}
                if (reference_) DenyResource(reference_->environment(), args);
            });
        Check(core->AddWebResourceRequestedFilter(L"*", COREWEBVIEW2_WEB_RESOURCE_CONTEXT_ALL), "Reference request filter");
        Check(core->add_WebResourceRequested(resource.Get(), &event), "Reference request policy");
        auto completed = On<ICoreWebView2NavigationCompletedEventHandler, ICoreWebView2*, ICoreWebView2NavigationCompletedEventArgs*>(
            [this, frame, file](ICoreWebView2*, ICoreWebView2NavigationCompletedEventArgs* args) {
                BOOL ok = FALSE;
                COREWEBVIEW2_WEB_ERROR_STATUS code{};
                args->get_IsSuccess(&ok);
                args->get_WebErrorStatus(&code);
                if (file && code == COREWEBVIEW2_WEB_ERROR_STATUS_OPERATION_CANCELED) return;
                wxTheApp->CallAfter([this, weak = std::weak_ptr<bool>(alive_), frame, file, ok] {
                    if (!weak.lock() || referenceFrame_ != frame) return;
                    if (!ok || file) frame->Close();
                    else if (!displaying_()) { frame_.Disable(); frame->Show(); frame->Raise(); }
                });
            });
        Check(core->add_NavigationCompleted(completed.Get(), &event), "Reference navigation completion");
        auto sourceChanged = On<ICoreWebView2SourceChangedEventHandler, ICoreWebView2*, ICoreWebView2SourceChangedEventArgs*>(
            [this, frame, reference, file](ICoreWebView2* sender, ICoreWebView2SourceChangedEventArgs* args) {
                BOOL fresh = TRUE;
                args->get_IsNewDocument(&fresh);
                if (file || fresh || Source(sender) == reference) return;
                wxTheApp->CallAfter([this, weak = std::weak_ptr<bool>(alive_), frame, reference] {
                    if (weak.lock() && referenceFrame_ == frame) reference_->Navigate(Wide(reference));
                });
            });
        Check(core->add_SourceChanged(sourceChanged.Get(), &event), "Reference history policy");
        FilterResponses(reference_, reference, file);
        ConfigureDownloads(reference_, reference, file);
        InstallGuard(reference_->controller(), [this](auto args) { return Key(args, true); });
        const auto ignored = IgnoreCdp();
        core->CallDevToolsProtocolMethod(L"Network.setBypassServiceWorker", LR"({"bypass":true})", ignored.Get());
        reference_->Navigate(Wide(reference));
    }, [this, frame](std::string) {
        wxTheApp->CallAfter([this, weak = std::weak_ptr<bool>(alive_), frame] { if (weak.lock() && referenceFrame_ == frame) frame->Close(); });
    }, true);
}

} // namespace proctor
