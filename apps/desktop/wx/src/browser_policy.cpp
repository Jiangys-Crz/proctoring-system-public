#include "browser_policy.hpp"

#include <algorithm>
#include <charconv>
#include <cstdint>
#include <regex>
#include <stdexcept>
#include <unordered_map>
#include <vector>

namespace proctor {
namespace {

using Params = std::unordered_map<std::string, std::vector<std::string>>;

const std::regex hydroObjectId(R"(^[a-f\d]{24}$)");
const std::regex hydroRecordRoute(R"(^/record/[a-f\d]{24}$)");
const std::regex hydroParticipant(R"(^/domjudge-ui(?:/(?:booklet\.pdf|samples|runs/-?\d+/[1-9]\d*|school-logos/[a-f0-9]{64}\.(?:png|jpg|webp|gif|svg)))?$)");
const std::regex hydroDynamic(R"(^(?:/d/[\w-]+)?/(?:contest|p|record)(?:/|$))");
const std::regex xcpcioIndex(R"(^/hydro-league-xcpcio/index(?:-[\w.-]+)?\.html$)");
const std::regex xcpcioManifest(R"(^/hydro-league-xcpcio/asset-manifest(?:-[\w.-]+)?\.json$)");
const std::regex hydroStatic(R"(\.(?:js|css|woff2?|ttf|otf|png|jpe?g|webp|svg|gif|ico|avif|mp4)$)", std::regex::icase);
const std::regex novaFile(R"(\.(?:pdf|zip|7z|rar|tar|gz|txt|csv|xlsx?|docx?|pptx?|cpp|c|h|py|java|in|out)$)", std::regex::icase);
const std::regex fileExtension(R"(\.[a-z\d]{1,12}$)", std::regex::icase);
const std::regex webPageExtension(R"(\.(?:html?|php|aspx?|jsp)$)", std::regex::icase);
const std::regex downloadPath(R"((?:^|/)(?:file|download)(?:/|$))", std::regex::icase);

std::string Arg(const Json& args, size_t index) {
    return args.is_array() && index < args.size() && args[index].is_string() ? args[index].get<std::string>() : "";
}

int Hex(char character) {
    if (character >= '0' && character <= '9') return character - '0';
    if (character >= 'A' && character <= 'F') return character - 'A' + 10;
    if (character >= 'a' && character <= 'f') return character - 'a' + 10;
    return -1;
}

std::string Decode(std::string_view text, bool query) {
    std::string output;
    for (size_t index = 0; index < text.size(); ++index) {
        const auto current = text[index];
        if (current == '%' && index + 2 < text.size()) {
            const auto first = Hex(text[index + 1]), second = Hex(text[index + 2]);
            if (first >= 0 && second >= 0) {
                output.push_back(static_cast<char>(first * 16 + second));
                index += 2;
                continue;
            }
        }
        if (current == '%' && !query) throw std::runtime_error("无效的文件地址");
        output.push_back(query && current == '+' ? ' ' : current);
    }
    return output;
}

Params ParseParams(std::string_view query) {
    Params params;
    if (query.starts_with('?')) query.remove_prefix(1);
    while (!query.empty()) {
        const auto next = query.find('&');
        const auto part = query.substr(0, next);
        const auto equals = part.find('=');
        if (!part.empty()) {
            params[Decode(part.substr(0, equals), true)].push_back(
                equals == std::string_view::npos ? "" : Decode(part.substr(equals + 1), true));
        }
        if (next == std::string_view::npos) break;
        query.remove_prefix(next + 1);
    }
    return params;
}

std::string_view Param(const Params& params, const std::string& key) {
    const auto found = params.find(key);
    return found == params.end() || found->second.empty() ? std::string_view{} : found->second.front();
}

bool AllMatch(const Params& params, const std::string& key, std::string_view expected) {
    const auto found = params.find(key);
    return found == params.end() || std::all_of(found->second.begin(), found->second.end(),
        [expected](const std::string& value) { return value == expected; });
}

bool HydroParams(const ContestPolicy& policy, const Params& params) {
    const auto domain = policy.basePath.empty() ? std::string_view("system") : std::string_view(policy.basePath).substr(3);
    return AllMatch(params, "domainId", domain) && AllMatch(params, "tid", policy.contestId) &&
        !params.count("all") && !params.count("allDomain") && !params.count("sid");
}

bool Frame(std::string_view type) { return type == "mainFrame" || type == "subFrame"; }

bool Within(std::string_view path, const std::string& prefix) {
    return path == prefix || path.starts_with(prefix + '/');
}

bool Word(std::string_view value, bool dot = false) {
    return !value.empty() && std::all_of(value.begin(), value.end(), [dot](char character) {
        return (character >= 'a' && character <= 'z') || (character >= 'A' && character <= 'Z') ||
               (character >= '0' && character <= '9') || character == '_' || character == '-' ||
               (dot && character == '.');
    });
}

bool FinalSegment(std::string_view path, std::string_view prefix) {
    return path.starts_with(prefix) && path.size() > prefix.size() && path.find('/', prefix.size()) == std::string_view::npos;
}

bool HydroBasePath(std::string_view value) {
    if (value == "/") return true;
    if (!value.starts_with("/d/")) return false;
    value.remove_prefix(3);
    if (value.ends_with('/')) value.remove_suffix(1);
    return Word(value);
}

bool HydroContestRoute(std::string_view route) {
    constexpr std::string_view scoreboard = "/scoreboard/";
    return route == "/problems" || route == "/print" || route == "/clarification" || route == "/scoreboard" ||
        (route.starts_with(scoreboard) && Word(route.substr(scoreboard.size()))) ||
        FinalSegment(route, "/file/public/") || FinalSegment(route, "/file/private/") ||
        std::regex_match(route.begin(), route.end(), hydroParticipant);
}

std::string_view HydroRoute(const ContestPolicy& policy, std::string_view path) {
    if (policy.basePath.empty() || policy.basePath == "/d/system") {
        return path.starts_with("/d/system/") ? path.substr(9) : path;
    }
    return path.starts_with(policy.basePath + '/') ? path.substr(policy.basePath.size()) : std::string_view{};
}

bool XcpcioFrame(const ContestPolicy& policy, const HttpUrl& url, const Params& params) {
    if (!std::regex_match(url.path, xcpcioIndex) || params.size() != 1 ||
        !params.count("source") || params.at("source").size() != 1) return false;
    const auto source = ResolveHttpUrl(policy.origin, Param(params, "source"));
    const auto route = HydroRoute(policy, source.path);
    const auto prefix = "/contest/" + policy.contestId + "/scoreboard/";
    if (source.origin != policy.origin || !route.starts_with(prefix)) return false;
    const auto view = route.substr(prefix.size());
    if (view != "xcpcio" && view != "leagueboard" && view != "league-xcpcio") return false;
    const auto query = ParseParams(source.query);
    return Param(query, "json") == "true" && std::all_of(query.begin(), query.end(), [](const auto& pair) {
        return pair.second.size() == 1 && (pair.first == "json" || pair.first == "scope" || pair.first == "realtime");
    });
}

bool HydroProblemRoute(std::string_view route) {
    if (!route.starts_with("/p/")) return false;
    route.remove_prefix(3);
    const auto slash = route.find('/');
    if (!Word(route.substr(0, slash), true)) return false;
    if (slash == std::string_view::npos) return true;
    const auto tail = route.substr(slash);
    return tail == "/submit" || FinalSegment(tail, "/file/");
}

bool NovaAsset(std::string_view path) {
    constexpr std::string_view problems = "/api/problems/";
    if (!path.starts_with(problems)) return false;
    path.remove_prefix(problems.size());
    const auto slash = path.find('/');
    return slash != 0 && slash != std::string_view::npos && FinalSegment(path.substr(slash), "/assets/");
}

bool HydroNavigate(const ContestPolicy& policy, const HttpUrl& url, const Params& params) {
    if (url.origin != policy.origin || !HydroParams(policy, params)) return false;
    const auto route = HydroRoute(policy, url.path);
    const auto prefix = "/contest/" + policy.contestId;
    if (route == prefix || route == prefix + '/') return true;
    if (route.starts_with(prefix + '/')) return HydroContestRoute(route.substr(prefix.size()));
    if (std::regex_match(route.begin(), route.end(), hydroRecordRoute)) return true;
    return Param(params, "tid") == policy.contestId && (route == "/record" || HydroProblemRoute(route));
}

bool HydroFile(const ContestPolicy& policy, const HttpUrl& url, const Params& params) {
    if (!HydroNavigate(policy, url, params)) return false;
    const auto route = HydroRoute(policy, url.path);
    return route.find("/file/") != std::string_view::npos || route.ends_with("/domjudge-ui/booklet.pdf") ||
        route.ends_with("/domjudge-ui/samples") || (std::regex_match(route.begin(), route.end(), hydroRecordRoute) && Param(params, "download") == "1");
}

HttpUrl ParseSocket(std::string_view url) {
    if (url.starts_with("wss://")) return ParseHttpUrl("https:" + std::string(url.substr(4)));
    return ParseHttpUrl("http:" + std::string(url.substr(3)));
}

bool HydroSocket(const ContestPolicy& policy, const HttpUrl& url) {
    if (url.origin != policy.origin) return false;
    const auto params = ParseParams(url.query);
    const auto rid = Param(params, "rid");
    return HydroParams(policy, params) &&
        ((url.path == "/record-conn" && Param(params, "tid") == policy.contestId) ||
         (url.path == "/record-detail-conn" && rid.size() == 24 && std::regex_match(rid.begin(), rid.end(), hydroObjectId)) ||
         url.path == "/websocket");
}

bool HydroRequest(const ContestPolicy& policy, const HttpUrl& url, std::string_view type, std::string_view method) {
    if (url.origin != policy.origin) return false;
    const auto params = ParseParams(url.query);
    const bool read = method.empty() || method == "GET" || method == "HEAD";
    if (HydroNavigate(policy, url, params)) {
        const auto ui = "/contest/" + policy.contestId + "/domjudge-ui";
        const auto route = HydroRoute(policy, url.path);
        if (route == ui) return method.empty() || method == "POST";
        return !route.starts_with(ui + '/') || read;
    }
    if (std::regex_search(url.path, hydroDynamic)) return false;
    const bool fetch = type == "xhr" || type == "fetch" || type == "other";
    if (read && (type == "subFrame" || fetch) && XcpcioFrame(policy, url, params)) return true;
    if (Frame(type)) return false;
    if (read && fetch && std::regex_match(url.path, xcpcioManifest)) return true;
    const bool asset = fetch || type == "script" || type == "stylesheet" || type == "image" || type == "font" || type == "media";
    return url.path.starts_with("/resource/") || url.path.starts_with("/fs/") ||
        (asset && std::regex_search(url.path, hydroStatic));
}

bool NovaRequest(const ContestPolicy& policy, const HttpUrl& url, std::string_view type) {
    return url.origin == policy.origin && (!Frame(type) || Within(url.path, "/contest/" + policy.contestId)
        || url.path == "/api/contests/" + policy.contestId + "/editorial");
}

bool CandidateRequest(const ContestPolicy& policy, const HttpUrl& url, std::string_view type) {
    const bool request = type == "xhr" || type == "fetch" || type == "other";
    const bool contest = Within(url.path, "/contest");
    if (url.origin == policy.clientOrigin) {
        if (Frame(type)) return contest;
        if (request && (contest || url.path.starts_with("/api/client/"))) return true;
        if (url.path.starts_with("/_next/static/") || url.path.starts_with("/candidate-assets/_next/static/")) return true;
        return type == "image" && (url.path == "/brand/logo.png" || url.path == "/candidate-assets/brand/logo.png");
    }
    if (Frame(type)) return false;
    if (url.origin == policy.backendOrigin && (type == "xhr" || type == "fetch")) {
        return url.path.starts_with("/api/client/");
    }
    if (policy.origin.empty() || url.origin != policy.origin) return false;
    return Within(url.path, "/contest/" + policy.contestId) || url.path.starts_with("/api/") ||
        url.path.starts_with("/fs/") || url.path.starts_with("/file/");
}

bool NovaId(std::string_view value) {
    if (value.empty() || value.front() == '0') return false;
    std::uint64_t number = 0;
    const auto parsed = std::from_chars(value.data(), value.data() + value.size(), number);
    return parsed.ec == std::errc{} && parsed.ptr == value.data() + value.size() && number <= 9007199254740991ULL;
}

}  // namespace

ContestPolicy MakeContestPolicy(const Json& args) {
    ContestPolicy result;
    result.platform = Arg(args, 3);
    result.contestId = Arg(args, 1);
    const auto base = Arg(args, 0), client = Arg(args, 2), backend = Arg(args, 4);
    if (!backend.empty()) {
        const auto url = ParseHttpUrl(backend);
        if (url.origin == backend) result.backendOrigin = url.origin;
    }
    if (result.External()) {
        const auto hydro = result.platform == "HYDRO_BROWSER";
        const auto* error = hydro ? "HydroOJ 考试范围无效" : "NovaJudge 考试范围无效";
        try {
            const auto url = ParseHttpUrl(base);
            if (!url.query.empty() || !url.fragment.empty()) throw std::runtime_error(error);
            if (hydro) {
                if (base.find_first_of(" \\\r\n\t\f\v") != std::string::npos ||
                    !HydroBasePath(url.path) || !std::regex_match(result.contestId, hydroObjectId)) {
                    throw std::runtime_error(error);
                }
                result.basePath = url.path.substr(0, url.path.size() - (url.path.back() == '/' ? 1 : 0));
            } else if (url.path != "/" || !NovaId(result.contestId)) {
                throw std::runtime_error(error);
            }
            result.origin = url.origin;
            result.host = url.host;
        } catch (const std::exception&) {
            throw std::runtime_error(error);
        }
        return result;
    }
    try {
        if (base.empty() || result.contestId.empty()) return result;
        const auto url = ParseHttpUrl(base);
        result.origin = url.origin;
        result.host = url.host;
        if (!client.empty()) result.clientOrigin = ParseHttpUrl(client).origin;
    } catch (const std::exception&) {
        // As in the existing client, malformed optional origins leave the guest unavailable.
    }
    return result;
}

bool ContestPolicy::External() const { return platform == "NOVAJUDGE" || platform == "HYDRO_BROWSER"; }

std::string ContestPolicy::Home() const {
    if (!External()) return clientOrigin.empty() ? "" : clientOrigin + "/contest";
    return origin.empty() ? "" : origin + basePath + "/contest/" + contestId;
}

bool ContestPolicy::Allows(std::string_view url, std::string_view type) const {
    return InspectResource(url, type).allowed;
}

ContestResource ContestPolicy::InspectResource(std::string_view url, std::string_view type, std::string_view method) const {
    if (url == "about:blank") return {true, std::nullopt};
    try {
        const bool external = External();
        if (url.starts_with("blob:")) {
            const bool allowed = !Frame(type) && (external ? ParseHttpUrl(url.substr(5)).origin == origin : !type.empty());
            return {allowed, std::nullopt};
        }
        if (url.starts_with("data:")) return {!Frame(type) && (external || !type.empty()), std::nullopt};
        if (url.starts_with("ws://") || url.starts_with("wss://")) {
            if (!external || type != "webSocket") return {};
            auto target = ParseSocket(url);
            const bool allowed = platform == "HYDRO_BROWSER" ? HydroSocket(*this, target) : target.origin == origin;
            return {allowed, std::move(target)};
        }
        auto target = ParseHttpUrl(url);
        bool allowed;
        if (platform == "HYDRO_BROWSER") allowed = type != "webSocket" && HydroRequest(*this, target, type, method);
        else if (platform == "NOVAJUDGE") allowed = NovaRequest(*this, target, type);
        else allowed = CandidateRequest(*this, target, type);
        return {allowed, std::move(target)};
    } catch (const std::exception&) {
        return {};
    }
}

bool ContestPolicy::IsFile(std::string_view url) const {
    if (!External()) return false;
    try {
        const auto target = ParseHttpUrl(url);
        if (target.origin != origin) return false;
        if (platform == "HYDRO_BROWSER") return HydroFile(*this, target, ParseParams(target.query));
        return NovaAsset(target.path) || std::regex_search(target.path, novaFile) ||
            target.path == "/api/contests/" + contestId + "/editorial" ||
            target.path == "/api/contests/" + contestId + "/rank-export";
    } catch (const std::exception&) {
        return false;
    }
}

std::string ContestPolicy::RecordId(const HttpUrl& target) const {
    if (platform != "HYDRO_BROWSER" || target.origin != origin) return {};
    if (target.path == "/record-detail-conn") {
        const auto params = ParseParams(target.query);
        const auto rid = Param(params, "rid");
        return rid.size() == 24 && std::regex_match(rid.begin(), rid.end(), hydroObjectId) ? std::string(rid) : "";
    }
    const auto route = HydroRoute(*this, target.path);
    if (std::regex_match(route.begin(), route.end(), hydroRecordRoute)) return std::string(route.substr(8));
    return {};
}

bool ContestPolicy::IsInlinePdf(std::string_view url) const {
    if (platform == "NOVAJUDGE") {
        try {
            const auto target = ParseHttpUrl(url);
            return target.origin == origin && target.path == "/api/contests/" + contestId + "/editorial";
        } catch (const std::exception&) { return false; }
    }
    if (platform != "HYDRO_BROWSER" || !IsFile(url)) return false;
    const auto target = ParseHttpUrl(url);
    static const std::regex pdf(R"(\.pdf$)", std::regex::icase);
    return target.path.ends_with("/domjudge-ui/booklet.pdf") || (target.path.find("/file/") != std::string::npos &&
        std::regex_search(target.path, pdf) && Param(ParseParams(target.query), "noDisposition") == "1");
}

bool ContestPolicy::AllowsDownload(std::string_view source, std::string_view url) const {
    if (source == "about:blank" || !Allows(source, "mainFrame")) return false;
    try {
        const bool blob = url.starts_with("blob:");
        const auto target = ParseHttpUrl(blob ? url.substr(5) : url);
        if (!External()) return blob && target.origin == clientOrigin;
        if (target.origin != origin) return false;
        return platform == "NOVAJUDGE" || blob || target.path.starts_with("/fs/") || IsFile(url);
    } catch (const std::exception&) {
        return false;
    }
}

bool ReferenceFile(std::string_view rawUrl) {
    try {
        const auto url = ParseHttpUrl(rawUrl);
        const auto name = Decode(std::string_view(url.path).substr(url.path.find_last_of('/') + 1), false);
        return (std::regex_search(name, fileExtension) && !std::regex_search(name, webPageExtension)) ||
            std::regex_search(url.path, downloadPath);
    } catch (const std::exception&) {
        return false;
    }
}

std::string DownloadName(std::string_view value) {
    const auto delimiter = value.find_last_of("/\\");
    if (delimiter != std::string_view::npos) value.remove_prefix(delimiter + 1);
    const auto end = value.find_last_not_of(". ");
    if (end == std::string_view::npos) return "题目附件";
    value = value.substr(0, end + 1);
    std::string name;
    for (size_t index = 0, units = 0; index < value.size() && units < 200;) {
        const auto byte = static_cast<unsigned char>(value[index]);
        if (byte < 128) {
            constexpr std::string_view invalid = "<>:\"|?*";
            name += byte < 32 || invalid.find(static_cast<char>(byte)) != std::string_view::npos ? '_' : value[index];
            ++index;
            ++units;
            continue;
        }
        // Apply the existing UTF-16 length limit without cutting a UTF-8 sequence.
        const size_t width = byte >= 0xf0 ? 4 : byte >= 0xe0 ? 3 : 2;
        const size_t count = width == 4 ? 2 : 1;
        if (index + width > value.size() || units + count > 200) break;
        name.append(value.substr(index, width));
        index += width;
        units += count;
    }
    return name.empty() ? "题目附件" : name;
}

}  // namespace proctor
