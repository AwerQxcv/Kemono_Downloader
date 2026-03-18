// Functions for general macros
function getPlatformName() {
  let platformName = document.querySelector(".post__title span:last-child").textContent;
  platformName = platformName.replace(/[()]/g, "");
  return sanitizeText(platformName);
}

function getUserName() {
  let userName = document.querySelector("a.post__user-name").textContent;
  return sanitizeText(userName);
}

function getUserID() {
  let userID = location.pathname.match(/(?<=user\/)(.*)(?=\/post)/);
  return userID[0];
}

function getPageID() {
  let pageID = location.pathname.match(/(?<=\/post\/)[a-zA-Z0-9-]+/);
  return pageID[0];
}

function getTitle() {
  let title = document.querySelector(".post__title span:first-child").textContent;
  title = sanitizeText(title);
  if (title.length > 100) {
    title = title.slice(0, 100) + "(···)";
  }
  return title;
}

function getImagesCount() {
  return document.querySelectorAll(".post__thumbnail").length;
}

function getAttachmentsCount() {
  return document.querySelectorAll(".post__attachment").length;
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
  try {
    src = document.querySelector(".timestamp").getAttribute("datetime");
    replaced = /(\d+)-(\d+)-(\d+)T(\d+):(\d+):(\d+)/.exec(src);
    return replaced[num];
  } catch (error) {
    replaced = [ "0", "0000", "00", "00", "00", "00", "00" ]
    return replaced[num];
  }
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
  const isImages = type === 'image'; // 인자로 받은 type이 image면 isImages는 true
  const selector = isImages ? '.post__thumbnail' : '.post__attachment'; // isImages가 true면 '.post__thumbnail', false면 '.post__attachment' 반환
  const items = document.querySelectorAll(selector); // html에서 selector에 해당하는 값을 모두 찾아서 items 리스트에 저장

  const seenUrls = new Set(); // Set을 만들어두어 중복된 URL을 필터링 및, 모든 html을 코드 반복 시 마다 실행하는 대신 한번에 저장하여 효율성 증대
  let validIndex = 1; // 다운로드 가능한 항목만 체크하기 위한 변수

  return Array.from(items).reduce((acc, item) => { // 위에서 저장해둔 items 배열로 반복문 시작. acc와 item이라는 변수를 지정하고 출발함
    let rawUrl = null; // rawUrl 초기화

    if (isImages) { // 만약 isImages가 true일 시
      const link = item.querySelector('a'); // item 에서 a를 긁어오는 코드
      const img = item.querySelector('img'); // item 에서 img를 긁어오는 코드
      rawUrl = link ? link.getAttribute('href') : (img ? img.getAttribute('src') : null); // link.href 혹은 img.src로 찾아본 후, 없으면 null 반환
    } else { // imImages가 0일 시
      const fileLink = item.querySelector('.post__attachment-link'); // item 에서 .post__attachment-link 를 긁어옴
      rawUrl = fileLink ? fileLink.getAttribute('href') : null; // fileLink가 있을 시 href를 긁고, 아니면 null 반환
    }

    if (!rawUrl) return acc; // raw Url이 false 일 시 acc 반환 후 다음 항목 실행 (저장하지 않고 넘어감)

    const [urlPart, namePart] = rawUrl.split('?'); // rawUrl에서 ?로 구분하여 urlPart와 namePart로 분리

    // cbRemoveDubByUrl 은 checkbox Remove Duplicate By URL 로, 확장프로그램의 설정 페이지에서 체크박스 형식으로 존재함.
    if (cbRemoveDupByUrl && seenUrls.has(urlPart)) return acc; // cbRemoveDupByUrl 가 true, seenUrls라는 Set에서 해당 urlPart가 있으면 acc 반환 (저장되지 않고 넘어감)

    //Extract filename from URL, check position of dot, get extension if esists, not in start or end 
    const urlLastSlash = urlPart.lastIndexOf('/'); // urlPart에서 /가 들어간 부분의 위치를 저장
    const fileNameFromUrl = urlPart.substring(urlLastSlash + 1); // urlPart를 urlLastSlash + 1 부터 시작하는 문자열로 저장 
    const urlDotIdx = fileNameFromUrl.lastIndexOf('.'); // fileNameFromUrl 에서 .의 위치를 urlDotIdx에 저장

    let extension = (urlDotIdx > 0 && urlDotIdx < fileNameFromUrl.length - 1) // 확장자 지정 urlDotIdx가 0보다 크고, urlDotIdx가 fileNameFromUrl의 문자열 길이 -1 보다 작을 때,
      ? fileNameFromUrl.substring(urlDotIdx) // 확장자명은 urlDotIdx 이후의 문자로 지정
      : '.txt'; // 그게 아닐 시 텍스트 파일로 지정

    let rawFileName = (namePart && namePart.includes('f=')) // rawFileName은 namePart 가 false가 아니고 f=를 포함하고 있다면
      ? namePart.split('f=')[1] //f=이후의 문자열로 반환
      : `file_${validIndex}.${extension}`; // 아니라면 위에서 지정한 validIndex(=1) + '.' + 확장자명 으로 지정

    // try - just for peace of mind in case of broken URLs
    try {
      rawFileName = decodeURIComponent(rawFileName).replace(/\+/g, ' '); // 알바벳 이외의 문자를 읽을 수 있게 변환하고 + 를 공백으로 변환
    } catch (e) {} // 에러 시 아무것도 안 함

    //The same extension check and extraction, as for URL
    let finalNameOnly = rawFileName;
    const lastDotIndex = rawFileName.lastIndexOf('.'); // rawFileName의 .의 위치를 저장

    if (lastDotIndex > 0 && lastDotIndex < rawFileName.length - 1) { // lastDotIndex가 0보다 크고 .의 위치가 파일명의 마지막 글자가 아닐 때
      extension = rawFileName.substring(lastDotIndex); // 확장자는 lastDotIndex 이후의 것으로 저장
      finalNameOnly = rawFileName.substring(0, lastDotIndex); // 파일 명은 rawFileName의 0부터 lastDotIndex 직전까지로 저장
    }

    if (cbRemoveDupByUrl) seenUrls.add(urlPart); //cbRemoveDubByUrl이 true일 시 urlPart를 seenUrls에 삽입

    acc.push({ // 위에 코드들이 정상적으로 실행되고서 최종적으로
      index: validIndex++, // index에 현재 validIndex값을 삽입 후, 하나씩 올려가며 url을 점차적으로 긁어옴
      url: urlPart, // 파일 이름을 땐 url을 사용
      name: sanitizeText(finalNameOnly, false), // 사용할 수 없는 문자열을 제거한 finalNameOnly
      extension: extension // 확장자명
    });
    
    // acc를 뒤에 나올 [] 배열에 순서대로 정렬
    return acc;
  }, []);
}

function dlText() {
  const container = document.querySelector(".post__content");
  const text = container ? container.innerText.trim() : null
  if (text) {
    const blob2 = new Blob([text], { type: "text/plain" });
    filename = convertMacrosInPath(txtBasePath + "/" + txtTextPath) + ".txt";

    if (isChromium() == true) {
      const blob3 = URL.createObjectURL(blob2);
      dlFile("download", blob3, filename);
      //URL.revokeObjectURL(blob3)
    } else {
      chrome.runtime.sendMessage({
        type: "blob",
        blob: blob2,
        filename: filename,
      });
    }
  }
}

async function dlContent(type) {
  const items = collectContent(type);

  for (const item of items) {
    try {
      const filename = getSavePathAndName(type, item);
      await new Promise((resolve) => {
        dlFile("download", item.url, filename);
        setTimeout(resolve, 150);
      });
    } catch (error) {
      console.error(`dlContent (${type}): Error processing item ${item.index}:`, error);
    }
  }
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

function dlFile(type, url, filename) {
  chrome.runtime.sendMessage({
    type: type,
    url: url,
    filename: filename,
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

  if (str.cbDlText == true) {
    dlText(); // dlText는 동기적으로 메시지를 보내므로 await 불필요
  }
  if (str.cbDlImages == true) {
    await dlContent('image'); // dlImages의 모든 요청 전송이 끝날 때까지 대기
  }
  if (str.cbDlAttachments == true) {
    await dlContent('attachment'); // dlAttachments의 모든 요청 전송이 끝날 때까지 대기
  }
}

chrome.runtime.onMessage.addListener(function (request, sender) {
  chrome.storage.local.get(
    ["cbDlText", "cbDlImages", "cbDlAttachments", "txtBasePath", "txtTextPath", "txtImagesPath", "txtAttachmentsPath", "cbRemoveDupByUrl"],
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
});