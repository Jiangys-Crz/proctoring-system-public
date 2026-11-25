#include "browser.hpp"
#include "build_config.hpp"
#include "media.hpp"
#include "migration.hpp"
#include "native_windows.hpp"
#include "workers.hpp"
#include "startup-diagnostics.hpp"

#include <wx/app.h>
#include <wx/button.h>
#include <wx/display.h>
#include <wx/frame.h>
#include <wx/msgdlg.h>
#include <wx/panel.h>
#include <wx/sizer.h>
#include <wx/stdpaths.h>
#include <wx/stattext.h>
#include <wx/timer.h>
#include <objbase.h>
#include <shlobj.h>
#include <shellapi.h>

#include <algorithm>
#include <charconv>
#include <chrono>
#include <condition_variable>
#include <cstdio>
#include <cstring>
#include <ctime>
#include <deque>
#include <fstream>
#include <iomanip>
#include <mutex>
#include <optional>
#include <thread>
#include <vector>

namespace proctor {
namespace {

constexpr auto title = L"程序设计算法协会监考客户端";
constexpr auto instanceName = L"Local\\org.cwnupaa.proctor.wx";
constexpr auto activateName = L"Local\\org.cwnupaa.proctor.wx.activate";
constexpr std::string_view frameEndpoint = "https://proctor-media.invalid/frame/";
constexpr std::string_view displayEndpoint = "https://proctor-display.invalid/image/";
constexpr auto shellStartupLimit = std::chrono::seconds(60);

HGLOBAL CopyBody(std::string_view bytes) {
    const auto body = GlobalAlloc(GMEM_MOVEABLE | GMEM_ZEROINIT, bytes.size());
    const auto buffer = body ? GlobalLock(body) : nullptr;
    if (!buffer) { if (body) GlobalFree(body); return nullptr; }
    std::memcpy(buffer, bytes.data(), bytes.size());
    GlobalUnlock(body);
    return body;
}

ComPtr<IStream> AdoptBody(HGLOBAL& body, SIZE_T exactSize) {
    ComPtr<IStream> content;
    if (body && SUCCEEDED(CreateStreamOnHGlobal(body, TRUE, &content))) {
        const auto allocated = GlobalSize(std::exchange(body, nullptr));
        if (allocated != exactSize) {
            ULARGE_INTEGER size{};
            size.QuadPart = exactSize;
            if (FAILED(content->SetSize(size))) content.Reset();
        }
    }
    return content;
}

struct PendingResource {
    ComPtr<ICoreWebView2WebResourceRequestedEventArgs> event;
    ComPtr<ICoreWebView2Deferral> deferral;
    ComPtr<ICoreWebView2Environment> environment;
    HGLOBAL body{};
    SIZE_T bodySize{};
    std::uint64_t sequence{};
    int status = 410;
    std::wstring contentType = L"image/jpeg";

    ~PendingResource() { if (body) GlobalFree(body); }

    void SetBody(std::string_view bytes) {
        body = CopyBody(bytes);
        bodySize = bytes.size();
    }

    void Complete() {
        // WebView2 event objects stay on the STA. The worker already filled
        // the global memory and this stream adopts it without another copy.
        try {
            const auto content = AdoptBody(body, bodySize);
            if (status == 200 && !content) status = 500;
            auto headers = std::wstring(L"Cache-Control: no-store\r\n"
                L"Access-Control-Allow-Origin: https://proctor-client.invalid\r\n"
                L"Access-Control-Expose-Headers: X-Proctor-Frame-Sequence\r\n"
                L"X-Content-Type-Options: nosniff\r\n");
            if (status == 200) headers += L"Content-Type: " + contentType + L"\r\n";
            else if (status != 204) headers += L"Content-Type: text/plain; charset=utf-8\r\n";
            if (sequence) headers += L"X-Proctor-Frame-Sequence: " + std::to_wstring(sequence) + L"\r\n";
            const auto text = status == 200 ? L"OK" : status == 204 ? L"No Content" : status == 410 ? L"Gone" :
                status == 429 ? L"Too Many Requests" : L"Internal Server Error";
            ComPtr<ICoreWebView2WebResourceResponse> response;
            if (SUCCEEDED(environment->CreateWebResourceResponse(content.Get(), status, text, headers.c_str(), &response)))
                event->put_Response(response.Get());
        } catch (...) {}
        deferral->Complete();
    }
};

fs::path AppData() {
    LPWSTR value = nullptr;
    Check(SHGetKnownFolderPath(FOLDERID_RoamingAppData, 0, nullptr, &value), "RoamingAppData");
    return fs::path(TakeString(value)) / title;
}

fs::path ExePath() {
    std::wstring path(32768, L'\0');
    const auto length = GetModuleFileNameW(nullptr, path.data(), static_cast<DWORD>(path.size()));
    if (!length || length == path.size()) throw std::runtime_error("无法读取客户端安装路径");
    path.resize(length);
    return fs::path(path);
}

std::string StringArg(const Json& args, std::size_t index) {
    return args.size() > index && args[index].is_string() ? args[index].get<std::string>() : "";
}

std::string Message(ICoreWebView2WebMessageReceivedEventArgs* args, std::wstring_view trusted) {
    LPWSTR raw = nullptr;
    if (FAILED(args->get_Source(&raw)) || !TrustedLocal(TakeString(raw), trusted)) return {};
    raw = nullptr;
    if (FAILED(args->get_WebMessageAsJson(&raw))) return {};
    const auto value = TakeString(raw);
    if (value.size() > 20 * 1024 * 1024) return {};
    auto text = Utf8(value);
    return text.size() <= 20 * 1024 * 1024 ? std::move(text) : std::string{};
}

void DenyPopups(ICoreWebView2* view) {
    EventRegistrationToken token{};
    auto popup = On<ICoreWebView2NewWindowRequestedEventHandler, ICoreWebView2*, ICoreWebView2NewWindowRequestedEventArgs*>(
        [](ICoreWebView2*, ICoreWebView2NewWindowRequestedEventArgs* args) { args->put_Handled(TRUE); });
    Check(view->add_NewWindowRequested(popup.Get(), &token), "WebView2 popup policy");
}

void LocalNavigation(ICoreWebView2* view, std::wstring_view trusted, std::function<void()> started) {
    EventRegistrationToken token{};
    auto navigation = On<ICoreWebView2NavigationStartingEventHandler, ICoreWebView2*, ICoreWebView2NavigationStartingEventArgs*>(
        [trusted, started = std::move(started)](ICoreWebView2*, ICoreWebView2NavigationStartingEventArgs* args) {
            LPWSTR raw = nullptr;
            if (FAILED(args->get_Uri(&raw)) || !TrustedLocal(TakeString(raw), trusted)) { args->put_Cancel(TRUE); return; }
            started();
        });
    Check(view->add_NavigationStarting(navigation.Get(), &token), "Local page navigation");
    auto frame = On<ICoreWebView2NavigationStartingEventHandler, ICoreWebView2*, ICoreWebView2NavigationStartingEventArgs*>(
        [](ICoreWebView2*, ICoreWebView2NavigationStartingEventArgs* args) { args->put_Cancel(TRUE); });
    Check(view->add_FrameNavigationStarting(frame.Get(), &token), "Local page frame navigation");
}

void LocalPermissions(ICoreWebView2* view, bool shell) {
    EventRegistrationToken token{};
    auto permission = On<ICoreWebView2PermissionRequestedEventHandler, ICoreWebView2*, ICoreWebView2PermissionRequestedEventArgs*>(
        [shell](ICoreWebView2*, ICoreWebView2PermissionRequestedEventArgs* args) {
            COREWEBVIEW2_PERMISSION_KIND kind{};
            LPWSTR raw = nullptr;
            args->get_PermissionKind(&kind);
            args->get_Uri(&raw);
            const auto origin = TakeString(raw);
            const bool local = origin == L"https://proctor-client.invalid/" || origin == L"https://proctor-client.invalid" || origin == clientUrl;
            const bool media = kind == COREWEBVIEW2_PERMISSION_KIND_CAMERA || kind == COREWEBVIEW2_PERMISSION_KIND_MICROPHONE;
            args->put_State(shell && local && media ? COREWEBVIEW2_PERMISSION_STATE_ALLOW : COREWEBVIEW2_PERMISSION_STATE_DENY);
        });
    Check(view->add_PermissionRequested(permission.Get(), &token), "Local page permission policy");
}

class MainFrame final : public wxFrame {
public:
    explicit MainFrame(std::function<bool()> locked)
        : wxFrame(nullptr, wxID_ANY, title, wxDefaultPosition, wxDefaultSize,
            wxDEFAULT_FRAME_STYLE | wxCLIP_CHILDREN), protected_(std::move(locked)) {
        SetSize(FromDIP(wxSize(1280, 820)));
        SetMinSize(FromDIP(wxSize(640, 480)));
        wxIcon icon;
        icon.LoadFile(L"1", wxBITMAP_TYPE_ICO_RESOURCE);
        if (icon.IsOk()) SetIcon(icon);
        SetBackgroundColour(wxColour(15, 23, 42));
        Centre();
    }
    void ApplyMode(std::string_view mode) {
        const bool locked = mode == "locked";
        const bool active = mode != "setup";
        if (locked && IsIconized()) Iconize(false);
        if (IsFullScreen() != locked) ShowFullScreen(locked, wxFULLSCREEN_ALL);
        HWND window = reinterpret_cast<HWND>(GetHandle());
        const auto style = GetWindowLongPtrW(window, GWL_STYLE);
        SetWindowLongPtrW(window, GWL_STYLE, active ? style & ~static_cast<LONG_PTR>(WS_MINIMIZEBOX) : style | WS_MINIMIZEBOX);
        if (const auto menu = GetSystemMenu(window, FALSE)) EnableMenuItem(menu, SC_CLOSE, MF_BYCOMMAND | (active ? MF_GRAYED : MF_ENABLED));
        SetWindowPos(window, locked ? HWND_TOPMOST : HWND_NOTOPMOST, 0, 0, 0, 0,
            SWP_FRAMECHANGED | SWP_NOMOVE | SWP_NOSIZE | SWP_NOACTIVATE);
    }
protected:
    WXLRESULT MSWWindowProc(WXUINT message, WXWPARAM wParam, WXLPARAM lParam) override {
        if (message == WM_SYSCOMMAND && protected_()) {
            const auto command = wParam & 0xfff0;
            if (command == SC_CLOSE || command == SC_MINIMIZE) return 0;
        }
        return wxFrame::MSWWindowProc(message, wParam, lParam);
    }
private:
    std::function<bool()> protected_;
};

class Application final : public wxApp {
public:
    bool OnInit() override {
        try { return Init(); }
        catch (const std::exception& e) { Failure("startup-failed", e.what(), L"监考客户端启动失败"); return false; }
    }
    int OnExit() override {
        shuttingDown_ = true;
        if (timer_) timer_->Stop();
        if (screen_) screen_->Release();
        if (migration_) migration_->Cancel();
        CleanupMonitoring();
        if (frameWorkers_) frameWorkers_->Close();
        if (workers_) workers_->Close();
        CloseOverlays();
        migration_.reset();
        browser_.reset();
        shell_.reset();
        if (bridge_) bridge_->Shutdown();
        bridge_.reset();
        screen_.reset();
        native_.reset();
        media_.reset();
        runtime_.reset();
        CloseInstance();
        if (activation_) CloseHandle(activation_);
        if (com_) CoUninitialize();
        return wxApp::OnExit();
    }
    bool OnExceptionInMainLoop() override {
        try { throw; }
        catch (const std::exception& e) { Failure("unhandled", e.what(), L"监考客户端启动失败"); }
        catch (...) { Failure("unhandled", "unexpected exception", L"监考客户端启动失败"); }
        BeginQuit();
        return true;
    }

private:
    struct Overlay {
        wxFrame* frame;
        std::shared_ptr<WebView> view;
        wxString displayName;
        wxRect bounds;
        bool primary;
    };

    bool Init() {
        executable_ = ExePath();
        data_ = AppData();
        resources_ = executable_.parent_path() / L"resources";
        logs_ = data_ / L"logs";
        bool elevatedRelaunch = false;
        for (int i = 1; i < argc; ++i) {
            elevatedRelaunch |= wxString(argv[i]) == L"--proctor-elevated-relaunch";
        }
        Log("bootstrap-start", elevatedRelaunch ? "administrator-relaunch=true" : "administrator-relaunch=false");
        activation_ = CreateEventW(nullptr, FALSE, FALSE, activateName);
        if (!TakeInstance()) { if (activation_) SetEvent(activation_); return false; }
        native_ = std::make_unique<NativeWindows>(resources_, data_, PROCTOR_VERSION,
            executable_.parent_path() / L"webview2" / PROCTOR_WEBVIEW2_VERSION, PROCTOR_PACKAGED);
        if (!EnsureAdministrator()) { CloseInstance(); return false; }

        const auto status = CoInitializeEx(nullptr, COINIT_APARTMENTTHREADED);
        Check(status, "COM STA");
        com_ = true;
        runtime_ = std::make_unique<Runtime>(executable_.parent_path());
        media_ = std::make_unique<DesktopMedia>(resources_ / L"ffmpeg" / L"ffmpeg.exe");
        auto workerFailed = [this](std::exception_ptr error) {
            try { std::rethrow_exception(error); }
            catch (const std::exception& failure) { Log("worker-exception", failure.what()); }
            catch (...) { Log("worker-exception", "unexpected worker exception"); }
        };
        workers_ = std::make_unique<Workers>(6, workerFailed);
        // Frame waits for the two capture leases must not sit behind process
        // inventory, recording preparation or long-running security checks.
        frameWorkers_ = std::make_unique<Workers>(2, workerFailed);
        migration_ = std::make_unique<LegacyMigration>(data_, resources_,
            [this](std::string_view detail) { Log("legacy-profile", detail); });
        screen_ = std::make_unique<ScreenControl>(resources_,
            [this](Json display, ScreenControl::Images images) {
                CallAfter([this, display = std::move(display), images = std::move(images)]() mutable {
                    if (!shuttingDown_) ShowDisplay(std::move(display), std::move(images));
                });
            },
            [this] { CallAfter([this] {
                if (shuttingDown_ || display_.is_null()) return;
                // The guard reports a different virtual desktop. Existing
                // HWNDs stay on the old desktop and must be recreated.
                CloseOverlays();
                ReconcileOverlays();
            }); });

        SetExitOnFrameDelete(false);
        frame_ = new MainFrame([this] { return mode_ != "setup" || IsDisplaying(); });
        SetTopWindow(frame_);
        panel_ = new wxPanel(frame_, wxID_ANY, wxDefaultPosition, wxDefaultSize, wxTAB_TRAVERSAL | wxCLIP_CHILDREN);
        panel_->SetBackgroundColour(wxColour(15, 23, 42));
        auto sizer = new wxBoxSizer(wxVERTICAL);
        sizer->Add(panel_, 1, wxEXPAND);
        frame_->SetSizer(sizer);
        frame_->Layout();
        auto loadingLayout = new wxBoxSizer(wxVERTICAL);
        loadingLayout->AddStretchSpacer();
        loading_ = new wxStaticText(panel_, wxID_ANY, L"正在启动监考客户端，请稍候…");
        loading_->SetForegroundColour(*wxWHITE);
        loadingLayout->Add(loading_, 0, wxALIGN_CENTER | wxALL, frame_->FromDIP(24));
        startupRetry_ = new wxButton(panel_, wxID_ANY, L"重试启动");
        startupRetry_->Hide();
        startupRetry_->Bind(wxEVT_BUTTON, [this](wxCommandEvent&) {
            if (shuttingDown_ || shown_) return;
            startupRetry_->Hide();
            loading_->SetLabel(L"正在重新启动客户端界面，请稍候…");
            panel_->Layout();
            CallAfter([this] { if (!shuttingDown_ && !shown_) StartShell(); });
        });
        loadingLayout->Add(startupRetry_, 0, wxALIGN_CENTER | wxBOTTOM, frame_->FromDIP(24));
        loadingLayout->AddStretchSpacer();
        panel_->SetSizer(loadingLayout);

        bridge_ = std::make_unique<Bridge>(Bridge::Config{PROCTOR_VERSION, resources_ / L"renderer", data_, PROCTOR_PACKAGED, resources_},
            [this](std::string_view channel, const Json& args, Bridge::Reply reply) { Dispatch(channel, args, std::move(reply)); },
            [this](const Json& message) { if (shell_ && !shuttingDown_) shell_->Send(message); },
            [this](const fs::path& installer) { Install(installer); },
            [this](std::function<void()> call) { CallAfter([this, call = std::move(call)] { if (!shuttingDown_) call(); }); });
        browser_ = std::make_unique<Browser>(*frame_, reinterpret_cast<HWND>(panel_->GetHandle()), *runtime_, data_ / L"WebView2", *bridge_,
            [this] { return IsDisplaying(); }, [this] { return mode_ == "locked"; },
            [this](std::string error) { Log("contest-webview", error); },
            [this](ICoreWebView2* core) { if (migration_) migration_->AttachContest(core); });
        browser_->SetDraftReader([this](LegacyDraftTarget target, std::function<void(Json)> ready) {
            migration_->ReadDrafts(std::move(target), *runtime_, reinterpret_cast<HWND>(panel_->GetHandle()),
                [this](std::function<void()> task) { return workers_->Post(std::move(task)); }, std::move(ready));
        });
        bridge_->SetApiPolicy([this](std::string_view url) { return browser_ && browser_->ApiAllowed(url); });
        bridge_->SetSubmitAllowed([this] { return mode_ != "locked" && !IsDisplaying(); });
        bridge_->SetInstallAllowed([this] { return mode_ == "setup" && !IsDisplaying(); });

        frame_->Bind(wxEVT_CLOSE_WINDOW, [this](wxCloseEvent& event) {
            if (event.CanVeto()) event.Veto();
            if (mode_ == "setup" && !IsDisplaying()) BeginQuit();
        });
        Bind(wxEVT_QUERY_END_SESSION, [this](wxCloseEvent& event) {
            if ((mode_ != "setup" || IsDisplaying()) && event.CanVeto()) event.Veto();
            else event.Skip();
        });
        frame_->Bind(wxEVT_MOVE, [this](wxMoveEvent& event) { Resize(); event.Skip(); });
        panel_->Bind(wxEVT_SIZE, [this](wxSizeEvent& event) { Resize(); event.Skip(); });
        frame_->Bind(wxEVT_DPI_CHANGED, [this](wxDPIChangedEvent& event) {
            frame_->SetMinSize(frame_->FromDIP(wxSize(640, 480)));
            CallAfter([this] { Resize(true); });
            event.Skip();
        });
        frame_->Bind(wxEVT_ICONIZE, [this](wxIconizeEvent& event) {
            if (event.IsIconized() && (mode_ != "setup" || IsDisplaying())) {
                CallAfter([this] { if (frame_ && !shuttingDown_) frame_->Iconize(false); });
            }
            if (browser_) browser_->SetVisible(!event.IsIconized());
            event.Skip();
        });
        frame_->Bind(wxEVT_DISPLAY_CHANGED, [this](wxDisplayChangedEvent& event) {
            if (!display_.is_null()) ReconcileOverlays();
            event.Skip();
        });
        timer_ = std::make_unique<wxTimer>(this);
        // Legacy profile preparation is optional and may take longer on Win7.
        // Start the WebView deadline when navigation actually starts instead.
        Bind(wxEVT_TIMER, [this](wxTimerEvent&) {
            if (shuttingDown_) return;
            if (shellDeadline_ && std::chrono::steady_clock::now() >= *shellDeadline_) {
                ShellFailure("renderer-timeout", "WebView2 shell navigation or renderer readiness timed out", L"监考客户端加载超时");
                return;
            }
            if (activation_ && WaitForSingleObject(activation_, 0) == WAIT_OBJECT_0) RaiseMain();
            if (migration_) migration_->Tick();
        }, timer_->GetId());
        timer_->Start(200);
        overlayFocusTimer_ = std::make_unique<wxTimer>(this);
        Bind(wxEVT_TIMER, [this](wxTimerEvent&) {
            if (!shuttingDown_ && !display_.is_null()) FocusOverlay();
        }, overlayFocusTimer_->GetId());
        // WebView2 109 can finish navigation without presenting a frame when
        // its HWND ancestors were hidden at controller creation/navigation.
        // Show and lay out the native host first, including on legacy upgrades.
        frame_->Maximize();
        frame_->Show();
        frame_->Layout();
        if (!workers_->Post([this] {
            try { migration_->Prepare(); }
            catch (const std::exception& error) { Log("legacy-profile-prepare", error.what()); }
            catch (...) { Log("legacy-profile-prepare", "unexpected migration preparation failure"); }
            CallAfter([this] {
                if (shuttingDown_) return;
                // The ordinary setup page does not need a second Chromium
                // process. Only a legacy contest cookie import needs it here.
                try {
                    if (migration_->NeedsContestTarget()) browser_->Start();
                    migration_->Start(*runtime_, reinterpret_cast<HWND>(panel_->GetHandle()), [this] {
                        CallAfter([this] { if (!shuttingDown_) StartShell(); });
                    });
                } catch (const std::exception& error) {
                    Log("legacy-profile-start", error.what());
                    StartShell();
                } catch (...) {
                    Log("legacy-profile-start", "unexpected migration startup failure");
                    StartShell();
                }
            });
        })) StartShell();
        return true;
    }

    bool TakeInstance() {
        instance_ = CreateMutexW(nullptr, FALSE, instanceName);
        if (!instance_) throw std::runtime_error("无法创建客户端实例锁");
        if (GetLastError() != ERROR_ALREADY_EXISTS) return true;
        CloseInstance();
        return false;
    }
    void CloseInstance() { if (instance_) { CloseHandle(instance_); instance_ = nullptr; } }

    bool EnsureAdministrator() {
        const auto status = native_->ElevationStatus();
        Log("administrator-status", status);
        if (status == "elevated") return true;
        if (status == "unavailable") {
            wxMessageDialog dialog(nullptr,
                L"无法确认客户端的管理员权限。\n\n请重新安装完整客户端，并检查安全软件是否隔离了权限检测组件。检测失败不会被当作已授权。",
                L"管理员权限检测失败", wxOK | wxICON_ERROR);
            dialog.SetOKLabel(L"关闭软件");
            dialog.ShowModal();
            return false;
        }
        std::string result;
        for (;;) {
            const wxString text = result == "cancelled" ? L"已取消管理员授权，客户端尚未启动。"
                : result == "failed" ? L"管理员授权组件未能启动。" : L"监考客户端需要管理员权限才能运行。";
            wxMessageDialog dialog(nullptr, text + (result == "failed"
                    ? L"\n\n可以关闭软件后右键选择“以管理员身份运行”。若仍然失败，请重新安装完整客户端并检查安全软件。"
                    : L"\n\n点击授权按钮后，请在 Windows 权限窗口中选择“是”或输入管理员账号和密码。授权成功后客户端会自动重新启动。"),
                L"需要管理员权限", wxOK | wxCANCEL | wxICON_WARNING);
            dialog.SetOKCancelLabels(result.empty() ? L"申请管理员权限" : L"重试管理员授权", L"关闭软件");
            if (dialog.ShowModal() != wxID_OK) return false;
            CloseInstance();
            try { result = native_->Relaunch() ? "started" : "cancelled"; }
            catch (...) { result = "failed"; }
            Log("administrator-relaunch", result);
            if (result == "started" || !TakeInstance()) return false;
        }
    }

    void StartShell() {
        if (shuttingDown_) return;
        if (!shellDeadline_) shellDeadline_ = std::chrono::steady_clock::now() + shellStartupLimit;
        try {
            shellNavigated_ = shellDocumentReady_ = false;
            auto script = ReadText(resources_ / L"shell-health.js") + "\n" + ReadText(resources_ / L"qr.js") + "\n" + ReadText(resources_ / L"media.js") + "\n"
                + ReadText(resources_ / L"bridge.js") + "\n" + ReadText(resources_ / L"guest.js");
            try { script += migration_->ShellScript(); }
            catch (const std::exception& error) { Log("legacy-renderer-script", error.what()); }
            shell_ = std::make_shared<WebView>(reinterpret_cast<HWND>(panel_->GetHandle()));
            const auto target = std::weak_ptr<WebView>(shell_);
            shell_->Start(*runtime_, data_ / L"WebView2" / L"client", resources_ / L"renderer", true, Wide(script),
                [this] { ConfigureShell(); },
                [this, target](std::string error) {
                    CallAfter([this, target, error] {
                        const auto expected = target.lock();
                        if (shuttingDown_ || !expected || expected != shell_) return;
                        ShellFailure("renderer-init", error, L"监考客户端组件加载失败");
                    });
                });
        } catch (const std::exception& error) {
            ShellFailure("renderer-init", error.what(), L"监考客户端组件加载失败");
        }
    }

    void ConfigureShell() {
        auto core = shell_->core();
        const auto target = std::weak_ptr<WebView>(shell_);
        LocalNavigation(core, clientUrl, [this] {
            ++shellDocument_;
            bridge_->NewDocument();
            browser_->ResetDocument();
            CleanupMonitoring();
        });
        DenyPopups(core);
        LocalPermissions(core, true);
        InstallTextEditingMenu(core, [this] { return !IsDisplaying() && mode_ != "locked"; });
        InstallGuard(shell_->controller(), [this](auto args) { return browser_->Key(args); });
        EventRegistrationToken token{};
        auto message = On<ICoreWebView2WebMessageReceivedEventHandler, ICoreWebView2*, ICoreWebView2WebMessageReceivedEventArgs*>(
            [this, target](ICoreWebView2*, ICoreWebView2WebMessageReceivedEventArgs* args) {
                if (shuttingDown_ || target.lock() != shell_) return;
                const auto text = Message(args, clientUrl);
                if (text.empty()) return;
                auto json = Json::parse(text, nullptr, false);
                if (!json.is_object()) return;
                // Return to WebView2 before dispatching actions that may navigate,
                // close a controller or enter another Windows message loop.
                CallAfter([this, target, document = shellDocument_, json = std::move(json)] {
                    const auto view = target.lock();
                    if (shuttingDown_ || !view || view != shell_ || document != shellDocument_) return;
                    if (json.contains("shellStatus")) {
                        if (!shellDeadline_) return;
                        if (json.value("shellStatus", "") == "ready") {
                            shellDocumentReady_ = true;
                            ShellReady();
                        } else if (json.value("shellStatus", "") == "failed") {
                            ShellFailure("renderer-document", json.value("reason", "unknown"), L"监考客户端界面初始化失败");
                        }
                    } else if (json.contains("guest")) {
                        browser_->GuestMessage(json, [this](const Json& value) { if (shell_) shell_->Send(value); });
                    } else bridge_->HandleParsedMessage(json);
                });
            });
        Check(core->add_WebMessageReceived(message.Get(), &token), "Local bridge");
        auto request = On<ICoreWebView2WebResourceRequestedEventHandler, ICoreWebView2*, ICoreWebView2WebResourceRequestedEventArgs*>(
            [this, target](ICoreWebView2*, ICoreWebView2WebResourceRequestedEventArgs* args) {
                const auto view = target.lock();
                if (!view) return;
                if (view != shell_) { DenyResource(view->environment(), args); return; }
                ComPtr<ICoreWebView2WebResourceRequest> resource;
                args->get_Request(&resource);
                LPWSTR uri = nullptr;
                COREWEBVIEW2_WEB_RESOURCE_CONTEXT context{};
                args->get_ResourceContext(&context);
                if (resource) resource->get_Uri(&uri);
                const auto url = Utf8(TakeString(uri));
                if (url.starts_with(frameEndpoint)) {
                    ReadScreenFrame(resource.Get(), args, context, std::string_view(url).substr(frameEndpoint.size()));
                } else if (!browser_->MainRequestAllowed(url, context)) DenyResource(shell_->environment(), args);
            });
        // Static assets and media do not need a policy round trip to the STA.
        for (const auto context : {COREWEBVIEW2_WEB_RESOURCE_CONTEXT_DOCUMENT,
             COREWEBVIEW2_WEB_RESOURCE_CONTEXT_XML_HTTP_REQUEST, COREWEBVIEW2_WEB_RESOURCE_CONTEXT_FETCH}) {
            Check(core->AddWebResourceRequestedFilter(L"*", context), "Local request filter");
        }
        Check(core->AddWebResourceRequestedFilter(L"https://proctor-media.invalid/frame/*", COREWEBVIEW2_WEB_RESOURCE_CONTEXT_ALL),
            "Local capture request filter");
        Check(core->add_WebResourceRequested(request.Get(), &token), "Local request policy");
        ComPtr<ICoreWebView2_4> downloads;
        Check(core->QueryInterface(IID_PPV_ARGS(&downloads)), "Local download policy");
        auto download = On<ICoreWebView2DownloadStartingEventHandler, ICoreWebView2*, ICoreWebView2DownloadStartingEventArgs*>(
            [](ICoreWebView2*, ICoreWebView2DownloadStartingEventArgs* args) { args->put_Cancel(TRUE); });
        Check(downloads->add_DownloadStarting(download.Get(), &token), "Deny local downloads");
        auto loaded = On<ICoreWebView2NavigationCompletedEventHandler, ICoreWebView2*, ICoreWebView2NavigationCompletedEventArgs*>(
            [this, target](ICoreWebView2*, ICoreWebView2NavigationCompletedEventArgs* args) {
                BOOL success = FALSE;
                COREWEBVIEW2_WEB_ERROR_STATUS error{};
                args->get_IsSuccess(&success);
                args->get_WebErrorStatus(&error);
                CallAfter([this, target, success, error] {
                    const auto expected = target.lock();
                    if (shuttingDown_ || !expected || expected != shell_ || error == COREWEBVIEW2_WEB_ERROR_STATUS_OPERATION_CANCELED) return;
                    if (!success) { ShellFailure("renderer-load-failed", std::to_string(error), L"监考客户端页面加载失败"); return; }
                    shellNavigated_ = true;
                    ShellReady();
                });
            });
        Check(core->add_NavigationCompleted(loaded.Get(), &token), "Local page loaded");
        auto failed = On<ICoreWebView2ProcessFailedEventHandler, ICoreWebView2*, ICoreWebView2ProcessFailedEventArgs*>(
            [this, target](ICoreWebView2*, ICoreWebView2ProcessFailedEventArgs* args) {
                COREWEBVIEW2_PROCESS_FAILED_KIND kind{};
                if (FAILED(args->get_ProcessFailedKind(&kind))) return;
                if (kind != COREWEBVIEW2_PROCESS_FAILED_KIND_BROWSER_PROCESS_EXITED && kind != COREWEBVIEW2_PROCESS_FAILED_KIND_RENDER_PROCESS_EXITED) return;
                CallAfter([this, target, kind] {
                    const auto view = target.lock();
                    if (shuttingDown_ || !view || view != shell_ ||
                        (shellRecovering_ && kind == COREWEBVIEW2_PROCESS_FAILED_KIND_RENDER_PROCESS_EXITED)) return;
                    CleanupMonitoring();
                    Log("render-process-gone", std::to_string(kind));
                    if (!bridge_->BeginRendererRecovery(mode_ != "setup" || IsDisplaying())) {
                        ShellFailure("renderer-recovery-failed", std::to_string(kind), L"监考客户端页面异常");
                        return;
                    }
                    shellRecovering_ = true;
                    shellNavigated_ = shellDocumentReady_ = false;
                    if (!shellDeadline_) shellDeadline_ = std::chrono::steady_clock::now() + shellStartupLimit;
                    if (kind == COREWEBVIEW2_PROCESS_FAILED_KIND_BROWSER_PROCESS_EXITED || FAILED(view->core()->Reload())) {
                        view->Close();
                        StartShell();
                    }
                });
            });
        Check(core->add_ProcessFailed(failed.Get(), &token), "Local renderer recovery");
        try { migration_->AttachClient(core); }
        catch (const std::exception& error) { Log("legacy-renderer-attach", error.what()); }
        shell_->Navigate(clientUrl);
        wchar_t dev[8]{};
        if (GetEnvironmentVariableW(L"PROCTOR_DEV", dev, 8) == 1 && dev[0] == L'1') {
            ComPtr<ICoreWebView2Settings> settings;
            if (SUCCEEDED(core->get_Settings(&settings))) settings->put_AreDevToolsEnabled(TRUE);
            core->OpenDevToolsWindow();
        }
    }

    void ShellReady() {
        if (!shellNavigated_ || !shellDocumentReady_) return;
        shellDeadline_.reset();
        shellRecovering_ = false;
        shown_ = true;
        if (loading_) loading_->Hide();
        if (startupRetry_) startupRetry_->Hide();
        panel_->Layout();
        shell_->Visible(!frame_->IsIconized());
        Resize(true);
        Log("renderer-ready", "navigation and interface initialization complete");
    }

    void ReadScreenFrame(ICoreWebView2WebResourceRequest* resource, ICoreWebView2WebResourceRequestedEventArgs* event,
                         COREWEBVIEW2_WEB_RESOURCE_CONTEXT context, std::string_view path) {
        const auto slash = path.find('/');
        constexpr auto validId = "0123456789abcdef-";
        auto deny = [this, event] { DenyResource(shell_->environment(), event); };
        if (shuttingDown_ || !resource || slash != 36 || path.substr(0, slash).find_first_not_of(validId) != std::string_view::npos ||
            (context != COREWEBVIEW2_WEB_RESOURCE_CONTEXT_FETCH && context != COREWEBVIEW2_WEB_RESOURCE_CONTEXT_XML_HTTP_REQUEST)) {
            deny();
            return;
        }
        const auto digits = path.substr(slash + 1);
        std::uint64_t after = 0;
        if (digits.empty() || digits.size() > 16) { deny(); return; }
        const auto [end, error] = std::from_chars(digits.data(), digits.data() + digits.size(), after);
        if (error != std::errc{} || end != digits.data() + digits.size() || after > 9007199254740991ULL) { deny(); return; }
        LPWSTR raw = nullptr;
        if (FAILED(resource->get_Method(&raw)) || TakeString(raw) != L"GET") { deny(); return; }
        ComPtr<ICoreWebView2HttpRequestHeaders> headers;
        if (FAILED(resource->get_Headers(&headers))) { deny(); return; }
        raw = nullptr;
        if (FAILED(headers->GetHeader(L"Origin", &raw)) || TakeString(raw) != L"https://proctor-client.invalid") { deny(); return; }
        LPWSTR source = nullptr;
        if (FAILED(shell_->core()->get_Source(&source)) || !TrustedLocal(TakeString(source), clientUrl)) { deny(); return; }

        auto pending = std::make_shared<PendingResource>();
        pending->event = event;
        pending->environment = shell_->environment();
        if (FAILED(event->GetDeferral(&pending->deferral))) { deny(); return; }
        const auto id = std::string(path.substr(0, slash));
        if (!frameWorkers_->Post([this, pending, id, after] {
            try {
                const auto frame = media_->ReadFrame(id, after);
                pending->sequence = frame.sequence;
                pending->status = frame.imageSequence > after ? 200 : 204;
                if (pending->status == 200) pending->SetBody(*frame.jpeg);
            } catch (const std::exception& failure) {
                if (*failure.what()) pending->SetBody(failure.what());
            } catch (...) {}
            CallAfter([pending] { pending->Complete(); });
        })) {
            pending->status = 429;
            pending->Complete();
        }
    }

    void Dispatch(std::string_view channel, const Json& args, Bridge::Reply reply) {
        if (browser_->Handle(channel, args, reply)) return;
        if (channel == "window:mode") {
            const auto next = StringArg(args, 0);
            if (next == "exit") { QuitFromPage(reply); return; }
            if (next == "setup") bridge_->ResetNovaJudge();
            if ((next == "setup" || next == "floating" || next == "locked") && next != mode_) {
                mode_ = next;
                frame_->ApplyMode(mode_);
                browser_->SetVisible(!frame_->IsIconized());
            }
            if (next == "setup" || next == "floating" || next == "locked") native_->SetUsbEnabled(mode_ != "setup");
            reply(nullptr, {});
            return;
        }
        if (channel == "app:quit") { QuitFromPage(reply); return; }
        if (channel == "app:relaunchAsAdmin") {
            if (IsDisplaying()) { reply(nullptr, "屏幕展示期间不能重新启动客户端"); return; }
            // Startup has already established the token for this process.
            reply(native_->ElevationStatus() == "elevated", {});
            return;
        }
        if (channel == "screen-control:isDisplaying") { reply(IsDisplaying(), {}); return; }
        if (channel == "screen-control:release") { screen_->Release(); reply(nullptr, {}); return; }
        if (channel == "screen-control:watch") {
            const auto& identity = args.at(0);
            const auto url = ParseHttpUrl(identity.at("baseUrl").get<std::string>());
            if (!browser_->ApiAllowed(url.origin + "/api/client/screen-control")) {
                reply(nullptr, "当前不允许访问该地址：" + url.origin + "/api/client/screen-control"); return;
            }
            auto wait = screen_->PrepareWatch(identity);
            Queue(reply, [wait = std::move(wait)] { wait(); return Json(nullptr); });
            return;
        }
        if (channel.rfind("desktop:", 0) == 0) {
            Queue(reply, [this, name = std::string(channel), args, generation = media_->Generation()] {
                return media_->Invoke(name, args, generation);
            });
            return;
        }
        if (channel == "security:confirmPeripheralBaseline") {
            if (IsDisplaying() || mode_ != "setup") { reply(nullptr, "请先结束当前考试或屏幕展示，再检测登录设备"); return; }
            Queue([this, reply](Json result, std::string error) {
                if (error.empty() && (IsDisplaying() || mode_ != "setup")) error = "客户端状态已改变，请重新检测登录设备";
                reply(std::move(result), std::move(error));
            }, [this, args] { return native_->Handle("security:confirmPeripheralBaseline", args, "setup"); });
            return;
        }
        if (channel.rfind("security:", 0) == 0 || channel.rfind("permissions:", 0) == 0 || channel == "system:getInfo") {
            auto input = args;
            if (channel == "security:snapshot") {
                input = Json::array({browser_->SnapshotHosts(args.empty() ? Json::array() : args[0]), args.size() < 2 || args[1] != false});
            }
            Queue(reply, [this, name = std::string(channel), input, mode = mode_] { return native_->Handle(name, input, mode); });
            return;
        }
        reply(nullptr, "未知客户端操作");
    }

    void Queue(Bridge::Reply reply, std::function<Json()> work) {
        if (!workers_->Post([this, reply, work = std::move(work)] {
            Json result;
            std::string error;
            try { result = work(); }
            catch (const std::exception& e) { error = e.what(); }
            catch (...) { error = "客户端操作失败"; }
            CallAfter([this, reply, result = std::move(result), error = std::move(error)]() mutable {
                if (!shuttingDown_) reply(std::move(result), std::move(error));
            });
        })) reply(nullptr, "客户端操作繁忙，请稍后重试");
    }

    void Resize(bool notifyPosition = false) {
        if (shuttingDown_) return;
        if (shell_) shell_->Resize(notifyPosition);
        if (browser_) browser_->NotifyPosition(notifyPosition);
    }

    bool IsDisplaying() const { return screen_ && screen_->IsDisplaying(); }
    void RaiseMain() {
        if (!frame_ || shuttingDown_) return;
        if (IsDisplaying()) { FocusOverlay(); return; }
        if (frame_->IsIconized()) frame_->Iconize(false);
        frame_->Show();
        frame_->Raise();
        if (shell_) shell_->Focus();
    }

    void Log(std::string_view event, std::string_view detail) const {
        startup::Trace(event);
        if (logs_.empty()) return;
        try {
            fs::create_directories(logs_);
            const auto path = logs_ / L"startup.log";
            std::error_code error;
            if (fs::file_size(path, error) > 512 * 1024 && !error) std::ofstream(path, std::ios::trunc);
            auto stream = std::ofstream(path, std::ios::app);
            const auto now = std::time(nullptr);
            std::tm utc{};
            gmtime_s(&utc, &now);
            stream << std::put_time(&utc, "%Y-%m-%dT%H:%M:%SZ") << " v" << PROCTOR_VERSION
                   << " win32/" << PROCTOR_ARCH << ' ' << event << ": " << detail << '\n';
        } catch (...) {}
    }

    void Failure(std::string_view event, std::string_view error, const wchar_t* caption, bool active = false) {
        Log(event, error);
        auto text = wxString(active
            ? L"客户端页面进程异常退出，自动恢复未完成。请联系监考老师检查日志并恢复考试；该提示不表示安装包损坏。"
            : L"客户端页面未能正常启动，请联系监考老师检查日志及客户端安装。");
        if (!logs_.empty()) text += L"若问题持续，请将此目录中的日志交给监考老师：\n" + wxString(logs_.wstring());
        wxMessageBox(text, caption, wxOK | wxICON_ERROR, frame_);
    }

    void ShellFailure(std::string_view event, std::string_view error, const wchar_t* caption) {
        shellDeadline_.reset();
        shellRecovering_ = false;
        if (!shown_ && frame_ && loading_ && startupRetry_) {
            Log(event, error);
            if (shell_) shell_->Close();
            shell_.reset();
            loading_->SetLabel(L"客户端界面尚未启动成功，可点击下方重试。\n若问题持续，请查看启动日志：\n" + wxString(logs_.wstring()));
            loading_->Show(); startupRetry_->Show();
            panel_->Layout(); frame_->Show(); frame_->Raise();
            return;
        }
        Failure(event, error, caption, mode_ != "setup" || IsDisplaying());
    }

    void CleanupMonitoring() {
        if (media_) media_->StopAll();
        if (native_) { native_->StopUsb(); native_->StopDomains(); }
        if (browser_) browser_->Cleanup();
    }

    void QuitFromPage(Bridge::Reply reply) {
        if (IsDisplaying()) { reply(nullptr, "请等待监考老师结束屏幕展示"); return; }
        mode_ = "setup";
        screen_->Release();
        frame_->ApplyMode(mode_);
        reply(nullptr, {});
        CallAfter([this] { BeginQuit(); });
    }

    void BeginQuit() {
        if (shuttingDown_) return;
        shuttingDown_ = true;
        if (migration_) migration_->Cancel();
        CleanupMonitoring();
        CloseOverlays();
        if (screen_) screen_->Release();
        // Finish owned-file removal and server revocation before the HWND and
        // bridge are destroyed. The network wait cannot block the wx STA.
        if (workers_ && bridge_ && workers_->Post([this] {
            bridge_->Shutdown();
            CallAfter([this] { ExitMainLoop(); });
        })) return;
        if (IsMainLoopRunning()) ExitMainLoop();
    }

    void Install(const fs::path& installer) {
        if (mode_ != "setup" || IsDisplaying()) throw std::runtime_error("请先结束当前考试或屏幕展示，再更新客户端");
        const auto parameters = L"--updated /D=" + executable_.parent_path().wstring();
        SHELLEXECUTEINFOW launch{sizeof(launch)};
        launch.fMask = SEE_MASK_FLAG_NO_UI;
        launch.lpVerb = L"open";
        launch.lpFile = installer.c_str();
        launch.lpParameters = parameters.c_str();
        launch.nShow = SW_SHOWNORMAL;
        if (!ShellExecuteExW(&launch)) throw std::runtime_error("安装包已下载，但无法打开，请重新尝试");
        BeginQuit();
    }

    void CloseOverlays() {
        if (screen_) screen_->SetWindows({});
        for (auto& overlay : overlays_) {
            overlay.view.reset();
            overlay.frame->Destroy();
        }
        overlays_.clear();
        if (overlayFocusTimer_) overlayFocusTimer_->Stop();
    }
    void SendDisplay() {
        if (display_.is_null()) return;
        for (const auto& entry : overlays_) entry.view->Send({{"channel", "screen-control:display"}, {"value", display_}});
    }
    void ShowDisplay(Json display, ScreenControl::Images images) {
        const bool visible = !display.is_null();
        if (displayImages_ != images) ++displayRevision_;
        displayImages_ = std::move(images);
        if (visible) {
            auto list = Json::array();
            if (displayImages_) {
                const auto prefix = std::string(displayEndpoint) + std::to_string(displayRevision_) + '/';
                for (std::size_t index = 0; index < displayImages_->size(); ++index) {
                    const auto& image = displayImages_->at(index);
                    list.push_back({{"id", image.id}, {"name", image.name}, {"dataUrl", prefix + std::to_string(index)}});
                }
            }
            display["images"] = std::move(list);
        }
        display_ = std::move(display);
        if (browser_) browser_->SetVisible(!visible && !frame_->IsIconized());
        if (!visible) { CloseOverlays(); RaiseMain(); return; }
        if (overlays_.empty()) ReconcileOverlays();
        SendDisplay();
        FocusOverlay();
    }

    void DisplayImage(ICoreWebView2Environment* environment, ICoreWebView2WebResourceRequestedEventArgs* event) {
        ComPtr<ICoreWebView2WebResourceRequest> resource;
        LPWSTR address = nullptr;
        if (!displayImages_ || FAILED(event->get_Request(&resource)) || !resource || FAILED(resource->get_Uri(&address))) {
            DenyResource(environment, event);
            return;
        }
        const auto url = Utf8(TakeString(address));
        const auto prefix = std::string(displayEndpoint) + std::to_string(displayRevision_) + '/';
        if (!url.starts_with(prefix)) { DenyResource(environment, event); return; }
        std::size_t index = 0;
        const auto end = url.data() + url.size();
        const auto parsed = std::from_chars(url.data() + prefix.size(), end, index);
        if (parsed.ec != std::errc{} || parsed.ptr != end || index >= displayImages_->size()) {
            DenyResource(environment, event);
            return;
        }
        const auto image = std::shared_ptr<const ScreenControl::DisplayImage>(displayImages_, &displayImages_->at(index));
        auto pending = std::make_shared<PendingResource>();
        pending->event = event;
        pending->environment = environment;
        pending->contentType = Wide(image->type);
        if (FAILED(event->GetDeferral(&pending->deferral))) { DenyResource(environment, event); return; }
        if (!workers_->Post([this, pending, image] {
            pending->SetBody(image->body);
            pending->status = 200;
            CallAfter([pending] { pending->Complete(); });
        })) {
            pending->status = 429;
            pending->Complete();
        }
    }
    void FocusOverlay() {
        const auto primary = std::find_if(overlays_.begin(), overlays_.end(), [](const Overlay& overlay) { return overlay.primary; });
        if (primary == overlays_.end()) return;
        primary->frame->Show();
        primary->frame->Raise();
        primary->view->Focus();
    }
    void ReconcileOverlays() {
        if (display_.is_null() || shuttingDown_) return;
        struct Monitor { wxString name; wxRect bounds; bool primary; };
        std::vector<Monitor> monitors;
        for (unsigned i = 0; i < wxDisplay::GetCount(); ++i) {
            const wxDisplay display(i);
            auto name = display.GetName();
            if (name.empty()) name = wxString::Format(L"%u", i);
            monitors.push_back({std::move(name), display.GetGeometry(), display.IsPrimary()});
        }
        std::erase_if(overlays_, [&monitors](const Overlay& overlay) {
            if (std::any_of(monitors.begin(), monitors.end(), [&](const Monitor& monitor) { return monitor.name == overlay.displayName; })) return false;
            overlay.frame->Destroy();
            return true;
        });
        std::vector<HWND> windows;
        std::wstring script;
        for (const auto& [name, bounds, primary] : monitors) {
            const auto existing = std::find_if(overlays_.begin(), overlays_.end(), [&](const Overlay& overlay) { return overlay.displayName == name; });
            if (existing != overlays_.end()) {
                auto window = reinterpret_cast<HWND>(existing->frame->GetHandle());
                if (existing->primary != primary) {
                    const auto style = GetWindowLongPtrW(window, GWL_EXSTYLE);
                    SetWindowLongPtrW(window, GWL_EXSTYLE, primary ? style & ~static_cast<LONG_PTR>(WS_EX_NOACTIVATE) : style | WS_EX_NOACTIVATE);
                    existing->primary = primary;
                }
                if (existing->bounds != bounds &&
                    SetWindowPos(window, HWND_TOPMOST, bounds.x, bounds.y, bounds.width, bounds.height, SWP_NOACTIVATE))
                    existing->bounds = bounds;
                existing->view->Resize();
                windows.push_back(window);
                continue;
            }
            if (script.empty()) script = Wide(ReadText(resources_ / L"overlay.js"));
            auto frame = new wxFrame(nullptr, wxID_ANY, L"监考屏幕展示", bounds.GetPosition(), bounds.GetSize(),
                wxBORDER_NONE | wxFRAME_NO_TASKBAR | wxSTAY_ON_TOP | wxCLIP_CHILDREN);
            frame->SetBackgroundColour(*wxBLACK);
            const auto hwnd = reinterpret_cast<HWND>(frame->GetHandle());
            if (!primary) SetWindowLongPtrW(hwnd, GWL_EXSTYLE, GetWindowLongPtrW(hwnd, GWL_EXSTYLE) | WS_EX_NOACTIVATE);
            auto view = std::make_shared<WebView>(hwnd);
            overlays_.push_back({frame, view, name, bounds, primary});
            windows.push_back(hwnd);
            frame->Bind(wxEVT_CLOSE_WINDOW, [this](wxCloseEvent& event) {
                if (!display_.is_null() && event.CanVeto()) event.Veto(); else event.Skip();
            });
            frame->Bind(wxEVT_SIZE, [weak = std::weak_ptr<WebView>(view)](wxSizeEvent& event) {
                if (auto web = weak.lock()) web->Resize();
                event.Skip();
            });
            frame->Bind(wxEVT_ACTIVATE, [this, frame](wxActivateEvent& event) {
                if (!event.GetActive() && !shuttingDown_ && !display_.is_null() && !overlayFocusTimer_->IsRunning()
                    && std::any_of(overlays_.begin(), overlays_.end(), [frame](const Overlay& entry) { return entry.primary && entry.frame == frame; })) {
                    // Match the legacy primary overlay's single delayed refocus.
                    overlayFocusTimer_->StartOnce(50);
                }
                event.Skip();
            });
            frame->SetSize(bounds);
            SetWindowPos(hwnd, HWND_TOPMOST, bounds.x, bounds.y, bounds.width, bounds.height, SWP_NOACTIVATE);
            if (primary) frame->Show(); else frame->ShowWithoutActivating();
            view->Start(*runtime_, data_ / L"WebView2" / L"overlay", resources_ / L"renderer", true, script,
                [this, weak = std::weak_ptr<WebView>(view)] {
                    const auto web = weak.lock();
                    if (!web) return;
                    auto core = web->core();
                    LocalNavigation(core, overlayUrl, [] {});
                    LocalPermissions(core, false);
                    DenyPopups(core);
                    InstallGuard(web->controller(), [](auto) { return true; });
                    EventRegistrationToken token{};
                    auto images = On<ICoreWebView2WebResourceRequestedEventHandler, ICoreWebView2*, ICoreWebView2WebResourceRequestedEventArgs*>(
                        [this, weak](ICoreWebView2*, ICoreWebView2WebResourceRequestedEventArgs* args) {
                            if (const auto view = weak.lock()) DisplayImage(view->environment(), args);
                        });
                    Check(core->AddWebResourceRequestedFilter(L"https://proctor-display.invalid/image/*",
                        COREWEBVIEW2_WEB_RESOURCE_CONTEXT_IMAGE), "Screen display image filter");
                    Check(core->add_WebResourceRequested(images.Get(), &token), "Screen display image response");
                    auto signal = On<ICoreWebView2WebMessageReceivedEventHandler, ICoreWebView2*, ICoreWebView2WebMessageReceivedEventArgs*>(
                        [this, weak](ICoreWebView2*, ICoreWebView2WebMessageReceivedEventArgs* args) {
                            const auto text = Message(args, overlayUrl);
                            const auto value = Json::parse(text, nullptr, false);
                            if (value.is_object() && value.value("channel", "") == "screen-control:ready" && !display_.is_null()) {
                                if (const auto web = weak.lock()) web->Send({{"channel", "screen-control:display"}, {"value", display_}});
                            }
                        });
                    Check(core->add_WebMessageReceived(signal.Get(), &token), "Screen display bridge");
                    auto failed = On<ICoreWebView2ProcessFailedEventHandler, ICoreWebView2*, ICoreWebView2ProcessFailedEventArgs*>(
                        [this, weak](ICoreWebView2*, ICoreWebView2ProcessFailedEventArgs* args) {
                            COREWEBVIEW2_PROCESS_FAILED_KIND kind{};
                            if (FAILED(args->get_ProcessFailedKind(&kind))) return;
                            if (kind != COREWEBVIEW2_PROCESS_FAILED_KIND_BROWSER_PROCESS_EXITED && kind != COREWEBVIEW2_PROCESS_FAILED_KIND_RENDER_PROCESS_EXITED) return;
                            CallAfter([this, weak, kind] {
                                const auto failed = weak.lock();
                                if (!failed || shuttingDown_ || display_.is_null()) return;
                                if (kind == COREWEBVIEW2_PROCESS_FAILED_KIND_RENDER_PROCESS_EXITED &&
                                    failed->core() && SUCCEEDED(failed->core()->Navigate(overlayUrl))) return;
                                failed->Close();
                                std::erase_if(overlays_, [&](const Overlay& overlay) {
                                    if (overlay.view != failed) return false;
                                    overlay.frame->Destroy();
                                    return true;
                                });
                                ReconcileOverlays();
                            });
                        });
                    Check(core->add_ProcessFailed(failed.Get(), &token), "Screen display recovery");
                    web->Navigate(overlayUrl);
                }, [this](std::string error) { Log("screen-control-webview", error); });
        }
        screen_->SetWindows(std::move(windows));
        FocusOverlay();
    }

    HANDLE activation_ = nullptr;
    HANDLE instance_ = nullptr;
    bool com_ = false;
    bool shown_ = false;
    bool shuttingDown_ = false;
    bool shellRecovering_ = false;
    bool shellNavigated_ = false;
    bool shellDocumentReady_ = false;
    std::uint64_t shellDocument_ = 0;
    std::optional<std::chrono::steady_clock::time_point> shellDeadline_;
    std::string mode_ = "setup";
    fs::path executable_, data_, resources_, logs_;
    MainFrame* frame_ = nullptr;
    wxPanel* panel_ = nullptr;
    wxStaticText* loading_ = nullptr;
    wxButton* startupRetry_ = nullptr;
    std::unique_ptr<wxTimer> timer_;
    std::unique_ptr<wxTimer> overlayFocusTimer_;
    std::unique_ptr<Runtime> runtime_;
    std::unique_ptr<DesktopMedia> media_;
    std::unique_ptr<LegacyMigration> migration_;
    std::unique_ptr<NativeWindows> native_;
    std::unique_ptr<ScreenControl> screen_;
    std::unique_ptr<Workers> workers_;
    std::unique_ptr<Workers> frameWorkers_;
    std::unique_ptr<Bridge> bridge_;
    std::unique_ptr<Browser> browser_;
    std::shared_ptr<WebView> shell_;
    std::vector<Overlay> overlays_;
    Json display_;
    ScreenControl::Images displayImages_;
    std::uint64_t displayRevision_ = 0;
};

} // namespace
} // namespace proctor

wxIMPLEMENT_APP_NO_MAIN(proctor::Application);

extern "C" int WINAPI WinMain(HINSTANCE instance, HINSTANCE previous, wxCmdLineArgType command, int show) {
    proctor::startup::Initialize();
    int count = 0;
    LPWSTR* args = CommandLineToArgvW(GetCommandLineW(), &count);
    bool version = false;
    for (int i = 1; args && i < count; ++i) version |= std::wstring_view(args[i]) == L"--proctor-version";
    if (args) LocalFree(args);
    if (version) {
        try {
            const auto exe = proctor::ExePath();
            const auto info = proctor::Json{{"version", PROCTOR_VERSION}, {"arch", PROCTOR_ARCH}, {"packaged", bool(PROCTOR_PACKAGED)},
                {"appPath", proctor::Utf8(exe.parent_path().wstring())}, {"executable", proctor::Utf8(exe.wstring())}}.dump() + "\n";
            DWORD written = 0;
            const auto out = GetStdHandle(STD_OUTPUT_HANDLE);
            return out && out != INVALID_HANDLE_VALUE && WriteFile(out, info.data(), static_cast<DWORD>(info.size()), &written, nullptr)
                && written == info.size() ? 0 : 1;
        } catch (...) { return 1; }
    }
    wxDISABLE_DEBUG_SUPPORT();
    const auto result = wxEntry(instance, previous, command, show);
    proctor::startup::Trace("native-exit");
    return result;
}
