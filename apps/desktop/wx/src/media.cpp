#include "media.hpp"

#include <windows.h>
#include <objbase.h>
#include <gdiplus.h>
#include <wincrypt.h>

#include <nlohmann/json.hpp>

#include <algorithm>
#include <array>
#include <atomic>
#include <chrono>
#include <condition_variable>
#include <cstddef>
#include <cstdint>
#include <deque>
#include <exception>
#include <mutex>
#include <stdexcept>
#include <string>
#include <thread>
#include <tuple>
#include <type_traits>
#include <unordered_map>
#include <utility>
#include <vector>

namespace proctor {
namespace {

using Json = nlohmann::json;
using namespace std::chrono_literals;
constexpr size_t maxJpegBytes = 4 * 1024 * 1024;

class Handle {
public:
    explicit Handle(HANDLE value = nullptr) : value_(value) {}
    Handle(Handle&& other) noexcept : value_(std::exchange(other.value_, nullptr)) {}
    ~Handle() { if (*this) CloseHandle(value_); }

    Handle& operator=(Handle&& other) noexcept {
        Handle previous(std::exchange(value_, std::exchange(other.value_, nullptr)));
        return *this;
    }
    HANDLE Get() const { return value_; }
    explicit operator bool() const { return value_ && value_ != INVALID_HANDLE_VALUE; }

private:
    HANDLE value_;
};

std::string WindowsError(DWORD code) {
    return "Win32 " + std::to_string(code);
}

std::string Base64(const void* data, size_t bytes) {
    DWORD length = 0;
    constexpr DWORD flags = CRYPT_STRING_BASE64 | CRYPT_STRING_NOCRLF;
    const auto* input = static_cast<const BYTE*>(data);
    if (!CryptBinaryToStringA(input, static_cast<DWORD>(bytes), flags, nullptr, &length)) {
        throw std::runtime_error("屏幕画面编码失败");
    }
    std::string result(length, '\0');
    if (!CryptBinaryToStringA(input, static_cast<DWORD>(bytes), flags, result.data(), &length)) {
        throw std::runtime_error("屏幕画面编码失败");
    }
    result.resize(length);
    if (!result.empty() && result.back() == '\0') result.pop_back();
    return result;
}

bool IsWindows7() {
    using RtlGetVersion = LONG(WINAPI*)(OSVERSIONINFOW*);
    const auto address = GetProcAddress(GetModuleHandleW(L"ntdll.dll"), "RtlGetVersion");
    const auto query = reinterpret_cast<RtlGetVersion>(reinterpret_cast<void*>(address));
    OSVERSIONINFOW version{};
    version.dwOSVersionInfoSize = sizeof(version);
    return query && query(&version) == 0 && version.dwMajorVersion == 6 && version.dwMinorVersion == 1;
}

struct Display {
    RECT rect{};
    HMONITOR handle{};
    bool primary{};
};

struct DisplayList {
    std::vector<Display> values;
    std::exception_ptr error;
};

BOOL CALLBACK AddDisplay(HMONITOR monitor, HDC, LPRECT, LPARAM data) {
    auto& list = *reinterpret_cast<DisplayList*>(data);
    MONITORINFO info{};
    info.cbSize = sizeof(info);
    if (GetMonitorInfoW(monitor, &info)) {
        try {
            list.values.push_back({info.rcMonitor, monitor, (info.dwFlags & MONITORINFOF_PRIMARY) != 0});
        } catch (...) {
            list.error = std::current_exception();
            return FALSE;
        }
    }
    return TRUE;
}

std::vector<Display> Displays() {
    DisplayList list;
    const auto ok = EnumDisplayMonitors(nullptr, nullptr, AddDisplay, reinterpret_cast<LPARAM>(&list));
    if (list.error) std::rethrow_exception(list.error);
    if (!ok) throw std::runtime_error("屏幕源探测失败");
    std::stable_partition(list.values.begin(), list.values.end(), [](const Display& value) { return value.primary; });
    return std::move(list.values);
}

std::string SourceId(size_t index) {
    return "screen:" + std::to_string(index) + ":0";
}

HBITMAP CaptureBitmap(const RECT& rect, int maxWidth, int maxHeight) {
    const auto originalWidth = rect.right - rect.left;
    const auto originalHeight = rect.bottom - rect.top;
    if (originalWidth <= 0 || originalHeight <= 0) return {};
    const auto scale = std::min(static_cast<double>(maxWidth) / originalWidth,
                                static_cast<double>(maxHeight) / originalHeight);
    const auto width = std::max(1, static_cast<int>(originalWidth * scale));
    const auto height = std::max(1, static_cast<int>(originalHeight * scale));
    const auto screen = GetDC(nullptr);
    if (!screen) return {};
    const auto resized = CreateCompatibleDC(screen);
    const auto bitmap = CreateCompatibleBitmap(screen, width, height);
    bool captured = false;
    if (bitmap && resized) {
        const auto previous = SelectObject(resized, bitmap);
        if (previous && previous != HGDI_ERROR) {
            SetStretchBltMode(resized, HALFTONE);
            SetBrushOrgEx(resized, 0, 0, nullptr);
            captured = StretchBlt(resized, 0, 0, width, height, screen, rect.left, rect.top,
                                  originalWidth, originalHeight, SRCCOPY | CAPTUREBLT) != FALSE;
            SelectObject(resized, previous);
        }
    }
    if (resized) DeleteDC(resized);
    ReleaseDC(nullptr, screen);
    if (captured) return bitmap;
    if (bitmap) DeleteObject(bitmap);
    return nullptr;
}

std::string Thumbnail(const RECT& rect, ULONG_PTR gdiplus, int maxWidth, int maxHeight) {
    if (!gdiplus) return {};
    // The system PNG codec is available on the same Windows versions as GDI+.
    const CLSID png{0x557cf406, 0x1a04, 0x11d3, {0x9a, 0x73, 0, 0, 0xf8, 0x1e, 0xf3, 0x2e}};
    const auto deleteBitmap = [](HBITMAP handle) { if (handle) DeleteObject(handle); };
    const std::unique_ptr<std::remove_pointer_t<HBITMAP>, decltype(deleteBitmap)> bitmap(
        CaptureBitmap(rect, maxWidth, maxHeight), deleteBitmap);
    if (!bitmap) return {};
    IStream* output = nullptr;
    if (FAILED(CreateStreamOnHGlobal(nullptr, TRUE, &output))) return {};
    const auto release = [](IStream* stream) { stream->Release(); };
    const std::unique_ptr<IStream, decltype(release)> stream(output, release);
    Gdiplus::Bitmap image(bitmap.get(), nullptr);
    if (image.Save(stream.get(), &png, nullptr) != Gdiplus::Ok) return {};
    STATSTG stat{};
    if (FAILED(stream->Stat(&stat, STATFLAG_NONAME)) || stat.cbSize.QuadPart > 1024 * 1024 ||
        FAILED(stream->Seek({}, STREAM_SEEK_SET, nullptr))) return {};
    std::vector<unsigned char> bytes(stat.cbSize.LowPart);
    ULONG read = 0;
    if (FAILED(stream->Read(bytes.data(), static_cast<ULONG>(bytes.size()), &read)) || read != bytes.size()) return {};
    return "data:image/png;base64," + Base64(bytes.data(), bytes.size());
}

Json ListSources(bool withThumbnail, ULONG_PTR gdiplus, bool verifyAccess = false) {
    const auto displays = Displays();
    auto result = Json::array();
    for (size_t index = 0; index < displays.size(); ++index) {
        const auto& display = displays[index];
        auto source = Json{
            {"id", SourceId(index)},
            {"name", displays.size() == 1 ? "Entire Screen" : "Screen " + std::to_string(index + 1)},
        };
        if (verifyAccess) {
            // Probe actual desktop access as the legacy thumbnail query did.
            // Monitor enumeration alone can succeed for an inaccessible desktop.
            const auto sample = CaptureBitmap(display.rect, 80, 45);
            if (!sample) continue;
            DeleteObject(sample);
        }
        if (withThumbnail) source["thumbnail"] = Thumbnail(display.rect, gdiplus, 360, 220);
        else source["displayId"] = std::to_string(reinterpret_cast<std::uintptr_t>(display.handle));
        result.push_back(std::move(source));
    }
    return result;
}

std::string LeaseId() {
    GUID guid{};
    wchar_t text[39]{};
    if (FAILED(CoCreateGuid(&guid)) || !StringFromGUID2(guid, text, 39)) {
        throw std::runtime_error("无法建立屏幕采集会话");
    }
    std::string id;
    for (int index = 1; index < 37; ++index) {
        const auto value = static_cast<char>(text[index]);
        id.push_back(value >= 'A' && value <= 'F' ? value - 'A' + 'a' : value);
    }
    return id;
}

struct CaptureConfig {
    LONG x{}, y{}, width{}, height{};
    int fps{}, maxWidth{}, maxHeight{};

    bool operator==(const CaptureConfig& other) const {
        return std::tie(x, y, width, height, fps, maxWidth, maxHeight) ==
               std::tie(other.x, other.y, other.width, other.height, other.fps, other.maxWidth, other.maxHeight);
    }
};

CaptureConfig CaptureSettings(const RECT& rect, int fps, int width, int height) {
    const CaptureConfig settings{rect.left, rect.top, rect.right - rect.left, rect.bottom - rect.top, fps, width, height};
    if (settings.x < -100000 || settings.x > 100000 || settings.y < -100000 || settings.y > 100000 ||
        settings.width < 32 || settings.height < 32 || settings.width > 32768 || settings.height > 32768) {
        throw std::runtime_error("无法确认完整屏幕尺寸");
    }
    return settings;
}

std::pair<Handle, Handle> Pipe(SECURITY_ATTRIBUTES& attributes, DWORD capacity = 0) {
    HANDLE read{}, write{};
    if (!CreatePipe(&read, &write, &attributes, capacity)) {
        throw std::runtime_error("无法创建屏幕采集管道（" + WindowsError(GetLastError()) + "）");
    }
    std::pair<Handle, Handle> result{Handle(read), Handle(write)};
    if (!SetHandleInformation(read, HANDLE_FLAG_INHERIT, 0)) {
        throw std::runtime_error("无法配置屏幕采集管道（" + WindowsError(GetLastError()) + "）");
    }
    return result;
}

class CaptureProcess {
public:
    CaptureProcess(const std::filesystem::path& executable, const CaptureConfig& config) {
        SECURITY_ATTRIBUTES security{sizeof(security), nullptr, TRUE};
        // Hold typical 1080p JPEG frames in one pipe buffer so the producer
        // does not wait for a consumer polling interval between small writes.
        auto [output, childOutput] = Pipe(security, 512 * 1024);
        auto [errors, childErrors] = Pipe(security);
        Handle childInput(CreateFileW(L"NUL", GENERIC_READ, FILE_SHARE_READ | FILE_SHARE_WRITE,
                                     &security, OPEN_EXISTING, FILE_ATTRIBUTE_NORMAL, nullptr));
        if (!childInput) throw std::runtime_error("无法配置屏幕采集进程输入");

        // Inherit just these three handles. Other Windows helpers can spawn concurrently.
        std::array handles{childInput.Get(), childOutput.Get(), childErrors.Get()};
        SIZE_T attributeBytes = 0;
        InitializeProcThreadAttributeList(nullptr, 1, 0, &attributeBytes);
        if (!attributeBytes) throw std::runtime_error("无法配置屏幕采集进程");
        auto storage = std::make_unique<std::byte[]>(attributeBytes);
        auto* attributes = reinterpret_cast<LPPROC_THREAD_ATTRIBUTE_LIST>(storage.get());
        if (!InitializeProcThreadAttributeList(attributes, 1, 0, &attributeBytes)) {
            throw std::runtime_error("无法配置屏幕采集进程");
        }
        const std::unique_ptr<std::remove_pointer_t<LPPROC_THREAD_ATTRIBUTE_LIST>,
                              decltype(&DeleteProcThreadAttributeList)> attributeList(attributes, DeleteProcThreadAttributeList);
        if (!UpdateProcThreadAttribute(attributes, 0, PROC_THREAD_ATTRIBUTE_HANDLE_LIST,
                                       handles.data(), sizeof(handles), nullptr, nullptr)) {
            throw std::runtime_error("无法配置屏幕采集进程");
        }

        // The complete monitor rectangle includes taskbars. The filter preserves aspect ratio.
        const auto filter = L"scale=w='min(" + std::to_wstring(config.maxWidth) +
            L",iw)':h='min(" + std::to_wstring(config.maxHeight) +
            L",ih)':force_original_aspect_ratio=decrease:force_divisible_by=2";
        auto command = L"\"" + executable.wstring() +
            L"\" -nostdin -hide_banner -loglevel error -f gdigrab -framerate " + std::to_wstring(config.fps) +
            L" -draw_mouse 1 -offset_x " + std::to_wstring(config.x) + L" -offset_y " + std::to_wstring(config.y) +
            L" -video_size " + std::to_wstring(config.width) + L"x" + std::to_wstring(config.height) +
            L" -i desktop -vf " + filter + L" -an -c:v mjpeg -q:v 4 -threads 1 -f image2pipe pipe:1";
        STARTUPINFOEXW startup{};
        startup.StartupInfo.cb = sizeof(startup);
        startup.StartupInfo.dwFlags = STARTF_USESTDHANDLES;
        startup.StartupInfo.hStdInput = childInput.Get();
        startup.StartupInfo.hStdOutput = childOutput.Get();
        startup.StartupInfo.hStdError = childErrors.Get();
        startup.lpAttributeList = attributes;

        Handle job(CreateJobObjectW(nullptr, nullptr));
        JOBOBJECT_EXTENDED_LIMIT_INFORMATION limits{};
        limits.BasicLimitInformation.LimitFlags = JOB_OBJECT_LIMIT_KILL_ON_JOB_CLOSE;
        if (job && !SetInformationJobObject(job.Get(), JobObjectExtendedLimitInformation, &limits, sizeof(limits))) {
            job = Handle();
        }
        PROCESS_INFORMATION info{};
        if (!CreateProcessW(executable.c_str(), command.data(), nullptr, nullptr, TRUE,
                            EXTENDED_STARTUPINFO_PRESENT | CREATE_NO_WINDOW | CREATE_SUSPENDED,
                            nullptr, nullptr, &startup.StartupInfo, &info)) {
            throw std::runtime_error("无法启动 FFmpeg 屏幕采集（" + WindowsError(GetLastError()) + "）");
        }
        Handle primaryThread(info.hThread);
        process_ = Handle(info.hProcess);
        if (job && AssignProcessToJobObject(job.Get(), process_.Get())) job_ = std::move(job);
        output_ = std::move(output);
        errors_ = std::move(errors);
        if (ResumeThread(primaryThread.Get()) == static_cast<DWORD>(-1)) {
            Terminate();
            throw std::runtime_error("无法运行 FFmpeg 屏幕采集");
        }
    }

    ~CaptureProcess() { Terminate(); }
    void Terminate() const { if (process_ && Running()) TerminateProcess(process_.Get(), 1); }
    bool Running() const { return WaitForSingleObject(process_.Get(), 0) == WAIT_TIMEOUT; }
    void Wait(DWORD ms) const { WaitForSingleObject(process_.Get(), ms); }
    HANDLE Output() const { return output_.Get(); }
    HANDLE Errors() const { return errors_.Get(); }

private:
    Handle process_;
    Handle job_;
    Handle output_;
    Handle errors_;
};

size_t ReadAvailable(HANDLE pipe, char* buffer, DWORD capacity) {
    DWORD available = 0, read = 0;
    if (PeekNamedPipe(pipe, nullptr, 0, nullptr, &available, nullptr) && available) {
        if (ReadFile(pipe, buffer, std::min(capacity, available), &read, nullptr)) return read;
    }
    return 0;
}

class Producer {
public:
    Producer(const std::filesystem::path& ffmpeg, CaptureConfig config, std::atomic<std::uint64_t>& sequence)
        : config_(config), sequence_(sequence), process_(ffmpeg, config),
          worker_([this] { Capture(); }) {}

    ~Producer() { Stop(); }
    CaptureConfig Config() const { return config_; }

    std::string NewLease() {
        const auto id = LeaseId();
        std::lock_guard lock(mutex_);
        if (leases_.size() >= 2) throw std::runtime_error("屏幕采集正在切换，请稍后重试");
        leases_.emplace(id, false);
        return id;
    }

    bool RemoveLease(const std::string& id) {
        std::lock_guard lock(mutex_);
        leases_.erase(id);
        changed_.notify_all();
        return leases_.empty();
    }

    bool Failed() {
        std::lock_guard lock(mutex_);
        return !failure_.empty();
    }

    size_t LeaseCount() {
        std::lock_guard lock(mutex_);
        return leases_.size();
    }

    bool HasLease(const std::string& id) {
        std::lock_guard lock(mutex_);
        return leases_.contains(id);
    }

    WindowsCaptureFrame Read(const std::string& id, std::uint64_t after) {
        std::unique_lock lock(mutex_);
        auto lease = leases_.find(id);
        if (lease == leases_.end()) throw std::runtime_error("屏幕采集已结束");
        if (!failure_.empty()) throw std::runtime_error(failure_);
        if (lease->second) throw std::runtime_error("请等待上一帧采集完成");
        if (latest_ && latest_->sequence > after) return *latest_;
        lease->second = true;
        const auto ready = changed_.wait_for(lock, after ? 3s : 8s, [&] {
            return leases_.find(id) == leases_.end() || !failure_.empty() || (latest_ && latest_->sequence > after);
        });
        lease = leases_.find(id);
        if (lease == leases_.end()) throw std::runtime_error("屏幕采集已结束");
        lease->second = false;
        if (!failure_.empty()) throw std::runtime_error(failure_);
        if (!ready) throw std::runtime_error("完整屏幕采集超时，请重新检测");
        return *latest_;
    }

    void RequestStop() {
        {
            std::lock_guard lock(mutex_);
            if (stopped_) return;
            stopped_ = true;
            leases_.clear();
            latest_.reset();
            changed_.notify_all();
        }
        process_.Terminate();
    }

    void Stop() {
        RequestStop();
        if (worker_.joinable()) worker_.join();
        process_.Wait(1000);
    }

private:
    void Capture() {
        std::array<char, 65536> chunk{};
        std::string pending, stderrTail;
        size_t search = 2;
        try {
            for (;;) {
                const auto errors = ReadAvailable(process_.Errors(), chunk.data(), static_cast<DWORD>(chunk.size()));
                stderrTail.append(chunk.data(), errors);
                if (stderrTail.size() > 2048) stderrTail.erase(0, stderrTail.size() - 2048);
                const auto bytes = ReadAvailable(process_.Output(), chunk.data(), static_cast<DWORD>(chunk.size()));
                if (bytes) {
                    pending.append(chunk.data(), bytes);
                    ProcessFrames(pending, search);
                    continue;
                }
                if (!process_.Running()) break;
                process_.Wait(8);
            }
            // FFmpeg writes platform diagnostics as bytes. Make the tail safe for JSON.
            stderrTail.erase(std::remove_if(stderrTail.begin(), stderrTail.end(),
                [](char value) { return static_cast<unsigned char>(value) >= 128; }), stderrTail.end());
            const auto first = stderrTail.find_first_not_of(" \r\n\t");
            const auto last = stderrTail.find_last_not_of(" \r\n\t");
            Fail(first == std::string::npos ? "完整屏幕采集已停止"
                                           : "完整屏幕采集已停止：" + stderrTail.substr(first, last - first + 1));
        } catch (const std::exception& error) {
            Fail(error.what());
            process_.Terminate();
        }
    }

    void ProcessFrames(std::string& pending, size_t& search) {
        // Image2pipe may split a JPEG marker across two pipe reads.
        while (!pending.empty()) {
            const auto start = pending.find("\xff\xd8");
            if (start == std::string::npos) {
                pending.erase(0, pending.size() - 1);
                search = 2;
                return;
            }
            if (start) {
                pending.erase(0, start);
                search = 2;
            }
            const auto end = pending.find("\xff\xd9", search);
            if (end == std::string::npos) {
                if (pending.size() > maxJpegBytes) throw std::runtime_error("屏幕采集帧不完整");
                search = std::max<size_t>(2, pending.size() - 1);
                return;
            }
            if (end + 2 > maxJpegBytes) throw std::runtime_error("屏幕采集帧过大");
            const auto bytes = std::string_view(pending).substr(0, end + 2);
            {
                std::lock_guard lock(mutex_);
                if (stopped_) return;
                const auto seq = ++sequence_;
                // Keep the original frame timing while avoiding transport and
                // decode work for identical desktop images.
                if (latest_ && *latest_->jpeg == bytes) latest_->sequence = seq;
                else latest_ = WindowsCaptureFrame{seq, seq, std::make_shared<const std::string>(bytes)};
                changed_.notify_all();
            }
            pending.erase(0, end + 2);
            search = 2;
        }
    }

    void Fail(std::string message) {
        std::lock_guard lock(mutex_);
        if (stopped_) return;
        failure_ = std::move(message);
        latest_.reset();
        changed_.notify_all();
    }

    const CaptureConfig config_;
    std::atomic<std::uint64_t>& sequence_;
    CaptureProcess process_;
    std::mutex mutex_;
    std::condition_variable changed_;
    std::unordered_map<std::string, bool> leases_;
    std::optional<WindowsCaptureFrame> latest_;
    std::string failure_;
    bool stopped_{};
    std::thread worker_;
};

int CaptureLimit(const Json& value, int min, int max, int fallback) {
    if (!value.is_number_integer()) return fallback;
    const auto number = value.get<double>();
    if (number < min || number > max) throw std::runtime_error("完整屏幕尺寸异常");
    return static_cast<int>(number);
}

std::string ReadId(const Json& args) {
    return args.is_array() && !args.empty() && args[0].is_string() ? args[0].get<std::string>() : "";
}

}  // namespace

struct DesktopMedia::State {
    explicit State(std::filesystem::path executable) : ffmpeg(std::move(executable)), reaper([this] { ReapStopped(); }) {
        Gdiplus::GdiplusStartupInput startup;
        Gdiplus::GdiplusStartup(&gdiplus, &startup, nullptr);
    }
    ~State() {
        StopAll();
        {
            std::lock_guard lock(mutex);
            closing = true;
        }
        stopped.notify_one();
        reaper.join();
        if (gdiplus) Gdiplus::GdiplusShutdown(gdiplus);
    }

    std::string Start(const CaptureConfig& config, std::optional<std::uint64_t> expectedGeneration) {
        std::lock_guard launch(launchMutex);
        std::unique_lock lock(mutex);
        const auto startingGeneration = generation.load();
        if (expectedGeneration && *expectedGeneration != startingGeneration) throw std::runtime_error("屏幕采集已结束");
        size_t leases = 0;
        std::shared_ptr<Producer> matching;
        for (auto producer = active.begin(); producer != active.end();) {
            if ((*producer)->Failed()) {
                Retire(std::move(*producer));
                producer = active.erase(producer);
                continue;
            }
            leases += (*producer)->LeaseCount();
            if ((*producer)->Config() == config) matching = *producer;
            ++producer;
        }
        if (leases >= 2) throw std::runtime_error("屏幕采集正在切换，请稍后重试");
        if (matching) return matching->NewLease();
        // The renderer swaps tracks only after the replacement emits a frame.
        // Keep the previous producer alive until its lease is released.
        lock.unlock();
        auto next = std::make_shared<Producer>(ffmpeg, config, sequence);
        const auto id = next->NewLease();
        lock.lock();
        // A page may close while FFmpeg is starting. Keep the STA free and
        // discard a producer whose renderer generation is no longer active.
        if (startingGeneration != generation.load()) {
            lock.unlock();
            throw std::runtime_error("屏幕采集已结束");
        }
        active.push_back(std::move(next));
        return id;
    }

    WindowsCaptureFrame Read(const std::string& id, std::uint64_t after) {
        std::shared_ptr<Producer> producer;
        {
            std::lock_guard lock(mutex);
            const auto match = FindLease(id);
            if (match != active.end()) producer = *match;
        }
        if (!producer) throw std::runtime_error("屏幕采集已结束");
        return producer->Read(id, after);
    }

    void Stop(const std::string& id) {
        std::lock_guard lock(mutex);
        const auto match = FindLease(id);
        if (match == active.end() || !(*match)->RemoveLease(id)) return;
        Retire(std::move(*match));
        active.erase(match);
    }

    std::vector<std::shared_ptr<Producer>>::iterator FindLease(const std::string& id) {
        return std::find_if(active.begin(), active.end(), [&id](const auto& producer) { return producer->HasLease(id); });
    }

    void Retire(std::shared_ptr<Producer> producer) {
        producer->RequestStop();
        retired.push_back(std::move(producer));
        stopped.notify_one();
    }

    void ReapStopped() {
        for (;;) {
            std::shared_ptr<Producer> previous;
            {
                std::unique_lock lock(mutex);
                stopped.wait(lock, [this] { return closing || !retired.empty(); });
                if (retired.empty()) return;
                previous = std::move(retired.front());
                retired.pop_front();
            }
            previous->Stop();
        }
    }

    void StopAll() {
        std::lock_guard lock(mutex);
        ++generation;
        for (auto& producer : active) Retire(std::move(producer));
        active.clear();
    }

    std::uint64_t Generation() const { return generation.load(); }

    std::filesystem::path ffmpeg;
    ULONG_PTR gdiplus{};
    std::mutex mutex;
    std::mutex launchMutex;
    std::condition_variable stopped;
    std::vector<std::shared_ptr<Producer>> active;
    std::deque<std::shared_ptr<Producer>> retired;
    std::atomic<std::uint64_t> sequence{};
    std::atomic<std::uint64_t> generation{};
    bool closing{};
    std::thread reaper;
};

DesktopMedia::DesktopMedia(std::filesystem::path ffmpeg) : state_(std::make_unique<State>(std::move(ffmpeg))) {}
DesktopMedia::~DesktopMedia() = default;
void DesktopMedia::StopAll() { state_->StopAll(); }
std::uint64_t DesktopMedia::Generation() const { return state_->Generation(); }
WindowsCaptureFrame DesktopMedia::ReadFrame(const std::string& lease, std::uint64_t after) {
    return state_->Read(lease, after);
}

Json DesktopMedia::Invoke(std::string_view channel, const Json& args, std::optional<std::uint64_t> generation) {
    if (channel == "desktop:getSources") {
        const bool withThumbnail = args.empty() || !args[0].is_boolean() || args[0].get<bool>();
        return ListSources(withThumbnail, state_->gdiplus);
    }
    if (channel == "desktop:testScreenCapture") {
        try {
            if (IsWindows7()) {
                const auto id = Invoke("desktop:windows7Start", Json::array(), generation).get<std::string>();
                try {
                    state_->Read(id, 0);
                    state_->Stop(id);
                } catch (...) {
                    state_->Stop(id);
                    throw;
                }
                return Json{{"ok", true}, {"sourceCount", 1}};
            }
            auto sources = ListSources(false, state_->gdiplus, true);
            const auto count = sources.size();
            auto result = Json{{"ok", count > 0}, {"sourceCount", count}, {"sources", std::move(sources)}};
            if (!count) result["reason"] = "未发现可采集的屏幕源";
            return result;
        } catch (const std::exception& error) {
            return Json{{"ok", false}, {"sourceCount", 0}, {"reason", error.what()}};
        }
    }
    if (channel == "desktop:windows7Start" || channel == "desktop:captureStart") {
        const bool windows7 = channel == "desktop:windows7Start";
        if (windows7 && !IsWindows7()) throw std::runtime_error("当前系统不使用 Windows 7 兼容采集");
        const auto displays = Displays();
        if (displays.empty()) throw std::runtime_error("未发现可采集的屏幕源");
        size_t index = 0;
        int fps = 15, width = 1920, height = 1080;
        if (!windows7) {
            const auto source = ReadId(args);
            if (!source.empty()) {
                while (index < displays.size() && SourceId(index) != source) ++index;
                if (index == displays.size()) throw std::runtime_error("未发现可采集的屏幕源");
            }
            fps = CaptureLimit(args.size() > 1 ? args[1] : Json(), 1, 30, 30);
            width = CaptureLimit(args.size() > 2 ? args[2] : Json(), 32, 1920, 1920);
            height = CaptureLimit(args.size() > 3 ? args[3] : Json(), 32, 1080, 1080);
        }
        return state_->Start(CaptureSettings(displays[index].rect, fps, width, height), generation);
    }
    if (channel == "desktop:windows7Read" || channel == "desktop:captureRead") {
        const auto id = ReadId(args);
        if (id.empty() || args.size() != 2 || !args[1].is_number_integer()) {
            throw std::runtime_error("屏幕采集已结束");
        }
        const auto number = args[1].get<double>();
        if (number < 0 || number > 9007199254740991.0) throw std::runtime_error("屏幕采集已结束");
        const auto frame = ReadFrame(id, static_cast<std::uint64_t>(number));
        return Json{{"sequence", frame.sequence}, {"jpeg", Base64(frame.jpeg->data(), frame.jpeg->size())}};
    }
    if (channel == "desktop:windows7Stop" || channel == "desktop:captureStop") {
        state_->Stop(ReadId(args));
        return nullptr;
    }
    throw std::runtime_error("未知的屏幕采集操作");
}

}  // namespace proctor
