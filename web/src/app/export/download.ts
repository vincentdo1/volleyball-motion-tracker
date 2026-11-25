/** Hands a blob to the browser's download flow. */
export function saveBlob(blob: Blob, fileName: string): void {
  const url = URL.createObjectURL(blob);
  const link = document.createElement('a');
  link.href = url;
  link.download = fileName;
  document.body.append(link);
  link.click();
  link.remove();
  // the download has started shortly; revoking at once can cancel it in some browsers
  setTimeout(() => URL.revokeObjectURL(url), 30_000);
}
