// === 설정 ===
const DEFAULT_MAX_RETRY = 5;
const RETRY_DELAY = 3000; // 3초

let maxRetry = DEFAULT_MAX_RETRY;
// 같은 이름의 파일이 있을 때 동작 ("uniquify": 001(1).jpg 처럼 새 이름, "overwrite": 덮어쓰기)
const DEFAULT_CONFLICT_ACTION = 'uniquify';
let conflictAction = DEFAULT_CONFLICT_ACTION;
// 동시에 진행할 최대 다운로드 수 (0은 제한 없음, 1이면 하나가 끝나야 다음 파일 시작)
const DEFAULT_MAX_CONCURRENT = 0;
let maxConcurrent = DEFAULT_MAX_CONCURRENT;
// 이미 받은 파일 건너뛰기 방식
//   "off": 건너뛰지 않음
//   "record": 확장이 직접 남긴 기록(downloadedFiles) 기준. 성공하면 기록하고 실패하면 지움 (기록은 방식과 상관없이 항상 남김)
//   "history": 브라우저 다운로드 기록에 같은 경로로 완료된 다운로드가 있고 파일이 아직 남아 있으면 건너뜀
const SKIP_MODES = ['off', 'record', 'history'];
let skipMode = 'off';
const downloadedFiles = new Set();
// 게시글별 마지막 다운로드 결과 { "service/user/post": { status: 'complete' | 'partial' | 'failed', time } }
// 게시글 / 작가 페이지에서 받은 적 있는지 표시할 때 사용
const downloadedPosts = new Map();
let saveRecordsTimer = null;

// 0은 "재시도 안 함"을 뜻하는 유효한 값이므로 || 대신 NaN/음수일 때만 기본값 사용
function parseRetryCount(value) {
  const n = parseInt(value);
  return isNaN(n) || n < 0 ? DEFAULT_MAX_RETRY : n;
}

function parseMaxConcurrent(value) {
  const n = parseInt(value);
  return isNaN(n) || n < 0 ? DEFAULT_MAX_CONCURRENT : n;
}

function parseSkipMode(value) {
  return SKIP_MODES.includes(value) ? value : 'off';
}

function parseConflictAction(value) {
  return value === 'overwrite' || value === 'uniquify' ? value : DEFAULT_CONFLICT_ACTION;
}

// storage에서 재시도 횟수 / 중복 파일 처리 방식 / 최대 동시 다운로드 수 로드
chrome.storage.local.get(['numRetryCount', 'selConflictAction', 'numMaxConcurrent', 'selSkipDownloaded', 'downloadedFiles', 'downloadedPosts'], (data) => {
  if (data.numRetryCount !== undefined) {
    maxRetry = parseRetryCount(data.numRetryCount);
  }
  conflictAction = parseConflictAction(data.selConflictAction);
  maxConcurrent = parseMaxConcurrent(data.numMaxConcurrent);
  skipMode = parseSkipMode(data.selSkipDownloaded);
  mergeDownloadedFiles(data.downloadedFiles);
  mergeDownloadedPosts(data.downloadedPosts);
  pumpQueue();
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
  if (changes.selSkipDownloaded) {
    skipMode = parseSkipMode(changes.selSkipDownloaded.newValue);
  }
  // 설정 페이지의 "기록 지우기"는 빈 값을, "기록 가져오기"는 합친 기록을 저장함
  // (자기가 저장한 값도 여기로 오지만 이미 가진 항목이라 합쳐도 그대로)
  if (changes.downloadedFiles) {
    const files = changes.downloadedFiles.newValue;
    if (Array.isArray(files) && files.length === 0) downloadedFiles.clear();
    else mergeDownloadedFiles(files);
  }
  if (changes.downloadedPosts) {
    const posts = changes.downloadedPosts.newValue;
    if (posts && typeof posts === 'object' && Object.keys(posts).length === 0) downloadedPosts.clear();
    else mergeDownloadedPosts(posts);
  }
  if (changes.numMaxConcurrent) {
    maxConcurrent = parseMaxConcurrent(changes.numMaxConcurrent.newValue);
    pumpQueue(); // 제한이 늘어났으면 대기 중인 파일을 바로 시작
  }
});


// === 배치 추적 시스템 ===
// batchId → { tabId, dispatched, notificationText, items: [ { url, filename, status, error, retryCount, downloadId } ] }
const batchMap = new Map();
// downloadId → item (item.batchId로 배치를 찾음. 배치가 없는 다운로드도 동시 다운로드 수 관리를 위해 등록)
const downloadToItemMap = new Map();

// === 다운로드 대기열 ===
// maxConcurrent개까지만 동시에 진행하고, 나머지는 여기서 기다렸다가 앞의 파일이 끝나면 시작
const downloadQueue = [];
let activeDownloads = 0; // 자리를 차지하고 있는 항목 수 (시작 중, 진행 중, 재시도 대기 중)


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
      postKey: request.postKey || null, // "service/user/post" (게시글별 기록용)
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


// === 받은 파일 기록 ===
// 저장 경로 기준 (Windows는 대소문자를 구분하지 않고 구분자가 \\ 일 수 있으므로 통일)
function downloadedKey(filename) {
  return filename.replace(/\\/g, '/').toLowerCase();
}

function mergeDownloadedFiles(files) {
  if (!Array.isArray(files)) return;
  for (const key of files) {
    if (typeof key === 'string') downloadedFiles.add(key);
  }
}

// 같은 게시글이면 더 나중 기록을 남김
function mergeDownloadedPosts(posts) {
  if (!posts || typeof posts !== 'object') return;
  for (const [key, record] of Object.entries(posts)) {
    if (!record || typeof record.status !== 'string') continue;
    const current = downloadedPosts.get(key);
    if (!current || (record.time || 0) > (current.time || 0)) downloadedPosts.set(key, record);
  }
}

// 파일마다 저장하면 일괄 다운로드 때 너무 자주 쓰므로 모아서 저장
function scheduleSaveRecords() {
  clearTimeout(saveRecordsTimer);
  saveRecordsTimer = setTimeout(() => {
    chrome.storage.local.set({
      downloadedFiles: Array.from(downloadedFiles),
      downloadedPosts: Object.fromEntries(downloadedPosts),
    });
  }, 1000);
}

function markDownloaded(filename, done) {
  const key = downloadedKey(filename);
  if (done ? downloadedFiles.has(key) : !downloadedFiles.has(key)) return;
  if (done) downloadedFiles.add(key);
  else downloadedFiles.delete(key);
  scheduleSaveRecords();
}

// 게시글 하나(배치)의 결과 기록. 받을 파일이 없던 게시글은 기록하지 않음
function markPost(postKey, success, failed) {
  const status = failed === 0 ? 'complete' : success > 0 ? 'partial' : 'failed';
  downloadedPosts.set(postKey, { status: status, time: Date.now() });
  scheduleSaveRecords();
}


// 브라우저 다운로드 기록에서 같은 저장 경로로 완료됐고 파일이 아직 있는 다운로드를 찾음
// DownloadItem.filename은 다운로드 폴더를 포함한 전체 경로이므로 끝부분이 저장 경로와 같은지 비교
async function existsInBrowserHistory(filename) {
  const key = downloadedKey(filename);
  const normalized = filename.replace(/\\/g, '/');
  const baseName = normalized.substring(normalized.lastIndexOf('/') + 1);
  try {
    const results = await browser.downloads.search({ query: [baseName], state: 'complete' });
    return results.some((d) => d.exists !== false && downloadedKey(d.filename).endsWith('/' + key));
  } catch (error) {
    console.warn('Download history search failed:', error);
    return false;
  }
}

async function isAlreadyDownloaded(filename) {
  if (skipMode === 'record') return downloadedFiles.has(downloadedKey(filename));
  if (skipMode === 'history') return existsInBrowserHistory(filename);
  return false;
}


// === 다운로드 실행 및 배치 추적 ===
async function downloadAndTrack(url, filename, batchId) {
  // download()는 비동기라 batch-end가 먼저 도착할 수 있으므로, 대기열에 넣기 전에 동기적으로 배치에 등록
  // (나중에 등록하면 완료 검사에서 누락되어 "0개 파일 완료" 같은 잘못된 알림이 뜸)
  const batch = batchId ? batchMap.get(batchId) : undefined;
  const item = {
    url: url,
    filename: filename,
    batchId: batch ? batchId : null,
    status: 'queued',
    error: null,
    retryCount: 0,
    downloadId: null,
    holdsSlot: false
  };
  if (batch) batch.items.push(item);

  // 이미 받은 파일이면 다운로드하지 않고 성공으로 처리
  // (확인하는 동안에도 항목은 'queued' 상태로 배치에 있으므로 배치가 먼저 끝나지 않음)
  if (await isAlreadyDownloaded(filename)) {
    item.status = 'complete';
    item.skipped = true;
    if (item.batchId) checkBatchCompletion(item.batchId);
    return;
  }

  downloadQueue.push(item);
  pumpQueue();
}

// 자리가 남아 있는 만큼 대기열의 파일을 시작
function pumpQueue() {
  while (downloadQueue.length > 0 && (maxConcurrent === 0 || activeDownloads < maxConcurrent)) {
    const item = downloadQueue.shift();
    item.holdsSlot = true;
    activeDownloads++;
    startDownload(item);
  }
}

async function startDownload(item) {
  item.status = 'starting';
  let downloadId;
  try {
    downloadId = await browser.downloads.download({
      url: item.url,
      filename: item.filename,
      saveAs: false,
      conflictAction: conflictAction,
    });
  } catch (error) {
    console.error('Download start failed:', error);
    // 다운로드 시작 자체가 실패한 경우에도 배치에 기록
    finishItem(item, 'failed', item.retryCount > 0 ? item.error : 'DOWNLOAD_START_FAILED');
    return;
  }

  item.downloadId = downloadId;
  item.status = 'in_progress';
  downloadToItemMap.set(downloadId, item);

  // 서버가 바로 오류를 주면 onChanged가 위 매핑 등록보다 먼저 와서 무시될 수 있음.
  // 그러면 항목이 영원히 "진행 중"으로 남아 배치가 끝나지 않으므로, 등록 직후 현재 상태를 한 번 확인
  try {
    const [info] = await browser.downloads.search({ id: downloadId });
    if (info && info.state === 'complete') {
      handleDownloadComplete(downloadId);
    } else if (info && info.state === 'interrupted') {
      handleDownloadError(downloadId, info.error || 'INTERRUPTED');
    }
  } catch (error) {
    console.warn('Download state check failed:', error);
  }
}

// 항목을 완료/실패로 확정하고, 차지하던 자리를 비워 다음 파일을 시작
function finishItem(item, status, error = null) {
  item.status = status;
  item.error = error;
  markDownloaded(item.filename, status === 'complete');
  if (item.downloadId !== null) downloadToItemMap.delete(item.downloadId);
  if (item.holdsSlot) {
    item.holdsSlot = false;
    activeDownloads--;
  }
  if (item.batchId) checkBatchCompletion(item.batchId);
  pumpQueue();
}

// ✅ 성공 완료. onChanged와 startDownload의 상태 확인 양쪽에서 불릴 수 있으므로,
// 매핑이 이미 지워졌으면(먼저 처리됨) 아무것도 하지 않음
function handleDownloadComplete(downloadId) {
  const item = downloadToItemMap.get(downloadId);
  if (!item) return;
  finishItem(item, 'complete');
}

// ❌ 에러 또는 중단 발생
function handleDownloadError(downloadId, errorReason) {
  const item = downloadToItemMap.get(downloadId);
  if (!item) return;

  // 사용자가 의도적으로 취소한 경우 → 재시도하지 않음
  if (errorReason === 'USER_CANCELED') {
    finishItem(item, 'failed', 'USER_CANCELED');
    return;
  }

  // 그 외 에러 → 재시도 (자리는 그대로 차지한 채 기다림)
  if (item.retryCount < maxRetry) {
    item.retryCount++;
    item.status = 'retrying';
    item.error = errorReason;

    // 기존 매핑 제거 (새 downloadId로 교체 예정)
    downloadToItemMap.delete(downloadId);
    item.downloadId = null;

    setTimeout(() => startDownload(item), RETRY_DELAY);
  } else {
    // 재시도 횟수 초과 → 실패 확정
    finishItem(item, 'failed', errorReason);
  }
}


// === 다운로드 상태 모니터링 ===
chrome.downloads.onChanged.addListener((delta) => {
  // 이 확장이 시작한 다운로드가 아니면 handle 함수들이 무시함
  if (delta.state?.current === 'complete') {
    handleDownloadComplete(delta.id);
  } else if (delta.error?.current || delta.state?.current === 'interrupted') {
    // 중단 상태인데 오류 사유가 같이 오지 않는 경우도 실패로 처리
    handleDownloadError(delta.id, delta.error?.current || 'INTERRUPTED');
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

  if (batch.postKey && total > 0) markPost(batch.postKey, success, failed);

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
        downloadToItemMap.delete(item.downloadId);
      }
    }
    batchMap.delete(batchId);
  }
}