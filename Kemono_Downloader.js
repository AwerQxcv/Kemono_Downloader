// === 게시글 API ===
// kemono / pawchive 모두 /api/v1/{service}/user/{user}/post/{id} 구조를 사용.
// HTML 파싱 대신 이 API로 게시글 정보를 받아와 globalThis.postData에 저장해 두고, 아래 매크로/다운로드 함수들이 이것을 사용함.
// 작가 페이지에서는 게시글을 하나씩 받아 postData를 바꿔가며 같은 다운로드 과정을 반복함 (downloadCreator 참고).

// 이미지(본문 이미지)로 취급할 확장자. 사이트 프론트엔드도 확장자로 이미지/첨부파일을 나눔
const IMAGE_EXTENSIONS = new Set(['.jpg', '.jpeg', '.jpe', '.jfif', '.png', '.gif', '.webp', '.avif', '.bmp']);

// 서비스 ID → 사이트에 표시되는 플랫폼 이름 ($PlatformName$ 매크로가 기존 HTML 파싱 결과와 같도록)
const PLATFORM_NAMES = {
  patreon: 'Patreon',
  fanbox: 'Pixiv Fanbox',
  fantia: 'Fantia',
  gumroad: 'Gumroad',
  subscribestar: 'SubscribeStar',
  dlsite: 'DLsite',
  discord: 'Discord',
  boosty: 'Boosty',
  afdian: 'Afdian',
  onlyfans: 'OnlyFans',
  fansly: 'Fansly',
  candfans: 'CandFans',
};

const CREATOR_PAGE_SIZE = 50; // 작가 게시글 목록 API는 o(offset)를 50 단위로 받음
const CREATOR_POST_INTERVAL = 1000; // 작가 일괄 다운로드 시 게시글 사이 대기 시간 (ms). 서버 429 방지용
const RATE_LIMIT_RETRY = 5; // 429(요청 너무 많음)일 때 재시도 횟수
const RATE_LIMIT_WAIT = 5000; // 429일 때 기본 대기 시간 (ms). 재시도할수록 늘어남

class PostNotFoundError extends Error { }

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

// kemono API는 Accept: text/css 가 아니면 403을 주는 경우가 있어 먼저 text/css로 시도하고, 실패하면 일반 Accept로 재시도
async function apiGet(path) {
  let response;
  for (let attempt = 0; ; attempt++) {
    for (const accept of ['text/css', '*/*']) {
      response = await fetch(location.origin + '/api/v1' + path, { headers: { 'Accept': accept }, credentials: 'include' });
      if (response.ok || response.status === 404 || response.status === 429) break;
    }
    if (response.status !== 429 || attempt >= RATE_LIMIT_RETRY) break;
    // 429면 Retry-After(초)만큼, 없으면 점점 길게 쉬었다가 다시 요청
    const retryAfter = parseInt(response.headers.get('Retry-After'));
    await sleep(isNaN(retryAfter) ? RATE_LIMIT_WAIT * (attempt + 1) : retryAfter * 1000);
  }
  if (response.status === 404) throw new PostNotFoundError(path);
  if (!response.ok) {
    const error = new Error(`API ${path} : HTTP ${response.status}`);
    error.status = response.status;
    throw error;
  }
  return JSON.parse(await response.text()); // Content-Type이 text/css로 올 수 있어 response.json() 대신 직접 파싱
}

// 현재 주소에서 서비스 / 유저 ID / 게시글 ID 추출. 작가 페이지면 pageID는 null
function parsePagePath() {
  const match = location.pathname.match(/^\/([^/]+)\/user\/([^/]+)(?:\/post\/([a-zA-Z0-9-]+))?\/?$/);
  if (!match) return null;
  return { service: match[1], userID: match[2], pageID: match[3] || null };
}

async function fetchPostData(service, userID, pageID) {
  const data = await apiGet(`/${service}/user/${userID}/post/${pageID}`);
  // 평평한 게시글 JSON과 { post, attachments, previews, videos } 형태 둘 다 지원
  const post = data && data.post ? data.post : data;
  if (!post || !post.id) throw new PostNotFoundError(pageID);

  const { images, attachments } = classifyFiles(post);

  return {
    service: service,
    userID: userID,
    pageID: pageID,
    userName: await fetchUserName(service, userID),
    title: decodeHtmlEntities(post.title || ''),
    content: post.content || '',
    published: post.published || post.added || '',
    images: images,
    attachments: attachments,
  };
}

// 유저 이름은 게시글 API에 없으므로 프로필 API에서 가져옴. 실패하면 페이지에서 읽고, 그것도 안 되면 유저 ID 사용
// 작가 일괄 다운로드 때 게시글마다 다시 요청하지 않도록 저장해 둠
const userNameCache = new Map();

async function fetchUserName(service, userID) {
  const key = `${service}/${userID}`;
  if (!userNameCache.has(key)) {
    userNameCache.set(key, await loadUserName(service, userID));
  }
  return userNameCache.get(key);
}

async function loadUserName(service, userID) {
  try {
    const profile = await apiGet(`/${service}/user/${userID}/profile`);
    if (profile && profile.name) return decodeHtmlEntities(profile.name);
  } catch (error) {
    console.warn('fetchUserName: profile API failed', error);
  }
  const link = document.querySelector('a.post__user-name, .user-header__profile span[itemprop="name"]');
  return link ? link.textContent : userID;
}

// 작가의 모든 게시글 ID를 최신순으로 모음. o를 50씩 올리며 빈 목록이 올 때까지 요청
// 목록 경로는 사이트마다 /user/{id}/posts 또는 /user/{id} 이므로 첫 페이지에서 되는 쪽을 골라 계속 사용
async function fetchCreatorPostIDs(service, userID) {
  const candidates = [`/${service}/user/${userID}/posts`, `/${service}/user/${userID}`];
  const ids = [];
  const seenIDs = new Set();
  let listPath = null;

  for (let offset = 0; ; offset += CREATOR_PAGE_SIZE) {
    let posts = null;
    for (const path of listPath ? [listPath] : candidates) {
      try {
        const data = await apiGet(`${path}?o=${offset}`);
        posts = Array.isArray(data) ? data : (data && Array.isArray(data.posts) ? data.posts : null);
      } catch (error) {
        // 마지막 페이지 다음을 요청하면 빈 목록 대신 404/400을 주는 사이트가 있음 → 목록 끝으로 처리
        if (listPath && (error instanceof PostNotFoundError || error.status === 400)) return ids;
        if (listPath) throw error; // 이미 되던 경로가 도중에 다른 이유로 실패하면 중단
        console.warn(`fetchCreatorPostIDs: ${path} failed`, error);
      }
      if (posts) {
        listPath = path;
        break;
      }
    }
    if (!posts) throw new Error('creator post list API not available');

    let added = 0;
    for (const post of posts) {
      if (!post || !post.id || seenIDs.has(String(post.id))) continue;
      seenIDs.add(String(post.id));
      ids.push(String(post.id));
      added++;
    }
    // 한 페이지(50개)보다 적게 왔으면 마지막 페이지. 새 게시글이 하나도 없어도(같은 페이지 반복 방지) 끝
    if (posts.length < CREATOR_PAGE_SIZE || added === 0) break;
  }
  return ids;
}

// file + attachments를 확장자로 이미지 / 첨부파일로 분류
// file(썸네일)이 attachments에 같은 path로 또 들어있는 경우가 있어 그때는 file을 제외 (사이트 화면과 동일)
// 그 밖의 중복은 기존처럼 cbRemoveDupByUrl 설정에 따라 collectContent에서 처리
function classifyFiles(post) {
  const attachmentList = (Array.isArray(post.attachments) ? post.attachments : []).filter((file) => file && file.path);
  const files = [...attachmentList];
  if (post.file && post.file.path && !attachmentList.some((file) => file.path === post.file.path)) {
    files.unshift(post.file);
  }

  const images = [];
  const attachments = [];
  for (const file of files) {
    const name = decodeHtmlEntities(file.name || '');
    const entry = {
      url: getFileServer(file) + '/data' + file.path,
      downloadUrl: getTempUrl(file), // 있으면 url 대신 이 주소로 다운로드
      name: name,
    };
    (IMAGE_EXTENSIONS.has(getExtension(name || file.path)) ? images : attachments).push(entry);
  }
  return { images, attachments };
}

// 파일이 저장된 서버 주소. API 응답의 server(전체 주소)나 node(서버 번호, 2면 n2.도메인)를 사용
// 둘 다 없으면 pawchive는 file.도메인, kemono는 사이트 주소(/data가 파일 서버로 넘겨줌)
function getFileServer(file) {
  if (file.server) return file.server.replace(/\/+$/, '');
  if (file.node) return `https://n${file.node}.${location.hostname}`;
  return location.hostname.startsWith('pawchive.') ? `https://file.${location.hostname}` : location.origin;
}

// 일부 게시글(preview_only 등)은 /data 경로 대신 서명된 임시 주소(temp_url)로만 받을 수 있음
// 만료(temp_expires)되지 않았으면 그 주소를 그대로 사용 (서명이 깨지지 않도록 ?f= 를 붙이지 않음)
function getTempUrl(file) {
  if (!file.temp_url) return null;
  const expires = Date.parse(file.temp_expires);
  if (!isNaN(expires) && expires <= Date.now()) return null;
  return decodeHtmlEntities(file.temp_url);
}

function getExtension(fileName) {
  const dotIdx = fileName.lastIndexOf('.');
  return dotIdx > 0 ? fileName.substring(dotIdx).toLowerCase() : '';
}

// API의 title / name / content에는 &amp; 같은 HTML 엔티티가 그대로 들어있어 디코딩이 필요
function decodeHtmlEntities(text) {
  if (!text) return '';
  return new DOMParser().parseFromString(text, 'text/html').documentElement.textContent;
}

// 본문 HTML → 텍스트. 분리된 문서에서는 innerText가 줄바꿈을 만들지 않아 직접 처리
function htmlToText(html) {
  const doc = new DOMParser().parseFromString(html, 'text/html');
  doc.querySelectorAll('br').forEach((br) => br.replaceWith('\n'));
  doc.querySelectorAll('p, div, li, h1, h2, h3, h4, h5, h6, blockquote, pre, tr').forEach((el) => el.append('\n'));
  return doc.body.textContent.replace(/\n{3,}/g, '\n\n').trim();
}

// Functions for general macros
function getPlatformName() {
  const service = postData.service;
  return sanitizeText(PLATFORM_NAMES[service] || service);
}

function getUserName() {
  return sanitizeText(postData.userName);
}

function getUserID() {
  return postData.userID;
}

function getPageID() {
  return postData.pageID;
}

function getTitle() {
  let title = sanitizeText(postData.title);
  if (title.length > 100) {
    title = title.slice(0, 100) + "(···)";
  }
  return title;
}

function getImagesCount() {
  return postData.images.length;
}

function getAttachmentsCount() {
  return postData.attachments.length;
}

function sanitizeText(text, includeDot = true) {
  if (!text) return "";

  text = text.normalize('NFKC');

  text = text.replace(/[\u200B-\u200D\uFEFF\uFE0F]/g, '');

  text = text.replace(/[\x00-\x08\x0b\x0c\x0e-\x1f\x7f]/g, '');

  text = text.replace(/\s+/g, ' ');

  const charMap = {
    ':': '：', '/': '／', '\\': '￥', '*': '＊', '?': '？',
    '"': '”', '<': '＜', '>': '＞', '|': '｜'
  };

  if (includeDot) charMap['.'] = '．';

  const escapedKeys = Object.keys(charMap).map(key =>
    key.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
  );
  const pattern = new RegExp(escapedKeys.join('|'), 'g');

  return text.replace(pattern, (match) => charMap[match]).trim();
}

// Functions for time macros
function getDate(num) {
  let replaced = /(\d+)-(\d+)-(\d+)[T\s](\d+):(\d+):(\d+)/.exec(postData.published);
  if (replaced == null) {
    replaced = ["0", "0000", "00", "00", "00", "00", "00"];
  }
  return replaced[num];
}

function getDateNow(query) {
  dateNow = new Date(Date.now());
  replaced = [
    dateNow,
    dateNow.getFullYear().toString(),
    (dateNow.getMonth() + 1).toString(),
    dateNow.getDate().toString(),
    dateNow.getHours().toString(),
    dateNow.getMinutes().toString(),
  ];
  return replaced[query].padStart(2, "0");
}

// Downloading functions
function collectContent(type) {
  const isImages = type === 'image';
  const files = isImages ? postData.images : postData.attachments; // API 응답을 확장자로 분류해 둔 목록 (classifyFiles 참고)

  const seenUrls = new Set(); // cbRemoveDupByUrl 이 켜져 있을 때 같은 URL을 걸러내기 위한 Set
  let validIndex = 1; // 다운로드 가능한 항목만 체크하기 위한 변수

  return files.reduce((acc, file) => {
    const urlPart = file.url;

    // cbRemoveDupByUrl 은 checkbox Remove Duplicate By URL 로, 확장프로그램의 설정 페이지에서 체크박스 형식으로 존재함.
    if (cbRemoveDupByUrl && seenUrls.has(urlPart)) return acc;

    //Extract extension from URL (서버에 저장된 해시 파일명), not in start or end
    const urlLastSlash = urlPart.lastIndexOf('/');
    const fileNameFromUrl = urlPart.substring(urlLastSlash + 1);
    const urlDotIdx = fileNameFromUrl.lastIndexOf('.');

    let extension = (urlDotIdx > 0 && urlDotIdx < fileNameFromUrl.length - 1)
      ? fileNameFromUrl.substring(urlDotIdx)
      : '.txt';

    let rawFileName = file.name || `file_${validIndex}${extension}`; // 원본 파일명이 없으면 file_번호.확장자

    //The same extension check and extraction, as for URL
    let finalNameOnly = rawFileName;
    const lastDotIndex = rawFileName.lastIndexOf('.');

    if (lastDotIndex > 0 && lastDotIndex < rawFileName.length - 1) { // 원본 파일명에 확장자가 있으면 그것을 사용
      extension = rawFileName.substring(lastDotIndex);
      finalNameOnly = rawFileName.substring(0, lastDotIndex);
    }

    if (cbRemoveDupByUrl) seenUrls.add(urlPart);

    acc.push({
      index: validIndex++,
      // temp_url이 있으면 그대로, 아니면 ?f= (서버가 원본 파일명으로 내려주게 하는 파라미터)를 붙인 /data 주소
      url: file.downloadUrl || `${urlPart}?f=${encodeURIComponent(rawFileName)}`,
      name: sanitizeText(finalNameOnly, false),
      extension: extension
    });

    return acc;
  }, []);
}

function dlText(batchId, usedNames) {
  const text = htmlToText(postData.content);
  if (text) {
    const blob2 = new Blob([text], { type: "text/plain" });
    filename = makeUniqueInBatch(convertMacrosInPath(txtBasePath + "/" + txtTextPath) + ".txt", usedNames);

    if (isChromium() == true) {
      const blob3 = URL.createObjectURL(blob2);
      dlFile("download", blob3, filename, batchId);
      //URL.revokeObjectURL(blob3)
    } else {
      chrome.runtime.sendMessage({
        type: "blob",
        blob: blob2,
        filename: filename,
        batchId: batchId,
      });
    }
  }
}

async function dlContent(type, batchId, usedNames) {
  const items = collectContent(type);

  for (const item of items) {
    try {
      const filename = makeUniqueInBatch(getSavePathAndName(type, item), usedNames);
      await new Promise((resolve) => {
        dlFile("download", item.url, filename, batchId);
        setTimeout(resolve, numDownloadDelay);
      });
    } catch (error) {
      console.error(`dlContent (${type}): Error processing item ${item.index}:`, error);
    }
  }
}

// 한 게시글 안에서 서로 다른 파일이 같은 경로가 되면 " (2)", " (3)"…을 붙여 구분.
// 덮어쓰기 모드에서 서로 덮어쓰지 않게 하고, 다시 받아도 항상 같은 이름이 나오게 함.
// usedNames: 이번 배치에서 이미 쓴 경로 (Windows는 대소문자를 구분하지 않으므로 소문자로 저장)
function makeUniqueInBatch(filename, usedNames) {
  const slashIdx = filename.lastIndexOf('/');
  const dotIdx = filename.lastIndexOf('.');
  const hasExt = dotIdx > slashIdx + 1;
  const stem = hasExt ? filename.substring(0, dotIdx) : filename;
  const ext = hasExt ? filename.substring(dotIdx) : '';

  let candidate = filename;
  for (let n = 2; usedNames.has(candidate.toLowerCase()); n++) {
    candidate = `${stem} (${n})${ext}`;
  }
  usedNames.add(candidate.toLowerCase());
  return candidate;
}

function getSavePathAndName(type, item) {
  const config = {
    'image': { path: txtImagesPath, prefix: 'Image' },
    'attachment': { path: txtAttachmentsPath, prefix: 'Att' }
  };

  const { path, prefix } = config[type];
  let query = convertMacrosInPath(txtBasePath + "/" + path);

  // Search $PrefixCounter$ or $PrefixCounter#X$
  const counterRegex = new RegExp(`\\$${prefix}Counter(?:#(\\d+))?\\$`, 'g');

  query = query.replace(counterRegex, (match, padValue) => {
    const indexStr = String(item.index);
    return padValue ? indexStr.padStart(Number(padValue), "0") : indexStr;
  });

  return query.replaceAll(`$${prefix}Name$`, item.name) + item.extension;
}

function convertMacrosInPath(query) {
  query = query.replaceAll("$PlatformName$", getPlatformName());
  query = query.replaceAll("$UserName$", getUserName());
  query = query.replaceAll("$UserID$", getUserID());
  query = query.replaceAll("$Title$", getTitle());
  query = query.replaceAll("$PageID$", getPageID());
  query = query.replaceAll("$ImagesCount$", getImagesCount());
  query = query.replaceAll("$AttsCount$", getAttachmentsCount());
  query = query.replaceAll("$YYYY$", getDate(1));
  query = query.replaceAll("$YY$", getDate(1).slice(-2));
  query = query.replaceAll("$MM$", getDate(2));
  query = query.replaceAll("$DD$", getDate(3));
  query = query.replaceAll("$hh$", getDate(4));
  query = query.replaceAll("$mm$", getDate(5));
  query = query.replaceAll("$NYYYY$", getDateNow(1));
  query = query.replaceAll("$NYY$", getDateNow(1).slice(-2));
  query = query.replaceAll("$NMM$", getDateNow(2));
  query = query.replaceAll("$NDD$", getDateNow(3));
  query = query.replaceAll("$Nhh$", getDateNow(4));
  query = query.replaceAll("$Nmm$", getDateNow(5));
  return query.trim();
}

function dlFile(type, url, filename, batchId) {
  chrome.runtime.sendMessage({
    type: type,
    url: url,
    filename: filename,
    batchId: batchId,
  });
}

// Utility function
function isChromium() {
  const s = chrome.runtime.getURL("");
  if (/chrome/.test(s) == true) {
    return true;
  } else return false;
}

// Main functions
async function main(str) {
  globalThis.txtBasePath = str.txtBasePath;
  globalThis.txtTextPath = str.txtTextPath;
  globalThis.txtImagesPath = str.txtImagesPath;
  globalThis.txtAttachmentsPath = str.txtAttachmentsPath;
  globalThis.cbRemoveDupByUrl = str.cbRemoveDupByUrl;
  const delay = parseInt(str.numDownloadDelay);
  globalThis.numDownloadDelay = isNaN(delay) || delay < 0 ? 150 : delay; // 파일 간 다운로드 지연 시간 (ms)

  const page = parsePagePath();
  if (!page) return;
  if (creatorRun) return; // 작가 일괄 다운로드 중에는 postData를 쓰고 있으므로 새 다운로드를 시작하지 않음

  if (page.pageID) {
    await downloadSinglePost(str, page);
  } else {
    await downloadCreator(str, page);
  }
}

function showPostFetchError(error, body = '') {
  const notFound = error instanceof PostNotFoundError;
  showToast(
    '❌ ' + chrome.i18n.getMessage(notFound ? 'notify_post_not_found_title' : 'notify_post_fetch_failed_title'),
    body || (notFound ? '' : String(error.message || error)),
    '',
    'error'
  );
}

// 게시글 페이지: 현재 게시글 하나를 다운로드
async function downloadSinglePost(str, page) {
  // 게시글 정보를 API로 받아옴. 아래 매크로 변환과 다운로드 목록이 모두 이것을 사용
  try {
    globalThis.postData = await fetchPostData(page.service, page.userID, page.pageID);
  } catch (error) {
    console.error('main: failed to fetch post', error);
    showPostFetchError(error);
    return;
  }
  await downloadPost(str);
}

// postData에 들어있는 게시글 하나를 하나의 배치로 다운로드하고 batchId를 반환
async function downloadPost(str) {
  // 배치 ID 생성 (유저ID_페이지ID_타임스탬프)
  const batchId = `${getUserID()}_${getPageID()}_${Date.now()}`;

  // 알림 문구는 지금(게시글 정보가 있는 시점) 미리 만들어 둠.
  // 완료 시점에는 사용자가 다른 페이지로 이동했거나 다음 게시글로 넘어갔을 수 있어 그때 매크로를 변환하면 엉뚱한 제목이 나옴
  const notificationText = convertMacrosInPath(str.txtNotificationFormat || '$PlatformName$ $UserName$ - $Title$');

  // 작가 일괄 다운로드 중이면 결과를 모아서 마지막에 한 번만 알림 (handleBatchResult 참고)
  if (creatorRun) creatorRun.pendingBatchIds.add(batchId);

  // 배치 시작 알림
  chrome.runtime.sendMessage({ type: "batch-start", batchId: batchId, notificationText: notificationText });

  const usedNames = new Set(); // 이번 배치에서 이미 쓴 파일 경로 (makeUniqueInBatch 참고)

  try {
    if (str.cbDlText == true) {
      dlText(batchId, usedNames); // dlText는 동기적으로 메시지를 보내므로 await 불필요
    }
    if (str.cbDlImages == true) {
      await dlContent('image', batchId, usedNames); // dlImages의 모든 요청 전송이 끝날 때까지 대기
    }
    if (str.cbDlAttachments == true) {
      await dlContent('attachment', batchId, usedNames); // dlAttachments의 모든 요청 전송이 끝날 때까지 대기
    }
  } finally {
    // 배치 종료 알림 (모든 다운로드 요청 전송 완료). 도중에 오류가 나도 보내야 결과 알림이 뜸
    chrome.runtime.sendMessage({ type: "batch-end", batchId: batchId });
  }
  return batchId;
}

// === 작가 페이지 일괄 다운로드 ===
// 진행 중인 작가 일괄 다운로드 상태. 없으면 null
// { total, sent, fetchFailed, cancelled, dispatchDone, pendingBatchIds, files, filesFailed, progress }
let creatorRun = null;

async function downloadCreator(str, page) {
  const progress = showProgressToast(chrome.i18n.getMessage('notify_creator_loading'));
  let ids;
  try {
    ids = await fetchCreatorPostIDs(page.service, page.userID);
  } catch (error) {
    console.error('downloadCreator: failed to fetch post list', error);
    progress.remove();
    showPostFetchError(error);
    return;
  }
  progress.remove();

  if (ids.length === 0) {
    showToast('ℹ️ ' + chrome.i18n.getMessage('notify_creator_no_posts'), '', '', 'warning');
    return;
  }
  if (!confirm(chrome.i18n.getMessage('confirm_creator_download', [ids.length.toString()]))) return;

  creatorRun = {
    total: ids.length,
    sent: 0,
    fetchFailed: 0,
    cancelled: false,
    dispatchDone: false,
    pendingBatchIds: new Set(),
    files: 0,
    filesFailed: 0,
    progress: showProgressToast('', () => { creatorRun.cancelled = true; }),
  };
  const run = creatorRun;

  for (const [i, pageID] of ids.entries()) {
    if (run.cancelled) break;
    run.progress.update(chrome.i18n.getMessage('notify_creator_progress', [(i + 1).toString(), run.total.toString()]));
    try {
      globalThis.postData = await fetchPostData(page.service, page.userID, pageID);
      await downloadPost(str);
      run.sent++;
    } catch (error) {
      console.error(`downloadCreator: post ${pageID} failed`, error);
      run.fetchFailed++;
    }
    if (i < ids.length - 1) await sleep(CREATOR_POST_INTERVAL);
  }

  run.dispatchDone = true;
  run.progress.update(chrome.i18n.getMessage('notify_creator_waiting'), false);
  finishCreatorRunIfDone();
}

// 모든 게시글 요청을 보냈고 모든 배치 결과가 돌아왔으면 요약 알림을 띄우고 종료
function finishCreatorRunIfDone() {
  const run = creatorRun;
  if (!run || !run.dispatchDone || run.pendingBatchIds.size > 0) return;
  creatorRun = null;
  run.progress.remove();

  const filesOk = run.files - run.filesFailed;
  const failed = run.filesFailed > 0 || run.fetchFailed > 0;
  const lines = [chrome.i18n.getMessage('notify_creator_stats', [run.sent.toString(), filesOk.toString(), run.files.toString()])];
  if (run.fetchFailed > 0) {
    lines.push(chrome.i18n.getMessage('notify_creator_fetch_failed', [run.fetchFailed.toString()]));
  }
  showToast(
    (failed ? '⚠️ ' : '✅ ') + chrome.i18n.getMessage(run.cancelled ? 'notify_creator_cancelled_title' : 'notify_creator_complete_title'),
    lines.join('\n'),
    '',
    failed || run.cancelled ? 'warning' : 'success'
  );
}

chrome.runtime.onMessage.addListener(function (request, sender) {
  // 배치 결과 수신 → 토스트 알림 표시
  if (request.type === "batch-result") {
    handleBatchResult(request);
    return;
  }

  // 기존 다운로드 트리거 (getImage 메시지)
  if (request.message === "getImage") {
    chrome.storage.local.get(
      ["cbDlText", "cbDlImages", "cbDlAttachments", "txtBasePath", "txtTextPath", "txtImagesPath", "txtAttachmentsPath", "cbRemoveDupByUrl", "numDownloadDelay", "txtNotificationFormat"],
      function (str) {
        if (str.txtBasePath == undefined) {
          const version = browser.runtime.getManifest().version;
          const message = browser.i18n.getMessage("alert_first_run", [version]);
          alert(message);
          return chrome.runtime.sendMessage({ type: "set" });
        } else {
          main(str);
        }
      }
    );
  }
});


// === 토스트 알림 시스템 ===
function createToastContainer() {
  let container = document.getElementById('kd-toast-container');
  if (!container) {
    container = document.createElement('div');
    container.id = 'kd-toast-container';
  }
  // 사이트가 페이지 이동 중 body/head를 다시 그리면서 컨테이너나 스타일을 지울 수 있음.
  // 스타일이 <head>에서만 지워지면 알림이 스타일 없이 화면 오른쪽에 붙어 나오므로,
  // 스타일을 컨테이너 안에 함께 넣고 호출할 때마다 둘 다 있는지 확인함
  if (!container.querySelector('#kd-toast-style')) {
    container.prepend(createToastStyle());
  }
  if (!container.isConnected) {
    document.body.appendChild(container);
  }
  return container;
}

function createToastStyle() {
  const style = document.createElement('style');
  style.id = 'kd-toast-style';
  style.textContent = `
    #kd-toast-container {
      position: fixed;
      bottom: 20px;
      right: 20px;
      z-index: 2147483647;
      display: flex;
      flex-direction: column-reverse;
      gap: 10px;
      pointer-events: none;
      font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, 'Helvetica Neue', sans-serif;
    }
    .kd-toast {
      min-width: 300px;
      max-width: 420px;
      padding: 14px 18px;
      border-radius: 12px;
      color: #fff;
      font-size: 13px;
      line-height: 1.5;
      pointer-events: auto;
      box-shadow: 0 8px 32px rgba(0, 0, 0, 0.25), 0 2px 8px rgba(0, 0, 0, 0.15);
      backdrop-filter: blur(12px);
      -webkit-backdrop-filter: blur(12px);
      animation: kd-slide-in 0.4s cubic-bezier(0.21, 1.02, 0.73, 1) forwards;
      cursor: default;
      overflow: hidden;
    }
    .kd-toast.kd-success {
      background: linear-gradient(135deg, rgba(40, 167, 69, 0.93), rgba(28, 120, 50, 0.93));
      border: 1px solid rgba(255, 255, 255, 0.12);
    }
    .kd-toast.kd-warning {
      background: linear-gradient(135deg, rgba(255, 152, 0, 0.93), rgba(220, 120, 0, 0.93));
      border: 1px solid rgba(255, 255, 255, 0.12);
    }
    .kd-toast.kd-error {
      background: linear-gradient(135deg, rgba(220, 53, 69, 0.93), rgba(170, 40, 52, 0.93));
      border: 1px solid rgba(255, 255, 255, 0.12);
    }
    .kd-toast.kd-progress {
      background: linear-gradient(135deg, rgba(52, 58, 64, 0.93), rgba(33, 37, 41, 0.93));
      border: 1px solid rgba(255, 255, 255, 0.12);
      display: flex;
      align-items: center;
      justify-content: space-between;
      gap: 12px;
    }
    .kd-toast-button {
      flex-shrink: 0;
      padding: 4px 12px;
      border: 1px solid rgba(255, 255, 255, 0.4);
      border-radius: 6px;
      background: transparent;
      color: #fff;
      font-size: 12px;
      cursor: pointer;
    }
    .kd-toast-button:disabled {
      opacity: 0.5;
      cursor: default;
    }
    .kd-toast.kd-progress .kd-toast-title {
      margin-bottom: 0;
    }
    .kd-toast-title {
      font-weight: 700;
      font-size: 14px;
      margin-bottom: 4px;
      letter-spacing: -0.01em;
    }
    .kd-toast-body {
      opacity: 0.92;
      font-size: 12.5px;
      word-break: break-word;
      white-space: pre-line;
    }
    .kd-toast-stats {
      opacity: 0.75;
      font-size: 11px;
      margin-top: 6px;
    }
    .kd-toast.kd-fade-out {
      animation: kd-fade-out 0.5s ease forwards !important;
    }
    @keyframes kd-slide-in {
      from {
        opacity: 0;
        transform: translateY(30px) scale(0.96);
      }
      to {
        opacity: 1;
        transform: translateY(0) scale(1);
      }
    }
    @keyframes kd-fade-out {
      from {
        opacity: 1;
        transform: translateY(0) scale(1);
      }
      to {
        opacity: 0;
        transform: translateY(-10px) scale(0.96);
      }
    }
  `;
  return style;
}

function showToast(title, body, stats, type) {
  const container = createToastContainer();

  const toast = document.createElement('div');
  toast.className = `kd-toast kd-${type}`;
  // 게시글 제목 등이 HTML로 해석되지 않도록 textContent로 삽입 (빈 줄은 생략)
  for (const [className, text] of [['kd-toast-title', title], ['kd-toast-body', body], ['kd-toast-stats', stats]]) {
    if (!text) continue;
    const line = document.createElement('div');
    line.className = className;
    line.textContent = text;
    toast.appendChild(line);
  }

  // 하단에서 상단으로 올라오는 스택형 (오래된 게 위로)
  container.appendChild(toast);

  // 5초 후 페이드 아웃
  const scheduleFadeOut = () => setTimeout(() => {
    toast.classList.add('kd-fade-out');
    toast.addEventListener('animationend', (e) => {
      if (e.animationName === 'kd-fade-out') toast.remove();
    });
  }, 5000);

  // 다른 탭을 보고 있는 동안 완료되면 보지도 못하고 사라지므로, 탭으로 돌아온 뒤부터 5초를 셈
  if (document.hidden) {
    document.addEventListener('visibilitychange', function onVisible() {
      if (document.hidden) return;
      document.removeEventListener('visibilitychange', onVisible);
      scheduleFadeOut();
    });
  } else {
    scheduleFadeOut();
  }
}

// 작가 일괄 다운로드 진행 상황을 보여주는, 사라지지 않는 토스트. onCancel이 있으면 취소 버튼 표시
function showProgressToast(text, onCancel) {
  const container = createToastContainer();

  const toast = document.createElement('div');
  toast.className = 'kd-toast kd-progress';
  const line = document.createElement('div');
  line.className = 'kd-toast-title';
  toast.appendChild(line);

  let button = null;
  if (onCancel) {
    button = document.createElement('button');
    button.className = 'kd-toast-button';
    button.textContent = chrome.i18n.getMessage('button_cancel');
    button.addEventListener('click', () => {
      button.disabled = true;
      onCancel();
    });
    toast.appendChild(button);
  }
  container.appendChild(toast);

  const update = (newText, cancellable = true) => {
    line.textContent = newText;
    if (button && !cancellable) button.remove();
  };
  update(text);
  return { update, remove: () => toast.remove() };
}

function handleBatchResult(result) {
  // 작가 일괄 다운로드에 속한 배치면 결과만 모으고, 실패가 있을 때만 해당 게시글 알림을 띄움
  if (creatorRun && creatorRun.pendingBatchIds.has(result.batchId)) {
    creatorRun.pendingBatchIds.delete(result.batchId);
    creatorRun.files += result.total;
    creatorRun.filesFailed += result.failed;
    if (result.failed > 0) showBatchResultToast(result);
    finishCreatorRunIfDone();
    return;
  }
  showBatchResultToast(result);
}

function showBatchResultToast(result) {
  // 다운로드 시작 시점에 만들어 둔 알림 문구 사용 (main 참고)
  const notificationText = result.notificationText || '';

  if (result.total === 0) {
    // 다운로드할 파일 없음
    showToast(
      'ℹ️ ' + chrome.i18n.getMessage('notify_batch_empty_title'),
      notificationText,
      '',
      'warning'
    );
  } else if (result.failed === 0) {
    // 모두 성공
    showToast(
      '✅ ' + chrome.i18n.getMessage('notify_batch_complete_title'),
      notificationText,
      chrome.i18n.getMessage('notify_batch_stats_success', [result.total.toString()]),
      'success'
    );
  } else if (result.success > 0) {
    // 일부 실패
    showToast(
      '⚠️ ' + chrome.i18n.getMessage('notify_batch_partial_fail_title'),
      notificationText,
      chrome.i18n.getMessage('notify_batch_stats_partial', [result.success.toString(), result.total.toString(), result.failed.toString()]),
      'warning'
    );
  } else {
    // 전부 실패
    showToast(
      '❌ ' + chrome.i18n.getMessage('notify_batch_failed_title'),
      notificationText,
      chrome.i18n.getMessage('notify_batch_stats_partial', [result.success.toString(), result.total.toString(), result.failed.toString()]),
      'error'
    );
  }
}