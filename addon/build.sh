#!/bin/sh
# สร้างไฟล์ .mcaddon 2 แบบ: เซิฟ BDS และ โลกธรรมดา (ใช้โค้ดชุดเดียวกัน)
set -e
cd "$(dirname "$0")"
OUT=${1:-dist}; rm -rf "$OUT/tmp"; mkdir -p "$OUT/tmp/s" "$OUT/tmp/w"
cp -r BP "$OUT/tmp/s/AstraNovaVoice_Server_BP"; cp -r RP "$OUT/tmp/s/AstraNovaVoice_RP"
mkdir -p "$OUT/tmp/w/AstraNovaVoice_World_BP"
cp -r BP/items BP/recipes BP/scripts BP_WORLD/manifest.json BP_WORLD/pack_icon.png "$OUT/tmp/w/AstraNovaVoice_World_BP/"
rm -f "$OUT/tmp/w/AstraNovaVoice_World_BP/scripts/entry_server.js"
cp -r RP "$OUT/tmp/w/AstraNovaVoice_RP"
OUTABS=$(cd "$OUT" && pwd)
(cd "$OUT/tmp/s" && rm -f "$OUTABS/AstraNovaVoice-Server.mcaddon" && zip -qr "$OUTABS/AstraNovaVoice-Server.mcaddon" .)
(cd "$OUT/tmp/w" && rm -f "$OUTABS/AstraNovaVoice-World.mcaddon" && zip -qr "$OUTABS/AstraNovaVoice-World.mcaddon" .)
rm -rf "$OUT/tmp"; ls -la "$OUT"
