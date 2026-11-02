(function (root) {
  root.proctorRecordingMimeTypes = function (os) {
    const codecs = /^win32 6\.1(?:\.|\s|$)/.test(os || '') ? ['vp8', 'vp9'] : ['vp9', 'vp8'];
    return codecs.flatMap(codec => [`video/webm;codecs=${codec},opus`, `video/webm;codecs=${codec}`]).concat('video/webm');
  };
  root.proctorCapturePolicy = function (session, requirements, live = {}) {
    const active = Boolean(session?.id && session.status !== 'FINISHED');
    const requireFrontCamera = requirements?.requireFrontCamera === true;
    return {
      captureScreen: active,
      captureCamera: active && requireFrontCamera,
      previewScreen: active && live.screen === true,
      previewCamera: active && requireFrontCamera && live.camera === true,
      channels: active
        ? ['DESKTOP_SCREEN', ...(requireFrontCamera ? ['DESKTOP_CAMERA'] : [])]
        : []
    };
  };
})(globalThis);
