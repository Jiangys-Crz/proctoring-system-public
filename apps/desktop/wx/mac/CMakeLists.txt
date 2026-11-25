include(FetchContent)
if(NOT CMAKE_OSX_ARCHITECTURES)
  set(CMAKE_OSX_ARCHITECTURES "${CMAKE_HOST_SYSTEM_PROCESSOR}")
endif()
if(CMAKE_OSX_ARCHITECTURES STREQUAL "arm64")
  set(DESKTOP_ARCH arm64)
elseif(CMAKE_OSX_ARCHITECTURES STREQUAL "x86_64")
  set(DESKTOP_ARCH x64)
else()
  message(FATAL_ERROR "Build one macOS architecture at a time (arm64 or x86_64).")
endif()
if(CMAKE_OSX_DEPLOYMENT_TARGET VERSION_LESS "14.0")
  message(FATAL_ERROR "macOS 14 or later is required for separate persistent WebKit profiles.")
endif()

set(CMAKE_CXX_STANDARD 20)
set(CMAKE_CXX_STANDARD_REQUIRED ON)
set(CMAKE_OBJCXX_STANDARD 20)
set(CMAKE_OBJCXX_STANDARD_REQUIRED ON)
set(PROCTOR_BUILD_CHANNEL "unified" CACHE STRING "Desktop release channel")
set(PROCTOR_PACKAGED ON CACHE BOOL "Use production startup/update semantics")
set(PROCTOR_FFMPEG "" CACHE FILEPATH "FFmpeg executable for the selected Mac architecture")
set(PROCTOR_LEGACY_ELECTRON "" CACHE PATH "Legacy Mac Electron.app used only by first-run migration")
find_program(NODE_EXECUTABLE node REQUIRED)
get_filename_component(DESKTOP "${CMAKE_CURRENT_SOURCE_DIR}/../.." ABSOLUTE)
set_property(DIRECTORY APPEND PROPERTY CMAKE_CONFIGURE_DEPENDS "${DESKTOP}/package.json")
file(READ "${DESKTOP}/package.json" DESKTOP_PACKAGE)
string(JSON PROCTOR_VERSION GET "${DESKTOP_PACKAGE}" version)
string(JSON PRODUCT_NAME GET "${DESKTOP_PACKAGE}" build productName)
if(NOT PROCTOR_FFMPEG)
  set(PROCTOR_FFMPEG "${DESKTOP}/build/ffmpeg/darwin-${DESKTOP_ARCH}/ffmpeg")
endif()
if(NOT EXISTS "${PROCTOR_FFMPEG}")
  message(FATAL_ERROR "Missing Mac FFmpeg. Run node scripts/prepare-mac-ffmpeg.mjs ${DESKTOP_ARCH}.")
endif()
if(NOT PROCTOR_LEGACY_ELECTRON)
  set(PROCTOR_LEGACY_ELECTRON "${DESKTOP}/build/legacy-electron/darwin-${DESKTOP_ARCH}/Electron.app")
endif()
set(LEGACY_ELECTRON_BINARY "${PROCTOR_LEGACY_ELECTRON}/Contents/MacOS/Electron")
if(PROCTOR_PACKAGED AND NOT EXISTS "${LEGACY_ELECTRON_BINARY}")
  message(FATAL_ERROR "Missing the legacy migration runtime. Run node wx/mac/prepare-mac-legacy-runtime.mjs ${DESKTOP_ARCH}.")
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
FetchContent_MakeAvailable(wxwidgets nlohmann_json)
configure_file(../resources/build_config.hpp.in "${CMAKE_CURRENT_BINARY_DIR}/build_config.hpp" @ONLY)

add_executable(proctor-desktop MACOSX_BUNDLE
  main.mm local_http.cpp webview.mm browser.mm migration.cpp migration_import.mm legacy_launch.cpp
  bridge_http.mm native.mm native_domains.cpp native_process.cpp native_screen.cpp media.mm
  ../src/browser_policy.cpp ../src/bridge.cpp ../src/bridge_submit.cpp ../src/bridge_update.cpp ../src/legacy_drafts.cpp)
set_target_properties(proctor-desktop PROPERTIES
  OUTPUT_NAME "${PRODUCT_NAME}"
  MACOSX_BUNDLE_INFO_PLIST "${CMAKE_CURRENT_SOURCE_DIR}/Info.plist.in")
target_compile_options(proctor-desktop PRIVATE $<$<COMPILE_LANGUAGE:OBJCXX>:-fobjc-arc>)
target_include_directories(proctor-desktop PRIVATE "../src" "${CMAKE_CURRENT_BINARY_DIR}")
target_link_libraries(proctor-desktop PRIVATE wx::core wx::base nlohmann_json::nlohmann_json curl)
foreach(framework AppKit ApplicationServices AVFoundation CoreGraphics CoreMedia CoreVideo
    Foundation ImageIO IOSurface QuartzCore ScreenCaptureKit Security SystemConfiguration WebKit)
  find_library(PROCTOR_${framework} ${framework} REQUIRED)
  target_link_libraries(proctor-desktop PRIVATE "${PROCTOR_${framework}}")
endforeach()

set(BUNDLE_RESOURCES "$<TARGET_BUNDLE_DIR:proctor-desktop>/Contents/Resources")
add_custom_target(proctor-mac-assets ALL
  COMMAND "${CMAKE_COMMAND}" -E env "PROCTOR_BUILD_CHANNEL=${PROCTOR_BUILD_CHANNEL}"
    "${NODE_EXECUTABLE}" "${CMAKE_CURRENT_SOURCE_DIR}/../resources/stage.cjs" "${BUNDLE_RESOURCES}" mac
  COMMAND "${CMAKE_COMMAND}" -E make_directory "${BUNDLE_RESOURCES}/ffmpeg"
  COMMAND "${CMAKE_COMMAND}" -E copy_if_different "${PROCTOR_FFMPEG}" "${BUNDLE_RESOURCES}/ffmpeg/ffmpeg"
  COMMAND /bin/chmod 755 "${BUNDLE_RESOURCES}/ffmpeg/ffmpeg"
  COMMAND "${CMAKE_COMMAND}" -E copy_if_different "${DESKTOP}/build/icon.icns" "${BUNDLE_RESOURCES}/icon.icns"
  COMMAND "${CMAKE_COMMAND}" -E copy_directory "${DESKTOP}/resources/novajudge-submit" "${BUNDLE_RESOURCES}/novajudge-submit"
  COMMAND "${CMAKE_COMMAND}" -E copy_directory "${CMAKE_CURRENT_SOURCE_DIR}/legacy-export" "${BUNDLE_RESOURCES}/legacy-export"
  DEPENDS proctor-desktop
  VERBATIM)
if(EXISTS "${LEGACY_ELECTRON_BINARY}")
  add_custom_command(TARGET proctor-mac-assets POST_BUILD
    COMMAND "${CMAKE_COMMAND}" -E make_directory "$<TARGET_BUNDLE_DIR:proctor-desktop>/Contents/Helpers"
    COMMAND /usr/bin/ditto "${PROCTOR_LEGACY_ELECTRON}" "$<TARGET_BUNDLE_DIR:proctor-desktop>/Contents/Helpers/Electron.app"
    VERBATIM)
endif()
