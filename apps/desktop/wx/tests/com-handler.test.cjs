const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { spawnSync } = require('node:child_process');

test('COM callbacks survive registration removal, nested dispatch and exceptions until Invoke returns', t => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'proctor-com-handler-'));
  t.after(() => fs.rmSync(directory, { recursive: true, force: true }));
  const source = path.join(directory, 'test.cpp'), executable = path.join(directory, 'test');
  fs.writeFileSync(source, `#include <cassert>
#include <functional>
#include <memory>
#include <stdexcept>
#define STDMETHODCALLTYPE
using HRESULT=int; using ULONG=unsigned long; using REFIID=int;
constexpr HRESULT S_OK=0,E_FAIL=-1,E_POINTER=-2,E_NOINTERFACE=-3;
template<class T> constexpr int iid=1;
#define __uuidof(T) iid<T>
struct IUnknown{virtual HRESULT QueryInterface(REFIID,void**)=0;virtual ULONG AddRef()=0;virtual ULONG Release()=0;};
struct Event:IUnknown{virtual HRESULT Invoke(int,int)=0;};
#include "com-handler.hpp"
struct Probe{bool& destroyed;~Probe(){destroyed=true;}};
int main(){
 for(bool throws:{false,true}){
  bool destroyed=false,continued=false,nested=false;
  Event* event=nullptr;
  auto probe=std::make_shared<Probe>(destroyed);
  using Callback=proctor::Handler<Event,int,int,std::function<void(int,int)>>;
  event=new Callback([&,probe](int depth,int){
   if(depth==0){assert(event->Invoke(1,0)==S_OK);nested=true;}
   else return;
   event->Release(); // Closing a controller removes its last registration.
   assert(!destroyed && probe.use_count()==1);
   continued=true;
   if(throws)throw std::runtime_error("controller closed during callback");
  });
  probe.reset();
  assert(event->Invoke(0,0)==(throws?E_FAIL:S_OK));
  assert(nested && continued && destroyed);
 }
}
`);
  const built = spawnSync('c++', ['-std=c++20', '-fsanitize=address,undefined', '-fno-omit-frame-pointer', '-I', path.join(__dirname, '../src'), source, '-o', executable]);
  assert.equal(built.status, 0, built.stderr.toString());
  const run = spawnSync(executable, [], { timeout: 5000 });
  assert.equal(run.status, 0, run.stderr.toString());
});
