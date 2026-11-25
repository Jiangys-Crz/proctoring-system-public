#pragma once

#include <cstdint>
#include <filesystem>
#include <memory>
#include <optional>
#include <string>
#include <string_view>

#include <nlohmann/json_fwd.hpp>

namespace proctor {

#ifdef _WIN32
struct WindowsCaptureFrame {
    std::uint64_t sequence;
    std::uint64_t imageSequence;
    std::shared_ptr<const std::string> jpeg;
};
#endif
#ifdef __APPLE__
struct MacCaptureFrame {
    std::uint64_t sequence;
    std::string jpeg;
};
#endif

class DesktopMedia {
public:
    explicit DesktopMedia(std::filesystem::path ffmpeg);
    ~DesktopMedia();

    DesktopMedia(const DesktopMedia&) = delete;
    DesktopMedia& operator=(const DesktopMedia&) = delete;

    // Frame reads wait on a worker thread. StopAll invalidates and wakes every lease.
    nlohmann::json Invoke(std::string_view channel, const nlohmann::json& args,
                          std::optional<std::uint64_t> generation = std::nullopt);
#ifdef _WIN32
    WindowsCaptureFrame ReadFrame(const std::string& lease, std::uint64_t after);
#endif
#ifdef __APPLE__
    MacCaptureFrame ReadFrame(const std::string& lease, std::uint64_t after);
#endif
    std::uint64_t Generation() const;
    void StopAll();

private:
    struct State;
    std::unique_ptr<State> state_;
};

}  // namespace proctor
