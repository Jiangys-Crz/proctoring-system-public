#include "native.hpp"
#include "native_process.hpp"

#import <AppKit/AppKit.h>
#import <ApplicationServices/ApplicationServices.h>
#import <AVFoundation/AVFoundation.h>
#import <CoreGraphics/CoreGraphics.h>
#import <Security/Security.h>

#include <CommonCrypto/CommonDigest.h>
#include <algorithm>
#include <dispatch/dispatch.h>
#include <fcntl.h>
#include <fstream>
#include <future>
#include <map>
#include <mutex>
#include <regex>
#include <set>
#include <sys/stat.h>
#include <sys/utsname.h>
#include <thread>
#include <unistd.h>

namespace proctor {
namespace {
using namespace mac;

std::string Utf8(NSString* value) {
    const char* text = [value UTF8String];
    return text ? text : "";
}

NSString* NsString(std::string_view value) {
    return [[NSString alloc] initWithBytes:value.data() length:value.size() encoding:NSUTF8StringEncoding];
}

std::string Sha256(const unsigned char* bytes) {
    constexpr std::string_view hex = "0123456789abcdef";
    std::string result;
    for (std::size_t index = 0; index < CC_SHA256_DIGEST_LENGTH; ++index) {
        result += hex[bytes[index] >> 4];
        result += hex[bytes[index] & 15];
    }
    return result;
}

std::string FileHash(const fs::path& path) {
    unsigned char bytes[CC_SHA256_DIGEST_LENGTH];
    CC_SHA256_CTX context;
    CC_SHA256_Init(&context);
    std::ifstream file(path, std::ios::binary);
    if (!file) return {};
    char buffer[16384];
    while (file.read(buffer, sizeof buffer) || file.gcount())
        CC_SHA256_Update(&context, buffer, static_cast<CC_LONG>(file.gcount()));
    if (!file.eof()) return {};
    CC_SHA256_Final(bytes, &context);
    return Sha256(bytes);
}

std::string DeviceId(const fs::path& directory) {
    fs::create_directories(directory);
    const auto path = directory / "device-id";
    std::ifstream input(path, std::ios::binary);
    std::string saved;
    if (input) {
        char bytes[128]{};
        input.read(bytes, sizeof bytes);
        saved = Trim(std::string_view(bytes, static_cast<std::size_t>(input.gcount())));
    }
    static const std::regex format("[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}", std::regex::icase);
    if (std::regex_match(saved, format)) return saved;
    const auto id = Lower(Utf8([NSUUID UUID].UUIDString));
    auto temporary = path;
    temporary += "." + Utf8([NSUUID UUID].UUIDString) + ".tmp";
    const auto file = open(temporary.c_str(), O_WRONLY | O_CREAT | O_EXCL | O_CLOEXEC, 0600);
    if (file < 0) throw std::runtime_error("无法写入客户端设备标识");
    const bool written = write(file, id.data(), id.size()) == static_cast<ssize_t>(id.size());
    const auto closed = close(file);
    if (!written || closed || rename(temporary.c_str(), path.c_str()) != 0) {
        unlink(temporary.c_str());
        throw std::runtime_error("无法写入客户端设备标识");
    }
    return id;
}

const char* MediaStatus(AVMediaType type) {
    switch ([AVCaptureDevice authorizationStatusForMediaType:type]) {
        case AVAuthorizationStatusNotDetermined: return "not-determined";
        case AVAuthorizationStatusRestricted: return "restricted";
        case AVAuthorizationStatusDenied: return "denied";
        case AVAuthorizationStatusAuthorized: return "granted";
        default: return "unknown";
    }
}

Json MediaStatuses() {
    return {{"camera", MediaStatus(AVMediaTypeVideo)}, {"microphone", MediaStatus(AVMediaTypeAudio)},
            {"screen", CGPreflightScreenCaptureAccess() ? "granted" : "denied"}};
}

bool Accessibility(bool prompt) {
    if (!prompt) return AXIsProcessTrusted();
    const auto options = @{(__bridge NSString*)kAXTrustedCheckOptionPrompt: @YES};
    if ([NSThread isMainThread]) return AXIsProcessTrustedWithOptions((__bridge CFDictionaryRef)options);
    __block bool trusted = false;
    dispatch_sync(dispatch_get_main_queue(), ^{ trusted = AXIsProcessTrustedWithOptions((__bridge CFDictionaryRef)options); });
    return trusted;
}

bool AskMedia(const std::string& kind) {
    const auto type = kind == "camera" ? AVMediaTypeVideo : kind == "microphone" ? AVMediaTypeAudio : nil;
    if (!type) throw std::runtime_error("未知的设备权限");
    if ([NSThread isMainThread]) throw std::runtime_error("设备权限请求需要后台调度");
    const auto result = std::make_shared<std::promise<bool>>();
    auto future = result->get_future();
    dispatch_async(dispatch_get_main_queue(), ^{
        [AVCaptureDevice requestAccessForMediaType:type completionHandler:^(BOOL granted) {
            result->set_value(granted);
        }];
    });
    return future.get();
}

bool OpenUrl(std::string_view url) {
    auto address = [NSURL URLWithString:NsString(url)];
    if ([NSThread isMainThread]) return [[NSWorkspace sharedWorkspace] openURL:address];
    __block bool opened = false;
    dispatch_sync(dispatch_get_main_queue(), ^{ opened = [[NSWorkspace sharedWorkspace] openURL:address]; });
    return opened;
}

bool OpenPrivacyPane(const std::string& pane) {
    static const std::map<std::string, std::string_view> suffixes{{"camera", "Camera"}, {"microphone", "Microphone"},
        {"screen", "ScreenCapture"}, {"accessibility", "Accessibility"}, {"automation", "Automation"}, {"localNetwork", "LocalNetwork"}};
    const auto found = suffixes.find(pane);
    if (found == suffixes.end()) throw std::runtime_error("未知的系统权限页面");
    if (pane == "screen" && !CGPreflightScreenCaptureAccess()) {
        // macOS lists the bundle in Screen Recording after it requests access.
        if ([NSThread isMainThread]) CGRequestScreenCaptureAccess();
        else dispatch_sync(dispatch_get_main_queue(), ^{ CGRequestScreenCaptureAccess(); });
    }
    if (!OpenUrl("x-apple.systempreferences:com.apple.preference.security?Privacy_" + std::string(found->second)))
        throw std::runtime_error("无法打开系统权限页面");
    return true;
}

struct ProcessInfo { pid_t pid; std::string executable, command; };

std::map<pid_t, std::string> PidRows(const std::string& input) {
    std::map<pid_t, std::string> result;
    static const std::regex row(R"(^\s*(\d+)\s+(.+?)\s*$)");
    for (const auto& line : Split(input, '\n')) {
        std::smatch match;
        if (std::regex_match(line, match, row)) result.emplace(static_cast<pid_t>(std::stol(match[1])), match[2]);
    }
    return result;
}

std::vector<ProcessInfo> Processes() {
    auto pending = std::async(std::launch::async, [] { return PidRows(CheckedRun("/bin/ps", {"-axo", "pid=,args="})); });
    auto commands = PidRows(CheckedRun("/bin/ps", {"-axo", "pid=,comm="}));
    const auto args = pending.get();
    std::vector<ProcessInfo> entries;
    for (auto& [pid, executable] : commands) {
        if (pid <= 0 || executable.empty()) continue;
        const auto command = args.find(pid);
        entries.push_back({pid, std::move(executable), command == args.end() ? "" : command->second});
    }
    return entries;
}

std::string DisplayName(const ProcessInfo& entry) {
    static const std::regex bundle(R"(/([^/]+)\.app/)");
    std::smatch match;
    if (std::regex_search(entry.executable, match, bundle) || std::regex_search(entry.command, match, bundle)) return match[1];
    const auto name = fs::path(entry.executable).filename().string();
    return name.empty() ? "PID " + std::to_string(entry.pid) : name;
}

bool FitsProduct(const std::string& identifier, std::string_view product) {
    return identifier == product || identifier.starts_with(std::string(product) + ".");
}

struct SigningInfo { bool valid = false; std::string team, identifier; };

SigningInfo CodeInfo(const fs::path& path, bool apple) {
    @autoreleasepool {
        auto url = [NSURL fileURLWithPath:NsString(path.string())];
        SecStaticCodeRef code = nullptr;
        if (SecStaticCodeCreateWithPath((__bridge CFURLRef)url, kSecCSDefaultFlags, &code) != errSecSuccess) return {};
        const std::unique_ptr<const __SecCode, decltype(&CFRelease)> codeOwner(code, CFRelease);
        SecRequirementRef requirement = nullptr;
        if (SecRequirementCreateWithString(apple ? CFSTR("anchor apple") : CFSTR("anchor apple generic"), kSecCSDefaultFlags,
            &requirement) != errSecSuccess) return {};
        const std::unique_ptr<const __SecRequirement, decltype(&CFRelease)> requirementOwner(requirement, CFRelease);
        if (SecStaticCodeCheckValidity(code, kSecCSStrictValidate, requirement) != errSecSuccess) return {};
        if (apple) return {true, {}, {}};
        CFDictionaryRef info = nullptr;
        if (SecCodeCopySigningInformation(code, kSecCSSigningInformation, &info) != errSecSuccess) return {};
        const std::unique_ptr<const __CFDictionary, decltype(&CFRelease)> infoOwner(info, CFRelease);
        auto team = (__bridge NSString*)CFDictionaryGetValue(info, kSecCodeInfoTeamIdentifier);
        auto identifier = (__bridge NSString*)CFDictionaryGetValue(info, kSecCodeInfoIdentifier);
        return {true, Utf8(team), Utf8(identifier)};
    }
}

bool MatchesSystemPath(std::string_view path) {
    return path.starts_with("/System/") || path.starts_with("/usr/libexec/") || path.starts_with("/usr/sbin/") || path.starts_with("/sbin/");
}

bool IsWebKitSystemHelper(std::string_view path, std::string_view name) {
    return path.starts_with("/System/Library/Frameworks/WebKit.framework/") &&
           (name == "com.apple.WebKit.WebContent" || name == "com.apple.WebKit.Networking" || name == "com.apple.WebKit.GPU" ||
            name == "com.apple.WebKit.WebContent.CaptivePortal");
}

bool IsSystemProcess(std::string_view name) {
    static const std::set<std::string_view> names{"launchd", "kernel_task", "WindowServer", "Finder", "Dock", "loginwindow",
        "SystemUIServer", "ControlCenter", "NotificationCenter", "coreaudiod", "cfprefsd", "distnoted", "mds", "mdworker",
        "mdworker_shared", "trustd", "securityd", "lsd", "notifyd", "bluetoothd", "powerd", "runningboardd", "sharingd", "tccd", "rapportd"};
    return names.contains(name);
}

bool IsIde(std::string_view name) {
    static const std::set<std::string_view> names{"code.exe", "code", "electron", "code helper", "code helper (renderer)",
        "code helper (gpu)", "code helper (plugin)", "idea64.exe", "idea", "pycharm64.exe", "pycharm", "clion64.exe", "clion",
        "rider64.exe", "rider", "goland64.exe", "goland", "eclipse.exe", "eclipse"};
    return names.contains(name);
}

bool MatchesIdeSignature(const std::string& name, const SigningInfo& proof) {
    if (!proof.valid) return false;
    const auto lower = Lower(name);
    if (lower.starts_with("code") || name == "Electron")
        return proof.team == "UBF8T346G9" && FitsProduct(proof.identifier, "com.microsoft.VSCode");
    static const std::map<std::string, std::string_view> products{{"idea", "intellij"}, {"pycharm", "pycharm"},
        {"clion", "clion"}, {"rider", "rider"}, {"goland", "goland"}};
    const auto found = products.find(lower);
    return found != products.end() && proof.team == "2ZEFAR8TH3" &&
        FitsProduct(Lower(proof.identifier), "com.jetbrains." + std::string(found->second));
}

std::string HardwareValue(const Json& entry, std::initializer_list<std::string_view> keys) {
    for (const auto& key : keys) {
        const auto found = entry.find(key);
        if (found == entry.end() || !(found->is_string() || found->is_number())) continue;
        auto raw = found->is_string() ? found->get<std::string>() : found->dump();
        // system_profiler serial numbers and names may contain non-ASCII characters.
        auto value = Trim(Utf8([NsString(raw) lowercaseString]));
        if (!value.empty()) return value;
    }
    return {};
}

std::string HardwareHex(const Json& entry, std::initializer_list<std::string_view> keys) {
    static const std::regex hex("0x([0-9a-f]+)");
    auto value = HardwareValue(entry, keys);
    std::smatch match;
    if (!std::regex_search(value, match, hex)) return value;
    value = match[1];
    const auto digit = value.find_first_not_of('0');
    return digit == std::string::npos ? "0" : value.substr(digit);
}

void CollectDevices(const Json& entries, bool usb, unsigned depth, std::set<std::string>& result) {
    if (!entries.is_array() || depth > 64) throw std::runtime_error("USB 外设报告格式无效");
    for (const auto& entry : entries) {
        if (!entry.is_object()) throw std::runtime_error("USB 外设报告格式无效");
        if (usb) {
            const auto vendor = HardwareHex(entry, {"USBDeviceKeyVendorID", "vendor_id"});
            const auto product = HardwareHex(entry, {"USBDeviceKeyProductID", "product_id"});
            const auto location = HardwareHex(entry, {"USBKeyLocationID", "location_id"});
            auto serial = HardwareValue(entry, {"USBDeviceKeySerialNumber", "serial_num"});
            if (serial == "not provided") serial.clear();
            if (!vendor.empty() || !product.empty()) {
                if (vendor.empty() || product.empty() || (location.empty() && serial.empty()))
                    throw std::runtime_error("USB 外设身份信息不完整");
                result.insert(Json::array({"usb", vendor, product, location, serial}).dump());
            } else if (depth || HardwareValue(entry, {"_name"}).empty()) throw std::runtime_error("USB 外设身份信息不完整");
        } else if (depth) {
            auto uid = HardwareValue(entry, {"switch_uid_key", "device_uid_key", "uid"});
            if (uid.empty()) throw std::runtime_error("Thunderbolt 外设身份信息不完整");
            result.insert(Json::array({"thunderbolt", uid}).dump());
        }
        if (entry.contains("_items")) CollectDevices(entry.at("_items"), usb, depth + 1, result);
    }
}

std::string ActiveApplication() {
    return Trim(CheckedRun("/usr/bin/osascript", {"-e",
        "tell application \"System Events\" to get name of first application process whose frontmost is true"}, 3s));
}

std::string Elevation() { return getuid() == 0 ? "elevated" : "standard"; }

template<typename Action>
auto WithPool(Action action) {
    @autoreleasepool { return action(); }
}

template<typename Action>
auto Background(Action action) { return std::async(std::launch::async, [action] { return WithPool(action); }); }

template<typename Result>
void Collect(Json& result, const char* key, std::future<Result>& pending) {
    try { result[key] = pending.get(); }
    catch (const std::exception& error) { NSLog(@"[security] %s: %s", key, error.what()); }
}

}  // namespace

struct NativeMac::State {
    const fs::path resources, userData, executable;
    const std::string version;
    const bool packaged;
    const std::function<void()> openWireshark;
    Json pins = Json::object();
    DomainMonitor domains;
    std::mutex device, hardware, process, peripheral;
    std::optional<Json> hardwareSignals;
    std::string usbType;
    bool hasThunderbolt = false;

    struct Probe {
        Clock::time_point time;
        std::string fingerprint;
        std::uint64_t sequence;
    };

    std::shared_future<std::string> pendingPeripheral;
    std::optional<Probe> observation, change;
    std::string stableFingerprint;
    std::uint64_t observationSequence = 0;

    struct SignedPath {
        struct stat info;
        bool allowed;
    };
    std::map<fs::path, SignedPath> signedPaths;

    State(fs::path res, fs::path data, std::string clientVersion, bool appPackaged, std::function<void()> open)
        : resources(std::move(res)), userData(std::move(data)), executable(Utf8(NSBundle.mainBundle.executablePath)),
          version(std::move(clientVersion)), packaged(appPackaged), openWireshark(std::move(open)) {
        try {
            std::ifstream file(resources / "renderer" / "process-policy.json");
            const auto manifest = Json::parse(file);
            if (manifest.value("version", 0) == 1 && manifest.contains("executables") && manifest.at("executables").is_object())
                pins = manifest.at("executables");
        } catch (const std::exception&) {}
    }

    Json DesktopInfo() {
        const std::lock_guard lock(device);
        struct utsname os{};
        uname(&os);
        char host[256]{};
        gethostname(host, sizeof host - 1);
        return {{"deviceId", DeviceId(userData)}, {"hostname", host}, {"os", "darwin " + std::string(os.release)}, {"clientVersion", version}};
    }

    Json SystemPermissionStatus() const {
        auto name = Utf8([NSBundle.mainBundle objectForInfoDictionaryKey:@"CFBundleName"]);
        if (name.empty()) name = Utf8(NSProcessInfo.processInfo.processName);
        auto bundleId = Utf8(NSBundle.mainBundle.bundleIdentifier);
        if (bundleId.empty()) bundleId = "org.cwnupaa.proctor";
        return {{"platform", "darwin"}, {"media", MediaStatuses()}, {"accessibility", Accessibility(false)},
                {"bundleId", bundleId}, {"appName", name}, {"execPath", executable.string()}, {"isPackaged", packaged}};
    }

    bool TrustedProcess(const ProcessInfo& entry) {
        if (entry.pid == getpid()) return true;
        const fs::path path(entry.executable);
        if (!path.is_absolute()) return false;
        if (Lower(path.lexically_normal().string()) == Lower(executable.lexically_normal().string()) ||
            Lower(path.lexically_normal().string()) == Lower((resources / "ffmpeg" / "ffmpeg").lexically_normal().string())) return true;
        const auto rawName = path.filename().string();
        const auto rawPinned = pins.contains(path.lexically_normal().string());
        if (!rawPinned && !IsSystemProcess(rawName) && !IsIde(Lower(rawName)) && !IsWebKitSystemHelper(entry.executable, rawName)) return false;

        std::error_code error;
        const auto canonical = fs::canonical(path, error);
        if (error) return false;
        struct stat info{};
        if (stat(canonical.c_str(), &info) || !S_ISREG(info.st_mode)) return false;
        const auto match = signedPaths.find(canonical);
        if (match != signedPaths.end()) {
            const auto& previous = match->second.info;
            if (previous.st_ino == info.st_ino && previous.st_dev == info.st_dev && previous.st_size == info.st_size &&
                previous.st_mtimespec.tv_sec == info.st_mtimespec.tv_sec && previous.st_mtimespec.tv_nsec == info.st_mtimespec.tv_nsec &&
                previous.st_ctimespec.tv_sec == info.st_ctimespec.tv_sec && previous.st_ctimespec.tv_nsec == info.st_ctimespec.tv_nsec)
                return match->second.allowed;
        }

        auto allowed = false;
        const auto name = canonical.filename().string();
        const auto location = canonical.string();
        const auto pin = pins.find(location);
        static const std::regex hash("[a-fA-F0-9]{64}");
        if (pin != pins.end() && pin->is_string() && std::regex_match(pin->get<std::string>(), hash))
            allowed = Lower(pin->get<std::string>()) == FileHash(canonical);
        if (!allowed && info.st_uid == 0 && !(info.st_mode & 0022) && MatchesSystemPath(location) &&
            (IsSystemProcess(name) || IsWebKitSystemHelper(location, name))) allowed = CodeInfo(canonical, true).valid;
        if (!allowed && IsIde(Lower(name)) && location.starts_with("/Applications/"))
            allowed = MatchesIdeSignature(name, CodeInfo(canonical, false));
        signedPaths[canonical] = {info, allowed};
        return allowed;
    }

    Json DisallowedProcesses() {
        const auto entries = Processes();
        const std::lock_guard lock(process);
        auto result = Json::array();
        std::set<std::string> names;
        for (const auto& entry : entries) {
            if (TrustedProcess(entry)) continue;
            auto name = DisplayName(entry);
            if (!names.insert(name).second) continue;
            result.push_back(std::move(name));
            if (result.size() == 60) break;
        }
        return result;
    }

    Json VmSignals() {
        const std::lock_guard lock(hardware);
        if (hardwareSignals) return *hardwareSignals;
        const auto report = Json::parse(CheckedRun("/usr/sbin/system_profiler", {"SPHardwareDataType", "-json"}, 10s));
        const auto& entries = report.at("SPHardwareDataType");
        if (!entries.is_array() || entries.empty()) throw std::runtime_error("设备型号报告不完整，请重新检测");
        std::string identity;
        for (const auto& entry : entries) {
            if (!entry.is_object()) throw std::runtime_error("设备型号报告无效，请重新检测");
            for (const auto* key : {"machine_name", "machine_model", "manufacturer", "model_name", "model_identifier"}) {
                const auto value = entry.find(key);
                if (value != entry.end() && value->is_string()) identity += Trim(value->get<std::string>()) + ' ';
            }
        }
        identity = Lower(Trim(identity));
        if (identity.empty()) throw std::runtime_error("设备型号信息不完整，请重新检测");
        auto result = Json::array();
        for (const std::string needle : {"vmware", "virtualbox", "innotek", "parallels", "qemu", "hyper-v", "kvm", "xen", "bhyve", "bochs"}) {
            const auto word = needle == "kvm" || needle == "xen";
            if (word ? std::regex_search(identity, std::regex("\\b" + needle + "\\b")) : identity.find(needle) != identity.npos)
                result.push_back(needle);
        }
        if (identity.find("microsoft") != identity.npos && identity.find("virtual machine") != identity.npos &&
            std::find(result.begin(), result.end(), "hyper-v") == result.end()) result.push_back("hyper-v");
        hardwareSignals = result;
        return result;
    }

    std::string ScanPeripherals() {
        if (usbType.empty()) {
            const auto rawTypes = Split(CheckedRun("/usr/sbin/system_profiler", {"-listDataTypes"}, 10s), '\n');
            std::set<std::string> types;
            for (const auto& type : rawTypes) types.insert(Trim(type));
            if (types.contains("SPUSBHostDataType")) usbType = "SPUSBHostDataType";
            else if (types.contains("SPUSBDataType")) usbType = "SPUSBDataType";
            else throw std::runtime_error("当前 macOS 未提供 USB 外设信息");
            hasThunderbolt = types.contains("SPThunderboltDataType");
        }
        std::vector<std::string> args{usbType};
        if (hasThunderbolt) args.push_back("SPThunderboltDataType");
        args.push_back("-json");
        const auto run = Run("/usr/sbin/system_profiler", args, 10s);
        static const std::regex incomplete(R"(timed?\s*out|timeout|incomplete|failed|error)", std::regex::icase);
        if (run.status || std::regex_search(run.errors, incomplete)) throw std::runtime_error("USB 外设检测未完成");
        const auto report = Json::parse(run.output);
        const auto& usb = report.at(usbType);
        if (!usb.is_array() || usb.empty() || (hasThunderbolt && !report.contains("SPThunderboltDataType")))
            throw std::runtime_error("USB 外设报告缺少硬件信息");
        std::set<std::string> devices;
        CollectDevices(usb, true, 0, devices);
        if (report.contains("SPThunderboltDataType")) CollectDevices(report.at("SPThunderboltDataType"), false, 0, devices);
        std::vector<std::string> identities(devices.begin(), devices.end());
        const auto utf16 = [](std::string_view value) {
            NSString* string = NsString(value);
            std::u16string units(string.length, 0);
            [string getCharacters:reinterpret_cast<unichar*>(units.data()) range:NSMakeRange(0, string.length)];
            return units;
        };
        std::sort(identities.begin(), identities.end(), [&](const auto& a, const auto& b) { return utf16(a) < utf16(b); });
        const auto bytes = Json(identities).dump();
        unsigned char digest[CC_SHA256_DIGEST_LENGTH];
        CC_SHA256(bytes.data(), static_cast<CC_LONG>(bytes.size()), digest);
        return "mac-usb-v3:" + Sha256(digest);
    }

    std::string Fingerprint() {
        std::unique_lock lock(peripheral);
        if (pendingPeripheral.valid()) {
            auto pending = pendingPeripheral;
            lock.unlock();
            return pending.get();
        }
        std::promise<std::string> promise;
        pendingPeripheral = promise.get_future().share();
        lock.unlock();
        try {
            auto fingerprint = ScanPeripherals();
            lock.lock();
            const auto now = Clock::now();
            observation = Probe{now, fingerprint, ++observationSequence};
            if (stableFingerprint.empty() || fingerprint == stableFingerprint) {
                stableFingerprint = fingerprint;
                change.reset();
            } else if (!change || change->fingerprint != fingerprint) change = observation;
            else if (now - change->time >= 1s) {
                stableFingerprint = fingerprint;
                change.reset();
            }
            promise.set_value(stableFingerprint);
            pendingPeripheral = {};
            return stableFingerprint;
        } catch (...) {
            if (!lock.owns_lock()) lock.lock();
            ++observationSequence;
            observation.reset();
            change.reset();
            promise.set_exception(std::current_exception());
            pendingPeripheral = {};
            throw;
        }
    }

    std::string ConfirmBaseline() {
        std::optional<Probe> previous;
        {
            const std::lock_guard lock(peripheral);
            if (observation && !change && observation->fingerprint == stableFingerprint &&
                Clock::now() - observation->time <= 5s) previous = observation;
        }
        for (int attempt = 0; attempt < 4; ++attempt) {
            if (previous) std::this_thread::sleep_until(previous->time + 1s);
            Fingerprint();
            const std::lock_guard lock(peripheral);
            // A failed or intervening scan must not bridge observations into a stable pair.
            if (previous && observation && previous->sequence + 1 == observation->sequence &&
                previous->fingerprint == observation->fingerprint && observation->time - previous->time >= 1s &&
                !change && stableFingerprint == observation->fingerprint) return observation->fingerprint;
            previous = observation;
        }
        throw std::runtime_error("设备检测未稳定，请稍后重试");
    }

    Json Capabilities() {
        auto processes = Background([] { return !Processes().empty(); });
        auto fingerprint = Background([this] { return Fingerprint(); });
        auto vm = Background([this] { return VmSignals(); });
        auto active = Background([] { return ActiveApplication(); });
        const auto elevation = Elevation();
        const auto network = domains.Status();
        Json result{{"platform", "darwin"}, {"elevated", elevation == "elevated"}, {"elevationStatus", elevation},
            {"networkScan", network.at("state") == "ready" || network.at("state") == "limited"}, {"networkDomainStatus", network}};
        Collect(result, "processScan", processes);
        Collect(result, "peripheralsFingerprint", fingerprint);
        Collect(result, "vmSignals", vm);
        Collect(result, "activeName", active);
        result["processScan"] = result.value("processScan", false);
        result["hardwareScan"] = result.contains("peripheralsFingerprint");
        result["vmScan"] = result.contains("vmSignals");
        result["activeWindow"] = result.contains("activeName");
        result.erase("activeName");
        result["processScanMessage"] = result.value("processScan", false) ? "" : "进程列表读取失败，请重试；已授权时请检查系统检测组件或安全软件拦截。";
        result["hardwareScanMessage"] = result.value("hardwareScan", false) ? "" : "外设信息读取失败，请重新检测，并检查安全软件是否隔离了检测组件。";
        result["vmScanMessage"] = result.value("vmScan", false) ? "" : "设备型号读取失败，请重新检测，并检查客户端检测组件。";
        result["activeWindowMessage"] = result.value("activeWindow", false) ? "" : "活动窗口读取失败，请检查辅助功能，以及“隐私与安全性 > 自动化”中允许客户端控制 System Events。";
        return result;
    }

    Json Snapshot(const Json& allowed, bool includePeripherals) {
        auto processes = Background([this] { return DisallowedProcesses(); });
        auto fingerprint = includePeripherals ? Background([this] { return Fingerprint(); }) : std::future<std::string>{};
        auto vm = Background([this] { return VmSignals(); });
        auto active = Background([] { return ActiveApplication(); });
        Json result{{"networkRemotes", domains.Remotes(allowed)}, {"networkDomainStatus", domains.Status()}, {"allowedNetworkRemotes", allowed}};
        Collect(result, "disallowedProcesses", processes);
        if (includePeripherals) {
            Collect(result, "peripheralsFingerprint", fingerprint);
            result["peripheralScanOk"] = result.contains("peripheralsFingerprint");
        }
        Collect(result, "vmSignals", vm);
        Collect(result, "activeWindow", active);
        return result;
    }

    Json RequestDomainPermission() {
        auto result = domains.RequestPermission();
        if (result.at("state") == "unavailable" && !result.value("permissionRequired", false)) {
            if (!openWireshark) return result;
            openWireshark();
            result["message"] = "已打开网络采集组件的官方安装入口，安装完成后点击卡片重新检测。";
        }
        return result;
    }
};

NativeMac::NativeMac(fs::path resources, fs::path userData, std::string version, bool packaged, std::function<void()> open)
    : state_(std::make_unique<State>(std::move(resources), std::move(userData), std::move(version), packaged, std::move(open))) {}
NativeMac::~NativeMac() = default;

Json NativeMac::Handle(std::string_view channel, const Json& args, std::string_view mode) {
    @autoreleasepool {
        const auto text = [&] { return !args.empty() && args[0].is_string() ? args[0].get<std::string>() : std::string{}; };
        if (channel == "system:getInfo") return state_->DesktopInfo();
        if (channel == "app:relaunchAsAdmin" || channel == "permissions:openWindowsPrivacyPane") return false;
        if (channel == "permissions:getMacMediaAccessStatus") return MediaStatuses();
        if (channel == "permissions:getSystemPermissionStatus") return state_->SystemPermissionStatus();
        if (channel == "permissions:askMacMediaAccess") return AskMedia(text());
        if (channel == "permissions:openMacPrivacyPane") return OpenPrivacyPane(text());
        if (channel == "permissions:promptMacAccessibility") return Accessibility(true);
        if (channel == "permissions:requestNetworkDomain") return state_->RequestDomainPermission();
        if (channel == "security:capabilities") return state_->Capabilities();
        if (channel == "security:snapshot") {
            const auto allowed = !args.empty() && args[0].is_array() ? args[0] : Json::array();
            return state_->Snapshot(allowed, args.size() < 2 || args[1] != false);
        }
        if (channel == "security:peripherals") {
            try { return {{"peripheralsFingerprint", state_->Fingerprint()}, {"peripheralScanOk", true}}; }
            catch (const std::exception& error) {
                NSLog(@"[security] peripheral-scan-failed: %s", error.what());
                return {{"peripheralScanOk", false}};
            }
        }
        if (channel == "security:startDomainMonitor") return state_->domains.Start();
        if (channel == "security:stopDomainMonitor") { StopMonitoring(); return nullptr; }
        if (channel == "security:resetDomains") { state_->domains.Clear(); return nullptr; }
        if (channel == "security:watchUsb" || channel == "security:ackUsb") return nullptr;
        if (channel == "security:readUsb") return {{"available", true}, {"events", Json::array()}};
        if (channel == "security:confirmPeripheralBaseline") {
            if (mode != "setup") throw std::runtime_error("请先结束当前考试或屏幕展示，再检测登录设备");
            return state_->ConfirmBaseline();
        }
        throw std::runtime_error("未知的 macOS 客户端接口");
    }
}

void NativeMac::StopMonitoring() { state_->domains.Stop(); }

}  // namespace proctor
