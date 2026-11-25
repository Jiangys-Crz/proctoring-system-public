#pragma once

#include <windows.h>
#include <nlohmann/json.hpp>
#include <filesystem>
#include <functional>
#include <memory>
#include <string>
#include <string_view>
#include <vector>

namespace proctor {
using Json = nlohmann::json;

class NativeWindows {
public:
    NativeWindows(std::filesystem::path resources, std::filesystem::path userData,
                  std::string version, std::filesystem::path fixedRuntime, bool packaged = true);
    ~NativeWindows();

    Json Handle(std::string_view channel, const Json& args, std::string_view mode);
    void SetUsbEnabled(bool enabled);
    void StopUsb();
    void StopDomains();
    std::string ElevationStatus();
    bool Relaunch();

private:
    struct State;
    std::unique_ptr<State> state_;
};

class ScreenControl {
public:
    struct DisplayImage {
        std::string id, name, type, body;
    };
    using Images = std::shared_ptr<const std::vector<DisplayImage>>;
    // Callbacks originate on worker threads and must post updates to the UI.
    ScreenControl(std::filesystem::path resources, std::function<void(Json, Images)> display,
                  std::function<void()> desktopChanged);
    ~ScreenControl();

    std::function<void()> PrepareWatch(const Json& identity);
    void Release();
    bool IsDisplaying() const;
    void SetWindows(std::vector<HWND> windows);

private:
    struct State;
    std::unique_ptr<State> state_;
};
}
