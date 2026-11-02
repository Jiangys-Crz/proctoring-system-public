/** Keep the object URL alive until the browser / desktop has started saving it. */
export function saveDownloadBlob(blob: Blob, name: string) {
  const url = URL.createObjectURL(blob);
  const anchor = document.createElement('a');
  anchor.href = url; anchor.download = name;
  document.body.appendChild(anchor);
  anchor.click(); anchor.remove();
  window.setTimeout(() => URL.revokeObjectURL(url), 30_000);
}
