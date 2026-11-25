const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { spawnSync } = require('node:child_process');

test('WebView detaches its COM members before reentrant controller Close and keeps them alive until it returns', t => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'proctor-webview-lifetime-'));
  t.after(() => fs.rmSync(directory, { recursive: true, force: true }));
  const source = fs.readFileSync(path.join(__dirname, '../src/webview.cpp'), 'utf8');
  const close = source.slice(source.indexOf('void WebView::Close()'), source.indexOf('\n} // namespace proctor'));
  const file = path.join(directory, 'test.cpp');
  const executable = path.join(directory, 'test');
  fs.writeFileSync(file, `#include <cassert>
#include <functional>
#include <memory>
#include <utility>
struct Controller { std::function<void()> onClose; void Close() { onClose(); } };
template<class T> struct ComPtr : std::shared_ptr<T> {
    ComPtr() = default;
    ComPtr(std::shared_ptr<T> value) : std::shared_ptr<T>(std::move(value)) {}
    void Reset() { this->reset(); }
};
struct WebView {
    void* parent_ = reinterpret_cast<void*>(1);
    ComPtr<Controller> controller_;
    ComPtr<int> core_, environment_;
    void Close();
};
${close}
int main() {
    WebView view;
    view.controller_ = std::make_shared<Controller>();
    view.core_ = std::make_shared<int>(1);
    view.environment_ = std::make_shared<int>(2);
    std::weak_ptr<Controller> controller = view.controller_;
    std::weak_ptr<int> core = view.core_, environment = view.environment_;
    int closes = 0;
    view.controller_->onClose = [&] {
        assert(++closes == 1);
        assert(!view.parent_ && !view.controller_ && !view.core_ && !view.environment_);
        assert(!controller.expired() && !core.expired() && !environment.expired());
        view.Close();
        assert(!controller.expired() && !core.expired() && !environment.expired());
    };
    view.Close();
    view.Close();
    assert(closes == 1 && controller.expired() && core.expired() && environment.expired());
}
`);
  const built = spawnSync('c++', ['-std=c++20', '-fsanitize=address,undefined', '-fno-omit-frame-pointer',
    file, '-o', executable], { encoding: 'utf8' });
  assert.equal(built.status, 0, built.stderr);
  const run = spawnSync(executable, [], { encoding: 'utf8', timeout: 5000 });
  assert.equal(run.status, 0, run.stderr);
});
