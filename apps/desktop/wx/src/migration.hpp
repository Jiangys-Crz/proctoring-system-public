#pragma once

#include "webview.hpp"
#include "legacy_drafts.hpp"

namespace proctor {

class LegacyMigration {
public:
    using Ready = std::function<void()>;
    using Report = std::function<void(std::string_view)>;
    using Worker = std::function<bool(std::function<void()>)>;

    LegacyMigration(fs::path userData, fs::path resources, Report report);
    ~LegacyMigration();

    // Prepare reads a closed Electron profile on a worker. All WebView2
    // operations, including attachment and cancellation, are on the wx STA.
    void Prepare();
    bool NeedsContestTarget() const;
    void Start(const Runtime& runtime, HWND parent, Ready ready);
    std::string ShellScript() const;
    void AttachClient(ICoreWebView2* target);
    void AttachContest(ICoreWebView2* target);
    void ReadDrafts(LegacyDraftTarget target, const Runtime& runtime, HWND parent, Worker worker,
        std::function<void(Json)> ready);
    void Tick();
    void Cancel();

private:
    struct State;
    std::shared_ptr<State> state_;
};

} // namespace proctor
