#import <CoreGraphics/CoreGraphics.h>
#import <CoreMedia/CoreMedia.h>
#import <CoreVideo/CoreVideo.h>
#import <Foundation/Foundation.h>
#import <ImageIO/ImageIO.h>
#import <ScreenCaptureKit/ScreenCaptureKit.h>

#include "../src/media.hpp"

#include <nlohmann/json.hpp>

#include <algorithm>
#include <chrono>
#include <cmath>
#include <condition_variable>
#include <mutex>
#include <stdexcept>
#include <type_traits>
#include <unordered_map>
#include <vector>

namespace {
using Json = nlohmann::json;
using namespace std::chrono_literals;

constexpr char noScreen[] = "未发现可采集的屏幕源";
constexpr char noPermission[] = "尚未取得系统屏幕录制权限，请授权并按系统要求重新启动客户端";
constexpr char stopped[] = "屏幕采集已结束";

template<typename T>
struct Release {
    void operator()(T value) const { CFRelease(value); }
};

template<typename T>
using ScopedCF = std::unique_ptr<std::remove_pointer_t<T>, Release<T>>;

bool HasScreenPermission()
{
    return CGPreflightScreenCaptureAccess();
}

std::vector<CGDirectDisplayID> Displays()
{
    uint32_t count = 0;
    if (CGGetActiveDisplayList(0, nullptr, &count) != kCGErrorSuccess || !count) return {};
    std::vector<CGDirectDisplayID> displays(count);
    if (CGGetActiveDisplayList(count, displays.data(), &count) != kCGErrorSuccess) return {};
    displays.resize(count);
    const auto main = std::find(displays.begin(), displays.end(), CGMainDisplayID());
    if (main != displays.end()) std::rotate(displays.begin(), main, main + 1);
    return displays;
}

std::string SourceId(CGDirectDisplayID display)
{
    return "screen:" + std::to_string(display) + ":0";
}

std::string SourceName(size_t index, size_t total)
{
    return total == 1 ? "Entire Screen" : "Screen " + std::to_string(index + 1);
}

std::pair<size_t, size_t> FitSize(size_t width, size_t height, int maxWidth, int maxHeight)
{
    const double scale = std::min({1.0, double(maxWidth) / std::max<size_t>(1, width),
                                 double(maxHeight) / std::max<size_t>(1, height)});
    return {std::max<size_t>(2, size_t(std::lround(width * scale)) & ~size_t(1)),
            std::max<size_t>(2, size_t(std::lround(height * scale)) & ~size_t(1))};
}

std::string EncodeJpeg(CGImageRef image)
{
    if (!image) throw std::runtime_error("屏幕画面读取失败");
    NSMutableData* data = [NSMutableData data];
    ScopedCF<CGImageDestinationRef> encoder(CGImageDestinationCreateWithData(
        (__bridge CFMutableDataRef)data, CFSTR("public.jpeg"), 1, nullptr));
    if (!encoder) throw std::runtime_error("屏幕画面编码失败");
    NSDictionary* options = @{(__bridge NSString*)kCGImageDestinationLossyCompressionQuality: @0.84};
    CGImageDestinationAddImage(encoder.get(), image, (__bridge CFDictionaryRef)options);
    if (!CGImageDestinationFinalize(encoder.get())) throw std::runtime_error("屏幕画面编码失败");
    return std::string(static_cast<const char*>(data.bytes), data.length);
}

std::string EncodeSurface(CVPixelBufferRef surface)
{
    struct LockedSurface {
        CVPixelBufferRef pixels;
        ~LockedSurface() { CVPixelBufferUnlockBaseAddress(pixels, kCVPixelBufferLock_ReadOnly); }
    };
    if (CVPixelBufferLockBaseAddress(surface, kCVPixelBufferLock_ReadOnly) != kCVReturnSuccess) {
        throw std::runtime_error("屏幕画面读取失败");
    }
    LockedSurface lock{surface};
    ScopedCF<CGColorSpaceRef> color(CGColorSpaceCreateWithName(kCGColorSpaceSRGB));
    ScopedCF<CGContextRef> context(CGBitmapContextCreate(CVPixelBufferGetBaseAddress(surface),
        CVPixelBufferGetWidth(surface), CVPixelBufferGetHeight(surface), 8,
        CVPixelBufferGetBytesPerRow(surface), color.get(),
        kCGBitmapByteOrder32Little | kCGImageAlphaPremultipliedFirst));
    ScopedCF<CGImageRef> image(context ? CGBitmapContextCreateImage(context.get()) : nullptr);
    return EncodeJpeg(image.get());
}

class Capture final : public std::enable_shared_from_this<Capture> {
public:
    Capture(CGDirectDisplayID display, int fps, int width, int height)
        : display_(display), fps_(fps), width_(width), height_(height) {}

    void Start();
    void Stop();
    proctor::MacCaptureFrame Read(std::uint64_t since, bool encode = true);
    void Push(CVPixelBufferRef pixels);
    void Fail(NSError* error);

private:
    void Open(SCShareableContent* content);

    const CGDirectDisplayID display_;
    const int fps_, width_, height_;
    std::mutex mutex_;
    std::condition_variable changed_;
    ScopedCF<CVPixelBufferRef> pixels_;
    std::uint64_t frame_ = 0;
    std::string error_;
    bool closed_ = false;
    SCStream* stream_ = nil;
    id output_ = nil;
};
} // namespace

@interface ProctorScreenOutput : NSObject<SCStreamOutput, SCStreamDelegate>
- (instancetype)initWithCapture:(const std::shared_ptr<Capture>&)capture;
@end

@implementation ProctorScreenOutput {
    std::weak_ptr<Capture> _capture;
}
- (instancetype)initWithCapture:(const std::shared_ptr<Capture>&)capture
{
    self = [super init];
    if (self) _capture = capture;
    return self;
}

- (void)stream:(SCStream*)stream didOutputSampleBuffer:(CMSampleBufferRef)sample ofType:(SCStreamOutputType)type
{
    if (type != SCStreamOutputTypeScreen || !CMSampleBufferIsValid(sample)) return;
    auto attachments = (__bridge NSArray<NSDictionary*>*)CMSampleBufferGetSampleAttachmentsArray(sample, false);
    NSNumber* status = attachments.firstObject[SCStreamFrameInfoStatus];
    if (!status || status.integerValue != SCFrameStatusComplete) return;
    if (auto capture = _capture.lock()) {
        if (auto frame = CMSampleBufferGetImageBuffer(sample)) capture->Push(frame);
    }
}

- (void)stream:(SCStream*)stream didStopWithError:(NSError*)error
{
    if (auto capture = _capture.lock()) capture->Fail(error);
}
@end

namespace {
void Capture::Start()
{
    auto weak = weak_from_this();
    [SCShareableContent getShareableContentExcludingDesktopWindows:NO onScreenWindowsOnly:YES
        completionHandler:^(SCShareableContent* content, NSError* error) {
            if (auto capture = weak.lock()) {
                if (content) capture->Open(content);
                else capture->Fail(error);
            }
        }];
}

void Capture::Open(SCShareableContent* content)
{
    SCDisplay* source = nil;
    for (SCDisplay* candidate in content.displays) {
        if (candidate.displayID == display_) {
            source = candidate;
            break;
        }
    }
    if (!source) {
        Fail([NSError errorWithDomain:@"ProctorScreenCapture" code:1
            userInfo:@{NSLocalizedDescriptionKey: @"未发现可采集的屏幕源"}]);
        return;
    }
    const auto [width, height] = FitSize(CGDisplayPixelsWide(display_), CGDisplayPixelsHigh(display_), width_, height_);
    SCContentFilter* filter = [[SCContentFilter alloc] initWithDisplay:source excludingWindows:@[]];
    SCStreamConfiguration* configuration = [[SCStreamConfiguration alloc] init];
    configuration.width = width;
    configuration.height = height;
    configuration.minimumFrameInterval = CMTimeMake(1, fps_);
    configuration.queueDepth = 3;
    configuration.pixelFormat = kCVPixelFormatType_32BGRA;
    configuration.showsCursor = YES;
    configuration.colorSpaceName = kCGColorSpaceSRGB;
    ProctorScreenOutput* output = [[ProctorScreenOutput alloc] initWithCapture:shared_from_this()];
    SCStream* stream = [[SCStream alloc] initWithFilter:filter configuration:configuration delegate:output];
    static dispatch_queue_t frameQueue = dispatch_queue_create("com.cwnupaa.proctor.screen.frames", DISPATCH_QUEUE_SERIAL);
    NSError* error = nil;
    if (![stream addStreamOutput:output type:SCStreamOutputTypeScreen sampleHandlerQueue:frameQueue error:&error]) {
        Fail(error);
        return;
    }
    {
        const std::lock_guard lock(mutex_);
        if (closed_) return;
        stream_ = stream;
        output_ = output;
    }
    auto weak = weak_from_this();
    [stream startCaptureWithCompletionHandler:^(NSError* failure) {
        if (auto capture = weak.lock()) {
            if (failure) capture->Fail(failure);
            {
                const std::lock_guard lock(capture->mutex_);
                if (!capture->closed_) return;
            }
        }
        // Stop may win the race before the start request has completed.
        [stream stopCaptureWithCompletionHandler:nil];
    }];
}

void Capture::Stop()
{
    SCStream* stream = nil;
    {
        const std::lock_guard lock(mutex_);
        if (closed_) return;
        closed_ = true;
        stream = stream_;
        stream_ = nil;
        output_ = nil;
        pixels_.reset();
    }
    changed_.notify_all();
    [stream stopCaptureWithCompletionHandler:nil];
}

void Capture::Push(CVPixelBufferRef pixels)
{
    {
        const std::lock_guard lock(mutex_);
        if (closed_ || !error_.empty()) return;
        pixels_.reset(CVPixelBufferRetain(pixels));
        ++frame_;
    }
    changed_.notify_all();
}

void Capture::Fail(NSError* error)
{
    {
        const std::lock_guard lock(mutex_);
        if (closed_) return;
        error_ = error.localizedDescription.UTF8String ?: "屏幕采集失败";
    }
    changed_.notify_all();
}

proctor::MacCaptureFrame Capture::Read(std::uint64_t since, bool encode)
{
    ScopedCF<CVPixelBufferRef> pixels;
    std::uint64_t sequence;
    {
        std::unique_lock lock(mutex_);
        // ScreenCaptureKit can suspend frame delivery while the screen is
        // static. Reuse the last complete image to maintain the recording track.
        changed_.wait_for(lock, pixels_ ? 250ms : 5s, [&] {
            return closed_ || !error_.empty() || (pixels_ && frame_ > since);
        });
        if (closed_) throw std::runtime_error(stopped);
        if (!error_.empty()) throw std::runtime_error(error_);
        if (!pixels_) throw std::runtime_error("屏幕画面读取超时");
        sequence = frame_;
        if (encode && sequence > since) pixels.reset(CVPixelBufferRetain(pixels_.get()));
    }
    auto jpeg = pixels ? EncodeSurface(pixels.get()) : std::string{};
    if (pixels) {
        const std::lock_guard lock(mutex_);
        if (closed_) throw std::runtime_error(stopped);
        if (!error_.empty()) throw std::runtime_error(error_);
    }
    return {sequence, std::move(jpeg)};
}

int Limit(const Json& args, size_t index, int min, int max, int fallback)
{
    if (index >= args.size() || !args[index].is_number()) return fallback;
    return int(std::clamp(args[index].get<double>(), double(min), double(max)));
}

std::string FirstString(const Json& args)
{
    if (!args.is_array() || args.empty() || !args[0].is_string()) {
        throw std::runtime_error("屏幕采集参数无效");
    }
    return args[0].get<std::string>();
}
} // namespace

namespace proctor {
struct DesktopMedia::State {
    mutable std::mutex mutex;
    std::uint64_t generation = 0;
    std::unordered_map<std::string, std::shared_ptr<Capture>> captures;

    std::string Start(CGDirectDisplayID display, int fps, int width, int height,
                      std::optional<std::uint64_t> expectedGeneration)
    {
        if (!HasScreenPermission()) throw std::runtime_error(noPermission);
        auto capture = std::make_shared<Capture>(display, fps, width, height);
        std::string id = NSUUID.UUID.UUIDString.UTF8String;
        {
            const std::lock_guard lock(mutex);
            if (expectedGeneration && *expectedGeneration != generation) throw std::runtime_error(stopped);
            if (captures.size() >= 4) throw std::runtime_error("正在使用的屏幕采集已达上限");
            captures.emplace(id, capture);
        }
        capture->Start();
        return id;
    }

    MacCaptureFrame Read(const std::string& id, std::uint64_t sequence, bool encode = true)
    {
        std::shared_ptr<Capture> capture;
        {
            const std::lock_guard lock(mutex);
            const auto found = captures.find(id);
            if (found == captures.end()) throw std::runtime_error(stopped);
            capture = found->second;
        }
        return capture->Read(sequence, encode);
    }

    void Stop(const std::string& id)
    {
        std::shared_ptr<Capture> capture;
        {
            const std::lock_guard lock(mutex);
            const auto found = captures.find(id);
            if (found == captures.end()) return;
            capture = found->second;
            captures.erase(found);
        }
        capture->Stop();
    }

    std::string Probe(CGDirectDisplayID display, int width, int height, std::optional<std::uint64_t> expectedGeneration,
                      bool thumbnail = true)
    {
        const auto id = Start(display, 1, width, height, expectedGeneration);
        try {
            auto frame = Read(id, 0, thumbnail);
            Stop(id);
            if (!thumbnail) return {};
            NSData* data = [NSData dataWithBytes:frame.jpeg.data() length:frame.jpeg.size()];
            return [data base64EncodedStringWithOptions:0].UTF8String;
        } catch (...) {
            Stop(id);
            throw;
        }
    }
};

DesktopMedia::DesktopMedia(std::filesystem::path) : state_(std::make_unique<State>()) {}
DesktopMedia::~DesktopMedia() { StopAll(); }

MacCaptureFrame DesktopMedia::ReadFrame(const std::string& lease, std::uint64_t after)
{
    @autoreleasepool {
        return state_->Read(lease, after);
    }
}

std::uint64_t DesktopMedia::Generation() const
{
    const std::lock_guard lock(state_->mutex);
    return state_->generation;
}

void DesktopMedia::StopAll()
{
    decltype(state_->captures) captures;
    {
        const std::lock_guard lock(state_->mutex);
        ++state_->generation;
        captures.swap(state_->captures);
    }
    for (const auto& entry : captures) entry.second->Stop();
}

Json DesktopMedia::Invoke(std::string_view channel, const Json& args, std::optional<std::uint64_t> generation)
{
    @autoreleasepool {
        if (channel == "desktop:captureStop") {
            state_->Stop(FirstString(args));
            return true;
        }
        const auto displays = Displays();
        if (channel == "desktop:captureStart") {
            const auto source = FirstString(args);
            auto display = std::find_if(displays.begin(), displays.end(), [&](CGDirectDisplayID id) {
                return source.empty() || SourceId(id) == source;
            });
            if (display == displays.end()) throw std::runtime_error(noScreen);
            return state_->Start(*display, Limit(args, 1, 1, 30, 30), Limit(args, 2, 32, 1920, 1920),
                                 Limit(args, 3, 32, 1080, 1080), generation);
        }
        if (channel == "desktop:getSources" || channel == "desktop:testScreenCapture") {
            const bool probe = channel == "desktop:testScreenCapture";
            const bool includeThumbnails = args.empty() || args[0] != false;
            const bool permitted = HasScreenPermission();
            auto sources = Json::array();
            for (size_t index = 0; index < displays.size(); ++index) {
                const auto display = displays[index];
                Json source{{"id", SourceId(display)}, {"name", SourceName(index, displays.size())}};
                if (probe) {
                    source["displayId"] = std::to_string(display);
                } else {
                    std::string thumbnail = "data:image/png;base64,";
                    if (includeThumbnails && permitted) {
                        try { thumbnail = "data:image/jpeg;base64," + state_->Probe(display, 360, 220, generation); }
                        catch (const std::exception&) { }
                    }
                    source["thumbnail"] = std::move(thumbnail);
                }
                sources.push_back(std::move(source));
            }
            if (!probe) return sources;
            Json result{{"ok", false}, {"sourceCount", sources.size()}, {"sources", std::move(sources)},
                        {"status", permitted ? "granted" : "denied"}};
            if (!permitted) result["reason"] = noPermission;
            else if (displays.empty()) result["reason"] = noScreen;
            else {
                try {
                    state_->Probe(displays.front(), 80, 45, generation, false);
                    result["ok"] = true;
                } catch (const std::exception& error) { result["reason"] = error.what(); }
            }
            return result;
        }
        throw std::runtime_error("未知屏幕采集指令");
    }
}
} // namespace proctor
