#pragma once
#include <condition_variable>
#include <deque>
#include <exception>
#include <functional>
#include <mutex>
#include <thread>
#include <utility>
#include <vector>

namespace proctor {
class Workers {
public:
    using Failed = std::function<void(std::exception_ptr)>;
    explicit Workers(int count = 8, Failed failed = {}) : failed_(std::move(failed)) {
        threads_.reserve(count);
        try {
            for (int i = 0; i < count; ++i) threads_.emplace_back([this] {
                for (;;) {
                    std::function<void()> run;
                    {
                        std::unique_lock lock(mutex_);
                        changed_.wait(lock, [this] { return closing_ || !queue_.empty(); });
                        if (closing_) return;
                        run = std::move(queue_.front()); queue_.pop_front();
                    }
                    // An exception must never escape a std::thread entry point:
                    // optional profile migration used to terminate the app here.
                    try { run(); }
                    catch (...) {
                        if (failed_) try { failed_(std::current_exception()); } catch (...) {}
                    }
                }
            });
        } catch (...) { Close(); throw; }
    }
    ~Workers() { Close(); }
    bool Post(std::function<void()> run) {
        std::lock_guard lock(mutex_);
        if (closing_ || queue_.size() >= 128) return false;
        queue_.push_back(std::move(run)); changed_.notify_one(); return true;
    }
    void Close() {
        { std::lock_guard lock(mutex_); closing_ = true; queue_.clear(); }
        changed_.notify_all();
        for (auto& thread : threads_) if (thread.joinable()) thread.join();
    }
private:
    std::mutex mutex_;
    std::condition_variable changed_;
    std::deque<std::function<void()>> queue_;
    std::vector<std::thread> threads_;
    Failed failed_;
    bool closing_ = false;
};
}
