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
  return sanitizeText(title);
}

function getImagesCount() {
  return document.querySelectorAll(".post__thumbnail").length;
}

function getAttachmentsCount() {
  return document.querySelectorAll(".post__attachment").length;
}

function getImageURL(getnum) {
  return document.querySelectorAll(".post__thumbnail")[getnum].querySelector("a").getAttribute("href");
}

function getAttachmentURL(getnum) {
  return document.querySelectorAll(".post__attachment")[getnum].querySelector("a").getAttribute("href");
}

function getText() {
  const container = document.querySelector(".post__content");
  return container ? container.innerText.trim() : null
}

function dlText() {
  const text = getText();
  if (text) {
    const blob2 = new Blob([text], { type: "text/plain" });
    filename = getTextSavePathAndName() + ".txt";

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

async function dlImages() {
  const count = getImagesCount();
  for (let num = 0; num < count; num++) {
    try {
      const url = getImageURL(num);
      const filename = getImageSavePathAndName(num) + "." + getFileExtension(url);
      await new Promise((resolve, reject) => {
        dlFile("download", url, filename);
        resolve();
      }, 100); // 지연 시간을 조금 늘려볼 수 있습니다 (예: 200ms)
    } catch (error) {
      console.error(`dlImages: Error processing image ${num + 1}:`, error);
      // 오류 발생 시 다음 이미지로 계속 진행할지 결정
    }
  }
}

async function dlAttachments() {
  const attachments = document.querySelectorAll(".post__attachment");
  const count = attachments.length;

  for (let num = 0; num < count; num++) {
    try {
      const attachmentElement = attachments[num].querySelector("a");
      const url = attachmentElement.getAttribute("href");
      const filename = attachmentElement.getAttribute("download");
      if (!url || !filename) {
        console.warn(`dlAttachments: 첨부 파일 ${num + 1}의 URL 또는 파일 이름을 찾을 수 없습니다. 건너뜁니다.`);
        continue; // URL이나 파일 이름이 없으면 다음 반복으로 건너뜁니다
      }

      full_path_filename = getAttachmentSavePathAndName(filename);

      await new Promise((resolve) => {
          dlFile("download", url, full_path_filename);
          setTimeout(resolve, 150); // 다음 반복 시작 전 150ms 대기
      });
    } catch (error) {
      console.error(`dlAttachments: 첨부 파일 ${num + 1} 처리 중 오류 발생:`, error);
    }
  }
}

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

function convertMacrosInPath(query) {
  query = query.replaceAll("$PlatformName$", getPlatformName());
  query = query.replaceAll("$UserName$", getUserName());
  query = query.replaceAll("$UserID$", getUserID());
  query = query.replaceAll("$Title$", getTitle());
  query = query.replaceAll("$PageID$", getPageID());
  query = query.replaceAll("$ImagesCount$", getImagesCount());
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

function sanitizeText(text, includeDot = true) {
  if (!text) return "";

  text = text.normalize('NFKC');

  text = text.replace(/[\u200b\ufeff]/g, '');

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


function getImageSavePathAndName(num) {
  let query;
  query = convertMacrosInPath(macro2);
  query = query.replaceAll("$Counter$", ("" + (num + 1)).padStart(3, "0"));
  return query;
}

function getTextSavePathAndName() {
  let query;
  query = convertMacrosInPath(macro);
  return query;
}

function getAttachmentSavePathAndName(name) {
  let query;
  query = convertMacrosInPath(macro3);
  query = query.replaceAll("$AttachmentName$", name);
  return query;
}

function getFileExtension(URL) {
  return URL.split(".").at(-1);
}

function dlFile(type, url, filename) {
  chrome.runtime.sendMessage({
    type: type,
    url: url,
    filename: filename,
  });
}

function isChromium() {
  const s = chrome.runtime.getURL("");
  if (/chrome/.test(s) == true) {
    return true;
  } else return false;
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

async function main(str) {
  globalThis.macro = str.macro;
  globalThis.macro2 = str.macro2;
  globalThis.macro3 = str.macro3;

  if (str.saveimg == true) {
    await dlImages(); // dlImages의 모든 요청 전송이 끝날 때까지 대기
  }
  if (str.savetext == true) {
    dlText(); // dlText는 동기적으로 메시지를 보내므로 await 불필요
  }
  if (str.saveattr == true) {
    await dlAttachments(); // dlAttachments의 모든 요청 전송이 끝날 때까지 대기
  }
}

chrome.runtime.onMessage.addListener(function (request, sender) {
  chrome.storage.local.get(
    ["savetext", "saveimg", "saveattr", "macro", "macro2", "macro3"],
    function (str) {
      if (str.macro == undefined) {
        alert("kemono-downloader：\n확장 프로그램 설정을 해주세요.\nPlease set the settings.\n設定をしてください。\n");
        return chrome.runtime.sendMessage({ type: "set" });
      } else {
        main(str);
      }
    }
  );
});