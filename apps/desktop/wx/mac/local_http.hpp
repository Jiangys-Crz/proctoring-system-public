#pragma once

#include "../src/media.hpp"

#include <atomic>
#include <array>
#include <filesystem>
#include <functional>
#include <mutex>
#include <string>
#include <thread>

namespace proctor {

class LocalHttp {
public:
    LocalHttp(const std::filesystem::path& renderer, const std::filesystem::path& data, DesktopMedia& media);
    ~LocalHttp();
    LocalHttp(const LocalHttp&) = delete;
    LocalHttp& operator=(const LocalHttp&) = delete;

    const std::string& Origin() const { return origin_; }

private:
    void Serve(std::size_t worker);
    void Stop();
    void Reply(int client) const;
    void ReplyFrame(int client, const std::string& lease, std::string_view sequence) const;
    std::filesystem::path renderer_;
    DesktopMedia& media_;
    std::string origin_, host_;
    int listener_ = -1;
    std::atomic_bool stopping_{false};
    mutable std::atomic_uint frameReaders_{0};
    std::mutex clientsMutex_;
    std::array<int, 4> clients_{-1, -1, -1, -1};
    std::array<std::thread, 4> workers_;
};

} // namespace proctor
