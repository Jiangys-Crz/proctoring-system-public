#pragma once

#include "browser_policy.hpp"

#include <optional>

namespace proctor {

struct LegacyDraftTarget {
    std::string origin, backend, sessionId, token;
};

std::optional<LegacyDraftTarget> LegacyDraftTargetFor(const ContestPolicy& scope, std::string_view url, const Json& options);
bool AuthorizeLegacyDrafts(const LegacyDraftTarget& target, const std::atomic_bool* stopping = nullptr);
std::string LegacyDraftReadScript(const LegacyDraftTarget& target);
std::string LegacyDraftInstallScript(const LegacyDraftTarget& target, const Json& drafts);

} // namespace proctor
