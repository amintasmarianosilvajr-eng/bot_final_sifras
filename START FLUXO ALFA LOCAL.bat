@echo off
title SIFRAS INVEST - SISTEMA AUTONOMO
color 0b
cd /d "%~dp0"

echo ======================================================
echo           SIFRAS FERRARI - SISTEMA ULTRA
echo          ----------------------------------
echo           MODO SILENCIOSO (MINIMIZADO)
echo ======================================================
echo.

echo [1/3] Verificando Motor...
netstat -ano | findstr :3000 >nul && (
    echo [ALERTA] Uma instancia ja esta rodando! Reiniciando...
    taskkill /F /IM node.exe >nul 2>&1
    timeout /t 1 >nul
)

echo [2/3] Ligando Servidor Blindado...
start /min cmd /c "title SIFRAS_MOTOR_BLINDADO && node server.js"
echo [OK] Motor invisivel ligado na barra de tarefas.
timeout /t 2 >nul

echo [3/3] Abrindo Painel...
start http://localhost:3000

echo.
echo ======================================================
echo    PRONTO! O SISTEMA ESTA RODANDO.
echo    ESTA JANELA VAI SE FECHAR EM 3 SEGUNDOS...
echo ======================================================
timeout /t 3 >nul
exit
