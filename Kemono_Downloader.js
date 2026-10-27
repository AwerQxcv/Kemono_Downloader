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
const RATE_LIMIT_MAX_WAIT = 60000; // 429일 때 한 번에 기다리는 최대 시간 (Retry-After가 너무 길어도 이만큼만)
const CREATOR_QUEUE_LIMIT = 10; // 백그라운드 대기열에 이만큼 쌓여 있으면 줄어들 때까지 다음 게시글을 미룸
const API_TIMEOUT = 30000; // API가 이 시간 안에 응답하지 않으면 실패 처리 (게시글 하나 때문에 일괄 다운로드가 멈추지 않도록)

// 콘솔 디버그 로그 (문제 확인용). 끄려면 false
const DEBUG_LOG = true;
function debugLog(...args) {
  if (DEBUG_LOG) console.log('[KD]', ...args);
}

class PostNotFoundError extends Error { }
class CancelledError extends Error { }

// signal이 취소되면 기다리지 않고 CancelledError로 끝냄
const sleep = (ms, signal) => new Promise((resolve, reject) => {
  if (signal && signal.aborted) return reject(new CancelledError());
  const timer = setTimeout(resolve, ms);
  if (signal) {
    signal.addEventListener('abort', () => {
      clearTimeout(timer);
      reject(new CancelledError());
    }, { once: true });
  }
});

// 응답 본문까지 API_TIMEOUT 안에 받지 못하면 실패. signal이 취소되면 바로 CancelledError
async function fetchWithTimeout(url, options, signal) {
  if (signal && signal.aborted) throw new CancelledError();
  const controller = new AbortController();
  let timedOut = false;
  const timer = setTimeout(() => {
    timedOut = true;
    controller.abort();
  }, API_TIMEOUT);
  const onAbort = () => controller.abort();
  if (signal) signal.addEventListener('abort', onAbort, { once: true });
  try {
    const response = await fetch(url, Object.assign({}, options, { signal: controller.signal }));
    const text = await response.text();
    return { ok: response.ok, status: response.status, headers: response.headers, text: text };
  } catch (error) {
    if (signal && signal.aborted) throw new CancelledError();
    if (timedOut) throw new Error(`API timeout (${API_TIMEOUT / 1000}s): ${url}`);
    throw error;
  } finally {
    clearTimeout(timer);
    if (signal) signal.removeEventListener('abort', onAbort);
  }
}

// kemono API는 Accept: text/css 가 아니면 403을 주는 경우가 있어 먼저 text/css로 시도하고, 실패하면 일반 Accept로 재시도
async function apiGet(path, signal) {
  let response;
  for (let attempt = 0; ; attempt++) {
    for (const accept of ['text/css', '*/*']) {
      response = await fetchWithTimeout(location.origin + '/api/v1' + path, { headers: { 'Accept': accept }, credentials: 'include' }, signal);
      if (response.ok || response.status === 404 || response.status === 429) break;
    }
    if (response.status !== 429 || attempt >= RATE_LIMIT_RETRY) break;
    // 429면 Retry-After(초)만큼, 없으면 점점 길게 쉬었다가 다시 요청
    const retryAfter = parseInt(response.headers.get('Retry-After'));
    const wait = Math.min(isNaN(retryAfter) ? RATE_LIMIT_WAIT * (attempt + 1) : retryAfter * 1000, RATE_LIMIT_MAX_WAIT);
    debugLog(`API 429 (요청 제한) ${path}: ${wait / 1000}초 뒤 다시 시도 (${attempt + 1}/${RATE_LIMIT_RETRY})`);
    await sleep(wait, signal);
  }
  if (response.status === 404) throw new PostNotFoundError(path);
  if (!response.ok) {
    const error = new Error(`API ${path} : HTTP ${response.status}`);
    error.status = response.status;
    throw error;
  }
  return JSON.parse(response.text); // Content-Type이 text/css로 올 수 있어 response.json() 대신 직접 파싱
}

// 현재 주소에서 서비스 / 유저 ID / 게시글 ID 추출. 작가 페이지면 pageID는 null
function parsePagePath() {
  const match = location.pathname.match(/^\/([^/]+)\/user\/([^/]+)(?:\/post\/([a-zA-Z0-9-]+))?\/?$/);
  if (!match) return null;
  return { service: match[1], userID: match[2], pageID: match[3] || null };
}

async function fetchPostData(service, userID, pageID, signal) {
  const data = await apiGet(`/${service}/user/${userID}/post/${pageID}`, signal);
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

// 작가의 모든 게시글 { id, title }을 최신순으로 모음. o를 50씩 올리며 빈 목록이 올 때까지 요청
// 목록 경로는 사이트마다 /user/{id}/posts 또는 /user/{id} 이므로 첫 페이지에서 되는 쪽을 골라 계속 사용
async function fetchCreatorPosts(service, userID) {
  const candidates = [`/${service}/user/${userID}/posts`, `/${service}/user/${userID}`];
  const list = [];
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
        if (listPath && (error instanceof PostNotFoundError || error.status === 400)) return list;
        if (listPath) throw error; // 이미 되던 경로가 도중에 다른 이유로 실패하면 중단
        console.warn(`fetchCreatorPosts: ${path} failed`, error);
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
      list.push({ id: String(post.id), title: decodeHtmlEntities(post.title || '') });
      added++;
    }
    // 한 페이지(50개)보다 적게 왔으면 마지막 페이지. 새 게시글이 하나도 없어도(같은 페이지 반복 방지) 끝
    if (posts.length < CREATOR_PAGE_SIZE || added === 0) break;
  }
  return list;
}

// "WIP, 진행중" → ['wip', '진행중']
function parseExcludeKeywords(text) {
  return String(text || '').split(',').map((keyword) => keyword.trim().toLowerCase()).filter((keyword) => keyword);
}

// 제목에 키워드가 하나라도 들어 있으면 제외 (대소문자 구분 없음)
function isExcludedTitle(title, keywords) {
  const lower = title.toLowerCase();
  return keywords.some((keyword) => lower.includes(keyword));
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

    // isText: 본문 텍스트 파일은 게시글 성공 여부 집계에서 따로 취급 (event_page.js의 checkBatchCompletion 참고)
    if (isChromium() == true) {
      const blob3 = URL.createObjectURL(blob2);
      chrome.runtime.sendMessage({
        type: "download",
        url: blob3,
        filename: filename,
        batchId: batchId,
        isText: true,
      });
      //URL.revokeObjectURL(blob3)
    } else {
      chrome.runtime.sendMessage({
        type: "blob",
        blob: blob2,
        filename: filename,
        batchId: batchId,
        isText: true,
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
    'error',
    notFound ? '' : chrome.i18n.getMessage('notify_server_issue_hint')
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
  chrome.runtime.sendMessage({
    type: "batch-start",
    batchId: batchId,
    notificationText: notificationText,
    postKey: `${postData.service}/${postData.userID}/${postData.pageID}`, // 게시글별 다운로드 기록용
  });

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
    debugLog(`배치 ${batchId} 전송 완료: 파일 ${usedNames.size}개`);
  }
  return batchId;
}

// === 작가 페이지 일괄 다운로드 ===
// 진행 중인 작가 일괄 다운로드 상태. 없으면 null
// { total, excluded, sent, fetchFailed, cancelled, abort, dispatchDone, pendingBatchIds, files, filesFailed, filesCancelled, progress, waitLogTimer }
let creatorRun = null;

async function downloadCreator(str, page) {
  const progress = showProgressToast(chrome.i18n.getMessage('notify_creator_loading'));
  let posts;
  try {
    posts = await fetchCreatorPosts(page.service, page.userID);
  } catch (error) {
    console.error('downloadCreator: failed to fetch post list', error);
    progress.remove();
    showPostFetchError(error);
    return;
  }
  progress.remove();

  if (posts.length === 0) {
    showToast('ℹ️ ' + chrome.i18n.getMessage('notify_creator_no_posts'), '', '', 'warning');
    return;
  }

  // 제외 키워드 입력 (지난번에 쓴 키워드를 기본값으로). 취소하면 다운로드하지 않음
  const saved = await browser.storage.local.get('txtExcludeKeywords');
  const input = prompt(
    chrome.i18n.getMessage('prompt_creator_exclude', [posts.length.toString()]) + '\n\n' + chrome.i18n.getMessage('notify_creator_navigation'),
    saved.txtExcludeKeywords || ''
  );
  if (input === null) return;
  chrome.storage.local.set({ txtExcludeKeywords: input.trim() });

  const keywords = parseExcludeKeywords(input);
  const ids = posts.filter((post) => !isExcludedTitle(post.title, keywords)).map((post) => post.id);
  const excluded = posts.length - ids.length;
  if (ids.length === 0) {
    showToast('ℹ️ ' + chrome.i18n.getMessage('notify_creator_all_excluded'), '', '', 'warning');
    return;
  }
  // 제외한 게시글이 있으면 몇 개를 받는지 한 번 더 확인
  if (excluded > 0 && !confirm(chrome.i18n.getMessage('confirm_creator_download_excluded', [posts.length.toString(), excluded.toString(), ids.length.toString()]))) return;

  const run = {
    total: ids.length,
    excluded: excluded,
    sent: 0,
    fetchFailed: 0,
    cancelled: false,
    abort: new AbortController(), // 취소하면 진행 중인 API 요청과 대기를 바로 끝냄
    dispatchDone: false,
    pendingBatchIds: new Set(),
    skippedPosts: 0,
    files: 0,
    filesFailed: 0,
    filesCancelled: 0,
    progress: null,
    waitLogTimer: null,
  };
  run.progress = showProgressToast('', () => cancelCreatorRun(run));
  creatorRun = run;
  debugLog(`작가 일괄 다운로드 시작: 게시글 ${ids.length}개 (제외 ${excluded}개)`);

  // "확장 기록" 건너뛰기 모드면 이미 모두 받은 게시글은 API 요청 없이 바로 건너뜀
  // (브라우저 기록 모드는 지운 파일을 다시 받기 위한 것이라 파일마다 확인)
  const postRecordKey = (pageID) => POST_RECORD_PREFIX + `${page.service}/${page.userID}/${pageID}`;
  const { selSkipDownloaded } = await browser.storage.local.get('selSkipDownloaded');
  const donePosts = selSkipDownloaded === 'record' ? await browser.storage.local.get(ids.map(postRecordKey)) : {};

  for (const [i, pageID] of ids.entries()) {
    if (run.cancelled) break;
    run.progress.update(chrome.i18n.getMessage('notify_creator_progress', [(i + 1).toString(), run.total.toString()]));

    const record = donePosts[postRecordKey(pageID)];
    if (record && record.status === 'complete') {
      run.skippedPosts++;
      debugLog(`[${i + 1}/${run.total}] 게시글 ${pageID} 건너뜀 (이미 모두 받음)`);
      continue;
    }

    // 백그라운드에 받을 파일이 많이 쌓여 있으면 줄어들 때까지 기다렸다가 다음 게시글로
    try {
      await waitForQueueRoom(run);
    } catch (error) {
      break; // 취소됨
    }

    debugLog(`[${i + 1}/${run.total}] 게시글 ${pageID} 정보 요청`);
    try {
      globalThis.postData = await fetchPostData(page.service, page.userID, pageID, run.abort.signal);
      debugLog(`[${i + 1}/${run.total}] 게시글 ${pageID} "${postData.title}": 이미지 ${postData.images.length}개, 첨부파일 ${postData.attachments.length}개`);
      await downloadPost(str);
      run.sent++;
    } catch (error) {
      if (error instanceof CancelledError) break;
      console.error(`downloadCreator: post ${pageID} failed`, error);
      debugLog(`[${i + 1}/${run.total}] 게시글 ${pageID} 실패: ${error.message || error}`);
      run.fetchFailed++;
    }
    if (i < ids.length - 1) {
      try {
        await sleep(CREATOR_POST_INTERVAL, run.abort.signal);
      } catch (error) {
        break; // 취소됨
      }
    }
  }

  run.dispatchDone = true;
  debugLog(`게시글 전송 끝 (보낸 게시글 ${run.sent}개, 불러오기 실패 ${run.fetchFailed}개${run.cancelled ? ', 취소됨' : ''}). 남은 배치 ${run.pendingBatchIds.size}개`);
  if (!run.cancelled) {
    // 남은 다운로드를 기다리는 동안에도 취소할 수 있음
    run.progress.update(chrome.i18n.getMessage('notify_creator_waiting'));
  }
  // 오래 기다리면 어떤 배치가 남았는지 30초마다 콘솔에 표시
  run.waitLogTimer = setInterval(() => {
    debugLog(`다운로드 완료 대기 중. 남은 배치 ${run.pendingBatchIds.size}개:`, Array.from(run.pendingBatchIds));
  }, 30000);
  finishCreatorRunIfDone();
}

// 백그라운드 대기열이 CREATOR_QUEUE_LIMIT보다 적어질 때까지 기다림. 취소되면 CancelledError
async function waitForQueueRoom(run) {
  let logged = false;
  for (;;) {
    let status;
    try {
      status = await browser.runtime.sendMessage({ type: 'queue-status' });
    } catch (error) {
      return; // 확인할 수 없으면 기다리지 않음
    }
    if (!status || status.queued < CREATOR_QUEUE_LIMIT) return;
    if (!logged) {
      debugLog(`다운로드 대기열 ${status.queued}개 (진행 ${status.active}개) → 줄어들 때까지 다음 게시글을 기다림`);
      logged = true;
    }
    await sleep(1000, run.abort.signal);
  }
}

// 취소: 게시글 전송을 멈추고, 백그라운드에 이미 보낸 게시글의 남은 파일(대기 중 / 진행 중)도 취소하도록 요청
function cancelCreatorRun(run) {
  if (run.cancelled) return;
  run.cancelled = true;
  run.abort.abort();
  debugLog(`취소 요청: 배치 ${run.pendingBatchIds.size}개의 남은 파일 취소`);
  chrome.runtime.sendMessage({ type: 'cancel-batches', batchIds: Array.from(run.pendingBatchIds) });
  run.progress.update(chrome.i18n.getMessage('notify_creator_cancelling'), false);
}

// 모든 게시글 요청을 보냈고 모든 배치 결과가 돌아왔으면 요약 알림을 띄우고 종료
function finishCreatorRunIfDone() {
  const run = creatorRun;
  if (!run || !run.dispatchDone || run.pendingBatchIds.size > 0) return;
  creatorRun = null;
  clearInterval(run.waitLogTimer);
  run.progress.remove();
  debugLog(`작가 일괄 다운로드 끝: 건너뛴 게시글 ${run.skippedPosts}개, 게시글 ${run.sent}개, 파일 ${run.files}개 중 실패 ${run.filesFailed}개, 취소 ${run.filesCancelled}개`);

  const filesOk = run.files - run.filesFailed;
  const failed = run.filesFailed > 0 || run.fetchFailed > 0;
  const lines = [chrome.i18n.getMessage('notify_creator_stats', [run.sent.toString(), filesOk.toString(), run.files.toString()])];
  if (run.excluded > 0) {
    lines.push(chrome.i18n.getMessage('notify_creator_excluded', [run.excluded.toString()]));
  }
  if (run.skippedPosts > 0) {
    lines.push(chrome.i18n.getMessage('notify_creator_skipped_posts', [run.skippedPosts.toString()]));
  }
  if (run.filesCancelled > 0) {
    lines.push(chrome.i18n.getMessage('notify_creator_cancelled_files', [run.filesCancelled.toString()]));
  }
  if (run.fetchFailed > 0) {
    lines.push(chrome.i18n.getMessage('notify_creator_fetch_failed', [run.fetchFailed.toString()]));
  }
  showToast(
    (run.cancelled ? '⏹️ ' : failed ? '⚠️ ' : '✅ ') + chrome.i18n.getMessage(run.cancelled ? 'notify_creator_cancelled_title' : 'notify_creator_complete_title'),
    lines.join('\n'),
    '',
    failed || run.cancelled ? 'warning' : 'success',
    failed ? chrome.i18n.getMessage('notify_server_issue_hint') : ''
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
    .kd-toast-hint {
      opacity: 0.85;
      font-size: 11px;
      line-height: 1.45;
      margin-top: 8px;
      padding-top: 6px;
      border-top: 1px solid rgba(255, 255, 255, 0.25);
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

// hint: 맨 아래에 작게 붙는 안내 문구. 있으면 읽을 시간을 주기 위해 더 오래 표시
function showToast(title, body, stats, type, hint = '') {
  const container = createToastContainer();

  const toast = document.createElement('div');
  toast.className = `kd-toast kd-${type}`;
  // 게시글 제목 등이 HTML로 해석되지 않도록 textContent로 삽입 (빈 줄은 생략)
  for (const [className, text] of [['kd-toast-title', title], ['kd-toast-body', body], ['kd-toast-stats', stats], ['kd-toast-hint', hint]]) {
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
  }, hint ? 12000 : 5000);

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
    // 사이트 안에서 페이지를 옮기면 화면이 다시 그려지면서 알림이 빠질 수 있으므로 다시 붙임
    if (!toast.isConnected) createToastContainer().appendChild(toast);
    line.textContent = newText;
    if (button && !cancellable) button.remove();
  };
  update(text);
  return { update, remove: () => toast.remove() };
}

function handleBatchResult(result) {
  // 작가 일괄 다운로드에 속한 배치면 결과만 모으고, 실패가 있을 때만 해당 게시글 알림을 띄움
  const cancelled = result.cancelled || 0;
  if (creatorRun && creatorRun.pendingBatchIds.has(result.batchId)) {
    creatorRun.pendingBatchIds.delete(result.batchId);
    creatorRun.files += result.total - cancelled;
    creatorRun.filesFailed += result.failed;
    creatorRun.filesCancelled += cancelled;
    debugLog(`배치 결과 ${result.batchId}: 성공 ${result.success}, 실패 ${result.failed}, 취소 ${cancelled} (남은 배치 ${creatorRun.pendingBatchIds.size}개)`);
    if (result.failed > 0) showBatchResultToast(result, false); // 서버 문제 안내는 마지막 요약에 한 번만
    finishCreatorRunIfDone();
    return;
  }
  showBatchResultToast(result);
}

// withHint: 실패했을 때 "사이트 서버 문제일 수 있음" 안내를 붙일지
function showBatchResultToast(result, withHint = true) {
  // 다운로드 시작 시점에 만들어 둔 알림 문구 사용 (main 참고)
  const notificationText = result.notificationText || '';
  const hint = withHint ? chrome.i18n.getMessage('notify_server_issue_hint') : '';

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
      'warning',
      hint
    );
  } else {
    // 전부 실패
    showToast(
      '❌ ' + chrome.i18n.getMessage('notify_batch_failed_title'),
      notificationText,
      chrome.i18n.getMessage('notify_batch_stats_partial', [result.success.toString(), result.total.toString(), result.failed.toString()]),
      'error',
      hint
    );
  }
}

// === 다운로드 기록 표시 ===
// 게시글별 다운로드 결과(event_page.js의 "p:<service/user/post>" 항목)를 페이지에 표시
//   작가 페이지: 각 카드 오른쪽 아래에 ✓ / ⚠ / ✕
//   게시글 페이지: 제목 옆에 상태와 날짜
// 기록 전체가 아니라 지금 화면에 보이는 게시글의 기록만 읽음
const STATUS_ICONS = { complete: '✓', partial: '⚠', failed: '✕' };
const POST_RECORD_PREFIX = 'p:';
const downloadedPosts = {}; // 읽어 온 기록 { "service/user/post": { status, time } }
const requestedPostKeys = new Set(); // 이미 읽었거나 읽는 중인 게시글
let renderStatusTimer = null;

function postStatusText(record) {
  const date = new Date(record.time || 0).toLocaleString();
  return `${chrome.i18n.getMessage('status_post_' + record.status)} · ${date}`;
}

// 카드에 data-* 가 없으면 링크 주소에서 읽음
function getCardPostKey(card) {
  if (card.dataset.service && card.dataset.user && card.dataset.id) {
    return `${card.dataset.service}/${card.dataset.user}/${card.dataset.id}`;
  }
  const link = card.querySelector('a[href*="/post/"]');
  const match = link && link.getAttribute('href').match(/\/([^/]+)\/user\/([^/]+)\/post\/([a-zA-Z0-9-]+)/);
  return match ? `${match[1]}/${match[2]}/${match[3]}` : null;
}

// 배지를 붙이거나 고치거나 뗌. 바뀐 게 없으면 DOM을 건드리지 않음 (MutationObserver가 다시 불리지 않도록)
function applyStatusBadge(container, record, inline) {
  let badge = container.querySelector(':scope > .kd-status-badge');
  if (!record || !STATUS_ICONS[record.status]) {
    if (badge) badge.remove();
    container.classList.remove('kd-has-status');
    return;
  }
  const className = `kd-status-badge kd-status-${record.status}${inline ? ' kd-status-inline' : ''}`;
  const text = inline ? `${STATUS_ICONS[record.status]} ${postStatusText(record)}` : STATUS_ICONS[record.status];
  const title = postStatusText(record);
  if (badge && badge.className === className && badge.textContent === text && badge.title === title) return;

  if (!badge) {
    badge = document.createElement('span');
    container.appendChild(badge);
  }
  badge.className = className;
  badge.textContent = text;
  badge.title = title;
  if (!inline) container.classList.add('kd-has-status');
}

function renderDownloadStatus() {
  ensureStatusStyle();
  const missing = [];
  const show = (container, key, inline) => {
    if (!requestedPostKeys.has(key)) missing.push(key);
    applyStatusBadge(container, downloadedPosts[key], inline);
  };

  for (const card of document.querySelectorAll('article.post-card')) {
    const key = getCardPostKey(card);
    if (key) show(card, key, false);
  }

  const page = parsePagePath();
  const title = document.querySelector('h1.post__title');
  if (page && page.pageID && title) {
    show(title, `${page.service}/${page.userID}/${page.pageID}`, true);
  }

  if (missing.length > 0) loadPostRecords(missing);
}

// 아직 읽지 않은 게시글의 기록을 읽어 와서 다시 표시
async function loadPostRecords(keys) {
  for (const key of keys) requestedPostKeys.add(key);
  const data = await browser.storage.local.get(keys.map((key) => POST_RECORD_PREFIX + key));
  for (const key of keys) {
    const record = data[POST_RECORD_PREFIX + key];
    if (record) downloadedPosts[key] = record;
  }
  renderDownloadStatus();
}

function scheduleRenderDownloadStatus() {
  clearTimeout(renderStatusTimer);
  renderStatusTimer = setTimeout(renderDownloadStatus, 200);
}

function ensureStatusStyle() {
  if (document.getElementById('kd-status-style')) return;
  const style = document.createElement('style');
  style.id = 'kd-status-style';
  style.textContent = `
    article.post-card.kd-has-status {
      position: relative;
    }
    .kd-status-badge {
      position: absolute;
      right: 6px;
      bottom: 6px;
      z-index: 2;
      width: 22px;
      height: 22px;
      border-radius: 50%;
      display: flex;
      align-items: center;
      justify-content: center;
      font-size: 13px;
      font-weight: bold;
      line-height: 1;
      color: #fff;
      box-shadow: 0 1px 3px rgba(0, 0, 0, 0.5);
      pointer-events: auto;
      font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, 'Helvetica Neue', sans-serif;
    }
    .kd-status-badge.kd-status-inline {
      position: static;
      display: inline-flex;
      width: auto;
      height: auto;
      margin-left: 10px;
      padding: 3px 10px;
      border-radius: 999px;
      font-size: 13px;
      font-weight: normal;
      vertical-align: middle;
      box-shadow: none;
    }
    .kd-status-complete { background: #2e9e5b; }
    .kd-status-partial { background: #d68a00; }
    .kd-status-failed { background: #d64545; }
  `;
  (document.head || document.documentElement).appendChild(style);
}

renderDownloadStatus();

// 다운로드가 끝나 기록이 바뀌면 바로 반영 (기록 지우기 / 가져오기 포함)
chrome.storage.onChanged.addListener((changes, areaName) => {
  if (areaName !== 'local') return;
  let changed = false;
  for (const [storageKey, change] of Object.entries(changes)) {
    if (!storageKey.startsWith(POST_RECORD_PREFIX)) continue;
    const key = storageKey.substring(POST_RECORD_PREFIX.length);
    if (change.newValue) downloadedPosts[key] = change.newValue;
    else delete downloadedPosts[key];
    requestedPostKeys.add(key);
    changed = true;
  }
  if (changed) renderDownloadStatus();
});

// 페이지 이동(목록 넘기기 등)으로 카드가 새로 그려지면 다시 표시
if (document.body) {
  new MutationObserver(scheduleRenderDownloadStatus).observe(document.body, { childList: true, subtree: true });
}