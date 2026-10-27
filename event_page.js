// === 설정 ===
const DEFAULT_MAX_RETRY = 5;
const RETRY_DELAY = 3000; // 3초
// 시작 후 이 시간 동안 한 바이트도 못 받으면 서버가 응답하지 않는 것으로 보고 취소 후 다시 시도
const NO_RESPONSE_TIMEOUT = 30000; // 30초
// 받는 도중 받은 양이 이 시간 동안 그대로면 멈춘 다운로드로 보고 취소 후 다시 시도
const STALL_TIMEOUT = 60000; // 1분
const STALL_CHECK_INTERVAL = 5000; // 5초마다 확인
const STATUS_LOG_INTERVAL = 15000; // 상태 로그는 15초마다만

// 콘솔 디버그 로그 (문제 확인용, about:debugging → 이 확장 → 검사). 끄려면 false
const DEBUG_LOG = true;
function debugLog(...args) {
  if (DEBUG_LOG) console.log('[KD-BG]', ...args);
}

let maxRetry = DEFAULT_MAX_RETRY;
// 같은 이름의 파일이 있을 때 동작 ("uniquify": 001(1).jpg 처럼 새 이름, "overwrite": 덮어쓰기)
const DEFAULT_CONFLICT_ACTION = 'uniquify';
let conflictAction = DEFAULT_CONFLICT_ACTION;
// 동시에 진행할 최대 다운로드 수 (1~5. 1이면 하나가 끝나야 다음 파일 시작)
// 너무 많이 동시에 받으면 서버가 응답을 끊는 경우가 많아 최대 5개로 제한
const DEFAULT_MAX_CONCURRENT = 3;
const MAX_CONCURRENT_LIMIT = 5;
let maxConcurrent = DEFAULT_MAX_CONCURRENT;
// 이미 받은 파일 건너뛰기 방식
//   "off": 건너뛰지 않음
//   "record": 확장이 직접 남긴 기록(f: 항목) 기준. 성공하면 기록하고 실패하면 지움 (기록은 방식과 상관없이 항상 남김)
//   "history": 브라우저 다운로드 기록에 같은 경로로 완료된 다운로드가 있고 파일이 아직 남아 있으면 건너뜀
const SKIP_MODES = ['off', 'record', 'history'];
let skipMode = 'off';
const downloadedFiles = new Set();
// 받은 파일 / 게시글 기록은 항목마다 따로 저장함 (기록이 수천 개여도 바뀐 것만 쓰고, 다른 탭에도 바뀐 것만 전달되도록)
//   "f:<저장 경로>" = 1
//   "p:<service/user/post>" = { status: 'complete' | 'partial' | 'failed', time }  게시글별 마지막 다운로드 결과
// 예전 버전은 downloadedFiles(배열) / downloadedPosts(객체) 한 덩어리로 저장했으므로 처음 실행할 때 옮김
const FILE_RECORD_PREFIX = 'f:';
const POST_RECORD_PREFIX = 'p:';
const pendingRecordWrites = {};
const pendingRecordRemovals = new Set();
let saveRecordsTimer = null;

// 0은 "재시도 안 함"을 뜻하는 유효한 값이므로 || 대신 NaN/음수일 때만 기본값 사용
function parseRetryCount(value) {
  const n = parseInt(value);
  return isNaN(n) || n < 0 ? DEFAULT_MAX_RETRY : n;
}

// 예전 설정의 0(제한 없음)이나 5보다 큰 값은 5로
function parseMaxConcurrent(value) {
  const n = parseInt(value);
  if (isNaN(n) || n < 0) return DEFAULT_MAX_CONCURRENT;
  return n === 0 ? MAX_CONCURRENT_LIMIT : Math.min(n, MAX_CONCURRENT_LIMIT);
}

function parseSkipMode(value) {
  return SKIP_MODES.includes(value) ? value : 'off';
}

function parseConflictAction(value) {
  return value === 'overwrite' || value === 'uniquify' ? value : DEFAULT_CONFLICT_ACTION;
}

// storage에서 재시도 횟수 / 중복 파일 처리 방식 / 최대 동시 다운로드 수 로드
chrome.storage.local.get(null, (data) => {
  if (data.numRetryCount !== undefined) {
    maxRetry = parseRetryCount(data.numRetryCount);
  }
  conflictAction = parseConflictAction(data.selConflictAction);
  maxConcurrent = parseMaxConcurrent(data.numMaxConcurrent);
  skipMode = parseSkipMode(data.selSkipDownloaded);
  for (const key of Object.keys(data)) {
    if (key.startsWith(FILE_RECORD_PREFIX)) downloadedFiles.add(key.substring(FILE_RECORD_PREFIX.length));
  }
  migrateOldRecords(data);
  debugLog(`받은 파일 기록 ${downloadedFiles.size}개 불러옴`);
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
  // 설정 페이지의 "기록 지우기"(삭제)와 "기록 가져오기"(추가)를 반영
  // (자기가 저장한 항목도 여기로 오지만 이미 같은 상태라 그대로)
  for (const [key, change] of Object.entries(changes)) {
    if (!key.startsWith(FILE_RECORD_PREFIX)) continue;
    const fileKey = key.substring(FILE_RECORD_PREFIX.length);
    if (change.newValue === undefined) downloadedFiles.delete(fileKey);
    else downloadedFiles.add(fileKey);
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
chrome.runtime.onMessage.addListener(function (request, sender, sendResponse) {
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
    downloadAndTrack(request.url, request.filename, request.batchId, request.isText === true);

  } else if (request.type === "blob") {
    // Blob 다운로드 실행 및 배치에 등록
    const blobUrl = URL.createObjectURL(request.blob);
    downloadAndTrack(blobUrl, request.filename, request.batchId, request.isText === true);

  } else if (request.type === "batch-end") {
    // 배치 내 모든 다운로드 요청 전송 완료
    const batch = batchMap.get(request.batchId);
    if (batch) {
      batch.dispatched = true;
      checkBatchCompletion(request.batchId);
    }

  } else if (request.type === "queue-status") {
    // 작가 일괄 다운로드가 대기열이 줄 때까지 다음 게시글을 미루는 데 사용
    sendResponse({ queued: downloadQueue.length, active: activeDownloads });

  } else if (request.type === "cancel-batches") {
    // 작가 일괄 다운로드 취소: 해당 배치의 남은 파일을 모두 취소
    cancelBatches(request.batchIds || []);

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

// 예전 한 덩어리 기록(downloadedFiles 배열, downloadedPosts 객체)을 항목별 키로 옮기고 지움
function migrateOldRecords(data) {
  const writes = {};
  if (Array.isArray(data.downloadedFiles)) {
    for (const fileKey of data.downloadedFiles) {
      if (typeof fileKey !== 'string') continue;
      downloadedFiles.add(fileKey);
      writes[FILE_RECORD_PREFIX + fileKey] = 1;
    }
  }
  if (data.downloadedPosts && typeof data.downloadedPosts === 'object') {
    for (const [postKey, record] of Object.entries(data.downloadedPosts)) {
      if (record && typeof record.status === 'string') writes[POST_RECORD_PREFIX + postKey] = record;
    }
  }
  if (data.downloadedFiles === undefined && data.downloadedPosts === undefined) return;
  debugLog(`예전 기록 옮김: ${Object.keys(writes).length}개`);
  chrome.storage.local.set(writes, () => {
    chrome.storage.local.remove(['downloadedFiles', 'downloadedPosts']);
  });
}

// 파일마다 저장하면 일괄 다운로드 때 너무 자주 쓰므로 바뀐 항목만 모아서 저장
function scheduleSaveRecords() {
  if (saveRecordsTimer) return;
  saveRecordsTimer = setTimeout(() => {
    saveRecordsTimer = null;
    const writes = Object.assign({}, pendingRecordWrites);
    const removals = Array.from(pendingRecordRemovals);
    for (const key of Object.keys(pendingRecordWrites)) delete pendingRecordWrites[key];
    pendingRecordRemovals.clear();
    if (Object.keys(writes).length > 0) chrome.storage.local.set(writes);
    if (removals.length > 0) chrome.storage.local.remove(removals);
  }, 2000);
}

function writeRecord(key, value) {
  pendingRecordRemovals.delete(key);
  pendingRecordWrites[key] = value;
  scheduleSaveRecords();
}

function removeRecord(key) {
  delete pendingRecordWrites[key];
  pendingRecordRemovals.add(key);
  scheduleSaveRecords();
}

function markDownloaded(filename, done) {
  const key = downloadedKey(filename);
  if (done ? downloadedFiles.has(key) : !downloadedFiles.has(key)) return;
  if (done) {
    downloadedFiles.add(key);
    writeRecord(FILE_RECORD_PREFIX + key, 1);
  } else {
    downloadedFiles.delete(key);
    removeRecord(FILE_RECORD_PREFIX + key);
  }
}

// 게시글 하나(배치)의 결과 기록. 받을 파일이 없던 게시글은 기록하지 않음
function markPost(postKey, success, failed) {
  const status = failed === 0 ? 'complete' : success > 0 ? 'partial' : 'failed';
  writeRecord(POST_RECORD_PREFIX + postKey, { status: status, time: Date.now() });
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
async function downloadAndTrack(url, filename, batchId, isText = false) {
  // download()는 비동기라 batch-end가 먼저 도착할 수 있으므로, 대기열에 넣기 전에 동기적으로 배치에 등록
  // (나중에 등록하면 완료 검사에서 누락되어 "0개 파일 완료" 같은 잘못된 알림이 뜸)
  const batch = batchId ? batchMap.get(batchId) : undefined;
  const item = {
    url: url,
    filename: filename,
    batchId: batch ? batchId : null,
    isText: isText, // 게시글 본문 텍스트 파일
    status: 'queued',
    error: null,
    retryCount: 0,
    downloadId: null,
    holdsSlot: false
  };
  if (batch) batch.items.push(item);

  // 이미 취소된 배치에 늦게 도착한 파일
  if (batch && batch.cancelled) {
    item.cancelled = true;
    finishItem(item, 'cancelled', 'CANCELLED');
    return;
  }

  // 이미 받은 파일이면 다운로드하지 않고 성공으로 처리
  // (확인하는 동안에도 항목은 'queued' 상태로 배치에 있으므로 배치가 먼저 끝나지 않음)
  const alreadyDownloaded = await isAlreadyDownloaded(filename);
  if (item.cancelled) return; // 확인하는 동안 취소됨 (cancelItem에서 이미 처리)
  if (alreadyDownloaded) {
    debugLog(`건너뜀 (이미 받음): ${filename}`);
    item.status = 'complete';
    item.skipped = true;
    if (item.batchId) checkBatchCompletion(item.batchId);
    return;
  }

  downloadQueue.push(item);
  debugLog(`대기열 추가: ${filename} (대기 ${downloadQueue.length}개, 진행 ${activeDownloads}/${maxConcurrent})`);
  pumpQueue();
}

// 배치들의 남은 파일을 취소. 앞으로 이 배치로 들어오는 파일도 바로 취소됨
function cancelBatches(batchIds) {
  debugLog(`배치 ${batchIds.length}개 취소 요청`);
  for (const batchId of batchIds) {
    const batch = batchMap.get(batchId);
    if (!batch) continue;
    batch.cancelled = true;
    // finishItem → cleanupBatch가 batch.items를 지울 수 있으므로 복사본으로 순회
    for (const item of batch.items.slice()) cancelItem(item);
  }
}

function cancelItem(item) {
  if (item.status === 'complete' || item.status === 'failed' || item.status === 'cancelled') return;
  item.cancelled = true;
  if (item.status === 'queued' || item.status === 'retrying') {
    // 아직 시작 전이거나 재시도 대기 중 → 바로 취소 처리
    const index = downloadQueue.indexOf(item);
    if (index !== -1) downloadQueue.splice(index, 1);
    finishItem(item, 'cancelled', 'CANCELLED');
  } else if (item.status === 'in_progress' && item.downloadId !== null) {
    // 진행 중 → 브라우저 다운로드를 취소. onChanged(USER_CANCELED)에서 취소로 확정됨
    browser.downloads.cancel(item.downloadId).catch((error) => {
      console.warn('Download cancel failed:', error);
      finishItem(item, 'cancelled', 'CANCELLED');
    });
  }
  // 'starting'은 download()가 끝난 뒤 startDownload에서 취소함
}

// 자리가 남아 있는 만큼 대기열의 파일을 시작
function pumpQueue() {
  while (downloadQueue.length > 0 && activeDownloads < maxConcurrent) {
    const item = downloadQueue.shift();
    item.holdsSlot = true;
    activeDownloads++;
    startDownload(item);
  }
}

async function startDownload(item) {
  // 재시도 대기 중에 취소된 경우
  if (item.cancelled) {
    if (item.status !== 'cancelled') finishItem(item, 'cancelled', 'CANCELLED');
    return;
  }
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
    if (item.cancelled) finishItem(item, 'cancelled', 'CANCELLED');
    else finishItem(item, 'failed', item.retryCount > 0 ? item.error : 'DOWNLOAD_START_FAILED');
    return;
  }

  item.downloadId = downloadId;
  item.status = 'in_progress';
  item.lastBytes = 0;
  item.lastProgressAt = Date.now();
  downloadToItemMap.set(downloadId, item);
  debugLog(`시작 #${downloadId}: ${item.filename}${item.retryCount > 0 ? ` (재시도 ${item.retryCount}/${maxRetry})` : ''}`);

  // 시작하는 동안 취소됨 → 바로 취소 (onChanged에서 취소로 확정)
  if (item.cancelled) {
    browser.downloads.cancel(downloadId).catch(() => finishItem(item, 'cancelled', 'CANCELLED'));
    return;
  }

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
  debugLog(`${status === 'complete' ? '완료' : status === 'cancelled' ? '취소' : '실패'}${item.downloadId !== null ? ` #${item.downloadId}` : ''}: ${item.filename}${error ? ` (${error})` : ''}`);
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

  // 일괄 다운로드 취소 → 재시도하지 않고 취소로 확정
  if (item.cancelled) {
    finishItem(item, 'cancelled', 'CANCELLED');
    return;
  }

  // 멈춰서 확장이 직접 취소한 경우 → 아래에서 재시도
  if (item.stalled) {
    item.stalled = false;
    errorReason = 'STALLED';
  } else if (errorReason === 'USER_CANCELED') {
    // 사용자가 의도적으로 취소한 경우 → 재시도하지 않음
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

    debugLog(`오류 #${downloadId}: ${item.filename} (${errorReason}) → ${RETRY_DELAY / 1000}초 뒤 재시도 ${item.retryCount}/${maxRetry}`);
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


// === 멈춘 다운로드 감지 ===
// 서버가 응답을 멈추면 브라우저 다운로드가 오류 없이 "진행 중"으로 남아,
// 그 파일이 자리를 계속 차지하고 배치도 끝나지 않음. 처음부터 응답이 없으면 NO_RESPONSE_TIMEOUT,
// 받는 도중 멈추면 STALL_TIMEOUT 뒤에 취소하고 재시도.
// onChanged 이벤트를 놓쳐 이미 끝난 다운로드가 "진행 중"으로 남은 경우도 여기서 정리됨
let lastStatusLogAt = 0;
async function checkStalledDownloads() {
  if (downloadToItemMap.size === 0 && downloadQueue.length === 0) return;
  const now = Date.now();
  if (now - lastStatusLogAt >= STATUS_LOG_INTERVAL) {
    lastStatusLogAt = now;
    debugLog(`상태: 진행 ${activeDownloads}개 (최대 ${maxConcurrent}), 대기열 ${downloadQueue.length}개, 배치 ${batchMap.size}개`);
  }

  for (const [downloadId, item] of Array.from(downloadToItemMap)) {
    if (item.status !== 'in_progress' || item.stalled) continue;
    let info;
    try {
      [info] = await browser.downloads.search({ id: downloadId });
    } catch (error) {
      continue;
    }

    if (!info) {
      // 다운로드 목록에서 지워져 결과를 알 수 없음 → 오류로 보고 재시도
      debugLog(`목록에서 사라짐 #${downloadId}: ${item.filename}`);
      handleDownloadError(downloadId, 'REMOVED');
    } else if (info.state === 'complete') {
      debugLog(`완료 이벤트 누락 #${downloadId}: ${item.filename}`);
      handleDownloadComplete(downloadId);
    } else if (info.state === 'interrupted') {
      debugLog(`중단 이벤트 누락 #${downloadId}: ${item.filename}`);
      handleDownloadError(downloadId, info.error || 'INTERRUPTED');
    } else if (info.paused) {
      // 사용자가 일시정지한 다운로드는 멈춘 것으로 보지 않음
      item.lastProgressAt = now;
    } else if (info.bytesReceived !== item.lastBytes) {
      item.lastBytes = info.bytesReceived;
      item.lastProgressAt = now;
    } else if (now - item.lastProgressAt > (info.bytesReceived > 0 ? STALL_TIMEOUT : NO_RESPONSE_TIMEOUT)) {
      // 아직 한 바이트도 못 받았으면 서버 무응답으로 보고 더 빨리 포기
      const reason = info.bytesReceived > 0 ? `${info.bytesReceived} bytes에서 변화 없음` : '서버 응답 없음';
      debugLog(`멈춤 감지 #${downloadId}: ${item.filename} (${Math.round((now - item.lastProgressAt) / 1000)}초 동안 ${reason}) → 취소 후 재시도`);
      item.stalled = true;
      browser.downloads.cancel(downloadId).catch((error) => {
        console.warn('Stalled download cancel failed:', error);
        item.stalled = false;
        handleDownloadError(downloadId, 'STALLED');
      });
    }
  }
}

setInterval(checkStalledDownloads, STALL_CHECK_INTERVAL);


// === 배치 완료 검사 ===
function checkBatchCompletion(batchId) {
  const batch = batchMap.get(batchId);
  if (!batch || !batch.dispatched) return;

  const items = batch.items;
  const allDone = items.every(item =>
    item.status === 'complete' || item.status === 'failed' || item.status === 'cancelled'
  );

  if (!allDone) return;

  // 결과 집계
  // 본문 텍스트 파일은 확장이 직접 만든 파일이라 거의 항상 성공하므로, 이미지 / 첨부파일이 있는 게시글에서는
  // 성공으로 세지 않음 (이미지가 전부 실패했는데 텍스트 때문에 "일부 실패"로 보이지 않도록). 실패는 그대로 셈.
  // 텍스트만 있는 게시글은 텍스트로 판단
  const hasMedia = items.some(i => !i.isText);
  const counted = hasMedia ? items.filter(i => !(i.isText && i.status === 'complete')) : items;
  const total = counted.length;
  const success = counted.filter(i => i.status === 'complete').length;
  const failed = counted.filter(i => i.status === 'failed').length;
  const cancelled = counted.filter(i => i.status === 'cancelled').length;
  const failedItems = counted
    .filter(i => i.status === 'failed')
    .map(i => ({ url: i.url, filename: i.filename, error: i.error }));
  debugLog(`배치 끝 ${batchId}: 전체 ${total}, 성공 ${success}, 실패 ${failed}, 취소 ${cancelled}`);

  // 전부 취소된 게시글은 기록하지 않음. 일부만 받았으면 "일부 실패"로 기록
  if (batch.postKey && success + failed > 0) markPost(batch.postKey, success, failed + cancelled);

  // 콘텐츠 스크립트에 결과 전송 (토스트 알림 표시용)
  if (batch.tabId) {
    chrome.tabs.sendMessage(batch.tabId, {
      type: "batch-result",
      batchId: batchId,
      total: total,
      success: success,
      failed: failed,
      cancelled: cancelled,
      failedItems: failedItems,
      notificationText: batch.notificationText
    }).catch(() => {
      // 탭이 닫혀있을 경우 OS 알림으로 대체
      showOSNotification(total, success, failed + cancelled, batch.notificationText);
    });
  } else {
    showOSNotification(total, success, failed + cancelled, batch.notificationText);
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
    message: [notificationText, stats, failed > 0 ? chrome.i18n.getMessage("notify_server_issue_hint") : ''].filter(Boolean).join("\n")
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