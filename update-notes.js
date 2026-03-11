function localizeHtmlPage() {
    // data-l11n-id 속성을 가진 모든 요소를 찾습니다.
    const localizableElements = document.querySelectorAll('[data-l11n-id]');

    localizableElements.forEach(elem => {
        // data-l11n-id 속성 값을 가져옵니다 (이것이 messages.json의 key가 됩니다).
        const messageKey = elem.getAttribute('data-l11n-id');
        if (messageKey) {
            // chrome.i18n.getMessage API를 사용하여 브라우저 언어에 맞는 텍스트를 가져옵니다.
            const message = browser.i18n.getMessage(messageKey);
            if (message) {
                elem.textContent = message;
            }
        }
    });
}

if (typeof browser !== 'undefined' && browser.runtime) {
    const manifest = browser.runtime.getManifest();
    document.getElementById('cur-version').textContent = 'v' + manifest.version;
}

const params = new URLSearchParams(location.search);
const prev = params.get('prev') ?? '-';

document.getElementById('prev-version').textContent = 'v' + prev;
document.addEventListener('DOMContentLoaded', () => { localizeHtmlPage(); });
document.getElementById('closeBtn').addEventListener('click', () => {
    window.close();
});