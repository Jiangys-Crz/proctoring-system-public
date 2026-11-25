#pragma once

#include <windows.h>
#include <WebView2.h>
#ifdef __MINGW32__
#include "webview2_mingw_guids.hpp"
#endif
#include <wrl/client.h>
#include <nlohmann/json.hpp>

#include <atomic>
#include <filesystem>
#include <functional>
#include <memory>
#include <string>
#include <string_view>
#include "com-handler.hpp"

namespace proctor {

using Json = nlohmann::json;
using Microsoft::WRL::ComPtr;
namespace fs = std::filesystem;

std::wstring Wide(std::string_view value);
std::string Utf8(std::wstring_view value);
std::wstring TakeString(wchar_t* value);
std::string ReadText(const fs::path& path);
void Check(HRESULT result, const char* operation);

// WebView2 takes a COM reference to each registered handler. A small adapter
// keeps the host independent of WRL's MSVC-only callback implementation.
template<class Interface, class Sender, class Args, class Function>
ComPtr<Interface> On(Function function) {
    ComPtr<Interface> result;
    result.Attach(new Handler<Interface, Sender, Args, Function>(std::move(function)));
    return result;
}

class Runtime {
public:
    explicit Runtime(const fs::path& executableDirectory);
    void Create(const fs::path& profile, ICoreWebView2CreateCoreWebView2EnvironmentCompletedHandler* callback,
        bool offline = false) const;
    void VerifyProcess(ICoreWebView2* view) const;
    const fs::path& directory() const { return directory_; }
private:
    using CreateEnvironment = HRESULT (STDAPICALLTYPE*)(PCWSTR, PCWSTR, ICoreWebView2EnvironmentOptions*,
        ICoreWebView2CreateCoreWebView2EnvironmentCompletedHandler*);
    fs::path directory_;
    CreateEnvironment create_ = nullptr;
};

class WebView : public std::enable_shared_from_this<WebView> {
public:
    using Ready = std::function<void()>;
    using Failed = std::function<void(std::string)>;
    explicit WebView(HWND parent) : parent_(parent) {}
    ~WebView();
    void Start(const Runtime& runtime, const fs::path& profile, const fs::path& assets, bool trusted,
        std::wstring script, Ready ready, Failed failed, bool inPrivate = false, bool offline = false);
    void Resize(bool notifyPosition = false) const;
    void Visible(bool value) const;
    void Focus() const;
    void Send(const Json& message) const;
    void Navigate(std::wstring_view url) const;
    void Close();
    ICoreWebView2* core() const { return core_.Get(); }
    ICoreWebView2Controller* controller() const { return controller_.Get(); }
    ICoreWebView2Environment* environment() const { return environment_.Get(); }
private:
    HWND parent_;
    mutable RECT bounds_{};
    mutable POINT position_{};
    mutable bool hasBounds_ = false;
    mutable bool hasPosition_ = false;
    mutable BOOL visible_ = -1;
    ComPtr<ICoreWebView2Environment> environment_;
    ComPtr<ICoreWebView2Controller> controller_;
    ComPtr<ICoreWebView2> core_;
};

inline constexpr wchar_t clientUrl[] = L"https://proctor-client.invalid/index.html";
inline constexpr wchar_t overlayUrl[] = L"https://proctor-client.invalid/screen-control.html";

} // namespace proctor
