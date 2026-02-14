@echo off
start "" python -m http.server 8000

timeout /t 1 > nul

start "" "http://localhost:8090/fbx_joint_fixed.html"
