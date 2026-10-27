@echo off
chcp 65001 >nul
rem Windows용 배포 zip 생성 (deploy.sh와 같은 파일 구성)
rem Windows 10 이상에 기본 포함된 tar.exe를 사용하므로 7-Zip 설치가 필요 없음
setlocal enabledelayedexpansion
cd /d "%~dp0"

for /f %%i in ('powershell -NoProfile -Command "Get-Date -Format yyyyMMdd_HHmmss"') do set STAMP=%%i
if not exist release mkdir release

rem 애드온에 필요한 파일만 압축 (deploy.sh, deploy.bat, .github, README 등은 제외)
set FILES=Kemono_Downloader.js event_page.js manifest.json LICENSE icon.svg _locales
for %%f in (popup.* settings.* update-notes.* icon_*.png) do set FILES=!FILES! %%f

tar -a -c -f "release\%STAMP%.zip" %FILES%
if errorlevel 1 (
  echo 압축에 실패했습니다.
  pause
  exit /b 1
)
echo release\%STAMP%.zip 생성 완료
pause
