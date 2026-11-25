#pragma once

#include "bridge.hpp"

#include <optional>

namespace proctor {

struct ContestResource {
    bool allowed = false;
    std::optional<HttpUrl> target;
};

struct ContestPolicy {
    std::string platform, origin, host, basePath, contestId, clientOrigin, backendOrigin;

    bool External() const;
    std::string Home() const;
    bool Allows(std::string_view url, std::string_view type) const;
    ContestResource InspectResource(std::string_view url, std::string_view type, std::string_view method = {}) const;
    bool IsFile(std::string_view url) const;
    bool IsInlinePdf(std::string_view url) const;
    std::string RecordId(const HttpUrl& target) const;
    bool AllowsDownload(std::string_view source, std::string_view url) const;
};

ContestPolicy MakeContestPolicy(const Json& args);
bool ReferenceFile(std::string_view url);
std::string DownloadName(std::string_view name);

}  // namespace proctor
