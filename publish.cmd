@echo off
setlocal

rem Публикация @db-state/core, server-mongo и vue в npm.
rem
rem   publish.cmd               все три пакета по порядку
rem   publish.cmd server-mongo  только один (когда остальные уже уехали)
rem
rem Токен спрашивается на месте и живёт только в этом окне: пишется во
rem временный npmrc, который стирается в конце. В глобальный ~/.npmrc
rem ничего не попадает.
rem
rem Токен нужен типа Automation (или Publish без 2FA-подтверждения),
rem иначе npm запросит одноразовый код и падёт в неинтерактивном окне.

cd /d "%~dp0" || exit /b 1

rem Что публикуем: аргумент или все три.
rem
rem Один пакет нужен, когда общий прогон уехал наполовину: повторно
rem опубликовать ту же версию npm не даст, и общий запуск упал бы на первом
rem же шаге, не дойдя до недостающего.
set "TARGETS=core server-mongo vue"
if not "%~1"=="" (
  set "TARGETS=%~1"
  call :known "%~1" || exit /b 1
)

set /p NPM_TOKEN=npm token:
if "%NPM_TOKEN%"=="" echo Token is empty & exit /b 1

set "NPM_CONFIG_USERCONFIG=%TEMP%\db-state-publish-npmrc"
> "%NPM_CONFIG_USERCONFIG%" echo //registry.npmjs.org/:_authToken=%NPM_TOKEN%

rem Не публикуем сломанное: сначала весь прогон тестов.
call npm test
if errorlevel 1 goto :failed

rem Порядок важен: core первым, остальные два от него зависят — если он не
rem уйдёт, зависимость ^x.y.z у них повиснет в воздухе. Список TARGETS уже
rem в нужном порядке, а один пакет порядка не требует.
rem
rem Путь обязательно с .\ — голое packages/core npm принимает за
rem GitHub-шорткат owner/repo и лезет клонировать чужой репозиторий.
rem
rem Код возврата проверяем через errorlevel, а не через ||: у `call npm`
rem (это .cmd-обёртка) оператор || срабатывает не всегда, и однажды
rem server-mongo молча не опубликовался, а скрипт отрапортовал об успехе.
for %%P in (%TARGETS%) do (
  echo.
  echo --- %%P ---
  call npm publish .\packages\%%P --access public
  if errorlevel 1 goto :failed
)

echo.
echo Опубликовано: %TARGETS%
goto :cleanup

:failed
echo.
echo ПУБЛИКАЦИЯ ПРЕРВАНА. Что уже ушло в npm, обратно не вернуть:
echo проверьте `npm view @db-state/^<пакет^> version` и допубликуйте
echo недостающее по одному — publish.cmd ^<пакет^>.
call :cleanup
exit /b 1

rem Опечатка в имени не должна кончаться попыткой опубликовать
rem несуществующую папку: список короткий, проверить его дешевле.
:known
for %%K in (core server-mongo vue) do if "%~1"=="%%K" exit /b 0
echo Неизвестный пакет: %~1
echo Ожидается core, server-mongo или vue.
exit /b 1

:cleanup
del /q "%NPM_CONFIG_USERCONFIG%" 2>nul
endlocal
