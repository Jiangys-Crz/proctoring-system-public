#pragma once

#include <filesystem>
#include <functional>
#include <memory>
#include <string>
#include <string_view>
#include <vector>
#include <nlohmann/json.hpp>

namespace proctor {
using Json = nlohmann::json;

class NativeMac {
public:
    NativeMac(std::filesystem::path resources, std::filesystem::path userData, std::string version, bool packaged,
              std::function<void()> openWireshark = {});
    ~NativeMac();

    // Permission prompts and inventory can wait for the OS. Invoke on a worker.
    Json Handle(std::string_view channel, const Json& args, std::string_view mode);
    void StopMonitoring();

private:
    struct State;
    std::unique_ptr<State> state_;
};

struct MacScreenImage {
    std::string mime, bytes;
};

class MacScreenControl {
public:
    // The callback can originate on a worker and must schedule window changes on the UI thread.
    explicit MacScreenControl(std::function<void(Json, std::vector<MacScreenImage>)> display);
    ~MacScreenControl();

    std::function<void()> PrepareWatch(const Json& identity);
    void Release();
    bool IsDisplaying() const;

private:
    struct State;
    std::shared_ptr<State> state_;
};
}
