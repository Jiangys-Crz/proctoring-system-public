const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { spawnSync } = require('node:child_process');
const source = path.join(__dirname, '../src/windows-device-access.cpp');

test('optimized native permission probe handles Win7 absence and Win10/11 external WinRT objects', t => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'proctor-winrt-'));
  t.after(() => fs.rmSync(dir, { force: true, recursive: true }));
  fs.writeFileSync(path.join(dir, 'windows.h'), `#pragma once
#include <cstdint>
#define WINAPI
#define STDMETHODCALLTYPE
using HRESULT=std::int32_t;using ULONG=unsigned long;using UINT32=unsigned int;
using HMODULE=void*;using HSTRING=void*;using FARPROC=void(*)();
struct GUID{std::uint32_t Data1;std::uint16_t Data2,Data3;unsigned char Data4[8];};
using REFIID=const GUID&;
constexpr HRESULT S_OK=0,E_FAIL=static_cast<HRESULT>(0x80004005),RPC_E_CHANGED_MODE=static_cast<HRESULT>(0x80010106);
#define FAILED(x) ((x)<0)
#define SUCCEEDED(x) ((x)>=0)
HMODULE GetModuleHandleW(const wchar_t*);FARPROC GetProcAddress(HMODULE,const char*);
struct IUnknown{virtual HRESULT QueryInterface(REFIID,void**)=0;virtual ULONG AddRef()=0;virtual ULONG Release()=0;};
`);
  fs.writeFileSync(path.join(dir, 'inspectable.h'), '#pragma once\n#include "windows.h"\nstruct IInspectable:IUnknown{virtual HRESULT GetIids(ULONG*,GUID**)=0;virtual HRESULT GetRuntimeClassName(HSTRING*)=0;virtual HRESULT GetTrustLevel(int*)=0;};\n');
  fs.writeFileSync(path.join(dir, 'eventtoken.h'), '#pragma once\nstruct EventRegistrationToken{long long value;};\n');
  fs.writeFileSync(path.join(dir, 'winstring.h'), '#pragma once\n#include "windows.h"\nHRESULT WindowsCreateString(const wchar_t*,UINT32,HSTRING*);HRESULT WindowsDeleteString(HSTRING);\n');
  fs.writeFileSync(path.join(dir, 'roapi.h'), '#pragma once\n#include "windows.h"\nenum RO_INIT_TYPE{RO_INIT_MULTITHREADED=1};\nHRESULT RoInitialize(RO_INIT_TYPE);void RoUninitialize();HRESULT RoGetActivationFactory(HSTRING,REFIID,void**);\n');
  // The objects are implemented in a separate translation unit, as they are by
  // the Windows runtime. Compile the actual shipping probe, not a copied probe.
  fs.writeFileSync(path.join(dir, 'mock.cpp'), `#include "windows-device-access.hpp"
#include <roapi.h>
#include <cassert>
#include <cstring>
using namespace proctor::Devices;
int scenario=0,initialized=0,uninitialized=0,released=0,deleted=0,created=0;DeviceClass observed;
#define INSPECTABLE HRESULT QueryInterface(REFIID,void**)override{return E_FAIL;} ULONG AddRef()override{return 1;} ULONG Release()override{++released;return 1;} HRESULT GetIids(ULONG*,GUID**)override{return E_FAIL;} HRESULT GetRuntimeClassName(HSTRING*)override{return E_FAIL;} HRESULT GetTrustLevel(int*)override{return E_FAIL;}
struct Info:AccessInformation{INSPECTABLE
 HRESULT add_AccessChanged(IUnknown*,EventRegistrationToken*)override{return E_FAIL;}
 HRESULT remove_AccessChanged(EventRegistrationToken)override{return E_FAIL;}
 HRESULT get_CurrentStatus(DeviceAccessStatus* out)override{*out=static_cast<DeviceAccessStatus>(scenario>=1&&scenario<=4?scenario-1:1);return scenario==10?E_FAIL:S_OK;}
} info;
struct Factory:AccessFactory{INSPECTABLE
 HRESULT CreateFromId(HSTRING,AccessInformation**)override{return E_FAIL;}
 HRESULT CreateFromDeviceClassId(GUID,AccessInformation**)override{return E_FAIL;}
 HRESULT CreateFromDeviceClass(DeviceClass kind,AccessInformation** out)override{observed=kind;++created;*out=scenario==9?nullptr:&info;return scenario==8?E_FAIL:S_OK;}
} factory;
HMODULE GetModuleHandleW(const wchar_t*){return scenario==0?nullptr:reinterpret_cast<void*>(1);}
HRESULT RoInitialize(RO_INIT_TYPE){++initialized;return scenario==11?RPC_E_CHANGED_MODE:S_OK;}
void RoUninitialize(){++uninitialized;}
HRESULT WindowsCreateString(const wchar_t*,UINT32,HSTRING* out){*out=reinterpret_cast<void*>(2);return S_OK;}
HRESULT WindowsDeleteString(HSTRING){++deleted;return S_OK;}
HRESULT RoGetActivationFactory(HSTRING,REFIID iid,void** out){assert(iid.Data1==0x574bd3d3);*out=scenario==7?nullptr:&factory;return scenario==6?E_FAIL:S_OK;}
FARPROC GetProcAddress(HMODULE,const char* name){
 if(scenario==5)return nullptr;
 if(!std::strcmp(name,"RoInitialize"))return reinterpret_cast<FARPROC>(RoInitialize);
 if(!std::strcmp(name,"RoUninitialize"))return reinterpret_cast<FARPROC>(RoUninitialize);
 if(!std::strcmp(name,"WindowsCreateString"))return reinterpret_cast<FARPROC>(WindowsCreateString);
 if(!std::strcmp(name,"WindowsDeleteString"))return reinterpret_cast<FARPROC>(WindowsDeleteString);
 return reinterpret_cast<FARPROC>(RoGetActivationFactory);
}
`);
  fs.writeFileSync(path.join(dir, 'main.cpp'), `#include "windows-device-access.hpp"
#include <cassert>
extern int scenario,initialized,uninitialized,released,deleted,created;extern proctor::Devices::DeviceClass observed;
int main(){
 const char* expected[]={"granted","not-determined","granted","denied","restricted","granted","granted","unknown","granted","unknown","unknown","granted"};
 for(int i=0;i<12;i++)for(auto kind:{proctor::Devices::DeviceClass_AudioCapture,proctor::Devices::DeviceClass_VideoCapture}){
  scenario=i;initialized=uninitialized=released=deleted=created=0;
  assert(proctor::DeviceAccess(kind)==expected[i]);
  if(i==0||i==5){assert(!initialized&&!deleted&&!created);continue;}
  assert(initialized==1&&uninitialized==(i==11?0:1)&&deleted==1);
  if(i==6||i==7){assert(!created);continue;}
  assert(created==1&&observed==kind&&released==((i==8||i==9)?1:2));
 }
}
`);
  const executable = path.join(dir, 'test');
  const result = spawnSync('c++', ['-std=c++20', '-O3', '-fsanitize=address,undefined', '-I', dir,
    '-I', path.dirname(source), source, path.join(dir, 'mock.cpp'), path.join(dir, 'main.cpp'), '-o', executable], { encoding: 'utf8' });
  assert.equal(result.status, 0, result.stderr);
  const run = spawnSync(executable, [], { encoding: 'utf8', timeout: 5000 });
  assert.equal(run.status, 0, run.stderr);
});

test('MinGW release optimization retains external COM dispatch instead of pure-virtual calls', t => {
  for (const arch of ['x86_64', 'i686']) {
    const compiler = `${arch}-w64-mingw32-g++`;
    const available = spawnSync(compiler, ['--version']);
    if (available.error?.code === 'ENOENT') { t.diagnostic(`${compiler} unavailable; cross-compile check skipped`); continue; }
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), `proctor-winrt-${arch}-`));
    t.after(() => fs.rmSync(dir, { force: true, recursive: true }));
    const assembly = path.join(dir, 'permission.s');
    const compiled = spawnSync(compiler, ['-std=c++20', '-O3', '-DNDEBUG', '-DWINVER=0x0601', '-D_WIN32_WINNT=0x0601',
      '-S', source, '-o', assembly], { encoding: 'utf8' });
    assert.equal(compiled.status, 0, compiled.stderr);
    assert.doesNotMatch(fs.readFileSync(assembly, 'utf8'), /__cxa_pure_virtual/,
      `${arch}: external Windows runtime objects must dispatch through their vtable`);
  }
});
