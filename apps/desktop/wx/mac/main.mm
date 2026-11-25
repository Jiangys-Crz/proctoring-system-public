#import <AppKit/AppKit.h>
#import <CoreGraphics/CoreGraphics.h>

#include "browser.hpp"
#include "build_config.hpp"
#include "legacy_launch.hpp"
#include "local_http.hpp"
#include "media.hpp"
#include "migration.hpp"
#include "migration_import.hpp"
#include "native.hpp"

#include <wx/app.h>
#include <wx/display.h>
#include <wx/frame.h>
#include <wx/msgdlg.h>
#include <wx/panel.h>
#include <wx/sizer.h>
#include <wx/timer.h>

#include <atomic>
#include <algorithm>
#include <cerrno>
#include <condition_variable>
#include <cstdio>
#include <cstdlib>
#include <deque>
#include <fstream>
#include <mutex>
#include <set>
#include <thread>
#include <tuple>

#include <fcntl.h>
#include <stdio.h>
#include <sys/file.h>
#include <unistd.h>

@interface ProctorOverlayWindow : NSWindow
@property(nonatomic) BOOL primary;
@end

@implementation ProctorOverlayWindow
- (BOOL)canBecomeKeyWindow { return self.primary; }
- (BOOL)canBecomeMainWindow { return self.primary; }
@end

@interface ProctorOverlayImages : NSObject<WKURLSchemeHandler>
@property(nonatomic, copy) NSDictionary<NSString*, NSArray*>* resources;
@end

@implementation ProctorOverlayImages
- (void)webView:(WKWebView*)view startURLSchemeTask:(id<WKURLSchemeTask>)task {
    NSURL* url = task.request.URL;
    NSArray* entry = self.resources[url.absoluteString ?: @""];
    if (!entry || ![task.request.HTTPMethod isEqualToString:@"GET"]) {
        [task didFailWithError:[NSError errorWithDomain:NSURLErrorDomain code:NSURLErrorFileDoesNotExist userInfo:nil]];
        return;
    }
    NSString* mime = entry[0];
    NSData* bytes = entry[1];
    NSURLResponse* response = [[NSURLResponse alloc] initWithURL:url MIMEType:mime
        expectedContentLength:static_cast<NSInteger>(bytes.length) textEncodingName:nil];
    [task didReceiveResponse:response];
    [task didReceiveData:bytes];
    [task didFinish];
}
- (void)webView:(WKWebView*)view stopURLSchemeTask:(id<WKURLSchemeTask>)task {}
@end

namespace proctor {
namespace {
namespace fs = std::filesystem;
constexpr auto title = "程序设计算法协会监考客户端";

wxString W(std::string_view value) { return wxString::FromUTF8(value.data(), value.size()); }

std::string Argument(const Json& args, std::size_t index) {
    return args.is_array() && args.size() > index && args[index].is_string() ? args[index].get<std::string>() : "";
}

NSDictionary<NSString*, NSArray*>* PrepareOverlayImages(Json& display, std::vector<MacScreenImage> images) {
    if (display.is_null()) return nil;
    auto* resources = [NSMutableDictionary<NSString*, NSArray*> new];
    NSString* prefix = [@"proctor-display://broadcast/" stringByAppendingString:NSUUID.UUID.UUIDString];
    auto& entries = display.at("images");
    for (std::size_t i = 0; i < images.size(); ++i) {
        auto body = std::make_shared<std::string>(std::move(images[i].bytes));
        auto* bytes = [[NSData alloc] initWithBytesNoCopy:body->data() length:body->size()
            deallocator:^(void*, NSUInteger) { (void)body; }];
        NSString* address = [prefix stringByAppendingFormat:@"/%lu", static_cast<unsigned long>(i)];
        resources[address] = @[Ns(images[i].mime), bytes];
        entries.at(i)["dataUrl"] = Utf8(address);
    }
    return [resources copy];
}

bool EnsureInstallation() {
    if (!PROCTOR_PACKAGED) return true;
    auto* source = NSBundle.mainBundle.bundleURL.URLByResolvingSymlinksInPath;
    const fs::path path(Utf8(source.path));
    const fs::path applications("/Applications");
    const fs::path userApplications = fs::path(Utf8(NSHomeDirectory())) / "Applications";
    if (path.parent_path() == applications || path.parent_path() == userApplications) return true;

    wxMessageDialog choice(nullptr, W("请先将新版安装到“应用程序”\n\n"
        "安装后会替换“应用程序”中的旧版本并重新打开。请先完全退出其他监考客户端，正在考试时请稍后更新。\n\n当前文件：") +
        W(Utf8(NSBundle.mainBundle.executablePath)), W("安装监考客户端 v" PROCTOR_VERSION), wxOK | wxCANCEL | wxICON_INFORMATION);
    choice.SetOKCancelLabels(W("安装并重新打开"), W("退出"));
    if (choice.ShowModal() != wxID_OK) return false;

    for (NSRunningApplication* app in [NSRunningApplication runningApplicationsWithBundleIdentifier:NSBundle.mainBundle.bundleIdentifier]) {
        if (app.processIdentifier != getpid() && !app.terminated) {
            wxMessageBox(W("新版尚未替换旧版，请完全退出旧客户端后再试。"), W("尚未完成安装"), wxOK | wxICON_WARNING);
            return false;
        }
    }
    auto* files = NSFileManager.defaultManager;
    auto destination = applications / path.filename();
    auto* target = [NSURL fileURLWithPath:Ns(destination.string()) isDirectory:YES];
    const auto personal = userApplications / path.filename();
    auto* personalTarget = [NSURL fileURLWithPath:Ns(personal.string()) isDirectory:YES];
    if (![files fileExistsAtPath:target.path] &&
        [[NSBundle bundleWithURL:personalTarget].bundleIdentifier isEqualToString:NSBundle.mainBundle.bundleIdentifier]) {
        destination = personal;
        target = personalTarget;
    }
    const auto staging = destination.parent_path() / (".proctor-install-" + Utf8(NSUUID.UUID.UUIDString));
    auto* temporary = [NSURL fileURLWithPath:Ns(staging.string()) isDirectory:YES];
    NSError* error = nil;
    bool installed = [files copyItemAtURL:source toURL:temporary error:&error];
    if (installed) {
        // Keep the old application in place until the complete copy is ready.
        const bool replacing = [files fileExistsAtPath:target.path];
        const int flags = replacing ? RENAME_SWAP : RENAME_EXCL;
        installed = renamex_np(staging.c_str(), destination.c_str(), flags) == 0;
    }
    [files removeItemAtURL:temporary error:nullptr];
    if (!installed) {
        wxMessageBox(W("请退出旧客户端，确认“应用程序”目录允许写入，再重新安装。\n") + W(Utf8(error.localizedDescription)),
            W("无法安装监考客户端"), wxOK | wxICON_ERROR);
        return false;
    }
    auto* options = [NSWorkspaceOpenConfiguration configuration];
    options.createsNewApplicationInstance = YES;
    [NSWorkspace.sharedWorkspace openApplicationAtURL:target configuration:options completionHandler:nil];
    return false;
}

class Tasks {
public:
    explicit Tasks(int count) {
        try {
            for (int i = 0; i < count; ++i) {
                threads_.emplace_back([this] {
                    for (;;) {
                        std::function<void()> work;
                        {
                            std::unique_lock lock(mutex_);
                            condition_.wait(lock, [this] { return stopping_ || !queue_.empty(); });
                            if (queue_.empty()) return;
                            work = std::move(queue_.front());
                            queue_.pop_front();
                        }
                        @autoreleasepool {
                            try { work(); } catch (...) {}
                        }
                        --pending_;
                    }
                });
            }
        } catch (...) {
            Stop();
            throw;
        }
    }
    ~Tasks() { Stop(); }
    bool Post(std::function<void()> work) {
        std::lock_guard lock(mutex_);
        if (stopping_ || queue_.size() >= 96) return false;
        queue_.push_back(std::move(work));
        ++pending_;
        condition_.notify_one();
        return true;
    }
    bool Idle() const { return pending_ == 0; }

private:
    void Stop() {
        {
            std::lock_guard lock(mutex_);
            stopping_ = true;
        }
        condition_.notify_all();
        for (auto& thread : threads_) if (thread.joinable()) thread.join();
    }
    std::mutex mutex_;
    std::condition_variable condition_;
    std::deque<std::function<void()>> queue_;
    std::atomic<unsigned> pending_{};
    bool stopping_ = false;
    std::vector<std::thread> threads_;
};

class DesktopApp : public wxApp {
public:
    bool OnInit() override {
        SetAppName(W(title));
        SetExitOnFrameDelete(false);
        try { return Open(); }
        catch (const std::exception& error) {
            Log("startup", error.what());
            wxMessageBox(W("监考客户端组件加载失败。请联系监考老师检查日志及客户端安装。"), W(title), wxOK | wxICON_ERROR);
            Dispose();
            return false;
        }
    }

    int OnExit() override {
        Dispose();
        return wxApp::OnExit();
    }

    void MacReopenApp() override {
        if (quitting_ || migrating_ || !frame_) return;
        if (Displaying()) { FocusOverlay(); return; }
        if (!shell_) StartShell();
        if (frame_->IsIconized()) frame_->Iconize(false);
        if (shown_) { frame_->Show(); frame_->Raise(); }
    }

private:
    struct Overlay {
        CGDirectDisplayID display;
        ProctorOverlayWindow* window;
        WKWebView* view;
        bool ready = false;
    };

    bool Open() {
        if (!EnsureInstallation()) return false;
        auto* support = [NSFileManager.defaultManager URLsForDirectory:NSApplicationSupportDirectory inDomains:NSUserDomainMask].firstObject;
        const fs::path applicationSupport(Utf8(support.path));
        if (applicationSupport.empty()) throw std::runtime_error("无法读取 macOS 应用数据目录");
        applicationSupport_ = applicationSupport;
        resources_ = Utf8(NSBundle.mainBundle.resourcePath);
        data_ = applicationSupport / "org.cwnupaa.proctor" / "wkwebview";
        fs::create_directories(data_);
        fs::permissions(data_, fs::perms::owner_all, fs::perm_options::replace);
        instance_ = open((data_ / "instance.lock").c_str(), O_CREAT | O_RDWR | O_CLOEXEC | O_NOFOLLOW, 0600);
        if (instance_ < 0) throw std::runtime_error("无法锁定客户端数据目录");
        if (flock(instance_, LOCK_EX | LOCK_NB) != 0) {
            const auto error = errno;
            close(instance_);
            instance_ = -1;
            if (error != EWOULDBLOCK) throw std::runtime_error("无法锁定客户端数据目录");
            for (NSRunningApplication* app in [NSRunningApplication runningApplicationsWithBundleIdentifier:NSBundle.mainBundle.bundleIdentifier]) {
                if (app.processIdentifier != getpid() && !app.terminated) [app activateWithOptions:0];
            }
            wxMessageDialog warning(nullptr, W("当前打开的是 v" PROCTOR_VERSION "，请先退出已经运行的客户端"),
                W("已有监考客户端正在运行"), wxOK | wxICON_WARNING);
            warning.SetExtendedMessage(W("关闭窗口可能不会退出应用。请在旧客户端按 Command-Q，再从“应用程序”打开新版；考试进行中请先完成考试。"));
            warning.SetOKLabel(W("退出"));
            warning.ShowModal();
            return false;
        }
        MigrateMacDeviceId(data_, applicationSupport);
        media_ = std::make_unique<DesktopMedia>(resources_ / "ffmpeg" / "ffmpeg");
        http_ = std::make_unique<LocalHttp>(resources_ / "renderer", data_, *media_);
        workers_ = std::make_unique<Tasks>(4);
        capture_ = std::make_unique<Tasks>(4);
        native_ = std::make_unique<NativeMac>(resources_, data_, PROCTOR_VERSION, PROCTOR_PACKAGED, [this] {
            CallAfter([this] {
                if (browser_ && !quitting_) browser_->OpenReference("https://www.wireshark.org/download.html");
            });
        });
        screen_ = std::make_unique<MacScreenControl>([this](Json value, std::vector<MacScreenImage> images) {
            @autoreleasepool {
                auto* resources = PrepareOverlayImages(value, std::move(images));
                CallAfter([this, value = std::move(value), resources]() mutable {
                    if (!quitting_) Display(std::move(value), resources);
                });
            }
        });

        frame_ = new wxFrame(nullptr, wxID_ANY, W(title), wxDefaultPosition, wxSize(1280, 820));
        frame_->SetMinSize(wxSize(640, 480));
        frame_->SetBackgroundColour(wxColour(15, 23, 42));
        SetTopWindow(frame_);
        panel_ = new wxPanel(frame_, wxID_ANY);
        panel_->SetBackgroundColour(wxColour(15, 23, 42));
        auto* sizer = new wxBoxSizer(wxVERTICAL);
        sizer->Add(panel_, 1, wxEXPAND);
        frame_->SetSizer(sizer);
        frame_->Bind(wxEVT_CLOSE_WINDOW, [this](wxCloseEvent& event) {
            if (event.CanVeto()) event.Veto();
            if (!Blocked() && mode_ == "setup" && !quitting_) CloseClient();
        });
        frame_->Bind(wxEVT_SIZE, [this](wxSizeEvent& event) { if (browser_) browser_->Resize(); event.Skip(); });
        frame_->Bind(wxEVT_DPI_CHANGED, [this](wxDPIChangedEvent& event) { if (browser_) browser_->Resize(); event.Skip(); });
        frame_->Bind(wxEVT_ICONIZE, [this](wxIconizeEvent& event) {
            if (event.IsIconized() && (mode_ != "setup" || Displaying())) {
                CallAfter([this] { if (frame_ && !quitting_) frame_->Iconize(false); });
            }
            if (browser_) browser_->SetVisible(!event.IsIconized());
            event.Skip();
        });
        Bind(wxEVT_QUERY_END_SESSION, [this](wxCloseEvent& event) {
            if (event.CanVeto()) {
                event.Veto();
                if (mode_ == "setup" && !Displaying()) BeginQuit();
            } else event.Skip();
        });
        Bind(wxEVT_END_SESSION, [this](wxCloseEvent& event) { BeginQuit(); });
        timer_.SetOwner(this);
        Bind(wxEVT_TIMER, [this](wxTimerEvent&) { CompleteQuit(); }, timer_.GetId());
        overlayFocus_.SetOwner(this);
        Bind(wxEVT_TIMER, [this](wxTimerEvent&) { if (Displaying() && !quitting_) FocusOverlay(); }, overlayFocus_.GetId());

        auto* notifications = NSNotificationCenter.defaultCenter;
        appActivated_ = [notifications addObserverForName:NSApplicationDidBecomeActiveNotification object:NSApp
            queue:nil usingBlock:^(NSNotification*) { if (!shell_) MacReopenApp(); }];
        screenChange_ = [notifications addObserverForName:NSApplicationDidChangeScreenParametersNotification object:NSApp
            queue:nil usingBlock:^(NSNotification*) { if (Displaying() && !quitting_) ReconcileOverlays(); }];
        overlayBlur_ = [notifications addObserverForName:NSWindowDidResignKeyNotification object:nil
            queue:nil usingBlock:^(NSNotification* event) {
                if (!Displaying() || quitting_ || overlayFocus_.IsRunning()) return;
                for (const auto& overlay : overlays_) {
                    if (overlay.window == event.object && overlay.window.primary) { overlayFocus_.StartOnce(50); break; }
                }
            }];

        keyMonitor_ = [NSEvent addLocalMonitorForEventsMatchingMask:NSEventMaskKeyDown handler:^NSEvent*(NSEvent* event) {
            return AllowKey(event) ? event : nil;
        }];
        [NSApp setMainMenu:nil];

        bridge_ = std::make_unique<Bridge>(
            Bridge::Config{PROCTOR_VERSION, resources_ / "renderer", data_, PROCTOR_PACKAGED, resources_},
            [this](auto channel, const auto& args, auto reply) { Dispatch(channel, args, std::move(reply)); },
            [this](const Json& message) { if (shell_ && !quitting_) Send(shell_, message); },
            [this](const fs::path& installer) { return Install(installer); },
            [this](std::function<void()> work) { CallAfter(std::move(work)); });
        bridge_->SetApiPolicy([this](std::string_view url) { return browser_ && browser_->ApiAllowed(url); });
        bridge_->SetInstallAllowed([this] { return shell_ && !quitting_ && mode_ == "setup" && !Displaying(); });
        bridge_->SetSubmitAllowed([this] { return !quitting_ && !Blocked(); });
        BeginLegacyMigration(applicationSupport);
        return true;
    }

    void BeginLegacyMigration(const fs::path& support) {
        migrating_ = true;
        const fs::path bundle(Utf8(NSBundle.mainBundle.bundlePath));
        if (workers_->Post([this, bundle, support] {
            auto result = ExportLegacyProfile(bundle, support, data_, cancelExport_);
            CallAfter([this, result = std::move(result)] {
                legacyStage_ = result.stage;
                if (quitting_) { DeleteLegacyStage(); return; }
                if (result.state != LegacyExport::Exported) {
                    FinishLegacyMigration(result.state != LegacyExport::Failed);
                    return;
                }
                legacyImport_ = MacLegacyImport::Begin(legacyStage_, data_, http_->Origin(), NativeView(*panel_),
                    [this](bool imported) { CallAfter([this, imported] { FinishLegacyMigration(imported); }); });
            });
        })) return;
        FinishLegacyMigration(false);
    }

    void DeleteLegacyStage() {
        if (legacyStage_.empty()) return;
        const auto remove = [stage = std::exchange(legacyStage_, {})] {
            std::error_code ignored;
            fs::remove_all(stage, ignored);
        };
        // A migration can leave many video files in the staging directory.
        // Let the main window paint while a worker removes them.
        if (!workers_ || !workers_->Post(remove)) remove();
    }

    void FinishLegacyMigration(bool imported) {
        legacyImport_.reset();
        DeleteLegacyStage();
        migrating_ = false;
        if (quitting_) return;
        if (!imported) Log("legacy-import", "migration incomplete; will retry on startup");
        StartShell();
    }

    void StartShell() {
        const auto address = http_->Origin() + "/index.html";
        auto* parent = NativeView(*panel_);
        auto* config = Configuration(Profile(@"94FF00CB-DF32-4727-B7E9-B4F8ABC11228"));
        config.preferences.inactiveSchedulingPolicy = WKInactiveSchedulingPolicyNone;
        config.mediaTypesRequiringUserActionForPlayback = WKAudiovisualMediaTypeNone;
        ViewHooks hooks;
        hooks.trusted = address;
        hooks.capture = true;
        hooks.dialogs = [this, address](std::string_view url) { return url == address && !Displaying(); };
        hooks.message = [this](const Json& message) {
            if (quitting_) return;
            try {
                if (message.contains("guest")) browser_->Message(message);
                else bridge_->HandleParsedMessage(message);
            } catch (const std::exception& error) {
                Log("renderer-message", error.what());
            }
        };
        hooks.started = [this] {
            if (quitting_) return;
            // Outstanding calls and captures belong to the departing document.
            bridge_->NewDocument();
            CleanMonitoring();
        };
        hooks.finished = [this](WKNavigation*, std::string, int error) {
            if (quitting_ || error == NSURLErrorCancelled) return;
            if (error) { Failure("renderer-load-failed", error); return; }
            if (!shown_) {
                shown_ = true;
                frame_->Maximize();
                frame_->Show();
                browser_->SetVisible(!Displaying());
            }
        };
        hooks.crashed = [this, address] {
            auto* crashed = shell_;
            CallAfter([this, address, crashed] {
                if (!shell_ || shell_ != crashed || quitting_) return;
                bridge_->NewDocument();
                CleanMonitoring();
                Log("render-process-gone", "");
                if (!bridge_->BeginRendererRecovery(mode_ != "setup" || Displaying())) {
                    Failure("renderer-recovery-failed", 0);
                    return;
                }
                Load(shell_, address);
            });
        };
        shell_ = CreateView(config, parent, std::move(hooks));
        const char* dev = std::getenv("PROCTOR_DEV");
        shell_.inspectable = dev && std::string_view(dev) == "1";
        browser_ = std::make_unique<MacBrowser>(*frame_, parent, *bridge_,
            [this](const Json& message) { if (shell_ && !quitting_) Send(shell_, message); },
            [this] { return Blocked(); },
            [this](std::function<void()> work) { return workers_->Post(std::move(work)); },
            [this, bundle = fs::path(Utf8(NSBundle.mainBundle.bundlePath)), support = applicationSupport_, data = data_]
            (const LegacyDraftTarget& target, const std::atomic_bool& stop) {
                const auto identity = std::tuple{target.origin, target.backend, target.sessionId};
                {
                    const std::lock_guard lock(legacyDraftMutex_);
                    if (legacyDraftAttempts_.contains(identity)) return std::string{};
                }
                if (stop || !HasLegacyDraftSource(support) || !AuthorizeLegacyDrafts(target, &stop)) return std::string{};
                {
                    const std::lock_guard lock(legacyDraftMutex_);
                    if (stop || !legacyDraftAttempts_.insert(identity).second) return std::string{};
                }
                return ExportLegacyDrafts(bundle, support, data, target.origin, target.backend, target.sessionId, stop);
            });
        Load(shell_, address);
    }

    void CloseClient() {
        bridge_->NewDocument();
        CleanMonitoring();
        browser_.reset();
        DetachView(shell_);
        shell_ = nil;
        shown_ = false;
        frame_->Hide();
    }

    void Dispatch(std::string_view channel, const Json& args, Bridge::Reply reply) {
        if (quitting_) { reply(nullptr, "客户端正在退出"); return; }
        if (browser_->Dispatch(channel, args, reply)) return;
        if (channel == "window:mode" || channel == "app:quit") {
            const auto next = channel == "app:quit" ? "exit" : Argument(args, 0);
            if (next == "exit") {
                if (Displaying()) { reply(nullptr, "请等待监考老师结束屏幕展示"); return; }
                SetMode("setup");
                reply(nullptr, {});
                CallAfter([this] { BeginQuit(); });
                return;
            }
            if (next == "setup" || next == "floating" || next == "locked") SetMode(next);
            reply(nullptr, {});
        } else if (channel == "app:relaunchAsAdmin") {
            if (Displaying()) reply(nullptr, "屏幕展示期间不能重新启动客户端");
            else reply(false, {});
        } else if (channel == "screen-control:isDisplaying") {
            reply(Displaying(), {});
        } else if (channel == "screen-control:release") {
            screen_->Release();
            reply(nullptr, {});
        } else if (channel == "screen-control:watch") {
            const auto& identity = args.at(0);
            const auto endpoint = ParseHttpUrl(identity.at("baseUrl").get<std::string>()).origin + "/api/client/screen-control";
            if (!browser_->ApiAllowed(endpoint)) { reply(nullptr, "当前不允许访问该地址：" + endpoint); return; }
            auto wait = screen_->PrepareWatch(identity);
            Queue(*workers_, std::move(reply), [wait = std::move(wait)] { wait(); return Json(nullptr); });
        } else if (channel.starts_with("desktop:")) {
            Queue(*capture_, std::move(reply), [this, channel = std::string(channel), args, generation = media_->Generation()] {
                return media_->Invoke(channel, args, generation);
            });
        } else if (channel == "security:confirmPeripheralBaseline") {
            if (Displaying() || mode_ != "setup") { reply(nullptr, "请先结束当前考试或屏幕展示，再检测登录设备"); return; }
            Queue(*workers_, [this, reply](Json result, std::string error) {
                if (error.empty() && (Displaying() || mode_ != "setup")) error = "客户端状态已改变，请重新检测登录设备";
                reply(std::move(result), std::move(error));
            }, [this, args] { return native_->Handle("security:confirmPeripheralBaseline", args, "setup"); });
        } else if (channel.starts_with("security:") || channel.starts_with("permissions:") || channel == "system:getInfo") {
            const auto input = channel == "security:snapshot"
                ? Json::array({browser_->SnapshotHosts(args.empty() ? Json::array() : args[0]), args.size() < 2 || args[1] != false}) : args;
            Queue(*workers_, std::move(reply), [this, channel = std::string(channel), input, mode = mode_] {
                return native_->Handle(channel, input, mode);
            });
        } else reply(nullptr, "未知客户端操作");
    }

    void Queue(Tasks& pool, Bridge::Reply reply, std::function<Json()> work) {
        if (!pool.Post([this, reply, work = std::move(work)] {
            Json result;
            std::string failure;
            try { result = work(); }
            catch (const std::exception& e) { failure = e.what(); }
            catch (...) { failure = "客户端操作失败"; }
            CallAfter([this, reply, result = std::move(result), failure = std::move(failure)]() mutable {
                if (!quitting_) reply(std::move(result), std::move(failure));
            });
        })) reply(nullptr, "客户端操作繁忙，请稍后重试");
    }

    void SetMode(const std::string& next) {
        if (next == "setup") bridge_->ResetNovaJudge();
        if (mode_ == next) return;
        const bool changingLock = (mode_ == "locked") != (next == "locked");
        mode_ = next;
        NSWindow* window = NativeView(*panel_).window;
        [window standardWindowButton:NSWindowCloseButton].enabled = mode_ == "setup";
        [window standardWindowButton:NSWindowMiniaturizeButton].enabled = mode_ == "setup";
        if (changingLock) {
            if (mode_ == "locked" && frame_->IsIconized()) frame_->Iconize(false);
            frame_->ShowFullScreen(mode_ == "locked");
            window.level = mode_ == "locked" ? CGWindowLevelForKey(kCGScreenSaverWindowLevelKey) : NSNormalWindowLevel;
            SetKiosk(mode_ == "locked");
        }
        browser_->SetVisible(!frame_->IsIconized());
    }

    void SetKiosk(bool locked) {
        if (locked == kiosk_) return;
        if (locked) {
            previousPresentation_ = NSApp.presentationOptions;
            // Match the controls disabled by Electron while a cheating or
            // peripheral lock is active. Restore them as soon as it ends.
            NSApp.presentationOptions =
                NSApplicationPresentationHideDock | NSApplicationPresentationHideMenuBar |
                NSApplicationPresentationDisableAppleMenu | NSApplicationPresentationDisableProcessSwitching |
                NSApplicationPresentationDisableForceQuit | NSApplicationPresentationDisableSessionTermination |
                NSApplicationPresentationDisableHideApplication;
        } else NSApp.presentationOptions = previousPresentation_;
        kiosk_ = locked;
    }

    bool Displaying() const { return screen_ && screen_->IsDisplaying(); }
    bool Blocked() const { return mode_ == "locked" || Displaying(); }

    bool AllowKey(NSEvent* event) {
        if (Displaying()) return false;
        if (!shell_) return true;
        const auto flags = event.modifierFlags;
        const auto key = Utf8(event.charactersIgnoringModifiers.lowercaseString);
        const bool mac = flags & NSEventModifierFlagCommand;
        const bool command = mac || (flags & NSEventModifierFlagControl);
        const bool alt = flags & NSEventModifierFlagOption;
        // There is no application menu to dispatch these Cocoa editing actions.
        if (event.window && event.window == NSApp.keyWindow && mac
            && !(flags & (NSEventModifierFlagOption | NSEventModifierFlagControl | NSEventModifierFlagShift))) {
            SEL action = nullptr;
            if (key == "a") action = @selector(selectAll:);
            else if (key == "c") action = @selector(copy:);
            else if (key == "v") action = @selector(paste:);
            else if (key == "x") action = @selector(cut:);
            if (action) return mode_ != "locked" && ![NSApp sendAction:action to:nil from:nil];
        }
        if (event.window != shell_.window) return true;
        if ((command && key == "r") || event.keyCode == 96) {
            if (!quitting_) bridge_->Push("browser:refresh-shortcut");
            return false;
        }
        if (event.keyCode == 103 || event.keyCode == 111 || (alt && event.keyCode == 118)) return false;
        if (command && (key == "q" || key == "w")) return false;
        if (mac && (key == "[" || key == "]" || key == "h" || key == "m")) return false;
        if (alt && (event.keyCode == 123 || event.keyCode == 124 || key == " ")) return false;
        if (mac && alt && key == "i") return false;
        return !(command && (flags & NSEventModifierFlagShift) && (key == "c" || key == "i" || key == "j"));
    }

    void Display(Json value, NSDictionary<NSString*, NSArray*>* resources) {
        const bool wasDisplaying = !display_.is_null();
        display_ = std::move(value);
        if (browser_) browser_->SetVisible(!frame_->IsIconized());
        if (display_.is_null()) {
            CloseOverlays();
            if (wasDisplaying && shell_) MacReopenApp();
            return;
        }
        if (!overlayImages_) overlayImages_ = [ProctorOverlayImages new];
        overlayImages_.resources = resources;
        ReconcileOverlays();
        for (const auto& overlay : overlays_) if (overlay.ready) SendDisplay(overlay.view);
    }

    void ReconcileOverlays() {
        if (display_.is_null()) return;
        NSArray<NSScreen*>* screens = NSScreen.screens;
        auto displayId = [](NSScreen* screen) {
            return static_cast<CGDirectDisplayID>([screen.deviceDescription[@"NSScreenNumber"] unsignedIntValue]);
        };
        std::erase_if(overlays_, [&](const Overlay& overlay) {
            for (NSScreen* screen in screens) if (displayId(screen) == overlay.display) return false;
            DestroyOverlay(overlay);
            return true;
        });
        const auto url = http_->Origin() + "/screen-control.html";
        for (NSScreen* screen in screens) {
            const auto id = displayId(screen);
            const bool primary = id == CGMainDisplayID();
            const auto existing = std::find_if(overlays_.begin(), overlays_.end(), [id](const Overlay& overlay) {
                return overlay.display == id;
            });
            if (existing != overlays_.end()) {
                existing->window.primary = primary;
                if (!NSEqualRects(existing->window.frame, screen.frame)) [existing->window setFrame:screen.frame display:YES];
                continue;
            }
            auto* window = [[ProctorOverlayWindow alloc] initWithContentRect:screen.frame
                styleMask:NSWindowStyleMaskBorderless backing:NSBackingStoreBuffered defer:NO];
            window.primary = primary;
            window.title = @"监考屏幕展示";
            window.backgroundColor = NSColor.blackColor;
            window.releasedWhenClosed = NO;
            window.movable = NO;
            window.hidesOnDeactivate = NO;
            window.level = CGWindowLevelForKey(kCGScreenSaverWindowLevelKey) + 1;
            window.collectionBehavior = NSWindowCollectionBehaviorCanJoinAllSpaces | NSWindowCollectionBehaviorFullScreenAuxiliary;
            auto* config = Configuration(WKWebsiteDataStore.nonPersistentDataStore);
            [config setURLSchemeHandler:overlayImages_ forURLScheme:@"proctor-display"];
            ViewHooks hooks;
            hooks.trusted = url;
            hooks.message = [this, id](const Json& message) {
                if (message.value("channel", "") != "screen-control:ready") return;
                for (auto& overlay : overlays_) if (overlay.display == id) {
                    overlay.ready = true;
                    SendDisplay(overlay.view);
                    break;
                }
            };
            hooks.crashed = [this, id, url] {
                CallAfter([this, id, url] {
                    if (!Displaying() || quitting_) return;
                    for (auto& overlay : overlays_) if (overlay.display == id) {
                        overlay.ready = false;
                        Load(overlay.view, url);
                        break;
                    }
                });
            };
            auto* view = CreateView(config, window.contentView, std::move(hooks));
            overlays_.push_back({id, window, view});
            [window orderFrontRegardless];
            Load(view, url);
        }
        FocusOverlay();
    }

    void SendDisplay(WKWebView* view) {
        if (!display_.is_null()) Send(view, {{"channel", "screen-control:display"}, {"value", display_}});
    }

    void FocusOverlay() {
        if (overlays_.empty()) return;
        auto primary = std::find_if(overlays_.begin(), overlays_.end(), [](const Overlay& overlay) {
            return overlay.window.primary;
        });
        if (primary == overlays_.end()) primary = overlays_.begin();
        primary->window.primary = YES;
        if (!NSApp.active) [NSApp activate];
        if (!primary->window.keyWindow) [primary->window makeKeyAndOrderFront:nil];
    }

    void DestroyOverlay(const Overlay& overlay) {
        DetachView(overlay.view);
        [overlay.window orderOut:nil];
        [overlay.window close];
    }

    void CloseOverlays() {
        overlayFocus_.Stop();
        for (const auto& overlay : overlays_) DestroyOverlay(overlay);
        overlays_.clear();
        overlayImages_ = nil;
    }

    void CleanMonitoring() {
        if (media_) media_->StopAll();
        if (native_) native_->StopMonitoring();
        if (bridge_) bridge_->ResetNovaJudge();
        if (browser_) browser_->Reset();
    }

    void BeginQuit() {
        if (quitting_) return;
        quitting_ = true;
        cancelExport_ = true;
        if (legacyImport_) legacyImport_->Cancel();
        screen_->Release();
        CloseOverlays();
        CleanMonitoring();
        timer_.Start(40);
    }

    void CompleteQuit() {
        if (!workers_->Idle() || !capture_->Idle()) return;
        if (!bridgeShutdown_) {
            bridgeShutdown_ = true;
            workers_->Post([this] { bridge_->Shutdown(); });
            return;
        }
        timer_.Stop();
        ExitMainLoop();
    }

    bool Install(const fs::path& path) {
        if (quitting_ || mode_ != "setup" || Displaying()) throw std::runtime_error("请先结束当前考试或屏幕展示，再更新客户端");
        auto* bundle = NSBundle.mainBundle.bundleURL;
        wxMessageDialog choice(frame_, W("请在原安装位置替换旧版本"), W("安装包已下载"), wxOK | wxCANCEL | wxICON_INFORMATION);
        choice.SetExtendedMessage(W("当前安装位置：") + W(Utf8(bundle.path)) +
            W("\n\n客户端将先退出。请打开安装包中的新版客户端，选择“安装并重新打开”，完成后从“应用程序”启动。仅下载或打开安装包不会替换旧版本。"));
        choice.SetOKCancelLabels(W("打开安装包并退出"), W("稍后安装"));
        if (choice.ShowModal() != wxID_OK) return false;
        if (quitting_ || mode_ != "setup" || Displaying()) throw std::runtime_error("请先结束当前考试或屏幕展示，再更新客户端");
        if (![NSWorkspace.sharedWorkspace openURL:[NSURL fileURLWithPath:Ns(path.string())]]) {
            throw std::runtime_error("安装包已下载，但无法打开，请重新尝试");
        }
        if ([bundle.pathExtension.lowercaseString isEqualToString:@"app"])
            [NSWorkspace.sharedWorkspace activateFileViewerSelectingURLs:@[bundle]];
        BeginQuit();
        return true;
    }

    void Dispose() {
        cancelExport_ = true;
        if (legacyImport_) legacyImport_->Cancel();
        legacyImport_.reset();
        DeleteLegacyStage();
        if (keyMonitor_) [NSEvent removeMonitor:keyMonitor_];
        keyMonitor_ = nil;
        if (appActivated_) [NSNotificationCenter.defaultCenter removeObserver:appActivated_];
        if (screenChange_) [NSNotificationCenter.defaultCenter removeObserver:screenChange_];
        if (overlayBlur_) [NSNotificationCenter.defaultCenter removeObserver:overlayBlur_];
        appActivated_ = screenChange_ = overlayBlur_ = nil;
        CloseOverlays();
        SetKiosk(false);
        browser_.reset();
        if (shell_) DetachView(shell_);
        shell_ = nil;
        if (screen_) screen_->Release();
        if (media_) media_->StopAll();
        if (bridge_) bridge_->Shutdown();
        capture_.reset();
        workers_.reset();
        screen_.reset();
        bridge_.reset();
        native_.reset();
        http_.reset();
        media_.reset();
        if (instance_ >= 0) close(instance_);
        instance_ = -1;
    }

    void Failure(std::string_view name, int code) {
        Log(name, std::to_string(code));
        wxMessageBox(W("客户端页面未能正常加载，请联系监考老师检查日志及客户端安装。"), W(title), wxOK | wxICON_ERROR, frame_);
    }
    void Log(std::string_view event, std::string_view detail) const {
        if (data_.empty()) return;
        try {
            const auto file = data_ / "startup.log";
            std::error_code error;
            if (fs::file_size(file, error) > 512 * 1024 && !error) std::ofstream(file, std::ios::trunc);
            std::ofstream(file, std::ios::app) << "v" << PROCTOR_VERSION << " mac/" << PROCTOR_ARCH
                << ' ' << event << ": " << detail << '\n';
        } catch (...) {}
    }

    fs::path resources_, data_, applicationSupport_, legacyStage_;
    std::mutex legacyDraftMutex_;
    std::set<std::tuple<std::string, std::string, std::string>> legacyDraftAttempts_;
    int instance_ = -1;
    std::unique_ptr<LocalHttp> http_;
    std::unique_ptr<Tasks> workers_, capture_;
    std::unique_ptr<NativeMac> native_;
    std::unique_ptr<DesktopMedia> media_;
    std::unique_ptr<MacScreenControl> screen_;
    std::unique_ptr<Bridge> bridge_;
    std::unique_ptr<MacBrowser> browser_;
    std::shared_ptr<MacLegacyImport> legacyImport_;
    wxFrame* frame_ = nullptr;
    wxPanel* panel_ = nullptr;
    WKWebView* shell_ = nil;
    id keyMonitor_ = nil, appActivated_ = nil, screenChange_ = nil, overlayBlur_ = nil;
    wxTimer timer_, overlayFocus_;
    std::vector<Overlay> overlays_;
    ProctorOverlayImages* overlayImages_ = nil;
    Json display_;
    std::string mode_ = "setup";
    bool shown_ = false, quitting_ = false, bridgeShutdown_ = false;
    bool migrating_ = false, kiosk_ = false;
    NSApplicationPresentationOptions previousPresentation_ = NSApplicationPresentationDefault;
    std::atomic_bool cancelExport_{false};
};
} // namespace
} // namespace proctor

wxIMPLEMENT_APP_NO_MAIN(proctor::DesktopApp);

int main(int argc, char** argv) {
    for (int i = 1; i < argc; ++i) {
        if (std::string_view(argv[i]) == "--proctor-version") {
            @autoreleasepool {
                const auto info = proctor::Json{{"version", PROCTOR_VERSION}, {"arch", PROCTOR_ARCH},
                    {"packaged", bool(PROCTOR_PACKAGED)}, {"appPath", proctor::Utf8(NSBundle.mainBundle.bundlePath)},
                    {"executable", proctor::Utf8(NSBundle.mainBundle.executablePath)}}.dump();
                std::puts(info.c_str());
            }
            return 0;
        }
    }
    return wxEntry(argc, argv);
}
