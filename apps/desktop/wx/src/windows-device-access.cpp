#include "windows-device-access.hpp"
#include <roapi.h>
#include <iterator>

namespace proctor {
std::string DeviceAccess(Devices::DeviceClass type) {
    // Resolve WinRT dynamically: Windows 7 has no combase/WinRT imports.
    HMODULE module = GetModuleHandleW(L"combase.dll");
    if (!module) return "granted";
    const auto roInitialize = reinterpret_cast<decltype(&RoInitialize)>(GetProcAddress(module, "RoInitialize"));
    const auto roUninitialize = reinterpret_cast<decltype(&RoUninitialize)>(GetProcAddress(module, "RoUninitialize"));
    const auto makeString = reinterpret_cast<decltype(&WindowsCreateString)>(GetProcAddress(module, "WindowsCreateString"));
    const auto freeString = reinterpret_cast<decltype(&WindowsDeleteString)>(GetProcAddress(module, "WindowsDeleteString"));
    const auto activation = reinterpret_cast<decltype(&RoGetActivationFactory)>(GetProcAddress(module, "RoGetActivationFactory"));
    if (!roInitialize || !roUninitialize || !makeString || !freeString || !activation) return "granted";
    const auto initialized = roInitialize(RO_INIT_MULTITHREADED);
    if (FAILED(initialized) && initialized != RPC_E_CHANGED_MODE) return "granted";
    struct Apartment { void (WINAPI* close)(); ~Apartment() { if (close) close(); } } apartment{SUCCEEDED(initialized) ? roUninitialize : nullptr};
    constexpr wchar_t runtime[] = L"Windows.Devices.Enumeration.DeviceAccessInformation";
    HSTRING name = nullptr;
    if (FAILED(makeString(runtime, static_cast<UINT32>(std::size(runtime) - 1), &name))) return "granted";
    Devices::AccessFactory* factory = nullptr;
    const auto result = activation(name, Devices::accessFactoryId, reinterpret_cast<void**>(&factory));
    freeString(name);
    if (FAILED(result)) return "granted";
    if (!factory) return "unknown";
    Devices::AccessInformation* info = nullptr;
    const auto created = factory->CreateFromDeviceClass(type, &info);
    factory->Release();
    if (FAILED(created)) return "granted";
    if (!info) return "unknown";
    auto access = Devices::DeviceAccessStatus_Unspecified;
    const auto read = info->get_CurrentStatus(&access);
    info->Release();
    if (FAILED(read)) return "unknown";
    switch (access) {
    case Devices::DeviceAccessStatus_Allowed: return "granted";
    case Devices::DeviceAccessStatus_DeniedByUser: return "denied";
    case Devices::DeviceAccessStatus_DeniedBySystem: return "restricted";
    case Devices::DeviceAccessStatus_Unspecified: return "not-determined";
    default: return "unknown";
    }
}
}
