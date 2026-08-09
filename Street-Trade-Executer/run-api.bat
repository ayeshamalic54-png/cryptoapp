@echo off
set PORT=8090
set "DATABASE_URL=postgresql://neondb_owner:npg_exiOFlobNQ72@ep-flat-star-azruayb4-pooler.c-3.ap-southeast-1.aws.neon.tech/neondb?sslmode=verify-full&channel_binding=require"
set NODE_ENV=development
node --enable-source-maps artifacts/api-server/dist/index.mjs
