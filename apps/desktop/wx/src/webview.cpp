#include "webview.hpp"
#include "build_config.hpp"

#include <fstream>
#include <iterator>
#include <stdexcept>
#include <vector>

namespace proctor {
namespace {

template<class Interface>
class Options final : public Interface {
public:
    explicit Options(std::wstring arguments) : arguments_(std::move(arguments)) {}
    HRESULT STDMETHODCALLTYPE QueryInterface(REFIID id, void** value) override {
        if (!value) return E_POINTER;
        *value = nullptr;
        if (id != __uuidof(Interface) && id != __uuidof(IUnknown)) return E_NOINTERFACE;
        *value = static_cast<Interface*>(this);
        AddRef();
        return S_OK;
    }
    ULONG STDMETHODCALLTYPE AddRef() override { return ++references_; }
    ULONG STDMETHODCALLTYPE Release() override {
        const auto count = --references_;
        if (!count) delete this;
        return count;
    }
    HRESULT STDMETHODCALLTYPE get_AdditionalBrowserArguments(LPWSTR* value) override { return Copy(arguments_, value); }
    HRESULT STDMETHODCALLTYPE put_AdditionalBrowserArguments(LPCWSTR value) override { arguments_ = value ? value : L""; return S_OK; }
    HRESULT STDMETHODCALLTYPE get_Language(LPWSTR* value) override { return Copy(language_, value); }
    HRESULT STDMETHODCALLTYPE put_Language(LPCWSTR value) override { language_ = value ? value : L""; return S_OK; }
    HRESULT STDMETHODCALLTYPE get_TargetCompatibleBrowserVersion(LPWSTR* value) override { return Copy(PROCTOR_WEBVIEW2_VERSION, value); }
    HRESULT STDMETHODCALLTYPE put_TargetCompatibleBrowserVersion(LPCWSTR) override { return E_ACCESSDENIED; }
    HRESULT STDMETHODCALLTYPE get_AllowSingleSignOnUsingOSPrimaryAccount(BOOL* value) override { *value = FALSE; return S_OK; }
    HRESULT STDMETHODCALLTYPE put_AllowSingleSignOnUsingOSPrimaryAccount(BOOL value) override { return value ? E_ACCESSDENIED : S_OK; }
private:
    static HRESULT Copy(const std::wstring& source, LPWSTR* value) {
        if (!value) return E_POINTER;
        const size_t bytes = (source.size() + 1) * sizeof(wchar_t);
        *value = static_cast<LPWSTR>(CoTaskMemAlloc(bytes));
        if (!*value) return E_OUTOFMEMORY;
        std::memcpy(*value, source.c_str(), bytes);
        return S_OK;
    }
    std::atomic<ULONG> references_{1};
    std::wstring arguments_;
    std::wstring language_;
};

void VerifyExecutableVersion(const fs::path& executable) {
    DWORD reserved = 0;
    const auto size = GetFileVersionInfoSizeW(executable.c_str(), &reserved);
    std::vector<unsigned char> data(size);
    VS_FIXEDFILEINFO* version = nullptr;
    UINT versionSize = 0;
    if (!size || !GetFileVersionInfoW(executable.c_str(), 0, size, data.data())
        || !VerQueryValueW(data.data(), L"\\", reinterpret_cast<void**>(&version), &versionSize)
        || versionSize < sizeof(VS_FIXEDFILEINFO) || version->dwSignature != VS_FFI_SIGNATURE) {
        throw std::runtime_error("缺少 WebView2 固定运行时，或无法读取其版本");
    }
    const auto actual = std::to_wstring(HIWORD(version->dwFileVersionMS)) + L"." + std::to_wstring(LOWORD(version->dwFileVersionMS))
        + L"." + std::to_wstring(HIWORD(version->dwFileVersionLS)) + L"." + std::to_wstring(LOWORD(version->dwFileVersionLS));
    if (actual != PROCTOR_WEBVIEW2_VERSION) {
        throw std::runtime_error("WebView2 固定运行时版本不匹配，需要 " + Utf8(PROCTOR_WEBVIEW2_VERSION));
    }
}

void SetOverride(const wchar_t* name, const wchar_t* value) {
    if (SetEnvironmentVariableW(name, value)) return;
    const auto error = GetLastError();
    if (!value && error == ERROR_ENVVAR_NOT_FOUND) return;
    Check(HRESULT_FROM_WIN32(error), "WebView2 environment");
}

void VerifyProfile(ICoreWebView2* core, const fs::path& expected) {
    ComPtr<ICoreWebView2_13> version;
    ComPtr<ICoreWebView2Profile> profile;
    Check(core->QueryInterface(IID_PPV_ARGS(&version)), "WebView2 profile interface");
    Check(version->get_Profile(&profile), "WebView2 profile");
    LPWSTR raw = nullptr;
    Check(profile->get_ProfilePath(&raw), "WebView2 ProfilePath");
    for (auto path = fs::path(TakeString(raw)); path.has_relative_path(); path = path.parent_path()) {
        std::error_code error;
        if (fs::equivalent(path, expected, error)) return;
    }
    throw std::runtime_error("WebView2 用户数据目录与应用配置不匹配");
}

} // namespace

std::wstring Wide(std::string_view value) {
    if (value.empty()) return {};
    const auto length = MultiByteToWideChar(CP_UTF8, MB_ERR_INVALID_CHARS, value.data(), static_cast<int>(value.size()), nullptr, 0);
    if (!length) throw std::runtime_error("无效的 UTF-8 文本");
    std::wstring result(length, L'\0');
    MultiByteToWideChar(CP_UTF8, MB_ERR_INVALID_CHARS, value.data(), static_cast<int>(value.size()), result.data(), length);
    return result;
}

std::string Utf8(std::wstring_view value) {
    if (value.empty()) return {};
    const auto length = WideCharToMultiByte(CP_UTF8, WC_ERR_INVALID_CHARS, value.data(), static_cast<int>(value.size()), nullptr, 0, nullptr, nullptr);
    if (!length) throw std::runtime_error("无效的 UTF-16 文本");
    std::string result(length, '\0');
    WideCharToMultiByte(CP_UTF8, WC_ERR_INVALID_CHARS, value.data(), static_cast<int>(value.size()), result.data(), length, nullptr, nullptr);
    return result;
}

std::wstring TakeString(wchar_t* value) {
    const std::unique_ptr<wchar_t, decltype(&CoTaskMemFree)> storage(value, CoTaskMemFree);
    return value ? std::wstring(value) : std::wstring();
}

std::string ReadText(const fs::path& path) {
    std::ifstream input(path, std::ios::binary);
    if (!input) throw std::runtime_error("无法读取 " + Utf8(path.wstring()));
    return {std::istreambuf_iterator<char>(input), std::istreambuf_iterator<char>()};
}

void Check(HRESULT result, const char* operation) {
    if (FAILED(result)) throw std::runtime_error(std::string(operation) + " (HRESULT " + std::to_string(static_cast<unsigned long>(result)) + ")");
}

Runtime::Runtime(const fs::path& executableDirectory)
    : directory_(executableDirectory / L"webview2" / PROCTOR_WEBVIEW2_VERSION) {
    VerifyExecutableVersion(directory_ / L"msedgewebview2.exe");
    // Load the SDK loader beside this executable, without probing PATH.
    const auto loader = LoadLibraryExW((executableDirectory / L"WebView2Loader.dll").c_str(), nullptr, LOAD_WITH_ALTERED_SEARCH_PATH);
    if (loader) create_ = reinterpret_cast<CreateEnvironment>(GetProcAddress(loader, "CreateCoreWebView2EnvironmentWithOptions"));
    if (!create_) throw std::runtime_error("无法加载 WebView2 109 SDK 组件");
    SetOverride(L"WEBVIEW2_BROWSER_EXECUTABLE_FOLDER", directory_.c_str());
    SetOverride(L"WEBVIEW2_RELEASE_CHANNEL_PREFERENCE", L"0");
    SetOverride(L"WEBVIEW2_WAIT_FOR_SCRIPT_DEBUGGER", nullptr);
    SetOverride(L"WEBVIEW2_PIPE_FOR_SCRIPT_DEBUGGER", nullptr);
}

void Runtime::Create(const fs::path& profile, ICoreWebView2CreateCoreWebView2EnvironmentCompletedHandler* callback, bool offline) const {
    fs::create_directories(profile);
    std::wstring arguments = L"--disable-gpu --disable-gpu-shader-disk-cache --disable-background-timer-throttling "
        L"--disable-renderer-backgrounding --disable-backgrounding-occluded-windows --disable-logging";
    if (offline) arguments += L" --no-proxy-server --host-resolver-rules=\"MAP * ~NOTFOUND\" --disable-background-networking";
    else arguments += L" --host-resolver-rules=\"MAP proctor-client.invalid ~NOTFOUND, MAP proctor-media.invalid ~NOTFOUND\"";
    // The loader reads overrides during this call on the STA. Set them from
    // our paths as environment values take precedence over policy values.
    SetOverride(L"WEBVIEW2_USER_DATA_FOLDER", profile.c_str());
    SetOverride(L"WEBVIEW2_ADDITIONAL_BROWSER_ARGUMENTS", arguments.c_str());
    ComPtr<ICoreWebView2EnvironmentOptions> options;
    options.Attach(new Options<ICoreWebView2EnvironmentOptions>(std::wstring()));
    Check(create_(directory_.c_str(), profile.c_str(), options.Get(), callback), "CreateCoreWebView2EnvironmentWithOptions");
}

void Runtime::VerifyProcess(ICoreWebView2* view) const {
    UINT32 pid = 0;
    Check(view->get_BrowserProcessId(&pid), "WebView2 BrowserProcessId");
    auto process = OpenProcess(PROCESS_QUERY_LIMITED_INFORMATION, FALSE, pid);
    if (!process) throw std::runtime_error("无法确认 WebView2 进程来源");
    std::wstring image(32768, L'\0');
    DWORD length = static_cast<DWORD>(image.size());
    const BOOL read = QueryFullProcessImageNameW(process, 0, image.data(), &length);
    CloseHandle(process);
    image.resize(length);
    if (!read || !fs::equivalent(fs::path(image), directory_ / L"msedgewebview2.exe")) {
        throw std::runtime_error("已拒绝启动非应用自带的 WebView2");
    }
}

WebView::~WebView() { Close(); }

void WebView::Start(const Runtime& runtime, const fs::path& profile, const fs::path& assets, bool trusted,
    std::wstring script, Ready ready, Failed failed, bool inPrivate, bool offline) {
    const auto weak = weak_from_this();
    auto completion = On<ICoreWebView2CreateCoreWebView2EnvironmentCompletedHandler, HRESULT, ICoreWebView2Environment*>(
        [weak, &runtime, profile, assets, trusted, script = std::move(script), ready, failed, inPrivate, offline](HRESULT error, ICoreWebView2Environment* env) {
            auto self = weak.lock();
            if (!self || !self->parent_) return;
            try {
                Check(error, "WebView2 environment");
                LPWSTR version = nullptr;
                Check(env->get_BrowserVersionString(&version), "WebView2 BrowserVersionString");
                if (TakeString(version) != PROCTOR_WEBVIEW2_VERSION) throw std::runtime_error("WebView2 运行时版本不匹配");
                self->environment_ = env;
                auto made = On<ICoreWebView2CreateCoreWebView2ControllerCompletedHandler, HRESULT, ICoreWebView2Controller*>(
                    [weak, &runtime, profile, assets, trusted, script, ready, failed, offline](HRESULT status, ICoreWebView2Controller* controller) {
                        auto host = weak.lock();
                        if (!host || !host->parent_) {
                            if (controller) controller->Close();
                            return;
                        }
                        try {
                            Check(status, "WebView2 controller");
                            host->controller_ = controller;
                            Check(controller->get_CoreWebView2(&host->core_), "CoreWebView2");
                            runtime.VerifyProcess(host->core_.Get());
                            VerifyProfile(host->core_.Get(), profile);
                            ComPtr<ICoreWebView2Settings> settings;
                            Check(host->core_->get_Settings(&settings), "WebView2 settings");
                            settings->put_AreHostObjectsAllowed(FALSE);
                            settings->put_AreDevToolsEnabled(FALSE);
                            settings->put_AreDefaultContextMenusEnabled(FALSE);
                            settings->put_IsStatusBarEnabled(FALSE);
                            settings->put_IsZoomControlEnabled(FALSE);
                            settings->put_IsWebMessageEnabled(trusted);
                            ComPtr<ICoreWebView2Settings3> keyboard;
                            if (SUCCEEDED(settings.As(&keyboard))) keyboard->put_AreBrowserAcceleratorKeysEnabled(FALSE);
                            ComPtr<ICoreWebView2Settings4> autofill;
                            if (SUCCEEDED(settings.As(&autofill))) {
                                autofill->put_IsPasswordAutosaveEnabled(FALSE);
                                autofill->put_IsGeneralAutofillEnabled(FALSE);
                            }
                            ComPtr<ICoreWebView2Controller4> drop;
                            if (SUCCEEDED(host->controller_.As(&drop))) drop->put_AllowExternalDrop(FALSE);
                            ComPtr<ICoreWebView2Controller2> color;
                            if (trusted && SUCCEEDED(host->controller_.As(&color))) color->put_DefaultBackgroundColor({255, 15, 23, 42});
                            if (!assets.empty()) {
                                ComPtr<ICoreWebView2_3> mapping;
                                Check(host->core_.As(&mapping), "WebView2 local resources");
                                Check(mapping->SetVirtualHostNameToFolderMapping(L"proctor-client.invalid", assets.c_str(),
                                    COREWEBVIEW2_HOST_RESOURCE_ACCESS_KIND_DENY), "SetVirtualHostNameToFolderMapping");
                            }
                            Check(host->controller_->put_IsVisible(offline ? FALSE : TRUE), "WebView2 initial visibility");
                            host->visible_ = offline ? FALSE : TRUE;
                            host->Resize();
                            if (script.empty()) { ready(); return; }
                            auto registered = On<ICoreWebView2AddScriptToExecuteOnDocumentCreatedCompletedHandler, HRESULT, LPCWSTR>(
                                [weak, ready, failed](HRESULT result, LPCWSTR) {
                                    if (!weak.lock()) return;
                                    try { Check(result, "WebView2 document script"); ready(); }
                                    catch (const std::exception& e) { failed(e.what()); }
                                });
                            Check(host->core_->AddScriptToExecuteOnDocumentCreated(script.c_str(), registered.Get()), "Register document script");
                        } catch (const std::exception& e) { host->Close(); failed(e.what()); }
                    });
                if (inPrivate) {
                    // Reference windows use an off-the-record profile for each opening.
                    ComPtr<ICoreWebView2Environment10> profiles;
                    Check(self->environment_.As(&profiles), "WebView2 InPrivate environment");
                    ComPtr<ICoreWebView2ControllerOptions> options;
                    Check(profiles->CreateCoreWebView2ControllerOptions(&options), "WebView2 controller options");
                    Check(options->put_IsInPrivateModeEnabled(TRUE), "WebView2 InPrivate mode");
                    Check(profiles->CreateCoreWebView2ControllerWithOptions(self->parent_, options.Get(), made.Get()),
                        "CreateCoreWebView2ControllerWithOptions");
                } else {
                    Check(env->CreateCoreWebView2Controller(self->parent_, made.Get()), "CreateCoreWebView2Controller");
                }
            } catch (const std::exception& e) { self->Close(); failed(e.what()); }
        });
    runtime.Create(profile, completion.Get(), offline);
}

void WebView::Resize(bool notifyPosition) const {
    if (!controller_) return;
    RECT bounds{};
    if (GetClientRect(parent_, &bounds) && (!hasBounds_ || !EqualRect(&bounds_, &bounds))
        && SUCCEEDED(controller_->put_Bounds(bounds))) {
        bounds_ = bounds;
        hasBounds_ = true;
    }
    POINT position{};
    if (ClientToScreen(parent_, &position) &&
        (notifyPosition || !hasPosition_ || position.x != position_.x || position.y != position_.y)
        && SUCCEEDED(controller_->NotifyParentWindowPositionChanged())) {
        position_ = position;
        hasPosition_ = true;
    }
}
void WebView::Visible(bool value) const {
    const BOOL show = value ? TRUE : FALSE;
    if (controller_ && visible_ != show && SUCCEEDED(controller_->put_IsVisible(show))) visible_ = show;
}
void WebView::Focus() const { if (controller_) controller_->MoveFocus(COREWEBVIEW2_MOVE_FOCUS_REASON_PROGRAMMATIC); }
void WebView::Send(const Json& message) const { if (core_) core_->PostWebMessageAsJson(Wide(message.dump()).c_str()); }
void WebView::Navigate(std::wstring_view url) const { if (core_) Check(core_->Navigate(std::wstring(url).c_str()), "WebView2 navigation"); }
void WebView::Close() {
    // Closing a controller can synchronously call host event handlers. Detach
    // first so a nested Close cannot close or release the same objects again.
    auto environment = std::move(environment_);
    auto controller = std::move(controller_);
    auto core = std::move(core_);
    parent_ = nullptr;
    if (controller) controller->Close();
}

} // namespace proctor
