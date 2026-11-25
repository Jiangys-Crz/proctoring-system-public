#pragma once

#include "native.hpp"

#include <chrono>
#include <optional>
#include <vector>
#include <sys/types.h>

namespace proctor::mac {
namespace fs = std::filesystem;
using Clock = std::chrono::steady_clock;
using namespace std::chrono_literals;

std::string Trim(std::string_view value);
std::string Lower(std::string value);
std::vector<std::string> Split(std::string_view value, char delimiter);
std::string Base64(std::string_view value);
bool Utf16LengthAtMost(std::string_view value, std::size_t maximum);

class ChildProcess {
public:
    ChildProcess(const std::string& executable, const std::vector<std::string>& arguments);
    ~ChildProcess();
    ChildProcess(const ChildProcess&) = delete;
    ChildProcess& operator=(const ChildProcess&) = delete;

    std::string ReadOutput();
    std::string ReadErrors();
    bool IsRunning();
    int ExitCode() const { return exitCode_; }

private:
    static std::string Read(int descriptor);
    pid_t pid_ = 0;
    int output_ = -1, errors_ = -1, exitCode_ = -1;
};

struct CommandResult {
    std::string output, errors;
    int status;
};

CommandResult Run(const std::string& executable, const std::vector<std::string>& arguments,
                  std::chrono::milliseconds timeout = 5s, std::size_t maxBytes = 4 * 1024 * 1024);
std::string CheckedRun(const std::string& executable, const std::vector<std::string>& arguments,
                       std::chrono::milliseconds timeout = 5s);

class DomainMonitor {
public:
    DomainMonitor();
    ~DomainMonitor();
    Json Status() const;
    Json Start();
    Json RequestPermission();
    Json Remotes(const Json& allowedHosts);
    void Clear();
    void Stop();

private:
    struct State;
    std::unique_ptr<State> state_;
};
}
