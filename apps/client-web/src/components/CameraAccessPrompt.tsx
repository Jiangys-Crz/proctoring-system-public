'use client';

import { useEffect, useId, useRef } from 'react';
import { Camera, RefreshCw } from 'lucide-react';

export default function CameraAccessPrompt({ message, onRetry, onDismiss }: {
  message: string;
  onRetry?: () => void;
  onDismiss: () => void;
}) {
  const dialogRef = useRef<HTMLDialogElement>(null);
  const titleId = useId();
  const messageId = useId();

  useEffect(() => {
    const dialog = dialogRef.current;
    if (!dialog) return;
    if (typeof dialog.showModal === 'function') dialog.showModal();
    else dialog.setAttribute('open', '');
    return () => dialog.close?.();
  }, []);

  return (
    <dialog ref={dialogRef} className="camera-access-prompt" role="alertdialog" aria-labelledby={titleId} aria-describedby={messageId}
      onCancel={event => { event.preventDefault(); onDismiss(); }}>
      <Camera size={36} />
      <h2 id={titleId}>重新获取摄像头权限</h2>
      <p id={messageId}>{message}</p>
      {onRetry ? <p>点击下方按钮重新请求授权，在浏览器弹出的权限窗口中选择“允许”。如果没有出现权限窗口，请在地址栏的站点权限中允许摄像头；录制环境视频还需允许麦克风。若仍无法开启，请在手机设置中允许当前浏览器使用相机和麦克风。</p> : null}
      <div className="camera-access-actions">
        <button className="secondary" type="button" onClick={onDismiss}>{onRetry ? '暂不重试' : '我知道了'}</button>
        {onRetry ? <button className="primary" type="button" autoFocus onClick={onRetry}><RefreshCw size={18} />重新获取摄像头权限</button> : null}
      </div>
    </dialog>
  );
}
