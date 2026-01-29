// Setting for default paths.
const PATH_CONFIG = {
  txtBasePath: 'Kemono_Downloader/$PlatformName$/$UserName$/$YY$$MM$$DD$_$Title$',
  txtTextPath: '__main__text__',
  txtImagesPath: '$ImageCounter#3$',
  txtAttachmentsPath: '$AttName$'
}

// Settings for searching for incorrect macros.
// The list of allowed macros is stored as a regexp.
// Standard: These are macros allowed in all input fields.
// Rules: These are macros available for input fields with specific IDs.
//        They are combined with the standard list. If the value is empty,
//        only standard macros can be used for this input field.
const MACRO_CONFIG = {
  standard: 'PlatformName|UserName|UserID|Title|PageID|ImagesCount|AttsCount|N?(YYYY|YY|MM|DD|hh|mm)',
  rules: {
    'txtBasePath': '',
    'txtTextPath': '',
    'txtImagesPath': 'ImageCounter|ImageCounter#\\d+|ImageName',
    'txtAttachmentsPath': 'AttCounter|AttCounter#\\d+|AttName'
  }
};

// Settings for attaching icons.
// The key is the "id" of the <label> tag. It must always start with "lbl".
// The value object contains the following data:
// containerClass: A required parameter. Contains the class name assigned to the <div> wrapper around the label and icons.
//                 It can be empty, in which case the "field-header" base class style will be applied.
// info:           If present, an information icon will be attached to the label. The value of this parameter is an entry from the localization file,
//                 the text of which will be displayed in the tooltip. The text may contain HTML tags.
// warning:        If present, a warning icon will be attached to the label. This parameter is currently only used in the <label>+<input> combination
//                 to display an error. The <input> "id" must match the <label> "id", but begin with "txt". The value of this parameter is an entry
//                 from the localization file, the text of which will be displayed in the tooltip. The text may contain HTML tags.
const tooltipRegistry = {
  "lblDlOptions": {
    containerClass: "field-header-txt"
  },
  "lblDlText": {
    info: "help_download_text",
    containerClass: "field-header-cb"
  },
  "lblDlImages": {
    info: "help_download_images",
    containerClass: "field-header-cb"
  },
  "lblDlAttachment": {
    info: "help_download_attachments",
    containerClass: "field-header-cb"
  },
  "lblRemoveDupByUrl": {
    info: "help_remove_duplicates_by_url",
    containerClass: "field-header-cb"
  },
  "lblBasePath": {
    info: "help_base_path",
    warning: "warning_save_problems",
    containerClass: "field-header-txt"
  },
  "lblTextPath": {
    info: "help_text_path",
    warning: "warning_save_problems",
    containerClass: "field-header-txt"
  },
  "lblImagesPath": {
    info: "help_images_path",
    warning: "warning_save_problems",
    containerClass: "field-header-txt"
  },
  "lblAttachmentsPath": {
    info: "help_attachments_path",
    warning: "warning_save_problems",
    containerClass: "field-header-txt"
  },
  "lblMacroList": {
    info: "help_macro_list",
    containerClass: "field-header-txt"
  }
};

function localizeHtmlPage() {
  // data-l10n-id 속성을 가진 모든 요소를 찾습니다.
  const localizableElements = document.querySelectorAll('[data-l10n-id]');
  
  localizableElements.forEach(elem => {
    // data-l10n-id 속성 값을 가져옵니다 (이것이 messages.json의 key가 됩니다).
    const messageKey = elem.getAttribute('data-l10n-id');
    if (messageKey) {
      // chrome.i18n.getMessage API를 사용하여 브라우저 언어에 맞는 텍스트를 가져옵니다.
      const message = chrome.i18n.getMessage(messageKey);
      if (message) {
        elem.textContent = message;
      }
    }
  });
}

function save_settings() {
  var cbDlText = document.getElementById("cbDlText").checked;
  var cbDlImages = document.getElementById("cbDlImages").checked;
  var cbDlAttachments = document.getElementById("cbDlAttachments").checked;
  var cbRemoveDupByUrl = document.getElementById("cbRemoveDupByUrl").checked;
  var txtBasePath = document.getElementById("txtBasePath").value;
  var txtTextPath = document.getElementById("txtTextPath").value;
  var txtImagesPath = document.getElementById("txtImagesPath").value;
  var txtAttachmentsPath = document.getElementById("txtAttachmentsPath").value;

  chrome.storage.local.set(
    {
      cbDlText: cbDlText,
      cbDlImages: cbDlImages,
      cbDlAttachments: cbDlAttachments,
      cbRemoveDupByUrl: cbRemoveDupByUrl,
      txtBasePath: txtBasePath,
      txtTextPath: txtTextPath,
      txtImagesPath: txtImagesPath,
      txtAttachmentsPath: txtAttachmentsPath,
    },
    function () {
      console.log("Done: save_settings()");
    }
  );
}

function load_settings() {
  chrome.storage.local.get(
    ["cbDlText", "cbDlImages", "cbDlAttachments", "txtBasePath", "txtTextPath", "txtImagesPath", "txtAttachmentsPath", "cbRemoveDupByUrl"],
    function (load) {
      document.getElementById("cbDlText").checked = load.cbDlText;
      document.getElementById("cbDlImages").checked = load.cbDlImages;
      document.getElementById("cbDlAttachments").checked = load.cbDlAttachments;
      document.getElementById("cbRemoveDupByUrl").checked = load.cbRemoveDupByUrl;
      document.getElementById("txtBasePath").value = load.txtBasePath;
      document.getElementById("txtTextPath").value = load.txtTextPath;
      document.getElementById("txtImagesPath").value = load.txtImagesPath;
      document.getElementById("txtAttachmentsPath").value = load.txtAttachmentsPath;
      if (load.txtBasePath == undefined) {
        initialize_settings();
        console.log("Initializing Settings");
        return null;
      }
      console.log("Done: load_settings()");
    }
  );
}

function clear_settings() {
  chrome.storage.local.clear(function () {
    console.log("Done: reset_settings()");
    location.reload();
  });
}

function initialize_settings() {
  document.getElementById("cbDlText").checked = true;
  document.getElementById("cbDlImages").checked = true;
  document.getElementById("cbDlAttachments").checked = true;
  document.getElementById("cbRemoveDupByUrl").checked = true;
  document.getElementById("txtBasePath").value = PATH_CONFIG.txtBasePath;
  document.getElementById("txtTextPath").value = PATH_CONFIG.txtTextPath;
  document.getElementById("txtImagesPath").value = PATH_CONFIG.txtImagesPath;
  document.getElementById("txtAttachmentsPath").value = PATH_CONFIG.txtAttachmentsPath;
  save_settings();
  // Hide warning icons when the reset to defaults button is pressed.
  for (const [id, config] of Object.entries(tooltipRegistry)) {
    if (config.warning) {
      toggleWarning(id, false);
    }
  }
}

// Checkboxes autosave
document.querySelectorAll('input[type="checkbox"]').forEach(cb => {
  cb.addEventListener('change', (e) => {
    chrome.storage.local.set({ [cb.id]: cb.checked });
  });
});

// Save and Cancel buttons for inputs
document.querySelectorAll('input[type="text"]').forEach(input => {
  // Create div - flex 100% width
  const wrapper = document.createElement('div');
  wrapper.style.display = 'flex';
  wrapper.style.alignItems = 'center';
  wrapper.style.width = '100%';
  wrapper.style.boxSizing = 'border-box';

  input.style.flexGrow = '1'; //Input fill all free space
  input.style.marginLeft = '1px';

  // Move input in div
  input.parentNode.insertBefore(wrapper, input);
  wrapper.appendChild(input);

  // Create buttons and add it in div after input
  const btnContainer = document.createElement('span');
  btnContainer.style.display = 'flex';
  btnContainer.style.flexShrink = '0'; // Don't shrink buttons

  const btnSave = createBtn('💾', () => {
    // Before saving, the path is cleared and a notification is displayed if the path has changed.
    const rawValue = input.value;
    const cleanValue = sanitizeMacroPath(input);

    input.value = cleanValue; // The clear path is displayed in the field.

    if (rawValue !== cleanValue) {
      if (typeof browser !== 'undefined' && browser.notifications) {
        browser.notifications.create({
          "type": "basic",
          "iconUrl": "icons/icon-48.png",
          "title": chrome.i18n.getMessage("notify_path_cleaned_title"),
          "message": chrome.i18n.getMessage("notify_path_cleaned_message", [cleanValue])
        });
      } else {
        console.log(chrome.i18n.getMessage("notify_path_cleaned_message", [cleanValue]));
      }
    }

    // Macro checking. The first invalid macro is found, enclosed in [>][<], and highlighted in the input field. Saving is canceled.
    const errorPath = findFirstError(cleanValue, input.id);

    if (errorPath) {
      input.value = errorPath;

      toggleWarning(input.id, true);

      // "Bad" visual effects.
      const originalBg = input.style.backgroundColor;
      const originalShadow = input.style.boxShadow;

      input.style.transition = 'background-color 0.4s ease, box-shadow 0.4s ease';
      input.style.backgroundColor = '#f8d7da';
      input.style.boxShadow = 'inset 0 0 0 1px #dc3545';

      const startIdx = errorPath.indexOf('[>]');
      const endIdx = errorPath.indexOf('[<]') + 3;

      input.focus();
      setTimeout(() => {
        input.setSelectionRange(startIdx, endIdx);
        // NEED FIX: Scrolling the field to display the selected fragment. Other options didn't work. Need a test. Or maybe not. :-)
        const charWidth = 6;
        input.scrollLeft = startIdx * charWidth;
      }, 10);

      setTimeout(() => {
        input.style.backgroundColor = originalBg;
        input.style.boxShadow = originalShadow;
      }, 1000);

      return;
    }

    chrome.storage.local.set({ [input.id]: cleanValue }, () => {
      toggleWarning(input.id, false);

      // "Good" visual effects.
      const originalBg = input.style.backgroundColor;
      const originalShadow = input.style.boxShadow;

      input.style.transition = 'background-color 0.4s ease, box-shadow 0.4s ease';
      input.style.backgroundColor = '#d4edda';
      input.style.boxShadow = 'inset 0 0 0 1px #28a745';

      setTimeout(() => {
        input.style.backgroundColor = originalBg;
        input.style.boxShadow = originalShadow;
      }, 500);
    });
  });

  const btnReset = createBtn('↻', () => {
    toggleWarning(input.id, false);

    chrome.storage.local.get(input.id, (res) => {
      if (res[input.id] !== undefined) input.value = res[input.id];
    });
  });

  btnContainer.append(btnSave, btnReset);
  wrapper.appendChild(btnContainer);
});

function createBtn(icon, onClick) {
  const btn = document.createElement('button');
  btn.style.fontSize = '20px'; 
  btn.textContent = icon;
  btn.style.cursor = 'pointer';
  btn.style.marginLeft = '1px';
  btn.style.height = '38px';
  btn.style.width = '38px'
  btn.onclick = onClick;
  btn.style.display = 'inline-flex';
  btn.style.alignItems = 'center';
  btn.style.justifyContent = 'center';
  btn.style.cursor = 'pointer';
  btn.style.padding = '0';
  btn.style.boxSizing = 'border-box';
  return btn;
}

function sanitizeMacroPath(input) {
    const reservedNames = /^(CON|PRN|AUX|NUL|COM[1-9]|LPT[1-9])$/i;

    const cleanPath = input.value
        .replace(/^[a-z]+:\/+/i, '')
        .replace(/\\/g, '/')
        .split('/')
        .filter(part => {
            const p = part.trim();
            return Boolean(p) && p !== '..' && p !== '.' && !reservedNames.test(p);
        })
        .join('/')
        .replace(/[:*?"<>|]/g, '_');

    return cleanPath || PATH_CONFIG[input.id] || 'default_filename.txt';
}

function findFirstError(path, inputId) {
  const dollarCount = (path.match(/\$/g) || []).length;
  const specificMacros = MACRO_CONFIG.rules[inputId] || '';
  const combinedPattern = specificMacros
    ? `^(${MACRO_CONFIG.standard}|${specificMacros})$`
    : `^(${MACRO_CONFIG.standard})$`;
  const macroRegex = new RegExp(combinedPattern);

  let firstErrorPath = null;

  // Find the first pair $...$ that does not pass validation.
  path.replace(/\$([^$]*)\$/g, (match, content, offset) => {
    if (firstErrorPath) return match;

    if (content === "" || !macroRegex.test(content)) {
      // The following string is formed: text_BEFORE + [>]$error$[<] + text_AFTER
      firstErrorPath = path.substring(0, offset) + `[>]${match}[<]` + path.substring(offset + match.length);
    }
    return match;
  });

  // If the macros in pairs are ok, but there is an odd number of $ signs, surround the last $ with [>][<],
  if (!firstErrorPath && dollarCount % 2 !== 0) {
    const lastDollarIdx = path.lastIndexOf('$');
    firstErrorPath = path.substring(0, lastDollarIdx) + "[>]$[<]" + path.substring(lastDollarIdx + 1);
  }
  return firstErrorPath;
}

// Listener for changes in the storage for real-time synchronization
chrome.storage.onChanged.addListener((changes, areaName) => {
  if (areaName === 'local') {
    for (let [key, { newValue }] of Object.entries(changes)) {
      const el = document.getElementById(key);
      if (el && el.type === 'checkbox')
        el.checked = newValue;
    }
  }
});

// Buttons for copying a macro.
document.addEventListener('DOMContentLoaded', () => {
  const buttons = document.querySelectorAll('.copy-btn');

  buttons.forEach(btn => {
    btn.addEventListener('click', () => {
      const row = btn.closest('tr');
      const textToCopy = row.cells[1].textContent.trim();

      const el = document.createElement('textarea');
      el.value = textToCopy;
      document.body.appendChild(el);
      el.select();

      try {
        document.execCommand('copy');
        const originalIcon = btn.textContent;
        btn.textContent = '✅';
        setTimeout(() => btn.textContent = originalIcon, 1000);
      } catch (err) {
        console.error('Copy failed', err);
      }

      document.body.removeChild(el);
    });
  });
});

function initTooltips() {
  const i18n = (typeof browser !== 'undefined') ? browser.i18n : chrome.i18n;

  for (const [id, config] of Object.entries(tooltipRegistry)) {
    const label = document.getElementById(id);
    if (!label) continue;

    const container = document.createElement('div');
    container.className = `field-header ${config.containerClass || ''}`;
    label.parentNode.insertBefore(container, label);
    container.appendChild(label);

    // Adding an information icon
    if (config.info) {
      const tooltipSpan = document.createElement('span');
      tooltipSpan.className = 'custom-tooltip-wrapper';
      tooltipSpan.innerHTML = `
        <span class="help-icon">ⓘ</span>
        <div class="tooltip-popup">${i18n.getMessage(config.info)}</div>
      `;
      container.appendChild(tooltipSpan);
    }

    // Adding a warning icon
    if (config.warning) {
      const warnSpan = document.createElement('span');
      warnSpan.className = 'custom-tooltip-wrapper warning-style';
      warnSpan.id = `warning-icon-${id}`; //Create an id for the icon with a name like "warning-lblText" to manage it.
      warnSpan.style.display = 'none'; // Hide by default, we don't have errors
      warnSpan.innerHTML = `
        <span class="help-icon">⚠</span>
        <div class="tooltip-popup">${i18n.getMessage(config.warning)}</div>
      `;
      container.appendChild(warnSpan);
    }
  }
}

function toggleWarning(inputId, show) {
    const labelId = inputId.replace('txt', 'lbl');
    const warningIcon = document.getElementById(`warning-icon-${labelId}`);

    if (warningIcon) {
        warningIcon.style.display = show ? 'inline-flex' : 'none';
    }
}

document.getElementById("reset").addEventListener("click", initialize_settings);

document.addEventListener("DOMContentLoaded", () => {
  localizeHtmlPage(); // UI 텍스트를 먼저 지역화합니다.
  load_settings();    // 그 다음 설정을 불러옵니다.
  initTooltips();
});
