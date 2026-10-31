@echo off
chcp 65001 >nul
title 抖音发布队列守护
cd /d "%~dp0"
echo ============================================
echo  抖音定时发布队列（每 30 秒检查一次）
echo  关掉这个窗口 = 停止自动发布
echo ============================================
node scripts/queue-daemon.js
pause
