@echo off
set PORT=24220
set BASE_PATH=/
pnpm --filter @workspace/trading-dashboard run dev --force
