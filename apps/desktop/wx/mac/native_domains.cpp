#include "native_process.hpp"
#include "bridge.hpp"

#include <algorithm>
#include <condition_variable>
#include <ifaddrs.h>
#include <list>
#include <map>
#include <mutex>
#include <net/if.h>
#include <netdb.h>
#include <regex>
#include <set>
#include <thread>
#include <unistd.h>

namespace proctor::mac {
namespace {

struct Interfaces {
    std::vector<std::string> capture;
    std::set<std::string> names, addresses;
};

Interfaces LocalInterfaces() {
    ifaddrs* entries = nullptr;
    if (getifaddrs(&entries) != 0) throw std::runtime_error("没有可用的本机网络接口");
    const std::unique_ptr<ifaddrs, decltype(&freeifaddrs)> owner(entries, freeifaddrs);
    Interfaces result;
    std::set<std::string> selected;
    for (auto* entry = entries; entry; entry = entry->ifa_next) {
        if (!entry->ifa_addr) continue;
        const int family = entry->ifa_addr->sa_family;
        if (family != AF_INET && family != AF_INET6) continue;
        const std::string name = entry->ifa_name;
        result.names.insert(name);
        char value[NI_MAXHOST]{};
        if (getnameinfo(entry->ifa_addr, entry->ifa_addr->sa_len, value, sizeof value, nullptr, 0, NI_NUMERICHOST) != 0) continue;
        const auto address = std::string(value).substr(0, std::string_view(value).find('%'));
        result.addresses.insert(address);
        if (name == "lo0" || (!(entry->ifa_flags & IFF_LOOPBACK) && !Lower(address).starts_with("fe80:") &&
            !address.starts_with("169.254."))) selected.insert(name);
    }
    result.capture.assign(selected.begin(), selected.end());
    const auto priority = [](const std::string& name) {
        return name == "lo0" ? 2 : std::regex_match(name, std::regex("en[0-9]+")) ? 0 : 1;
    };
    std::stable_sort(result.capture.begin(), result.capture.end(), [&](const auto& a, const auto& b) { return priority(a) < priority(b); });
    return result;
}

std::string SourceFilter(const Interfaces& interfaces) {
    if (interfaces.addresses.empty()) throw std::runtime_error("没有可用的本机网络接口");
    std::string filter;
    for (const auto& address : interfaces.addresses) {
        if (!filter.empty()) filter += " or ";
        filter += "src host " + address;
    }
    return "(" + filter + ")";
}

std::string NormalizeDomain(std::string value) {
    value = Lower(Trim(value));
    if (value.ends_with('.')) value.pop_back();
    if (value.empty() || value.size() > 253 || value.find('.') == value.npos ||
        value.ends_with(".arpa") || value.ends_with(".local") || value.ends_with(".localhost")) return {};
    static const std::regex label("[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?");
    bool numeric = true;
    for (const auto& part : Split(value, '.')) {
        if (!std::regex_match(part, label)) return {};
        numeric = numeric && std::all_of(part.begin(), part.end(), [](char c) { return c >= '0' && c <= '9'; });
    }
    return numeric ? std::string{} : value;
}

std::string FirstCommand(std::initializer_list<const char*> paths) {
    for (const auto* path : paths) if (access(path, X_OK) == 0) return path;
    return {};
}

bool PermissionError(const std::string& value) {
    static const std::regex warning("permission|permitted|denied|权限", std::regex::icase);
    return std::regex_search(value, warning);
}

Json DomainStatus(const char* state, std::string message, std::optional<bool> permission = {}) {
    Json result{{"state", state}, {"message", std::move(message)}};
    if (permission) result["permissionRequired"] = *permission;
    return result;
}

std::string AdministratorScript(uid_t uid, std::size_t count) {
    std::string script = "set -eu\ncapture_index=0\nwhile [ \"$capture_index\" -lt " + std::to_string(count) + " ]; do\n"
        "  capture_device=\"/dev/bpf$capture_index\"\n"
        "  [ -c \"$capture_device\" ] || break\n"
        "  /bin/dd if=\"$capture_device\" of=/dev/null count=0 2>/dev/null || true\n"
        "  /usr/sbin/chown " + std::to_string(uid) + " \"$capture_device\"\n"
        "  /bin/chmod u+rw \"$capture_device\"\n"
        "  capture_index=$((capture_index + 1))\ndone\n[ \"$capture_index\" -gt 0 ]";
    std::string quoted;
    for (const auto character : script) {
        if (character == '\n') quoted += "\\n";
        else {
            if (character == '\\' || character == '"') quoted += '\\';
            quoted += character;
        }
    }
    return "do shell script \"" + quoted + "\" with administrator privileges with prompt \"监考客户端需要允许当前登录用户进行网络检测。重启电脑后可能需要重新授权。\"";
}

std::pair<bool, std::string> RequestBpfPermission() {
    const auto uid = getuid();
    if (!uid) return {true, "已具有网络检测权限。"};
    try {
        std::size_t devices = 4;
        static const std::regex pattern("bpf([0-9]{1,3})");
        for (const auto& file : fs::directory_iterator("/dev")) {
            const auto name = file.path().filename().string();
            std::smatch match;
            if (std::regex_match(name, match, pattern)) devices = std::max(devices, std::size_t(std::stoi(match[1]) + 1));
        }
        const auto count = std::min<std::size_t>(256, devices + std::min<std::size_t>(64, LocalInterfaces().names.size() + 4));
        const auto result = Run("/usr/bin/osascript", {"-e", AdministratorScript(uid, count)}, 120s, 65536);
        if (result.status == 0) return {true, "网络检测授权完成，正在重新检测。"};
        static const std::regex cancelled("-128|cancelled|canceled|用户取消", std::regex::icase);
        if (std::regex_search(result.errors, cancelled)) return {false, "已取消网络检测授权，点击“网络检测”可再次申请。"};
    } catch (const std::exception&) {}
    return {false, "网络检测授权未完成，请再次点击卡片并在系统窗口中完成管理员验证。"};
}

}  // namespace

struct DomainMonitor::State {
    struct Entry { std::string domain, source; Clock::time_point at; };
    struct Capture { std::unique_ptr<ChildProcess> child; std::string line, errors; bool tshark; };

    mutable std::mutex mutex;
    std::mutex permissions;
    std::condition_variable changed;
    bool shutdown = false, requested = false, starting = false;
    std::uint64_t generation = 0;
    Json status = DomainStatus("idle", "尚未检测整机外部域名采集能力");
    std::list<Entry> entries;
    std::thread worker;

    State() : worker([this] { Poll(); }) {}
    ~State() {
        {
            const std::lock_guard lock(mutex);
            shutdown = true;
            ++generation;
        }
        changed.notify_all();
        worker.join();
    }

    bool Current(std::uint64_t serial) const {
        const std::lock_guard lock(mutex);
        return !shutdown && generation == serial;
    }

    void Add(std::uint64_t serial, std::string value, const char* source) {
        auto name = NormalizeDomain(std::move(value));
        if (name.empty()) return;
        const std::lock_guard lock(mutex);
        if (serial != generation) return;
        entries.remove_if([&](const Entry& entry) { return entry.domain == name && entry.source == source; });
        entries.push_back({std::move(name), source, Clock::now()});
        if (entries.size() > 2000) entries.pop_front();
    }

    void Read(Capture& capture, std::uint64_t serial) {
        capture.line += capture.child->ReadOutput();
        std::size_t start = 0;
        for (auto end = capture.line.find('\n'); end != std::string::npos; end = capture.line.find('\n', start)) {
            const auto line = capture.line.substr(start, end - start);
            if (capture.tshark) {
                static const std::regex port(":[0-9]+$");
                const auto fields = Split(line, '\t');
                for (std::size_t index = 0; index < std::min<std::size_t>(fields.size(), 3); ++index) {
                    for (auto value : Split(fields[index], ',')) {
                        if (index == 2) value = std::regex_replace(Trim(value), port, "");
                        Add(serial, std::move(value), index == 0 ? "DNS 查询" : index == 1 ? "TLS SNI" : "HTTP");
                    }
                }
            } else {
                static const std::regex query(R"(\b(?:A|AAAA|HTTPS|SVCB)\?\s+([^\s]+))");
                for (auto found = std::sregex_iterator(line.begin(), line.end(), query); found != std::sregex_iterator(); ++found)
                    Add(serial, (*found)[1], "DNS 查询");
            }
            start = end + 1;
        }
        capture.line.erase(0, start);
        if (capture.line.size() > 65536) capture.line.clear();
        capture.errors += capture.child->ReadErrors();
        if (capture.errors.size() > 4000) capture.errors.erase(0, capture.errors.size() - 4000);
    }

    Capture StartCapture(std::uint64_t serial, const std::string& command, const std::vector<std::string>& args, bool tshark) {
        Capture capture{std::make_unique<ChildProcess>(command, args), {}, {}, tshark};
        const auto deadline = Clock::now() + 5s;
        std::optional<Clock::time_point> ready;
        static const std::regex listening("listening on|Capturing on|Capture started", std::regex::icase);
        while (Current(serial) && Clock::now() < deadline) {
            Read(capture, serial);
            if (PermissionError(capture.errors) || !capture.child->IsRunning())
                throw std::runtime_error(capture.errors.empty() ? "采集程序已退出" : capture.errors);
            if (!ready && std::regex_search(capture.errors, listening)) ready = Clock::now() + 300ms;
            if (ready && Clock::now() >= *ready) return capture;
            std::this_thread::sleep_for(25ms);
        }
        throw std::runtime_error("域名采集启动超时");
    }

    void Publish(std::uint64_t serial, Json next) {
        const std::lock_guard lock(mutex);
        if (serial != generation) return;
        status = std::move(next);
        starting = false;
        changed.notify_all();
    }

    void CaptureDomains(std::uint64_t serial) {
        std::vector<Capture> captures;
        const auto interfaces = LocalInterfaces();
        const auto filter = SourceFilter(interfaces);
        const auto tshark = FirstCommand({"/Applications/Wireshark.app/Contents/MacOS/tshark", "/opt/homebrew/bin/tshark",
                                          "/usr/local/bin/tshark", "/usr/bin/tshark"});
        if (!tshark.empty()) {
            try {
                const auto listing = CheckedRun(tshark, {"-D"}, 6s);
                std::vector<std::string> args;
                static const std::regex interfaceLine(R"(^[0-9]+\. (\S+))");
                static const std::regex extcap("extcap|sshdump|ciscodump|randpkt|udpdump|wifidump", std::regex::icase);
                for (const auto& line : Split(listing, '\n')) {
                    std::smatch match;
                    if (!std::regex_search(line, extcap) && std::regex_search(line, match, interfaceLine) &&
                        interfaces.names.contains(match[1].str())) args.insert(args.end(), {"-i", match[1].str()});
                }
                if (args.empty()) throw std::runtime_error("没有可用的本机网络接口");
                args.insert(args.end(), {"-p", "-n", "-l", "-f", filter + " and (port 53 or tcp or udp port 443)",
                    "-Y", "(dns.flags.response == 0) or tls.handshake.extensions_server_name or http.host",
                    "-T", "fields", "-e", "dns.qry.name", "-e", "tls.handshake.extensions_server_name", "-e", "http.host"});
                if (!Current(serial)) return;
                captures.push_back(StartCapture(serial, tshark, args, true));
            } catch (const std::exception&) {}
        }
        if (captures.empty()) {
            const auto tcpdump = FirstCommand({"/usr/sbin/tcpdump", "/usr/bin/tcpdump"});
            if (tcpdump.empty()) throw std::runtime_error("未安装 tcpdump 或 Wireshark");
            if (std::ranges::none_of(interfaces.capture, [](const auto& name) { return name != "lo0"; }))
                throw std::runtime_error("没有可用的外部网络接口");
            unsigned external = 0, failed = 0;
            std::string firstError;
            for (const auto& name : interfaces.capture) {
                if (!Current(serial)) return;
                try {
                    captures.push_back(StartCapture(serial, tcpdump,
                        {"-i", name, "-p", "-n", "-l", "-s", "1500", filter + " and udp dst port 53"}, false));
                    if (name != "lo0") ++external;
                } catch (const std::exception& error) {
                    if (!failed++) firstError = error.what();
                }
            }
            if (!external) throw std::runtime_error(firstError.empty() ? "外部网络接口采集未启动" : firstError);
            Publish(serial, DomainStatus("limited", failed ? "网络检测部分可用：" + std::to_string(failed) + " 个接口采集失败" : "网络检测已授权"));
        } else Publish(serial, DomainStatus("ready", "网络检测已授权"));

        while (Current(serial)) {
            for (auto& capture : captures) {
                Read(capture, serial);
                if (!capture.child->IsRunning()) {
                    Publish(serial, DomainStatus("unavailable", "网络采集中断，请点击“网络检测”重新申请或检测权限。",
                                                 PermissionError(capture.errors)));
                    return;
                }
            }
            std::unique_lock lock(mutex);
            changed.wait_for(lock, 100ms, [&] { return shutdown || generation != serial; });
        }
    }

    void Poll() {
        std::unique_lock lock(mutex);
        while (!shutdown) {
            changed.wait(lock, [&] { return shutdown || requested; });
            if (shutdown) break;
            requested = false;
            const auto serial = generation;
            lock.unlock();
            try {
                CaptureDomains(serial);
            } catch (const std::exception& error) {
                const auto permission = PermissionError(error.what());
                Publish(serial, DomainStatus("unavailable", permission
                    ? "缺少网络检测权限，点击此卡片发起系统授权。"
                    : "网络采集工具未就绪，点击此卡片重新检测或打开安装入口。", permission));
            }
            lock.lock();
        }
    }
};

DomainMonitor::DomainMonitor() : state_(std::make_unique<State>()) {}
DomainMonitor::~DomainMonitor() = default;

Json DomainMonitor::Status() const {
    const std::lock_guard lock(state_->mutex);
    return state_->status;
}

Json DomainMonitor::Start() {
    auto& watch = *state_;
    std::unique_lock lock(watch.mutex);
    if (watch.status.at("state") == "ready" || watch.status.at("state") == "limited") return watch.status;
    if (!watch.starting) {
        ++watch.generation;
        watch.entries.clear();
        watch.starting = watch.requested = true;
        watch.changed.notify_all();
    }
    const auto serial = watch.generation;
    watch.changed.wait(lock, [&] { return watch.shutdown || watch.generation != serial || !watch.starting; });
    return watch.status;
}

Json DomainMonitor::RequestPermission() {
    auto& watch = *state_;
    const std::lock_guard request(watch.permissions);
    const auto initial = Start();
    if (initial.at("state") != "unavailable" || !initial.value("permissionRequired", false)) return initial;
    std::uint64_t serial;
    {
        const std::lock_guard lock(watch.mutex);
        serial = watch.generation;
        if (watch.status != initial) return watch.status;
    }
    const auto [granted, message] = RequestBpfPermission();
    {
        const std::lock_guard lock(watch.mutex);
        if (watch.generation != serial) return watch.status;
        if (!granted) return watch.status = DomainStatus("unavailable", message, true);
    }
    return Start();
}

Json DomainMonitor::Remotes(const Json& values) {
    std::set<std::string> allowed;
    if (values.is_array()) {
        for (const auto& value : values) {
            if (!value.is_string()) continue;
            auto host = value.get<std::string>();
            try { allowed.insert(NormalizeDomain(ParseHttpUrl(host.find("://") == host.npos ? "https://" + host : host).host)); }
            catch (const std::exception&) {}
        }
    }
    const std::lock_guard lock(state_->mutex);
    const auto expiry = Clock::now() - 30s;
    state_->entries.remove_if([&](const State::Entry& entry) { return entry.at < expiry; });
    auto result = Json::array();
    for (auto entry = state_->entries.rbegin(); entry != state_->entries.rend() && result.size() < 40; ++entry)
        if (!allowed.contains(entry->domain)) result.push_back(entry->domain + "（" + entry->source + "）");
    return result;
}

void DomainMonitor::Clear() {
    const std::lock_guard lock(state_->mutex);
    state_->entries.clear();
}

void DomainMonitor::Stop() {
    auto& watch = *state_;
    const std::lock_guard lock(watch.mutex);
    ++watch.generation;
    watch.entries.clear();
    watch.starting = watch.requested = false;
    watch.status = DomainStatus("idle", "整机外部域名采集未启动");
    watch.changed.notify_all();
}

}  // namespace proctor::mac
