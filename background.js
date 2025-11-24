chrome.runtime.onMessage.addListener((message, sender, sendResponse) => {
  if (message.action === 'downloadImage') {
    const { url, filename } = message;
    // downloads.download は Promise を返す（callbackも可）
    chrome.downloads.download({
      url: url,
      filename: filename || undefined,
      conflictAction: 'uniquify', // 同名は自動で別名に
      saveAs: false
    }, downloadId => {
      if (chrome.runtime.lastError) {
        console.error('Download failed:', chrome.runtime.lastError);
        sendResponse({ success: false, error: chrome.runtime.lastError.message });
      } else {
        sendResponse({ success: true, downloadId });
      }
    });
    // sendResponse を非同期で使うため true を返す
    return true;
  }
});
