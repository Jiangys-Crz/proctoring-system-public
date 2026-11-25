#include <winsock2.h>
#include <ws2tcpip.h>
#include <iphlpapi.h>
#include <winnls.h>

#include "native_windows_security.hpp"
#include "bridge.hpp"

#include <algorithm>
#include <condition_variable>
#include <regex>
#include <set>
#include <thread>

namespace proctor::native {
namespace {
const Json idle{{"state", "idle"}, {"message", "整机外部域名采集未启动"}};
const Json unavailable{{"state", "unavailable"}, {"message", "系统 DNS 缓存读取失败，请重新检测，并检查 DNS Client 服务或安全软件是否拦截了系统检测命令。"}};
const Json limited{{"state", "limited"}, {"message", "网络检测可用（系统 DNS 缓存）"}};
const Json ready{{"state", "ready"}, {"message", "网络检测已授权"}};

std::string NormalizedDomain(std::string_view input) {
    auto text = Trim(input);
    if (text.ends_with('.')) text.pop_back();
    if (text.size() > 1024 || text.find('.') == std::string::npos) return {};
    try {
        const auto unicode = Wide(text);
        wchar_t ascii[254]{};
        const int size = IdnToAscii(IDN_USE_STD3_ASCII_RULES, unicode.data(), static_cast<int>(unicode.size()), ascii, 254);
        if (size <= 0 || size > 253) return {};
        auto domain = Utf8(std::wstring_view(ascii, size));
        std::transform(domain.begin(), domain.end(), domain.begin(), [](unsigned char c) { return static_cast<char>(std::tolower(c)); });
        if (domain.ends_with(".arpa") || domain.ends_with(".local") || domain.ends_with(".localhost")) return {};
        in_addr ip{};
        if (InetPtonA(AF_INET, domain.c_str(), &ip) == 1) return {};
        const auto letterOrDigit = [](char c) { return (c >= 'a' && c <= 'z') || (c >= '0' && c <= '9'); };
        for (std::string_view labels = domain;;) {
            const auto separator = labels.find('.');
            const auto label = labels.substr(0, separator);
            if (label.empty() || label.size() > 63 || !letterOrDigit(label.front()) || !letterOrDigit(label.back()) ||
                !std::all_of(label.begin(), label.end(), [&](char c) { return letterOrDigit(c) || c == '-'; })) return {};
            if (separator == std::string_view::npos) break;
            labels.remove_prefix(separator + 1);
        }
        return domain;
    } catch (...) { return {}; }
}

std::set<std::string> CacheNames(bool& useLegacyIpconfig, const std::atomic_bool& cancelled) {
    if (!useLegacyIpconfig) {
        try {
            const auto output = Run(SystemCommand(L"WindowsPowerShell\\v1.0\\powershell.exe"), {
                L"-NoProfile", L"-NonInteractive", L"-Command",
                L"[Console]::OutputEncoding = New-Object System.Text.UTF8Encoding; Get-DnsClientCache -ErrorAction Stop | "
                L"Where-Object { $_.Type -in 1,28,5 -and $_.Status -eq 0 } | Select-Object -ExpandProperty Entry | ConvertTo-Json -Compress"
            }, 12s, 8 * 1024 * 1024, true, &cancelled);
            if (output.code) throw std::runtime_error("读取系统 DNS 缓存失败");
            auto text = Trim(output.output);
            if (text.starts_with("\xef\xbb\xbf")) text.erase(0, 3);
            auto names = text.empty() ? Json::array() : Json::parse(text);
            if (names.is_null()) return {};
            if (!names.is_array()) names = Json::array({names});
            std::set<std::string> result;
            for (auto& name : names) {
                auto domain = NormalizedDomain(name.get<std::string>());
                if (!domain.empty()) result.insert(std::move(domain));
            }
            return result;
        } catch (...) { useLegacyIpconfig = true; }
    }
    const auto output = Run(SystemCommand(L"ipconfig.exe"), {L"/displaydns"}, 12s, 8 * 1024 * 1024, true, &cancelled);
    if (output.code) throw std::runtime_error("读取系统 DNS 缓存失败");
    std::set<std::string> result;
    for (std::string_view lines = output.output; !lines.empty();) {
        const auto newline = lines.find('\n');
        const auto line = lines.substr(0, newline);
        const auto separator = line.find(':');
        if (separator != std::string_view::npos) {
            auto domain = NormalizedDomain(line.substr(separator + 1));
            if (!domain.empty()) result.insert(std::move(domain));
        }
        if (newline == std::string_view::npos) break;
        lines.remove_prefix(newline + 1);
    }
    return result;
}

std::wstring SourceFilter() {
    constexpr ULONG flags = GAA_FLAG_INCLUDE_ALL_INTERFACES | GAA_FLAG_SKIP_ANYCAST | GAA_FLAG_SKIP_MULTICAST | GAA_FLAG_SKIP_DNS_SERVER;
    ULONG size = 15000;
    std::vector<unsigned char> buffer(size);
    ULONG result;
    do {
        buffer.resize(size);
        result = GetAdaptersAddresses(AF_UNSPEC, flags, nullptr, reinterpret_cast<IP_ADAPTER_ADDRESSES*>(buffer.data()), &size);
    } while (result == ERROR_BUFFER_OVERFLOW);
    if (result != NO_ERROR) throw std::runtime_error("没有可用的本机网络接口");
    std::set<std::wstring> addresses;
    for (auto* adapter = reinterpret_cast<IP_ADAPTER_ADDRESSES*>(buffer.data()); adapter; adapter = adapter->Next) {
        for (auto* unicast = adapter->FirstUnicastAddress; unicast; unicast = unicast->Next) {
            const auto* socket = unicast->Address.lpSockaddr;
            wchar_t text[INET6_ADDRSTRLEN]{};
            if (socket->sa_family == AF_INET && InetNtopW(AF_INET, const_cast<IN_ADDR*>(&reinterpret_cast<const sockaddr_in*>(socket)->sin_addr), text, INET6_ADDRSTRLEN)) addresses.insert(text);
            if (socket->sa_family == AF_INET6 && InetNtopW(AF_INET6, const_cast<IN6_ADDR*>(&reinterpret_cast<const sockaddr_in6*>(socket)->sin6_addr), text, INET6_ADDRSTRLEN)) addresses.insert(text);
        }
    }
    if (addresses.empty()) throw std::runtime_error("没有可用的本机网络接口");
    std::wstring filter = L"(";
    for (const auto& address : addresses) {
        if (filter.size() > 1) filter += L" or ";
        filter += L"src host " + address;
    }
    return filter + L") and (port 53 or tcp or udp port 443)";
}
}

struct DomainMonitor::State {
    struct Observation { std::string domain, source; Clock::time_point at; };
    std::mutex lifecycle, mutex;
    std::condition_variable changed;
    MonitorWorkers workers;
    bool starting = false;
    Json status{{"state", "idle"}, {"message", "尚未检测整机外部域名采集能力"}};
    std::vector<Observation> entries;

    void Add(std::string domain, std::string source, Clock::time_point now) {
        if (domain.empty()) return;
        std::erase_if(entries, [&](const Observation& old) { return old.domain == domain && old.source == source; });
        if (entries.size() >= 2000) entries.erase(entries.begin());
        entries.push_back({std::move(domain), std::move(source), now});
    }
    void SetStatus(const Json& value, const std::atomic_bool& stop) {
        const std::lock_guard lock(mutex);
        if (stop) return;
        status = value;
        starting = false;
        changed.notify_all();
    }
    bool Wait(std::chrono::milliseconds delay, const std::atomic_bool& stop) {
        std::unique_lock lock(mutex);
        return changed.wait_for(lock, delay, [&] { return stop.load(); });
    }
    bool Capture(const fs::path& tshark, const std::atomic_bool& stop) {
        const auto listing = Run(tshark, {L"-D"}, 6s, 8 * 1024 * 1024, true, &stop);
        if (listing.code || Wait(0ms, stop)) return false;
        static const std::regex interfacePattern(R"(^\d+\. (\S+))");
        static const std::regex external(R"(extcap|sshdump|ciscodump|randpkt|udpdump|wifidump)", std::regex::icase);
        std::vector<std::wstring> args;
        for (const auto& line : Split(listing.output, '\n')) {
            std::smatch match;
            if (!std::regex_search(line, external) && std::regex_search(line, match, interfacePattern)) {
                // Opening the aggregate interface also covers the individual
                // interfaces. Keep the legacy choice if tshark exposes it.
                if (match[1] == "any") {
                    args = {L"-i", L"any"};
                    break;
                }
                args.push_back(L"-i");
                args.push_back(Wide(match[1].str()));
            }
        }
        if (args.empty()) return false;
        args.insert(args.end(), {L"-p", L"-n", L"-l", L"-f", SourceFilter(), L"-Y",
            L"(dns.flags.response == 0) or tls.handshake.extensions_server_name or http.host",
            L"-T", L"fields", L"-e", L"dns.qry.name", L"-e", L"tls.handshake.extensions_server_name", L"-e", L"http.host"});
        ChildProcess child(tshark, args);
        child.CloseInput();
        const auto deadline = Clock::now() + 5s;
        auto captureStarted = Clock::time_point::max();
        std::string stderrText, pending;
        static const std::regex listening(R"(listening on|Capturing on|Capture started)", std::regex::icase);
        static const std::regex denied(R"(permission denied|operation not permitted|don't have permission|access.*denied)", std::regex::icase);
        static const std::regex permission(R"(permission|permitted|denied)", std::regex::icase);
        static const std::regex port(R"(:\d+$)");
        const char* const sources[]{"DNS 查询", "TLS SNI", "HTTP"};
        bool active = false;
        do {
            const auto now = Clock::now();
            const auto errors = child.ReadErrors();
            if (!errors.empty()) {
                stderrText += errors;
                if (stderrText.size() > 4000) stderrText.erase(0, stderrText.size() - 4000);
                if (std::regex_search(stderrText, denied)) return true;
                if (captureStarted == Clock::time_point::max() && std::regex_search(stderrText, listening)) captureStarted = now;
            }
            if (!child.IsRunning()) {
                const auto tail = Trim(stderrText);
                const auto start = tail.size() > 600 ? tail.size() - 600 : 0;
                return std::regex_search(tail.begin() + start, tail.end(), permission);
            }
            if (!active && now >= deadline) return false;
            if (!active && captureStarted <= now && now - captureStarted >= 300ms) {
                SetStatus(ready, stop);
                active = true;
            }
            pending += child.ReadOutput();
            std::size_t consumed = 0;
            for (auto newline = pending.find('\n'); newline != std::string::npos; newline = pending.find('\n', consumed)) {
                const auto fields = Split(std::string_view(pending).substr(consumed, newline - consumed), '\t');
                consumed = newline + 1;
                const std::lock_guard lock(mutex);
                if (stop) return false;
                for (std::size_t i = 0; i < (std::min)(fields.size(), std::size(sources)); ++i) {
                    for (auto field : Split(fields[i], ',')) {
                        if (i == 2) field = std::regex_replace(Trim(field), port, "");
                        Add(NormalizedDomain(field), sources[i], now);
                    }
                }
            }
            if (consumed) pending.erase(0, consumed);
            if (pending.size() > 65536) pending.clear();
        } while (!Wait(50ms, stop));
        return false;
    }
    void RunMonitor(const std::atomic_bool& stop) {
        bool permissionRequired = false;
        try {
            auto programFiles = ReadEnv(L"ProgramFiles");
            const auto tshark = fs::path(programFiles.empty() ? L"C:\\Program Files" : std::move(programFiles)) / L"Wireshark/tshark.exe";
            if (fs::is_regular_file(tshark)) permissionRequired = Capture(tshark, stop);
        } catch (...) { /* Continue with the system DNS cache when packet capture fails. */ }
        {
            const std::lock_guard lock(mutex);
            if (stop) return;
            if (status.at("state") == "ready") {
                // A running capture ended. Report the interruption while
                // probing the DNS fallback instead of retaining stale readiness.
                status = {{"state", "unavailable"}, {"message", "网络采集中断，请点击“网络检测”重新申请或检测权限。"},
                          {"permissionRequired", permissionRequired}};
            }
        }
        bool useLegacyIpconfig = OsRelease().starts_with("6.1.");
        std::set<std::string> previous;
        bool baseline = false, first = true;
        do {
            try {
                auto current = CacheNames(useLegacyIpconfig, stop);
                {
                    const std::lock_guard lock(mutex);
                    if (stop) return;
                    if (baseline) for (const auto& domain : current) {
                        if (!previous.contains(domain)) Add(domain, "DNS 缓存新增", Clock::now());
                    }
                }
                previous = std::move(current);
                baseline = true;
                SetStatus(limited, stop);
            } catch (...) {
                baseline = false;
                previous.clear();
                SetStatus(unavailable, stop);
                if (first) return;
            }
            first = false;
        } while (!Wait(3s, stop));
    }
    void StopWorker() {
        const std::lock_guard lock(mutex);
        workers.Stop();
        starting = false;
        entries.clear();
        status = idle;
        changed.notify_all();
    }
};

DomainMonitor::DomainMonitor() : state_(std::make_unique<State>()) {}
DomainMonitor::~DomainMonitor() { Stop(); state_->workers.Join(); }
Json DomainMonitor::Status() {
    const std::lock_guard lock(state_->mutex);
    return state_->status;
}
Json DomainMonitor::Start() {
    Cancellation cancelled;
    {
        const std::lock_guard operation(state_->lifecycle);
        bool launch;
        {
            const std::lock_guard lock(state_->mutex);
            const auto status = state_->status.at("state");
            launch = !state_->starting && status != "ready" && status != "limited";
            cancelled = state_->workers.Current();
        }
        if (launch) {
            state_->StopWorker();
            const std::lock_guard lock(state_->mutex);
            state_->starting = true;
            try {
                cancelled = state_->workers.Start([this](const std::atomic_bool& stop) { state_->RunMonitor(stop); });
            } catch (...) {
                state_->starting = false;
                state_->status = unavailable;
                state_->changed.notify_all();
            }
        }
    }
    std::unique_lock lock(state_->mutex);
    state_->changed.wait(lock, [&] { return !state_->starting || (cancelled && cancelled->load()); });
    return state_->status;
}
void DomainMonitor::Stop() {
    const std::lock_guard lock(state_->lifecycle);
    state_->StopWorker();
}
void DomainMonitor::Reset() {
    const std::lock_guard lock(state_->mutex);
    state_->entries.clear();
}
Json DomainMonitor::Snapshot(const Json& allowedHosts) {
    std::set<std::string> allowed;
    if (allowedHosts.is_array()) for (const auto& host : allowedHosts) {
        if (!host.is_string()) continue;
        try {
            const auto& name = host.get_ref<const std::string&>();
            const auto parsed = ParseHttpUrl(name.find("://") != std::string::npos ? name : "https://" + name);
            allowed.insert(NormalizedDomain(parsed.host));
        } catch (...) { }
    }
    const auto now = Clock::now();
    const std::lock_guard lock(state_->mutex);
    std::erase_if(state_->entries, [&](const State::Observation& entry) { return now - entry.at > 30s; });
    auto sorted = state_->entries;
    std::stable_sort(sorted.begin(), sorted.end(), [](const auto& a, const auto& b) { return a.at > b.at; });
    Json result = Json::array();
    for (const auto& entry : sorted) {
        if (!allowed.contains(entry.domain)) result.push_back(entry.domain + "（" + entry.source + "）");
        if (result.size() >= 40) break;
    }
    return result;
}
}
