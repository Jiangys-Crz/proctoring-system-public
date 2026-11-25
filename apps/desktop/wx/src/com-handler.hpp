#pragma once
#include <atomic>
#include <utility>

namespace proctor {
// Include after the COM interface declarations. A callback can close its own
// controller and release the event registration while Invoke is still running.
template<class Interface, class Sender, class Args, class Function>
class Handler final : public Interface {
public:
    explicit Handler(Function function) : function_(std::move(function)) {}
    HRESULT STDMETHODCALLTYPE QueryInterface(REFIID id, void** value) override {
        if (!value) return E_POINTER;
        *value = nullptr;
        if (id != __uuidof(Interface) && id != __uuidof(IUnknown)) return E_NOINTERFACE;
        *value = static_cast<Interface*>(this);
        AddRef();
        return S_OK;
    }
    ULONG STDMETHODCALLTYPE AddRef() override { return ++references_; }
    ULONG STDMETHODCALLTYPE Release() override {
        const auto count = --references_;
        if (!count) delete this;
        return count;
    }
    HRESULT STDMETHODCALLTYPE Invoke(Sender sender, Args args) override {
        AddRef();
        HRESULT result = S_OK;
        try { function_(sender, args); }
        catch (...) { result = E_FAIL; }
        // Do not touch members after this release: the registration may already
        // have gone away during the callback, including nested COM dispatch.
        Release();
        return result;
    }
private:
    std::atomic<ULONG> references_{1};
    Function function_;
};
}
