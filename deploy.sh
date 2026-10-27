date=$(date '+%Y%m%d_%T' | tr -d :)
# 애드온에 필요한 파일만 압축 (deploy.sh, .github, README 등은 AMO 검사에서 "불필요한 파일" 경고가 뜨므로 제외)
7zz a ./release/$date.zip \
Kemono_Downloader.js event_page.js manifest.json LICENSE \
popup.* settings.* update-notes.* \
icon.svg icon_*.png _locales
