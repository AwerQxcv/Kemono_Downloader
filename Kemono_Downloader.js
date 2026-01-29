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
  const isImages = type === 'image';
  const selector = isImages ? '.post__thumbnail' : '.post__attachment';
  const items = document.querySelectorAll(selector);

  const seenUrls = new Set();
  let validIndex = 1;

  return Array.from(items).reduce((acc, item) => {
    let rawUrl = null;

    if (isImages) {
      const link = item.querySelector('a');
      const img = item.querySelector('img');
      rawUrl = link ? link.getAttribute('href') : (img ? img.getAttribute('src') : null);
    } else {
      const fileLink = item.querySelector('.post__attachment-link');
      rawUrl = fileLink ? fileLink.getAttribute('href') : null;
    }

    if (!rawUrl) return acc;

    const [urlPart, namePart] = rawUrl.split('?');

    if (cbRemoveDupByUrl && seenUrls.has(urlPart)) return acc;

    //Extract filename from URL, check position of dot, get extension if esists, not in start or end
    const urlLastSlash = urlPart.lastIndexOf('/');
    const fileNameFromUrl = urlPart.substring(urlLastSlash + 1);
    const urlDotIdx = fileNameFromUrl.lastIndexOf('.');

    let extension = (urlDotIdx > 0 && urlDotIdx < fileNameFromUrl.length - 1)
      ? fileNameFromUrl.substring(urlDotIdx)
      : '.txt';

    let rawFileName = (namePart && namePart.includes('f='))
      ? namePart.split('f=')[1]
      : `file_${validIndex}.${extension}`;

    // try - just for peace of mind in case of broken URLs
    try {
      rawFileName = decodeURIComponent(rawFileName).replace(/\+/g, ' ');
    } catch (e) {}

    //The same extension check and extraction, as for URL
    let finalNameOnly = rawFileName;
    const lastDotIndex = rawFileName.lastIndexOf('.');

    if (lastDotIndex > 0 && lastDotIndex < rawFileName.length - 1) {
      extension = rawFileName.substring(lastDotIndex);
      finalNameOnly = rawFileName.substring(0, lastDotIndex);
    }

    if (cbRemoveDupByUrl) seenUrls.add(urlPart);

    acc.push({
      index: validIndex++,
      url: urlPart,
      name: sanitizeText(finalNameOnly, false),
      extension: extension
    });

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