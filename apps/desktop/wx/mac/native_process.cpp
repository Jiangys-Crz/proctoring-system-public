#include "native_process.hpp"

#include <algorithm>
#include <array>
#include <cctype>
#include <cerrno>
#include <fcntl.h>
#include <signal.h>
#include <spawn.h>
#include <sys/wait.h>
#include <thread>
#include <unistd.h>

extern char** environ;

namespace proctor::mac {
namespace {

std::array<int, 2> Pipe() {
    std::array<int, 2> endpoints{};
    if (pipe(endpoints.data()) != 0) throw std::runtime_error("无法创建系统检测进程输出管道");
    for (auto& endpoint : endpoints) {
        if (endpoint > STDERR_FILENO) continue;
        const auto duplicate = fcntl(endpoint, F_DUPFD_CLOEXEC, STDERR_FILENO + 1);
        if (duplicate == -1) {
            close(endpoints[0]);
            close(endpoints[1]);
            throw std::runtime_error("无法配置系统检测进程输出管道");
        }
        close(endpoint);
        endpoint = duplicate;
    }
    if (fcntl(endpoints[0], F_SETFD, FD_CLOEXEC) == -1 ||
        fcntl(endpoints[1], F_SETFD, FD_CLOEXEC) == -1 ||
        fcntl(endpoints[0], F_SETFL, O_NONBLOCK) == -1) {
        close(endpoints[0]);
        close(endpoints[1]);
        throw std::runtime_error("无法配置系统检测进程输出管道");
    }
    return endpoints;
}

void CheckSpawn(int error) {
    if (error) throw std::runtime_error("无法启动系统检测进程（" + std::to_string(error) + "）");
}

}  // namespace

std::string Trim(std::string_view value) {
    while (!value.empty() && std::isspace(static_cast<unsigned char>(value.front()))) value.remove_prefix(1);
    while (!value.empty() && std::isspace(static_cast<unsigned char>(value.back()))) value.remove_suffix(1);
    return std::string(value);
}

std::string Lower(std::string value) {
    std::transform(value.begin(), value.end(), value.begin(), [](unsigned char character) { return std::tolower(character); });
    return value;
}

std::vector<std::string> Split(std::string_view value, char delimiter) {
    std::vector<std::string> result;
    for (;;) {
        const auto end = value.find(delimiter);
        result.emplace_back(value.substr(0, end));
        if (end == std::string_view::npos) return result;
        value.remove_prefix(end + 1);
    }
}

std::string Base64(std::string_view value) {
    constexpr std::string_view symbols = "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/";
    std::string encoded;
    encoded.reserve((value.size() + 2) / 3 * 4);
    for (std::size_t index = 0; index < value.size(); index += 3) {
        const auto first = static_cast<unsigned char>(value[index]);
        const auto second = index + 1 < value.size() ? static_cast<unsigned char>(value[index + 1]) : 0;
        const auto third = index + 2 < value.size() ? static_cast<unsigned char>(value[index + 2]) : 0;
        encoded += symbols[first >> 2];
        encoded += symbols[((first & 3) << 4) | (second >> 4)];
        encoded += index + 1 < value.size() ? symbols[((second & 15) << 2) | (third >> 6)] : '=';
        encoded += index + 2 < value.size() ? symbols[third & 63] : '=';
    }
    return encoded;
}

bool Utf16LengthAtMost(std::string_view value, std::size_t maximum) {
    std::size_t length = 0;
    for (const unsigned char character : value) {
        if ((character & 0xc0) == 0x80) continue;
        length += character >= 0xf0 ? 2 : 1;
        if (length > maximum) return false;
    }
    return true;
}

ChildProcess::ChildProcess(const std::string& executable, const std::vector<std::string>& arguments) {
    const auto output = Pipe();
    std::array<int, 2> errors{-1, -1};
    posix_spawn_file_actions_t actions{};
    posix_spawnattr_t attrs{};
    bool actionsReady = false, attrsReady = false;
    try {
        errors = Pipe();
        CheckSpawn(posix_spawn_file_actions_init(&actions));
        actionsReady = true;
        CheckSpawn(posix_spawnattr_init(&attrs));
        attrsReady = true;
        CheckSpawn(posix_spawnattr_setflags(&attrs, POSIX_SPAWN_CLOEXEC_DEFAULT));
        CheckSpawn(posix_spawn_file_actions_addopen(&actions, STDIN_FILENO, "/dev/null", O_RDONLY, 0));
        CheckSpawn(posix_spawn_file_actions_adddup2(&actions, output[1], STDOUT_FILENO));
        CheckSpawn(posix_spawn_file_actions_adddup2(&actions, errors[1], STDERR_FILENO));

        std::vector<char*> argv{const_cast<char*>(executable.c_str())};
        for (const auto& item : arguments) argv.push_back(const_cast<char*>(item.c_str()));
        argv.push_back(nullptr);
        std::vector<char*> environment;
        for (auto entry = environ; *entry; ++entry) {
            std::string_view item(*entry);
            if (!item.starts_with("LANG=") && !item.starts_with("LC_ALL=")) environment.push_back(*entry);
        }
        char lang[] = "LANG=C", locale[] = "LC_ALL=C";
        environment.insert(environment.end(), {lang, locale, nullptr});
        CheckSpawn(posix_spawn(&pid_, executable.c_str(), &actions, &attrs, argv.data(), environment.data()));
    } catch (...) {
        close(output[0]); close(output[1]);
        if (errors[0] != -1) { close(errors[0]); close(errors[1]); }
        if (attrsReady) posix_spawnattr_destroy(&attrs);
        if (actionsReady) posix_spawn_file_actions_destroy(&actions);
        throw;
    }
    posix_spawnattr_destroy(&attrs);
    posix_spawn_file_actions_destroy(&actions);
    close(output[1]); close(errors[1]);
    output_ = output[0];
    errors_ = errors[0];
}

ChildProcess::~ChildProcess() {
    if (IsRunning()) {
        kill(pid_, SIGKILL);
        while (waitpid(pid_, nullptr, 0) == -1 && errno == EINTR) {}
    }
    close(output_);
    close(errors_);
}

bool ChildProcess::IsRunning() {
    if (!pid_) return false;
    int status = 0;
    pid_t result;
    do { result = waitpid(pid_, &status, WNOHANG); } while (result == -1 && errno == EINTR);
    if (!result) return true;
    pid_ = 0;
    if (result > 0 && WIFEXITED(status)) exitCode_ = WEXITSTATUS(status);
    return false;
}

std::string ChildProcess::Read(int descriptor) {
    std::string text;
    char buffer[8192];
    while (text.size() < 256 * 1024) {
        const auto received = read(descriptor, buffer, sizeof buffer);
        if (received > 0) text.append(buffer, static_cast<std::size_t>(received));
        else if (!received || errno != EINTR) break;
    }
    return text;
}

std::string ChildProcess::ReadOutput() { return Read(output_); }
std::string ChildProcess::ReadErrors() { return Read(errors_); }

CommandResult Run(const std::string& executable, const std::vector<std::string>& arguments,
                  std::chrono::milliseconds timeout, std::size_t maxBytes) {
    ChildProcess child(executable, arguments);
    const auto deadline = Clock::now() + timeout;
    CommandResult result;
    while (true) {
        const bool running = child.IsRunning();
        auto output = child.ReadOutput(), errors = child.ReadErrors();
        result.output += output;
        result.errors += errors;
        if (result.output.size() > maxBytes || result.errors.size() > maxBytes)
            throw std::runtime_error("系统检测报告过大");
        if (!running && output.empty() && errors.empty()) break;
        if (Clock::now() >= deadline) throw std::runtime_error("系统检测超时");
        if (output.empty() && errors.empty()) std::this_thread::sleep_for(15ms);
    }
    result.status = child.ExitCode();
    return result;
}

std::string CheckedRun(const std::string& executable, const std::vector<std::string>& arguments,
                       std::chrono::milliseconds timeout) {
    const auto result = Run(executable, arguments, timeout);
    if (result.status != 0) throw std::runtime_error(result.errors.empty() ? "系统检测未完成" : Trim(result.errors));
    return result.output;
}

}  // namespace proctor::mac
