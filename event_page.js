// === 설정 ===
const DEFAULT_MAX_RETRY = 5;
const RETRY_DELAY = 3000; // 3초

let maxRetry = DEFAULT_MAX_RETRY;
// 같은 이름의 파일이 있을 때 동작 ("uniquify": 001(1).jpg 처럼 새 이름, "overwrite": 덮어쓰기)
const DEFAULT_CONFLICT_ACTION = 'uniquify';
let conflictAction = DEFAULT_CONFLICT_ACTION;

// 0은 "재시도 안 함"을 뜻하는 유효한 값이므로 || 대신 NaN/음수일 때만 기본값 사용
function parseRetryCount(value) {
  const n = parseInt(value);
  return isNaN(n) || n < 0 ? DEFAULT_MAX_RETRY : n;
}

function parseConflictAction(value) {
  return value === 'overwrite' || value === 'uniquify' ? value : DEFAULT_CONFLICT_ACTION;
}

// storage에서 재시도 횟수 / 중복 파일 처리 방식 로드
chrome.storage.local.get(['numRetryCount', 'selConflictAction'], (data) => {
  if (data.numRetryCount !== undefined) {
    maxRetry = parseRetryCount(data.numRetryCount);
  }
  conflictAction = parseConflictAction(data.selConflictAction);
});

// storage 변경 시 동기화
chrome.storage.onChanged.addListener((changes, areaName) => {
  if (areaName !== 'local') return;
  if (changes.numRetryCount) {
    maxRetry = parseRetryCount(changes.numRetryCount.newValue);
  }
  if (changes.selConflictAction) {
    conflictAction = parseConflictAction(changes.selConflictAction.newValue);
  }
});


// === 배치 추적 시스템 ===
// batchId → { tabId, dispatched, notificationText, items: [ { url, filename, status, error, retryCount, downloadId } ] }
const batchMap = new Map();
// downloadId → { batchId, itemIndex }
const downloadToBatchMap = new Map();


//コンテキスト表示
chrome.contextMenus.create({
  id: "kemo",
  title: chrome.i18n.getMessage("context_menu_save_page"),
  type: "normal",
  contexts: ["page"],
  documentUrlPatterns: [
    "https://kemono.cr/*/user/*",
    "https://pawchive.st/*/user/*",
    "https://pawchive.pw/*/user/*"
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


// === 메시지 핸들러 ===
chrome.runtime.onMessage.addListener(function (request, sender) {
  const tabId = sender.tab?.id;

  if (request.type === "batch-start") {
    // 배치 등록
    batchMap.set(request.batchId, {
      tabId: tabId,
      dispatched: false,
      notificationText: request.notificationText || '',
      items: []
    });

  } else if (request.type === "download") {
    // 다운로드 실행 및 배치에 등록
    console.log(request.filename);
    downloadAndTrack(request.url, request.filename, request.batchId);

  } else if (request.type === "blob") {
    // Blob 다운로드 실행 및 배치에 등록
    console.log(request.filename);
    const blobUrl = URL.createObjectURL(request.blob);
    downloadAndTrack(blobUrl, request.filename, request.batchId);

  } else if (request.type === "batch-end") {
    // 배치 내 모든 다운로드 요청 전송 완료
    const batch = batchMap.get(request.batchId);
    if (batch) {
      batch.dispatched = true;
      checkBatchCompletion(request.batchId);
    }

  } else if (request.type === "set") {
    chrome.runtime.openOptionsPage(); //background.jsから発火する必要がある
  }

  return true;
});


// === 다운로드 실행 및 배치 추적 ===
async function downloadAndTrack(url, filename, batchId) {
  // download()는 비동기라 batch-end가 먼저 도착할 수 있으므로, await 전에 동기적으로 배치에 등록
  // (나중에 등록하면 완료 검사에서 누락되어 "0개 파일 완료" 같은 잘못된 알림이 뜸)
  const batch = batchId ? batchMap.get(batchId) : undefined;
  const item = {
    url: url,
    filename: filename,
    status: 'pending',
    error: null,
    retryCount: 0,
    downloadId: null
  };
  const itemIndex = batch ? batch.items.push(item) - 1 : -1;

  try {
    const downloadId = await browser.downloads.download({
      url: url,
      filename: filename,
      saveAs: false,
      conflictAction: conflictAction,
    });

    if (batch) {
      item.downloadId = downloadId;
      item.status = 'in_progress';
      downloadToBatchMap.set(downloadId, { batchId, itemIndex });
    }
  } catch (error) {
    console.error('Download start failed:', error);

    // 다운로드 시작 자체가 실패한 경우에도 배치에 기록
    if (batch) {
      item.status = 'failed';
      item.error = 'DOWNLOAD_START_FAILED';
      checkBatchCompletion(batchId);
    }
  }
}


// === 다운로드 상태 모니터링 ===
chrome.downloads.onChanged.addListener((delta) => {
  const mapping = downloadToBatchMap.get(delta.id);

  // 이 확장이 시작한 배치 다운로드가 아니면 무시
  if (!mapping) return;

  const { batchId, itemIndex } = mapping;
  const batch = batchMap.get(batchId);
  if (!batch) return;

  const item = batch.items[itemIndex];
  if (!item) return;

  // ✅ 성공 완료
  if (delta.state?.current === 'complete') {
    item.status = 'complete';
    downloadToBatchMap.delete(delta.id);
    checkBatchCompletion(batchId);
    return;
  }

  // ❌ 에러 또는 중단 발생
  if (delta.error?.current) {
    const errorReason = delta.error.current;

    // 사용자가 의도적으로 취소한 경우 → 재시도하지 않음
    if (errorReason === 'USER_CANCELED') {
      item.status = 'failed';
      item.error = 'USER_CANCELED';
      downloadToBatchMap.delete(delta.id);
      checkBatchCompletion(batchId);
      return;
    }

    // 그 외 에러 → 재시도
    if (item.retryCount < maxRetry) {
      item.retryCount++;
      item.status = 'retrying';

      // 기존 매핑 제거 (새 downloadId로 교체 예정)
      downloadToBatchMap.delete(delta.id);

      setTimeout(async () => {
        try {
          const newDownloadId = await browser.downloads.download({
            url: item.url,
            filename: item.filename,
            saveAs: false,
            conflictAction: conflictAction,
          });

          // 새 downloadId로 매핑 갱신
          item.downloadId = newDownloadId;
          item.status = 'in_progress';
          downloadToBatchMap.set(newDownloadId, { batchId, itemIndex });
        } catch (error) {
          // 재시도 다운로드 시작 자체가 실패
          item.status = 'failed';
          item.error = errorReason;
          checkBatchCompletion(batchId);
        }
      }, RETRY_DELAY);
    } else {
      // 재시도 횟수 초과 → 실패 확정
      item.status = 'failed';
      item.error = errorReason;
      downloadToBatchMap.delete(delta.id);
      checkBatchCompletion(batchId);
    }
  }
});


// === 배치 완료 검사 ===
function checkBatchCompletion(batchId) {
  const batch = batchMap.get(batchId);
  if (!batch || !batch.dispatched) return;

  const items = batch.items;
  const allDone = items.every(item =>
    item.status === 'complete' || item.status === 'failed'
  );

  if (!allDone) return;

  // 결과 집계
  const total = items.length;
  const success = items.filter(i => i.status === 'complete').length;
  const failed = items.filter(i => i.status === 'failed').length;
  const failedItems = items
    .filter(i => i.status === 'failed')
    .map(i => ({ url: i.url, filename: i.filename, error: i.error }));

  // 콘텐츠 스크립트에 결과 전송 (토스트 알림 표시용)
  if (batch.tabId) {
    chrome.tabs.sendMessage(batch.tabId, {
      type: "batch-result",
      batchId: batchId,
      total: total,
      success: success,
      failed: failed,
      failedItems: failedItems,
      notificationText: batch.notificationText
    }).catch(() => {
      // 탭이 닫혀있을 경우 OS 알림으로 대체
      showOSNotification(total, success, failed, batch.notificationText);
    });
  } else {
    showOSNotification(total, success, failed, batch.notificationText);
  }

  // 배치 정리 (메모리 해제)
  cleanupBatch(batchId);
}


// === OS 알림 (탭이 닫혀있을 경우 대체) ===
function showOSNotification(total, success, failed, notificationText) {
  if (typeof browser === 'undefined' || !browser.notifications) return;

  let title, stats;
  if (total === 0) {
    title = chrome.i18n.getMessage("notify_batch_empty_title");
    stats = '';
  } else if (failed === 0) {
    title = chrome.i18n.getMessage("notify_batch_complete_title");
    stats = chrome.i18n.getMessage("notify_batch_stats_success", [total.toString()]);
  } else {
    // 전부 실패했으면 "일부 실패"가 아닌 "실패" 제목 사용
    title = chrome.i18n.getMessage(success > 0 ? "notify_batch_partial_fail_title" : "notify_batch_failed_title");
    stats = chrome.i18n.getMessage("notify_batch_stats_partial", [success.toString(), total.toString(), failed.toString()]);
  }

  // 어느 게시글의 결과인지 알 수 있도록 알림 문구를 함께 표시
  browser.notifications.create({
    type: "basic",
    iconUrl: "icon_48.png",
    title: title,
    message: [notificationText, stats].filter(Boolean).join("\n")
  });
}


// === 배치 정리 ===
function cleanupBatch(batchId) {
  const batch = batchMap.get(batchId);
  if (batch) {
    for (const item of batch.items) {
      if (item.downloadId !== null) {
        downloadToBatchMap.delete(item.downloadId);
      }
    }
    batchMap.delete(batchId);
  }
}