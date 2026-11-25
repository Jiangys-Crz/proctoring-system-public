const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { spawnSync } = require('node:child_process');
test('native workers survive migration exceptions and a throwing error reporter, then finish subsequent work', t => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'proctor-workers-test-'));
  t.after(() => fs.rmSync(directory, { recursive: true, force: true }));
  const source = path.join(directory, 'test.cpp'), executable = path.join(directory, 'test');
  fs.writeFileSync(source, `#include "workers.hpp"
#include <atomic>
#include <cassert>
#include <chrono>
#include <future>
#include <stdexcept>
int main(){
 std::atomic<int> failures=0; std::promise<void> complete;
 proctor::Workers workers(1,[&](std::exception_ptr error){try{std::rethrow_exception(error);}catch(const std::runtime_error&){failures++;}throw std::runtime_error("reporter failed");});
 assert(workers.Post([]{throw std::runtime_error("locked legacy profile");}));
 assert(workers.Post([]{throw 42;}));
 assert(workers.Post([&]{complete.set_value();}));
 assert(complete.get_future().wait_for(std::chrono::seconds(3))==std::future_status::ready);
 assert(failures==1);workers.Close();assert(!workers.Post([]{}));
}`);
  const built = spawnSync('c++', ['-std=c++20', '-pthread', '-I', path.join(__dirname, '../src'), source, '-o', executable]);
  assert.equal(built.status, 0, built.stderr.toString());
  const result = spawnSync(executable, [], { timeout: 5000 });
  assert.equal(result.status, 0, result.stderr.toString());
});
