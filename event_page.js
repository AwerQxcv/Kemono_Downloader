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

//選択時のイベント
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
  chrome.downloads.download({
    url: url,
    filename: filename,
    saveAs: false,
  });
}