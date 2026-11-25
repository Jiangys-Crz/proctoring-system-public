#pragma once

#include "native_windows.hpp"
#include "native_windows_process.hpp"

#include <algorithm>
#include <future>
#include <mutex>

namespace proctor::native {
template<typename Result>
class SharedWork {
public:
    template<typename Work>
    Result operator()(Work run) {
        std::promise<Result> promise;
        std::shared_future<Result> result;
        bool ownsRun = false;
        {
            const std::lock_guard lock(mutex_);
            if (!pending_.valid()) {
                pending_ = promise.get_future().share();
                ownsRun = true;
            }
            result = pending_;
        }
        if (ownsRun) {
            try { promise.set_value(run()); }
            catch (...) { promise.set_exception(std::current_exception()); }
            const std::lock_guard lock(mutex_);
            pending_ = {};
        }
        return result.get();
    }

private:
    std::mutex mutex_;
    std::shared_future<Result> pending_;
};

using Cancellation = std::shared_ptr<std::atomic_bool>;

// The caller serializes Starts and Stops. Cancelling a monitor is immediate
// even if a Win32 process launch stalls; its thread is joined before the
// monitor's state is destroyed.
class MonitorWorkers {
public:
    template<typename Work>
    Cancellation Start(Work run) {
        Stop();
        std::erase_if(threads_, [](auto& thread) { return thread.wait_for(0ms) == std::future_status::ready; });
        threads_.reserve(threads_.size() + 1);
        auto cancelled = std::make_shared<std::atomic_bool>(false);
        threads_.push_back(std::async(std::launch::async, [run = std::move(run), cancelled] { run(*cancelled); }));
        current_ = cancelled;
        return cancelled;
    }
    const Cancellation& Current() const { return current_; }
    void Stop() { if (current_) current_->store(true); }
    void Join() { for (auto& thread : threads_) thread.wait(); }

private:
    Cancellation current_;
    std::vector<std::future<void>> threads_;
};

class UsbMonitor {
public:
    UsbMonitor(fs::path inventory, std::function<void(std::string)> diagnostic);
    ~UsbMonitor();

    std::string Fingerprint();
    std::string ConfirmBaseline();
    void Watch(const std::string& sessionId, const std::string& baselineFingerprint);
    Json Read(const std::string& sessionId);
    void Acknowledge(const std::string& sessionId, const Json& ids);
    void SetEnabled(bool enabled);
    void Stop();

private:
    struct State;
    std::unique_ptr<State> state_;
};

class DomainMonitor {
public:
    DomainMonitor();
    ~DomainMonitor();

    Json Status();
    Json Start();
    void Stop();
    void Reset();
    Json Snapshot(const Json& allowedHosts);

private:
    struct State;
    std::unique_ptr<State> state_;
};

std::wstring ReadEnv(const wchar_t* key);
fs::path SystemCommand(const fs::path& relative);
fs::path ExecutablePath();
std::string OsRelease();
std::string Sha256(std::istream& input);
}
