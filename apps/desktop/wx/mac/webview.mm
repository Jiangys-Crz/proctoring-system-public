#import "webview.hpp"
#import <AppKit/AppKit.h>
#import <objc/runtime.h>

#include <type_traits>
#include <vector>
#include <wx/window.h>

using namespace proctor;

namespace {
std::string HttpOrigin(std::string_view address) {
    try { return ParseHttpUrl(address).origin; }
    catch (...) { return {}; }
}
}

@interface ProctorView : WKWebView
@end
@implementation ProctorView
- (NSMenu*)menuForEvent:(NSEvent*)event { return nil; }
@end

@interface ProctorDelegate : NSObject<WKNavigationDelegate, WKUIDelegate, WKScriptMessageHandler> {
@public
    ViewHooks hooks;
    NSOpenPanel* openPanel;
    WKNavigation* provisionalNavigation;
    bool replacingDocument;
}
- (void)cancelFileSelection;
@end

@implementation ProctorDelegate
- (void)observeValueForKeyPath:(NSString*)key ofObject:(id)object change:(NSDictionary*)change context:(void*)context {
    if (auto changed = hooks.changed) changed();
}
- (void)webView:(WKWebView*)view decidePolicyForNavigationAction:(WKNavigationAction*)action
    decisionHandler:(void (^)(WKNavigationActionPolicy))decision {
    auto policy = WKNavigationActionPolicyCancel;
    try {
        if (hooks.action) policy = hooks.action(action);
        else if (action.targetFrame.isMainFrame && Address(action.request.URL) == hooks.trusted)
            policy = WKNavigationActionPolicyAllow;
    } catch (...) {}
    decision(policy);
}
- (void)webView:(WKWebView*)view decidePolicyForNavigationResponse:(WKNavigationResponse*)response
    decisionHandler:(void (^)(WKNavigationResponsePolicy))decision {
    auto policy = WKNavigationResponsePolicyCancel;
    try {
        if (hooks.response) policy = hooks.response(response);
        else if (response.isForMainFrame && response.canShowMIMEType && Address(response.response.URL) == hooks.trusted)
            policy = WKNavigationResponsePolicyAllow;
    } catch (...) {}
    decision(policy);
}
- (void)webView:(WKWebView*)view didStartProvisionalNavigation:(WKNavigation*)navigation {
    [self cancelFileSelection];
    if (hooks.started) {
        replacingDocument = true;
        provisionalNavigation = navigation;
        hooks.started();
    }
}
- (void)webView:(WKWebView*)view didCommitNavigation:(WKNavigation*)navigation {
    if (provisionalNavigation == navigation) {
        replacingDocument = false;
        provisionalNavigation = nil;
    }
}
- (void)webView:(WKWebView*)view didFinishNavigation:(WKNavigation*)navigation {
    if (auto finished = hooks.finished) finished(navigation, Address(view.URL), 0);
}
- (void)webView:(WKWebView*)view didFailNavigation:(WKNavigation*)navigation withError:(NSError*)error {
    if (auto finished = hooks.finished) finished(navigation, Address(view.URL), static_cast<int>(error.code));
}
- (void)webView:(WKWebView*)view didFailProvisionalNavigation:(WKNavigation*)navigation withError:(NSError*)error {
    if (provisionalNavigation == navigation) {
        replacingDocument = false;
        provisionalNavigation = nil;
    }
    if (auto finished = hooks.finished) finished(navigation, Utf8(error.userInfo[NSURLErrorFailingURLStringErrorKey]), static_cast<int>(error.code));
}
- (void)webViewWebContentProcessDidTerminate:(WKWebView*)view {
    [self cancelFileSelection];
    if (hooks.crashed) hooks.crashed();
}
- (void)webView:(WKWebView*)view navigationAction:(WKNavigationAction*)action didBecomeDownload:(WKDownload*)download {
    if (hooks.download) hooks.download(download);
    else [download cancel:nil];
}
- (void)webView:(WKWebView*)view navigationResponse:(WKNavigationResponse*)response didBecomeDownload:(WKDownload*)download {
    if (hooks.download) hooks.download(download);
    else [download cancel:nil];
}
- (WKWebView*)webView:(WKWebView*)view createWebViewWithConfiguration:(WKWebViewConfiguration*)configuration
    forNavigationAction:(WKNavigationAction*)action windowFeatures:(WKWindowFeatures*)features { return nil; }
- (void)cancelFileSelection {
    auto* panel = openPanel;
    openPanel = nil;
    [panel cancel:nil];
}
- (void)webView:(WKWebView*)view runOpenPanelWithParameters:(WKOpenPanelParameters*)parameters
    initiatedByFrame:(WKFrameInfo*)frame completionHandler:(void (^)(NSArray<NSURL*>*))completion {
    const auto address = Address(view.URL);
    const auto origin = HttpOrigin(address);
    auto* window = view.window;
    // A same-document history update can leave the frame's request URL at the initial route.
    if (!frame.isMainFrame || origin.empty() || HttpOrigin(Address(frame.request.URL)) != origin || !window.isVisible ||
        window.attachedSheet || openPanel || !hooks.fileSelection || !hooks.fileSelection(address)) {
        completion(nil);
        return;
    }
    auto* panel = [NSOpenPanel openPanel];
    panel.allowsMultipleSelection = parameters.allowsMultipleSelection;
    panel.canChooseDirectories = parameters.allowsDirectories;
    panel.canChooseFiles = !parameters.allowsDirectories;
    openPanel = panel;
    [panel beginSheetModalForWindow:window completionHandler:^(NSModalResponse result) {
        const bool current = openPanel == panel;
        if (current) openPanel = nil;
        const auto shown = Address(view.URL);
        const bool allowed = current && result == NSModalResponseOK && HttpOrigin(shown) == origin &&
            hooks.fileSelection && hooks.fileSelection(shown);
        completion(allowed ? panel.URLs : nil);
    }];
}
- (NSAlert*)alert:(NSString*)text frame:(WKFrameInfo*)frame {
    if (!hooks.dialogs || !frame.isMainFrame || !hooks.dialogs(Address(frame.request.URL))) return nil;
    auto* alert = [NSAlert new];
    alert.messageText = text.length <= 4096 ? text : [text substringToIndex:4096];
    [alert addButtonWithTitle:@"确定"];
    return alert;
}
- (void)webView:(WKWebView*)view runJavaScriptAlertPanelWithMessage:(NSString*)message
    initiatedByFrame:(WKFrameInfo*)frame completionHandler:(void (^)(void))completion {
    auto* alert = [self alert:message frame:frame];
    if (alert) [alert runModal];
    completion();
}
- (void)webView:(WKWebView*)view runJavaScriptConfirmPanelWithMessage:(NSString*)message
    initiatedByFrame:(WKFrameInfo*)frame completionHandler:(void (^)(BOOL))completion {
    auto* alert = [self alert:message frame:frame];
    [alert addButtonWithTitle:@"取消"];
    completion(alert && [alert runModal] == NSAlertFirstButtonReturn);
}
- (void)webView:(WKWebView*)view runJavaScriptTextInputPanelWithPrompt:(NSString*)prompt defaultText:(NSString*)text
    initiatedByFrame:(WKFrameInfo*)frame completionHandler:(void (^)(NSString*))completion {
    auto* alert = [self alert:prompt frame:frame];
    if (!alert) { completion(nil); return; }
    [alert addButtonWithTitle:@"取消"];
    auto* field = [[NSTextField alloc] initWithFrame:NSMakeRect(0, 0, 260, 24)];
    field.stringValue = text ?: @"";
    alert.accessoryView = field;
    completion([alert runModal] == NSAlertFirstButtonReturn ? field.stringValue : nil);
}
- (void)webView:(WKWebView*)view requestMediaCapturePermissionForOrigin:(WKSecurityOrigin*)origin
    initiatedByFrame:(WKFrameInfo*)frame type:(WKMediaCaptureType)type
    decisionHandler:(void (^)(WKPermissionDecision))decision {
    const auto address = Address(frame.request.URL);
    decision(hooks.capture && frame.isMainFrame && address == hooks.trusted ? WKPermissionDecisionGrant : WKPermissionDecisionDeny);
}
- (void)userContentController:(WKUserContentController*)controller didReceiveScriptMessage:(WKScriptMessage*)message {
    if (replacingDocument || !hooks.message || !message.frameInfo.isMainFrame || Address(message.frameInfo.request.URL) != hooks.trusted ||
        Address(message.webView.URL) != hooks.trusted || ![message.body isKindOfClass:NSString.class]) return;
    NSString* raw = (NSString*)message.body;
    if (raw.length > 8 * 1024 * 1024) return;
    const auto value = Json::parse(Utf8(raw), nullptr, false);
    if (value.is_object()) hooks.message(value);
}
@end

namespace proctor {
namespace {
char delegateKey;

template <typename T>
NSView* CocoaView(T handle) {
    if constexpr (std::is_convertible_v<T, NSView*>) return handle;
    else return (__bridge NSView*)static_cast<void*>(handle);
}

std::string Shim(const std::string& trusted) {
    const auto origin = ParseHttpUrl(trusted).origin;
    return "(() => { if (self !== top || location.href !== " + Json(trusted).dump() + R"() return;
        Object.defineProperty(window, '__proctorShellOrigin', {value: )" + Json(origin).dump() + R"(});
        const transport = new EventTarget();
        Object.defineProperty(transport, 'postMessage', {value: data => {
            window.webkit.messageHandlers.proctor.postMessage(JSON.stringify(data));
        }});
        const chrome = window.chrome || {};
        Object.defineProperty(chrome, 'webview', {value: Object.freeze(transport)});
        if (!window.chrome) Object.defineProperty(window, 'chrome', {value: chrome});
        Object.defineProperty(window, '__proctorDeliver', {value: data => {
            transport.dispatchEvent(new MessageEvent('message', {data}));
        }});
    })())";
}
}

NSString* Ns(std::string_view text) {
    return [[NSString alloc] initWithBytes:text.data() length:text.size() encoding:NSUTF8StringEncoding];
}
std::string Utf8(NSString* text) {
    if (![text isKindOfClass:NSString.class]) return {};
    const auto* bytes = text.UTF8String;
    return bytes ? std::string(bytes) : std::string{};
}
std::string Address(NSURL* url) { return Utf8(url.absoluteString); }
NSView* NativeView(const wxWindow& window) { return CocoaView(window.GetHandle()); }
WKWebsiteDataStore* Profile(NSString* identifier) {
    return [WKWebsiteDataStore dataStoreForIdentifier:[[NSUUID alloc] initWithUUIDString:identifier]];
}
WKWebViewConfiguration* Configuration(WKWebsiteDataStore* data) {
    auto* config = [WKWebViewConfiguration new];
    config.websiteDataStore = data;
    return config;
}
WKWebView* CreateView(WKWebViewConfiguration* config, NSView* host, ViewHooks hooks) {
    auto* delegate = [ProctorDelegate new];
    delegate->hooks = std::move(hooks);
    auto* controller = config.userContentController;
    if (delegate->hooks.message) {
        [controller addScriptMessageHandler:delegate name:@"proctor"];
        auto* script = [[WKUserScript alloc] initWithSource:Ns(Shim(delegate->hooks.trusted))
            injectionTime:WKUserScriptInjectionTimeAtDocumentStart forMainFrameOnly:YES];
        [controller addUserScript:script];
    }
    auto* view = [[ProctorView alloc] initWithFrame:host.bounds configuration:config];
    view.navigationDelegate = delegate;
    view.UIDelegate = delegate;
    if (delegate->hooks.changed) {
        [view addObserver:delegate forKeyPath:@"URL" options:NSKeyValueObservingOptionNew context:&delegateKey];
    }
    objc_setAssociatedObject(view, &delegateKey, delegate, OBJC_ASSOCIATION_RETAIN_NONATOMIC);
    view.autoresizingMask = NSViewWidthSizable | NSViewHeightSizable;
    [host addSubview:view];
    return view;
}
void DetachView(WKWebView* view) {
    auto* delegate = (ProctorDelegate*)objc_getAssociatedObject(view, &delegateKey);
    if (delegate) {
        if (delegate->hooks.changed) [view removeObserver:delegate forKeyPath:@"URL" context:&delegateKey];
        delegate->hooks = {};
        [delegate cancelFileSelection];
    }
    view.navigationDelegate = nil;
    view.UIDelegate = nil;
    [view.configuration.userContentController removeScriptMessageHandlerForName:@"proctor"];
    [view stopLoading];
    [view removeFromSuperview];
    objc_setAssociatedObject(view, &delegateKey, nil, OBJC_ASSOCIATION_RETAIN_NONATOMIC);
}
void CancelFileSelection(WKWebView* view) {
    [(ProctorDelegate*)objc_getAssociatedObject(view, &delegateKey) cancelFileSelection];
}
void Send(WKWebView* view, const Json& message) {
    const auto data = message.dump(-1, ' ', true, Json::error_handler_t::replace);
    [view evaluateJavaScript:Ns("window.__proctorDeliver?.(" + data + ")") completionHandler:nil];
}
void Load(WKWebView* view, std::string_view address) {
    auto* url = [NSURL URLWithString:Ns(address)];
    if (url) [view loadRequest:[NSURLRequest requestWithURL:url]];
}
void CompileRules(WKWebView* view, const Json& rules, std::function<void(bool)> completion) {
    // WK requires compiling a list before navigation. Remove the compiled copy
    // after attaching, since a policy can contain details of a specific exam.
    NSString* identifier = [@"proctor-wk-" stringByAppendingString:NSUUID.UUID.UUIDString];
    WKContentRuleListStore* store = WKContentRuleListStore.defaultStore;
    [store compileContentRuleListForIdentifier:identifier encodedContentRuleList:Ns(rules.dump())
        completionHandler:^(WKContentRuleList* list, NSError*) {
            dispatch_async(dispatch_get_main_queue(), ^{
                if (list) {
                    [view.configuration.userContentController removeAllContentRuleLists];
                    [view.configuration.userContentController addContentRuleList:list];
                    [store removeContentRuleListForIdentifier:identifier completionHandler:^(NSError*) {}];
                }
                completion(list != nil);
            });
        }];
}
Json BlockExcept(const std::vector<std::string>& expressions) {
    Json rules = Json::array({{
        {"trigger", {{"url-filter", "^[a-zA-Z][a-zA-Z0-9+.-]*:"}}},
        {"action", {{"type", "block"}}}
    }});
    for (const auto& expression : expressions) {
        rules.push_back({{"trigger", {{"url-filter", expression}, {"url-filter-is-case-sensitive", true}}},
            {"action", {{"type", "ignore-previous-rules"}}}});
    }
    return rules;
}
std::string UrlExpression(std::string_view url) {
    std::string result = "^";
    for (const char ch : url) {
        if (std::string_view(".+?*()[]{}^$|\\").find(ch) != std::string::npos) result += '\\';
        result += ch;
    }
    return result;
}
} // namespace proctor
