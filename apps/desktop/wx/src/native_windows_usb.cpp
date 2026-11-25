#include "native_windows_security.hpp"

#include <algorithm>
#include <condition_variable>
#include <map>
#include <optional>
#include <regex>
#include <set>
#include <sstream>
#include <thread>
#include <utility>
#include <vector>

namespace proctor::native {
namespace {
using Devices = std::set<std::string>;

std::string InventoryFingerprint(const Devices& devices) {
    std::istringstream bytes(Json(devices).dump());
    return "usb-v6:" + Sha256(bytes);
}

std::string Upper(std::string_view value) {
    auto text = Wide(value);
    if (!text.empty()) CharUpperBuffW(text.data(), static_cast<DWORD>(text.size()));
    return Utf8(text);
}

std::string PhysicalIdentity(const std::string& id, const std::string& bus, const std::string& hardware) {
    static const std::regex functionInterface(R"(&MI_[0-9A-F]{2}(?:&|\\|\||$))");
    static const std::regex vidPid(R"(^(VID_[0-9A-F]{4}&PID_[0-9A-F]{4})(?:&|$))");
    static const std::regex hardwareVidPid(R"(^[^\\]+\\(VID_[0-9A-F]{4}&PID_[0-9A-F]{4})(?:&|$))");
    static const Devices childBuses{"HID", "USBSTOR", "SCSI", "STORAGE", "SWD", "ROOT", "HTREE", "BTHENUM", "PCI"};
    const auto parts = Split(id, '\\');
    if (parts.size() != 3 || !std::all_of(parts.begin(), parts.end(), [](const auto& part) { return !part.empty(); }) ||
        childBuses.contains(parts[0]) || std::regex_search(id + "|" + hardware, functionInterface) ||
        parts[1].find("ROOT_HUB") != std::string::npos || hardware.find("ROOT_HUB") != std::string::npos) return {};
    if (parts[0] != "USB" && bus != "USB" && !hardware.starts_with("USB\\")) return {};
    std::smatch model;
    if (!std::regex_search(parts[1], model, vidPid) && !std::regex_search(hardware, model, hardwareVidPid)) return {};
    return "USB\\" + model[1].str() + "\\" + parts[2];
}

std::string InterfaceIdentity(const Json& value) {
    static const std::regex pattern(R"(^\\\\\?\\([A-Z0-9_]{1,64})#(VID_[0-9A-F]{4}&PID_[0-9A-F]{4}(?:&[^#]+)?)#([^#]+)#\{A5DCBF10-6530-11D2-901F-00C04FB951ED\}$)");
    if (!value.is_string() || value.get_ref<const std::string&>().size() > 2048) return {};
    const auto path = Upper(value.get_ref<const std::string&>());
    std::smatch match;
    if (!std::regex_match(path, match, pattern)) return {};
    return PhysicalIdentity(match[1].str() + "\\" + match[2].str() + "\\" + match[3].str(), "USB", "");
}

Devices DeviceInventory(std::string output) {
    if (output.starts_with("\xef\xbb\xbf")) output.erase(0, 3);
    const auto lines = Split(Trim(output), '\n');
    if (lines.size() < 2) throw std::runtime_error("未读取到有效的 USB 外设信息");
    const auto header = ParseCsv(lines.front());
    const auto column = [&header](std::string_view name) {
        const auto at = std::find(header.begin(), header.end(), name);
        if (at == header.end()) throw std::runtime_error("未读取到有效的 USB 外设信息");
        return static_cast<std::size_t>(at - header.begin());
    };
    const auto device = column("DeviceID"), present = column("Present");
    const auto bus = column("BusType"), hardware = column("HardwareID");
    Devices devices;
    std::size_t parsedRows = 0;
    for (auto at = lines.begin() + 1; at != lines.end(); ++at) {
        if (Trim(*at).empty()) continue;
        ++parsedRows;
        const auto row = ParseCsv(*at);
        if (row.size() != header.size() || row[device].empty()) throw std::runtime_error("未读取到有效的 USB 外设信息");
        const auto presentValue = Upper(row[present]);
        if (presentValue != "TRUE" && presentValue != "FALSE") throw std::runtime_error("USB 外设状态无效");
        const auto id = Upper(row[device]);
        const auto busValue = Upper(row[bus]);
        const auto hardwareValue = Upper(row[hardware]);
        if (busValue != "USB" && busValue != "OTHER" && busValue != "UNKNOWN") throw std::runtime_error("USB 总线信息无效");
        if (!id.starts_with("USB\\") && !hardwareValue.starts_with("USB\\") && busValue != "USB") continue;
        static const std::regex complete(R"(^[^\\]+\\[^\\]+\\.+$)");
        if (!std::regex_match(id, complete)) throw std::runtime_error("USB 外设身份信息不完整");
        if (presentValue == "FALSE") continue;
        const auto identity = PhysicalIdentity(id, busValue, hardwareValue);
        if (!identity.empty()) devices.insert(identity);
    }
    if (!parsedRows) throw std::runtime_error("未读取到有效的 USB 外设信息");
    return devices;
}
}

struct UsbMonitor::State {
    struct InventorySample {
        Devices devices;
        Clock::time_point time;
    };

    struct Observation {
        std::string fingerprint;
        Clock::time_point time;
        std::uint64_t sequence = 0;
    };
    struct Candidate {
        Devices devices;
        Clock::time_point observed;
    };
    struct Arrival {
        std::optional<Clock::time_point> firstPresent;
        bool departed = false;
    };
    struct Event {
        std::string id, deviceId, inventoryFingerprint;
        const char* action;
        Clock::time_point firstSeenAt;
    };

    fs::path executable;
    std::function<void(std::string)> diagnostic;
    std::mutex inventoryMutex;
    std::shared_future<InventorySample> pendingInventory;
    SharedWork<std::string> fingerprintWork;
    std::mutex fingerprintMutex;
    Observation observed, pending;
    Devices observedDevices;
    std::optional<std::pair<std::string, Devices>> confirmedSetupBaseline;
    std::uint64_t observationSequence = 0;
    std::string stable;

    std::mutex lifecycle, eventsMutex;
    std::condition_variable eventsChanged;
    MonitorWorkers workers;
    bool enabled = false, ready = false, fault = false, starting = false;
    std::string session;
    std::vector<Event> events;
    std::optional<Devices> watcherBaseline;

    State(fs::path inventory, std::function<void(std::string)> log) : executable(std::move(inventory)), diagnostic(std::move(log)) {}

    InventorySample Inventory(const std::atomic_bool* cancelled = nullptr, bool requireFresh = false) {
        std::shared_future<InventorySample> result;
        {
            const std::lock_guard lock(inventoryMutex);
            if (pendingInventory.valid() && pendingInventory.wait_for(0ms) == std::future_status::ready) {
                try {
                    if (requireFresh || Clock::now() - pendingInventory.get().time >= 250ms) pendingInventory = {};
                } catch (...) { pendingInventory = {}; }
            }
            if (!pendingInventory.valid()) {
                pendingInventory = std::async(std::launch::async, [probe = executable] {
                    auto data = Run(probe, {L"peripherals"});
                    if (data.code) throw std::runtime_error("USB 外设检测未完成");
                    auto devices = DeviceInventory(std::move(data.output));
                    return InventorySample{std::move(devices), Clock::now()};
                }).share();
            }
            result = pendingInventory;
        }
        if (cancelled) {
            // Stop the notification process promptly even if a concurrent
            // heartbeat still needs the in-flight inventory scan.
            while (result.wait_for(25ms) != std::future_status::ready) {
                if (cancelled->load()) throw std::runtime_error("USB 检测已结束");
            }
        }
        return result.get();
    }
    std::string Fingerprint(bool requireFresh = false) {
        return fingerprintWork([&] {
            try {
                auto sample = Inventory(nullptr, requireFresh);
                auto fingerprint = InventoryFingerprint(sample.devices);
                const std::lock_guard lock(fingerprintMutex);
                if (sample.time <= observed.time) return stable;
                observed = {std::move(fingerprint), sample.time, ++observationSequence};
                observedDevices = std::move(sample.devices);
                if (stable.empty() || observed.fingerprint == stable) {
                    stable = observed.fingerprint;
                    pending = {};
                } else if (pending.fingerprint != observed.fingerprint) pending = observed;
                else if (observed.time - pending.time >= 3s) {
                    stable = observed.fingerprint;
                    pending = {};
                }
                return stable;
            } catch (...) {
                const std::lock_guard lock(fingerprintMutex);
                observed = {{}, Clock::now(), ++observationSequence};
                pending = {};
                throw;
            }
        });
    }
    void ConfirmWatcherFingerprint(const std::string& fingerprint, const InventorySample& sample) {
        const std::lock_guard lock(fingerprintMutex);
        const auto time = sample.time;
        if (time < observed.time || (time == observed.time && observed.fingerprint != fingerprint)) return;
        if (time != observed.time) {
            observed = {fingerprint, time, ++observationSequence};
            observedDevices = sample.devices;
        }
        stable = fingerprint;
        pending = {};
    }

    void Enqueue(const char* action, const std::string& id, Clock::time_point firstSeenAt, const std::string& inventoryFingerprint = {}) {
        if (events.size() >= 64) throw std::runtime_error("USB 事件队列已满");
        events.push_back({StringUuid(), id, inventoryFingerprint, action, firstSeenAt});
        diagnostic(std::string("confirmed ") + action + " " + id);
    }
    void RunWatcher(const std::atomic_bool& stop, Devices known, bool hasBaseline) {
        try {
            if (stop) return;
            ChildProcess child(executable, {L"peripheral-events", std::to_wstring(GetCurrentProcessId())});
            child.CloseInput();
            const auto startupDeadline = Clock::now() + 10s;
            auto nextScan = Clock::time_point::max();
            bool initialized = false;
            bool promptScan = false;
            unsigned failedScans = 0;
            std::string buffer;
            std::map<std::string, Arrival> arrivals;
            std::optional<Candidate> candidate;
            for (;;) {
                const auto now = Clock::now();
                {
                    const std::lock_guard lock(eventsMutex);
                    if (stop) return;
                }
                if (!child.IsRunning()) throw std::runtime_error("notification process exited");
                if (!initialized && now >= startupDeadline) throw std::runtime_error("startup timeout");
                (void)child.ReadErrors();
                buffer += child.ReadOutput();
                if (buffer.size() > 65536) throw std::runtime_error("notification stream overflow");
                for (auto newline = buffer.find('\n'); newline != std::string::npos; newline = buffer.find('\n')) {
                    const auto value = Json::parse(Trim(buffer.substr(0, newline)));
                    buffer.erase(0, newline + 1);
                    if (value.value("ready", false)) {
                        if (initialized) throw std::runtime_error("duplicate ready message");
                        auto baseline = Inventory(&stop, true);
                        if (Clock::now() >= startupDeadline) throw std::runtime_error("startup timeout");
                        const std::lock_guard lock(eventsMutex);
                        if (stop) return;
                        if (!hasBaseline) {
                            known = std::move(baseline.devices);
                            watcherBaseline = known;
                        } else if (baseline.devices != known) {
                            for (const auto& id : baseline.devices) {
                                if (!known.contains(id) && arrivals.size() < 64) arrivals.emplace(id, Arrival{baseline.time, false});
                            }
                            candidate = Candidate{std::move(baseline.devices), baseline.time};
                            nextScan = Clock::now() + 1500ms;
                        }
                        initialized = ready = true;
                        starting = false;
                        diagnostic("baseline devices=" + std::to_string(known.size()));
                        eventsChanged.notify_all();
                        continue;
                    }
                    const auto action = value.at("action").get<std::string>();
                    if (!initialized || (action != "INSERT" && action != "REMOVE")) throw std::runtime_error("invalid device event");
                    const auto id = InterfaceIdentity(value.at("path"));
                    if (id.empty()) continue;
                    if (action == "INSERT" && !known.contains(id)) {
                        if (auto arrival = arrivals.find(id); arrival != arrivals.end()) {
                            if (arrival->second.departed) arrival->second = {};
                        } else if (arrivals.size() < 64) arrivals.emplace(id, Arrival{});
                    } else if (auto arrival = arrivals.find(id); action == "REMOVE" && arrival != arrivals.end()) {
                        arrival->second.departed = true;
                    }
                    // Sample promptly after an idle notification. Subsequent
                    // samples must still confirm physical inventory changes.
                    if (nextScan == Clock::time_point::max()) {
                        nextScan = Clock::now() + 250ms;
                        promptScan = true;
                    }
                }
                if (Clock::now() >= nextScan) {
                    const bool prompt = std::exchange(promptScan, false);
                    std::optional<InventorySample> sample;
                    try { sample = Inventory(&stop); }
                    catch (const std::exception& error) {
                        if (stop) return;
                        candidate.reset();
                        arrivals.clear();
                        if (++failedScans >= 2) throw;
                        diagnostic(std::string("inventory retry: ") + error.what());
                        nextScan = Clock::now() + 1500ms;
                        continue;
                    }
                    failedScans = 0;
                    const auto& devices = sample->devices;
                    const std::lock_guard lock(eventsMutex);
                    if (stop) return;
                    // A present inventory sample and a later absent sample
                    // corroborate a brief insertion. Interface notifications
                    // alone only schedule a scan.
                    const auto before = events.size();
                    for (auto arrival = arrivals.begin(); arrival != arrivals.end();) {
                        auto& [id, hint] = *arrival;
                        if (devices.contains(id)) {
                            if (!hint.firstPresent) hint.firstPresent = sample->time;
                        } else if (hint.departed) {
                            if (hint.firstPresent) {
                                if (events.size() > 62) throw std::runtime_error("USB 事件队列已满");
                                Enqueue("INSERT", id, *hint.firstPresent);
                                Enqueue("REMOVE", id, sample->time);
                            }
                            arrival = arrivals.erase(arrival);
                            continue;
                        }
                        ++arrival;
                    }
                    const bool unchanged = devices == known;
                    if (unchanged) {
                        if (!prompt && before == events.size()) diagnostic("ignored interface notifications; physical inventory unchanged");
                        candidate.reset();
                        if (!prompt) arrivals.clear();
                    } else if (!candidate || devices != candidate->devices) candidate = Candidate{devices, sample->time};
                    else if (sample->time - candidate->observed >= 3s) {
                        Devices removed, inserted;
                        std::set_difference(known.begin(), known.end(), devices.begin(), devices.end(), std::inserter(removed, removed.end()));
                        std::set_difference(devices.begin(), devices.end(), known.begin(), known.end(), std::inserter(inserted, inserted.end()));
                        if (events.size() + removed.size() + inserted.size() > 64) throw std::runtime_error("USB 事件队列已满");
                        const auto fingerprint = InventoryFingerprint(devices);
                        for (const auto& id : removed) Enqueue("REMOVE", id, candidate->observed, fingerprint);
                        for (const auto& id : inserted) Enqueue("INSERT", id, candidate->observed, fingerprint);
                        ConfirmWatcherFingerprint(fingerprint, *sample);
                        known = devices;
                        watcherBaseline = known;
                        candidate.reset();
                        arrivals.clear();
                    }
                    // The first scan can run before SetupAPI publishes the
                    // new list. Keep the ordinary delayed verification too.
                    nextScan = candidate || (prompt && unchanged) ? Clock::now() + 1500ms : Clock::time_point::max();
                }
                std::unique_lock lock(eventsMutex);
                eventsChanged.wait_for(lock, candidate || !initialized ? 50ms : 200ms, [&] { return stop.load(); });
            }
        } catch (const std::exception& error) {
            const std::lock_guard lock(eventsMutex);
            if (stop) return;
            ready = starting = false;
            fault = true;
            diagnostic(std::string("failed ") + error.what());
            eventsChanged.notify_all();
        }
    }
    void StopWatcher() {
        const std::lock_guard lock(eventsMutex);
        workers.Stop();
        starting = ready = fault = false;
        eventsChanged.notify_all();
    }
    Cancellation Start(const std::string& sessionId, bool recoverOnly = false, const std::string& baselineFingerprint = {}) {
        const std::lock_guard lock(lifecycle);
        if (!enabled) {
            if (!recoverOnly) throw std::runtime_error("请先登录考试再启用 USB 检测");
            return {};
        }
        {
            const std::lock_guard eventsLock(eventsMutex);
            if (session == sessionId && (starting || ready)) return workers.Current();
            // A failure creating the worker sets fault before there is a
            // current worker to restart. Recover it on the next read too.
            if (recoverOnly && (session != sessionId || !fault)) return {};
        }
        StopWatcher();
        const std::lock_guard eventsLock(eventsMutex);
        if (session != sessionId) {
            session = sessionId;
            events.clear();
            watcherBaseline.reset();
            const std::lock_guard fingerprintLock(fingerprintMutex);
            if (confirmedSetupBaseline && confirmedSetupBaseline->first == baselineFingerprint) {
                watcherBaseline = confirmedSetupBaseline->second;
            }
        }
        fault = false;
        starting = true;
        try {
            return workers.Start([this, baseline = watcherBaseline](const std::atomic_bool& cancel) {
                RunWatcher(cancel, baseline.value_or(Devices{}), baseline.has_value());
            });
        }
        catch (const std::exception& error) {
            starting = false;
            fault = true;
            eventsChanged.notify_all();
            if (recoverOnly) {
                // A worker creation failure should not block the heartbeat
                // from reading and acknowledging previously queued events.
                diagnostic(std::string("failed restart: ") + error.what());
                return {};
            }
            throw;
        }
    }
};

UsbMonitor::UsbMonitor(fs::path inventory, std::function<void(std::string)> diagnostic)
    : state_(std::make_unique<State>(std::move(inventory), std::move(diagnostic))) {}
UsbMonitor::~UsbMonitor() { Stop(); state_->workers.Join(); }
std::string UsbMonitor::Fingerprint() { return state_->Fingerprint(); }
std::string UsbMonitor::ConfirmBaseline() {
    State::Observation previous;
    {
        const std::lock_guard lock(state_->fingerprintMutex);
        const auto& last = state_->observed;
        // Reuse a recent raw observation from setup, then confirm it with a new inventory.
        if (!last.fingerprint.empty() && state_->pending.fingerprint.empty() && state_->stable == last.fingerprint &&
            Clock::now() - last.time <= 5s) previous = last;
    }
    if (previous.sequence) std::this_thread::sleep_until(previous.time + 1s);
    for (int attempt = 0; attempt < 4; ++attempt) {
        state_->Fingerprint(true);
        {
            const std::lock_guard lock(state_->fingerprintMutex);
            const auto& value = state_->observed;
            if (previous.sequence && value.sequence == previous.sequence + 1 &&
                value.fingerprint == previous.fingerprint && value.time - previous.time >= 1s &&
                state_->pending.fingerprint.empty() && state_->stable == value.fingerprint) {
                state_->confirmedSetupBaseline.emplace(value.fingerprint, state_->observedDevices);
                return value.fingerprint;
            }
            previous = value;
        }
        if (attempt < 3) std::this_thread::sleep_for(1100ms);
    }
    throw std::runtime_error("设备检测未稳定，请稍后重试");
}
void UsbMonitor::Watch(const std::string& sessionId, const std::string& baselineFingerprint) {
    const auto cancelled = state_->Start(sessionId, false, baselineFingerprint);
    std::unique_lock lock(state_->eventsMutex);
    state_->eventsChanged.wait(lock, [&] { return cancelled->load() || state_->session != sessionId || !state_->starting; });
    if (cancelled->load() || state_->session != sessionId) throw std::runtime_error("USB 检测已结束");
    if (!state_->ready) throw std::runtime_error("USB 设备通知监听不可用，请重新检测");
}
Json UsbMonitor::Read(const std::string& sessionId) {
    state_->Start(sessionId, true);
    const std::lock_guard lock(state_->eventsMutex);
    const bool matches = state_->session == sessionId;
    auto events = Json::array();
    if (matches) {
        const auto now = Clock::now();
        for (const auto& event : state_->events) {
            const auto age = std::chrono::duration_cast<std::chrono::milliseconds>(now - event.firstSeenAt).count();
            Json value{{"id", event.id}, {"action", event.action}, {"deviceId", event.deviceId}, {"observedAgeMs", age}};
            if (!event.inventoryFingerprint.empty()) value["inventoryFingerprint"] = event.inventoryFingerprint;
            events.push_back(std::move(value));
        }
    }
    return {{"available", matches && state_->ready && !state_->fault}, {"events", std::move(events)}};
}
void UsbMonitor::Acknowledge(const std::string& sessionId, const Json& ids) {
    if (!ids.is_array() || ids.size() > 64) return;
    const std::lock_guard lock(state_->eventsMutex);
    if (sessionId != state_->session) return;
    std::erase_if(state_->events, [&](const auto& event) { return std::find(ids.begin(), ids.end(), event.id) != ids.end(); });
}
void UsbMonitor::SetEnabled(bool enabled) {
    const std::lock_guard lock(state_->lifecycle);
    state_->enabled = enabled;
    if (!enabled) state_->StopWatcher();
}
void UsbMonitor::Stop() { SetEnabled(false); }
}
