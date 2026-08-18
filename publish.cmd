@echo off
setlocal

rem Публикация @db-state/core, server-mongo и vue в npm одной командой.
rem Токен спрашивается на месте и живёт только в этом окне: пишется во
rem временный npmrc, который стирается в конце. В глобальный ~/.npmrc
rem ничего не попадает.
rem
rem Токен нужен типа Automation (или Publish без 2FA-подтверждения),
rem иначе npm запросит одноразовый код и падёт в неинтерактивном окне.

cd /d "%~dp0" || exit /b 1

set /p NPM_TOKEN=npm token:
if "%NPM_TOKEN%"=="" echo Token is empty & exit /b 1

set "NPM_CONFIG_USERCONFIG=%TEMP%\db-state-publish-npmrc"
> "%NPM_CONFIG_USERCONFIG%" echo //registry.npmjs.org/:_authToken=%NPM_TOKEN%

rem Не публикуем сломанное: сначала весь прогон тестов.
call npm test || goto :cleanup

rem core первым: остальные два от него зависят, и если он не уйдёт,
rem зависимость ^0.3.4 у них повиснет в воздухе.
rem Путь обязательно с .\ — голое packages/core npm принимает за
rem GitHub-шорткат owner/repo и лезет клонировать чужой репозиторий.
call npm publish .\packages\core --access public || goto :cleanup
call npm publish .\packages\server-mongo --access public || goto :cleanup
call npm publish .\packages\vue --access public || goto :cleanup

echo.
echo Опубликовано: core, server-mongo, vue.

:cleanup
del /q "%NPM_CONFIG_USERCONFIG%" 2>nul
endlocal
