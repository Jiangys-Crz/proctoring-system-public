#pragma once
#import <WebKit/WebKit.h>

#include "bridge.hpp"
#include <vector>

class wxWindow;

namespace proctor {

NSString* Ns(std::string_view text);
std::string Utf8(NSString* text);
std::string Address(NSURL* url);
NSView* NativeView(const wxWindow& window);
WKWebsiteDataStore* Profile(NSString* identifier);
WKWebViewConfiguration* Configuration(WKWebsiteDataStore* data);

struct ViewHooks {
    std::function<WKNavigationActionPolicy(WKNavigationAction*)> action;
    std::function<WKNavigationResponsePolicy(WKNavigationResponse*)> response;
    std::function<void()> started;
    std::function<void(WKNavigation*, std::string, int)> finished;
    std::function<void()> crashed;
    std::function<void()> changed;
    std::function<void(Json)> message;
    std::function<void(WKDownload*)> download;
    std::function<bool(std::string_view)> dialogs;
    std::function<bool(std::string_view)> fileSelection;
    std::string trusted;
    bool capture = false;
};

WKWebView* CreateView(WKWebViewConfiguration* config, NSView* host, ViewHooks hooks);
void DetachView(WKWebView* view);
void CancelFileSelection(WKWebView* view);
void Send(WKWebView* view, const Json& message);
void Load(WKWebView* view, std::string_view address);
void CompileRules(WKWebView* view, const Json& rules, std::function<void(bool)> completion);
Json BlockExcept(const std::vector<std::string>& expressions);
std::string UrlExpression(std::string_view url);
} // namespace proctor
