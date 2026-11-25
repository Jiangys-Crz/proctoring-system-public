#pragma once
#include <windows.h>
#include <inspectable.h>
#include <eventtoken.h>
#include <winstring.h>
#include <string>

// These ABI interfaces must have external linkage: their implementations live
// in Windows, outside this translation unit. Anonymous-namespace interfaces let
// GCC devirtualize successful activation into an unresolved pure-virtual call.
namespace proctor::Devices {
enum DeviceClass { DeviceClass_AudioCapture = 1, DeviceClass_VideoCapture = 4 };
enum DeviceAccessStatus { DeviceAccessStatus_Unspecified, DeviceAccessStatus_Allowed,
    DeviceAccessStatus_DeniedByUser, DeviceAccessStatus_DeniedBySystem };
struct AccessInformation : IInspectable {
    virtual HRESULT STDMETHODCALLTYPE add_AccessChanged(IUnknown*, EventRegistrationToken*) = 0;
    virtual HRESULT STDMETHODCALLTYPE remove_AccessChanged(EventRegistrationToken) = 0;
    virtual HRESULT STDMETHODCALLTYPE get_CurrentStatus(DeviceAccessStatus*) = 0;
};
struct AccessFactory : IInspectable {
    virtual HRESULT STDMETHODCALLTYPE CreateFromId(HSTRING, AccessInformation**) = 0;
    virtual HRESULT STDMETHODCALLTYPE CreateFromDeviceClassId(GUID, AccessInformation**) = 0;
    virtual HRESULT STDMETHODCALLTYPE CreateFromDeviceClass(DeviceClass, AccessInformation**) = 0;
};
inline constexpr GUID accessFactoryId{0x574bd3d3, 0x5f30, 0x45cd, {0x8a, 0x94, 0x72, 0x4f, 0xe5, 0x97, 0x30, 0x84}};
}
namespace proctor {
std::string DeviceAccess(Devices::DeviceClass type);
}
