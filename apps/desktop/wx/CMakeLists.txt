cmake_minimum_required(VERSION 3.24)
set(CMAKE_OSX_DEPLOYMENT_TARGET "14.0" CACHE STRING "Minimum macOS version")
project(ProctorDesktop LANGUAGES C CXX)
if(APPLE)
  enable_language(OBJCXX)
  add_subdirectory(mac)
  return()
endif()

if(NOT WIN32)
  message(FATAL_ERROR "The WebView2 Fixed Version host builds for Windows.")
endif()
enable_language(RC)

include(FetchContent)
set(CMAKE_CXX_STANDARD 20)
set(CMAKE_CXX_STANDARD_REQUIRED ON)
set(CMAKE_CXX_EXTENSIONS OFF)
set(PROCTOR_WINVER 0x0601)
if(CMAKE_GENERATOR_PLATFORM MATCHES "^ARM64(,|$)" OR CMAKE_SYSTEM_PROCESSOR MATCHES "^(arm64|ARM64|aarch64|AARCH64)$")
  set(SDK_ARCH arm64)
  set(DESKTOP_ARCH arm64)
  set(PROCTOR_WINVER 0x0A00)
elseif(CMAKE_GENERATOR_PLATFORM MATCHES "^ARM" OR CMAKE_SYSTEM_PROCESSOR MATCHES "^(arm|ARM)")
  message(FATAL_ERROR "The Windows desktop client supports ARM64, x64 and x86.")
elseif(CMAKE_SIZEOF_VOID_P EQUAL 8)
  set(SDK_ARCH x64)
  set(DESKTOP_ARCH x64)
else()
  set(SDK_ARCH x86)
  set(DESKTOP_ARCH ia32)
endif()
set(WEBVIEW2_VERSION 109.0.1518.140)
set(PROCTOR_WEBVIEW2_RUNTIME "" CACHE PATH "Unpacked Microsoft WebView2 Fixed Version 109.0.1518.140 directory")
set(PROCTOR_FFMPEG "" CACHE FILEPATH "Existing desktop release FFmpeg binary for the target architecture")
set(PROCTOR_BUILD_CHANNEL "unified" CACHE STRING "Existing release channel (unified, public, intranet or empty for development)")
set(PROCTOR_PACKAGED ON CACHE BOOL "Use production startup/update semantics")
find_program(NODE_EXECUTABLE node REQUIRED)
get_filename_component(DESKTOP "${CMAKE_CURRENT_SOURCE_DIR}/.." ABSOLUTE)
set_property(DIRECTORY APPEND PROPERTY CMAKE_CONFIGURE_DEPENDS "${DESKTOP}/package.json")
file(READ "${DESKTOP}/package.json" DESKTOP_PACKAGE)
string(JSON PROCTOR_VERSION GET "${DESKTOP_PACKAGE}" version)
string(REPLACE "." "," PROCTOR_VERSION_COMMAS "${PROCTOR_VERSION}")
if(NOT PROCTOR_FFMPEG)
  set(PROCTOR_FFMPEG "${DESKTOP}/build/ffmpeg/win32-${DESKTOP_ARCH}/ffmpeg.exe")
endif()
if(NOT EXISTS "${PROCTOR_FFMPEG}")
  message(FATAL_ERROR "Missing target FFmpeg. Use the existing desktop FFmpeg preparation script or set PROCTOR_FFMPEG.")
endif()
if(PROCTOR_WEBVIEW2_RUNTIME AND NOT EXISTS "${PROCTOR_WEBVIEW2_RUNTIME}/msedgewebview2.exe")
  message(FATAL_ERROR "PROCTOR_WEBVIEW2_RUNTIME must contain msedgewebview2.exe directly.")
endif()

if(MSVC)
  # MSVC 14.50 raised the runtime minimum to Windows 10. The Windows build
  # also targets Windows 7, so use the Visual Studio 2022 (v143) toolset.
  if(NOT SDK_ARCH STREQUAL "arm64" AND MSVC_VERSION GREATER_EQUAL 1950)
    message(FATAL_ERROR "Windows 7 support requires the Visual Studio 2022 v143 toolset (MSVC 14.44 or earlier) or MinGW-w64.")
  endif()
  set(CMAKE_MSVC_RUNTIME_LIBRARY "MultiThreaded$<$<CONFIG:Debug>:Debug>")
  set(wxBUILD_USE_STATIC_RUNTIME ON CACHE BOOL "")
endif()
set(wxBUILD_SHARED OFF CACHE BOOL "")
set(wxBUILD_INSTALL OFF CACHE BOOL "")
set(wxUSE_WEBVIEW OFF CACHE BOOL "")
set(wxUSE_MEDIACTRL OFF CACHE BOOL "")
set(wxUSE_LIBSDL OFF CACHE BOOL "")
set(JSON_BuildTests OFF CACHE BOOL "")
set(JSON_Install OFF CACHE BOOL "")
FetchContent_Declare(wxwidgets
  URL https://github.com/wxWidgets/wxWidgets/releases/download/v3.2.8.1/wxWidgets-3.2.8.1.tar.bz2
  URL_HASH SHA256=ad0cf6c18815dcf1a6a89ad3c3d21a306cd7b5d99a602f77372ef1d92cb7d756
  DOWNLOAD_EXTRACT_TIMESTAMP TRUE)
FetchContent_Declare(nlohmann_json
  URL https://github.com/nlohmann/json/releases/download/v3.11.3/json.tar.xz
  URL_HASH SHA256=d6c65aca6b1ed68e7a182f4757257b107ae403032760ed6ef121c9d55e81757d
  DOWNLOAD_EXTRACT_TIMESTAMP TRUE)
FetchContent_Declare(webview2_sdk
  URL https://api.nuget.org/v3-flatcontainer/microsoft.web.webview2/1.0.1518.46/microsoft.web.webview2.1.0.1518.46.nupkg
  URL_HASH SHA256=63020b2d569d09a2098ae1ca20dd4cc281885f794aa00fc8812c6ab52dd49618
  DOWNLOAD_NAME webview2.zip
  DOWNLOAD_EXTRACT_TIMESTAMP TRUE)
FetchContent_MakeAvailable(wxwidgets nlohmann_json webview2_sdk)
set(WEBVIEW2_NATIVE "${webview2_sdk_SOURCE_DIR}/build/native")
if(MINGW)
  execute_process(COMMAND "${NODE_EXECUTABLE}" "${CMAKE_CURRENT_SOURCE_DIR}/resources/mingw-guids.cjs"
    "${WEBVIEW2_NATIVE}/include/WebView2.h" "${CMAKE_CURRENT_BINARY_DIR}/webview2_mingw_guids.hpp"
    COMMAND_ERROR_IS_FATAL ANY)
endif()

configure_file(resources/client.rc.in "${CMAKE_CURRENT_BINARY_DIR}/client.rc" @ONLY)
configure_file(resources/build_config.hpp.in "${CMAKE_CURRENT_BINARY_DIR}/build_config.hpp" @ONLY)
add_executable(proctor-desktop WIN32
  src/main.cpp src/webview.cpp src/browser.cpp src/browser_policy.cpp src/migration.cpp src/legacy_drafts.cpp
  src/bridge.cpp src/bridge_http.cpp src/bridge_update.cpp src/bridge_submit.cpp
  src/native_windows.cpp src/windows-device-access.cpp src/native_windows_screen.cpp src/native_windows_process.cpp
  src/native_windows_usb.cpp src/native_windows_domains.cpp src/media.cpp
  "${CMAKE_CURRENT_BINARY_DIR}/client.rc")
target_compile_definitions(proctor-desktop PRIVATE UNICODE _UNICODE NOMINMAX WIN32_LEAN_AND_MEAN
  WINVER=${PROCTOR_WINVER} _WIN32_WINNT=${PROCTOR_WINVER})
target_include_directories(proctor-desktop PRIVATE "${WEBVIEW2_NATIVE}/include" "${CMAKE_CURRENT_BINARY_DIR}")
target_link_libraries(proctor-desktop PRIVATE wx::core wx::base nlohmann_json::nlohmann_json
  version uuid ole32 oleaut32 urlmon shlwapi shell32 advapi32 winhttp crypt32 bcrypt wintrust
  iphlpapi ws2_32 rpcrt4 normaliz gdiplus)
if(MSVC)
  target_compile_options(proctor-desktop PRIVATE $<$<COMPILE_LANGUAGE:CXX>:/utf-8;/bigobj>)
  target_link_options(proctor-desktop PRIVATE /MANIFEST:NO)
else()
  if(CMAKE_CXX_COMPILER_ID STREQUAL "GNU")
    target_compile_options(proctor-desktop PRIVATE $<$<COMPILE_LANGUAGE:CXX>:-Wa,-mbig-obj>)
  endif()
  target_link_options(proctor-desktop PRIVATE -static)
endif()

if(SDK_ARCH STREQUAL "arm64")
  # Compile the same helper sources with the ARM64 compiler used for the app.
  # Intel builds continue to use the bundled, versioned Win7 helper binaries.
  function(proctor_arm64_helper name directory source entry)
    add_executable(${name} "${DESKTOP}/native/${directory}/${source}")
    target_compile_definitions(${name} PRIVATE WINVER=${PROCTOR_WINVER} _WIN32_WINNT=${PROCTOR_WINVER} NTDDI_VERSION=0x0A000000)
    target_link_libraries(${name} PRIVATE ${ARGN})
    if(MSVC)
      target_compile_options(${name} PRIVATE /GS- /utf-8)
      target_link_options(${name} PRIVATE /NODEFAULTLIB /MANIFEST:NO "/ENTRY:${entry}" "/SUBSYSTEM:CONSOLE,10.00")
    else()
      target_compile_options(${name} PRIVATE -fno-stack-protector -fno-builtin)
      target_link_options(${name} PRIVATE -nostdlib "-Wl,--entry,${entry}" -Wl,--subsystem,console:10.0)
    endif()
  endfunction()
  proctor_arm64_helper(token-probe windows-token probe.c probe_entry advapi32 kernel32 shell32)
  proctor_arm64_helper(elevate-client windows-launcher launcher.c launcher_entry kernel32 shell32 ole32)
  proctor_arm64_helper(screen-control-guard windows-screen-control guard.c guard_entry kernel32 user32 gdi32 shell32 ole32 uuid)
  proctor_arm64_helper(inventory-probe windows-inventory inventory.c inventory_entry advapi32 kernel32 shell32 setupapi user32)
  set(TOKEN_HELPER $<TARGET_FILE:token-probe>)
  set(LAUNCHER_HELPER $<TARGET_FILE:elevate-client>)
  set(SCREEN_HELPER $<TARGET_FILE:screen-control-guard>)
  set(INVENTORY_HELPER $<TARGET_FILE:inventory-probe>)
else()
  set(TOKEN_HELPER "${DESKTOP}/native/windows-token/${DESKTOP_ARCH}/token-probe.exe")
  set(LAUNCHER_HELPER "${DESKTOP}/native/windows-launcher/${DESKTOP_ARCH}/elevate-client.exe")
  set(SCREEN_HELPER "${DESKTOP}/native/windows-screen-control/${DESKTOP_ARCH}/screen-control-guard.exe")
  set(INVENTORY_HELPER "${DESKTOP}/native/windows-inventory/${DESKTOP_ARCH}/inventory-probe.exe")
endif()

set(ASSET_STAGE "${CMAKE_CURRENT_BINARY_DIR}/client-resources")
add_custom_target(proctor-assets ALL
  COMMAND "${CMAKE_COMMAND}" -E env "PROCTOR_BUILD_CHANNEL=${PROCTOR_BUILD_CHANNEL}"
    "${NODE_EXECUTABLE}" "${CMAKE_CURRENT_SOURCE_DIR}/resources/stage.cjs" "${ASSET_STAGE}"
  COMMAND "${CMAKE_COMMAND}" -E make_directory "${ASSET_STAGE}/security" "${ASSET_STAGE}/ffmpeg"
  COMMAND "${CMAKE_COMMAND}" -E copy_if_different "${PROCTOR_FFMPEG}" "${ASSET_STAGE}/ffmpeg/ffmpeg.exe"
  COMMAND "${CMAKE_COMMAND}" -E copy_if_different "${TOKEN_HELPER}" "${ASSET_STAGE}/security/"
  COMMAND "${CMAKE_COMMAND}" -E copy_if_different "${LAUNCHER_HELPER}" "${ASSET_STAGE}/security/"
  COMMAND "${CMAKE_COMMAND}" -E copy_if_different "${SCREEN_HELPER}" "${ASSET_STAGE}/security/"
  COMMAND "${CMAKE_COMMAND}" -E copy_if_different "${INVENTORY_HELPER}" "${ASSET_STAGE}/security/"
  COMMAND "${CMAKE_COMMAND}" -E copy_directory "${DESKTOP}/resources/novajudge-submit" "${ASSET_STAGE}/novajudge-submit"
  COMMAND "${CMAKE_COMMAND}" -E copy_directory "${ASSET_STAGE}" "$<TARGET_FILE_DIR:proctor-desktop>/resources"
  COMMAND "${CMAKE_COMMAND}" -E copy_if_different "${WEBVIEW2_NATIVE}/${SDK_ARCH}/WebView2Loader.dll" "$<TARGET_FILE_DIR:proctor-desktop>/"
  VERBATIM)
if(PROCTOR_WEBVIEW2_RUNTIME)
  add_custom_command(TARGET proctor-assets POST_BUILD
    COMMAND "${CMAKE_COMMAND}" -E copy_directory "${PROCTOR_WEBVIEW2_RUNTIME}" "$<TARGET_FILE_DIR:proctor-desktop>/webview2/${WEBVIEW2_VERSION}"
    VERBATIM)
  install(DIRECTORY "${PROCTOR_WEBVIEW2_RUNTIME}/" DESTINATION "webview2/${WEBVIEW2_VERSION}")
endif()
add_dependencies(proctor-desktop proctor-assets)
install(TARGETS proctor-desktop RUNTIME DESTINATION .)
install(FILES "${WEBVIEW2_NATIVE}/${SDK_ARCH}/WebView2Loader.dll" DESTINATION .)
install(DIRECTORY "${ASSET_STAGE}/" DESTINATION resources)
