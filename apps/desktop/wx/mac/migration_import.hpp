#pragma once
#import <WebKit/WebKit.h>

#include <filesystem>
#include <functional>
#include <memory>
#include <string>

namespace proctor {

class MacLegacyImport {
public:
    static std::shared_ptr<MacLegacyImport> Begin(const std::filesystem::path& stage,
        const std::filesystem::path& userData, std::string origin, NSView* host,
        std::function<void(bool)> completion);
    ~MacLegacyImport();
    void Cancel();

private:
    struct State;
    explicit MacLegacyImport(std::shared_ptr<State> state);
    std::shared_ptr<State> state_;
};

} // namespace proctor
