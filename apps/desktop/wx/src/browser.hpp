#pragma once

#include "bridge.hpp"
#include "webview.hpp"
#include "browser_policy.hpp"
#include "legacy_drafts.hpp"

#include <chrono>
#include <array>
#include <future>
#include <map>
#include <optional>
#include <vector>
#include <set>

class wxFrame;
class wxTimer;

namespace proctor {

class Browser {
public:
    Browser(wxFrame& frame, HWND parent, const Runtime& runtime, fs::path data, Bridge& bridge,
        std::function<bool()> displaying, std::function<bool()> locked,
        std::function<void(std::string)> failed, std::function<void(ICoreWebView2*)> attachContest = {});
    ~Browser();

    void Start();
    void SetDraftReader(std::function<void(LegacyDraftTarget, std::function<void(Json)>)> reader);
    void ResetDocument();
    void Cleanup();
    bool Handle(std::string_view channel, const Json& args, Bridge::Reply reply);
    void GuestMessage(const Json& message, std::function<void(const Json&)> publish);
    bool ApiAllowed(std::string_view url) const;
    bool Key(ICoreWebView2AcceleratorKeyPressedEventArgs* args, bool reference = false) const;
    bool MainRequestAllowed(std::string_view url, COREWEBVIEW2_WEB_RESOURCE_CONTEXT context) const;
    void SetVisible(bool visible);
    void NotifyPosition(bool force = false);
    Json SnapshotHosts(Json hosts);

private:
    void Configure();
    void ChangeContest(const Json& args, Bridge::Reply reply);
    void InstallLogin(bool hydro, const Json& login, Bridge::Reply reply);
    void RefreshHydroSocketLease(Bridge::Reply firstLogin = {});
    void StopHydroSocketLease();
    void ClearCompletedChecks();
    void CancelRecordChecks();
    void CompleteRecordCheck(const std::string& record, bool allowed);
    void Navigate(std::string raw, std::uint64_t request, const Json& options);
    void NavigateWithDrafts(std::string raw, std::uint64_t request, LegacyDraftTarget target);
    void ClearDraftScript();
    void OpenReference(std::string raw);
    void GuestEvent(std::string_view event, std::string url = {}, int error = 0, bool main = true);
    void GuestReply(std::uint64_t request, Json value = nullptr, std::string error = {});
    void CompleteNavigation(std::string error = {});
    void ApplyBounds();
    void ApplyResource(ICoreWebView2WebResourceRequestedEventArgs* args);
    void BlockResource(ICoreWebView2WebResourceRequestedEventArgs* args);
    void FilterResponses(const std::shared_ptr<WebView>& view, const std::string& reference = {}, bool file = false);
    void ConfigureGuestResponseFilter(Bridge::Reply reply);
    void ConfigureDownloads(const std::shared_ptr<WebView>& view, const std::string& reference = {}, bool file = false);

    wxFrame& frame_;
    HWND guestWindow_ = nullptr;
    const Runtime& runtime_;
    fs::path data_;
    Bridge& bridge_;
    std::function<bool()> displaying_, locked_;
    std::function<void(std::string)> failed_;
    std::function<void(ICoreWebView2*)> attachContest_;
    std::function<void(LegacyDraftTarget, std::function<void(Json)>)> draftReader_;
    std::function<void(const Json&)> publish_;
    std::shared_ptr<WebView> guest_;
    std::shared_ptr<WebView> reference_;
    wxFrame* referenceFrame_ = nullptr;
    std::shared_ptr<bool> alive_ = std::make_shared<bool>(true);
    ContestPolicy scope_;
    std::set<std::string> hosts_;
    std::map<std::string, std::chrono::steady_clock::time_point> referenceHosts_;
    struct RecordRequest {
        ComPtr<ICoreWebView2WebResourceRequestedEventArgs> args;
        ComPtr<ICoreWebView2Deferral> deferral;
    };
    struct RecordCheck {
        ComPtr<ICoreWebView2Environment> environment;
        std::shared_ptr<std::atomic_bool> cancelled;
        std::vector<RecordRequest> requests;
    };
    std::map<std::string, RecordCheck> recordChecks_;
    std::vector<std::future<void>> checks_;
    std::unique_ptr<wxTimer> hydroSocketTimer_;
    std::shared_ptr<std::atomic_bool> hydroSocketCancel_;
    std::string credential_, sid_, url_ = "about:blank", requestUrl_, requestToken_, fileNavigation_;
    std::set<std::string> draftAttempts_;
    std::wstring draftScript_;
    Json geometry_;
    RECT appliedBounds_{};
    std::vector<std::array<LONG, 4>> appliedCuts_;
    std::optional<std::pair<Json, Bridge::Reply>> pendingScope_;
    bool visible_ = true;
    bool guestWindowVisible_ = false;
    bool attached_ = false;
    bool clearing_ = false;
    bool responseFilterActive_ = false;
    bool responseFilterReady_ = false;
    bool draftPreparing_ = false;
    std::uint64_t generation_ = 0;
    std::uint64_t request_ = 0, navigationId_ = 0;
};

void InstallTextEditingMenu(ICoreWebView2* core, std::function<bool()> allowed);
void InstallGuard(ICoreWebView2Controller* controller, std::function<bool(ICoreWebView2AcceleratorKeyPressedEventArgs*)> guard);
void DenyResource(ICoreWebView2Environment* environment, ICoreWebView2WebResourceRequestedEventArgs* args);
std::string ResourceType(COREWEBVIEW2_WEB_RESOURCE_CONTEXT context);
bool TrustedLocal(std::wstring_view url, std::wstring_view expected);

} // namespace proctor
