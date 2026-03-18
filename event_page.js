//コンテキスト表示
chrome.contextMenus.create({
  id: "kemo",
  title: chrome.i18n.getMessage("context_menu_save_page"),
  type: "normal",
  contexts: ["page"],
  documentUrlPatterns: [
    "https://kemono.cr/*/post/*"
  ]
});

// 選択時のイベント
chrome.contextMenus.onClicked.addListener(function (info, tab) {
  chrome.tabs.query({ active: true, currentWindow: true }, function (tabs) {
    chrome.tabs.sendMessage(tabs[0].id, { message: "getImage" });
  });
});


// 단축키 추가
browser.commands.onCommand.addListener((command) => {
    if (command === "download") {
    browser.tabs.query({ active: true, currentWindow: true }, function (tabs) {
      browser.tabs.sendMessage(tabs[0].id, { message: "getImage" });
    });
  }
});

// 업데이트 / 설치 시 표시되는 팝업 창
browser.runtime.onInstalled.addListener((details) => {
  if (details.reason === 'update') {
    details.previousVersion
    
    // 방법 A: 새 탭 열기
    browser.tabs.create({ url: `update-notes.html?prev=${details.previousVersion}` });
  }
});

//直リンに出来ない物は一度storageに投げた方がよさそう
chrome.runtime.onMessage.addListener(function (request) {
  if (request.type == "download") {
    console.log(request.filename);
    download(request.url, request.filename);
  } else if (request.type == "blob") {
    console.log(request.filename);
    const blob = URL.createObjectURL(request.blob);
    download(blob, request.filename);
  } else if (request.type == "set") {
    chrome.runtime.openOptionsPage(); //background.jsから発火する必要がある
  }
  return true;
});

function download(url, filename) {
  browser.downloads.download({
    url: url,
    filename: filename,
    saveAs: false,
  });
}


// 다운로드 실패 시 재시도 기능 구현
const retryMap = new Map(); // 다운로드 ID별 재시도 횟수 관리

chrome.downloads.onChanged.addListener((delta) => {
  if (delta.error && delta.error.current) {
    chrome.downloads.search({ id: delta.id }, ([item]) => {
      if (!item) return;

      const retryCount = retryMap.get(delta.id) ?? 0;

      if (retryCount >= 1000) {
        // 1000회 초과 시 포기
        retryMap.delete(delta.id);
        return;
      }

      retryMap.set(delta.id, retryCount + 1);

      // 5초 후 재시도
      setTimeout(() => {
        if (item.canResume) {
          chrome.downloads.resume(delta.id);
        } else {
          download(item.url, item.filename);
        }
      }, 5000);
    });
  }

  // 완료되면 재시도 카운트 정리
  if (delta.state?.current === 'complete') {
    retryMap.delete(delta.id);
  }
});