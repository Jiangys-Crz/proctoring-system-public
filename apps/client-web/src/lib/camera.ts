export function isCameraPermissionError(error: unknown) {
  const name = error && typeof error === 'object' && 'name' in error ? error.name : '';
  return name === 'NotAllowedError' || name === 'SecurityError';
}

export function cameraErrorMessage(error: unknown, audio = false) {
  if (isCameraPermissionError(error)) {
    return `请允许本页面使用摄像头${audio ? '和麦克风' : ''}，然后点击“重新获取摄像头权限”。若已禁止，请先在浏览器的站点权限中改为允许。`;
  }
  const name = error && typeof error === 'object' && 'name' in error ? error.name : '';
  if (name === 'NotReadableError' || name === 'TrackStartError') {
    return '摄像头暂时被占用，请关闭其他使用摄像头的页面或应用，然后点击“重新获取摄像头权限”。';
  }
  if (name === 'NotFoundError' || name === 'OverconstrainedError') {
    return '未找到可用摄像头，请检查摄像头和浏览器权限，然后点击“重新获取摄像头权限”。';
  }
  return '摄像头暂时不可用，请点击“重新获取摄像头权限”后重试。';
}

export async function requestCameraStream(constraints: MediaStreamConstraints) {
  try {
    return await navigator.mediaDevices.getUserMedia(constraints);
  } catch (error) {
    const name = error && typeof error === 'object' && 'name' in error ? error.name : '';
    // Some mobile cameras reject resolution/facing constraints despite being
    // available. Permission denials must wait for an explicit user retry.
    if (name !== 'OverconstrainedError' && name !== 'NotFoundError') throw error;
    return navigator.mediaDevices.getUserMedia({ video: true, audio: constraints.audio });
  }
}
