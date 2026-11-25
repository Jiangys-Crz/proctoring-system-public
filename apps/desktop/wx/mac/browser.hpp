#pragma once
#import "webview.hpp"

#include "browser_policy.hpp"
#include "legacy_drafts.hpp"
#include <cstdint>
#include <chrono>
#include <map>
#include <set>
#include <wx/timer.h>

class wxWindow;
class wxFrame;

namespace proctor {

class MacBrowser : public wxEvtHandler {
public:
    using Push = std::function<void(const Json&)>;
    using Queue = std::function<bool(std::function<void()>)>;
    using DraftLoader = std::function<std::string(const LegacyDraftTarget&, const std::atomic_bool&)>;
    MacBrowser(wxWindow& frame, NSView* parent, Bridge& bridge, Push push, std::function<bool()> blocked, Queue queue,
               DraftLoader draftLoader);
    ~MacBrowser();
    bool Dispatch(std::string_view channel, const Json& args, Bridge::Reply reply);
    void Message(const Json& message);
    bool ApiAllowed(std::string_view url) const;
    Json SnapshotHosts(Json hosts);
    void OpenReference(std::string url);
    void SetVisible(bool visible);
    void Reset(bool resetLayout = true);
    void Resize();

private:
    void Scope(const Json& args, Bridge::Reply reply);
    void Event(std::string_view event, std::string url = {}, int error = 0, bool main = true);
    void Reply(std::uint64_t id, Json value = nullptr, std::string error = {});
    void Navigate(const std::string& url, std::uint64_t id, const Json& options);
    void BeginNavigation(NSURLRequest* target, const std::string& draftScript = {});
    void CancelDraftRestore();
    WKNavigationActionPolicy Action(WKNavigationAction* action);
    WKNavigationResponsePolicy Response(WKNavigationResponse* response);
    void Download(WKDownload* download);
    void CloseReference();
    void SaveDownload(WKDownload* download, wxWindow& owner, std::function<bool(std::string_view)> allowed,
                      std::function<void()> finished = {});
    void InstallContestLogin(bool hydro, const Json& login, Bridge::Reply reply);
    void RenewContestCredentials(Bridge::Reply first = {});
    void StopContestCredentials(bool eraseCookies = true);

    wxWindow& frame_;
    NSView* parent_;
    NSView* clip_;
    WKWebView* view_;
    WKNavigation* pending_;
    wxFrame* referenceFrame_ = nullptr;
    WKWebView* reference_ = nil;
    std::map<std::string, std::chrono::steady_clock::time_point> referenceHosts_;
    Bridge& bridge_;
    Push push_;
    std::function<bool()> blocked_;
    Queue queue_;
    DraftLoader draftLoader_;
    wxTimer credentialTimer_;
    std::string sessionCookie_, proctoringKey_;
    Json novaContestAccess_;
    NSDate* sessionExpires_;
    NSArray<NSHTTPCookie*>* proofCookies_;
    std::shared_ptr<std::atomic_bool> credentialRequest_;
    std::shared_ptr<std::atomic_bool> draftRead_;
    ContestPolicy scope_;
    std::set<std::string> hosts_;
    Json geometry_;
    Json appliedGeometry_;
    std::string lastUrl_;
    std::uint64_t request_ = 0, generation_ = 0;
    bool visible_ = false, attached_ = false, clearing_ = false, ready_ = false, browserAuthorized_ = false;
    bool draftScript_ = false;
    std::shared_ptr<int> alive_ = std::make_shared<int>();
};

} // namespace proctor
