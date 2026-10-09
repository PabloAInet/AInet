#!/bin/bash
# start-mac.command — spustí worker Radara na Macu (dvojklik ve Finderu, nebo `bash agents/radar/start-mac.command`).
# Při prvním spuštění se zeptá na obnovovací kód Radara (d-…) a uloží ho mimo repozitář do ~/.ainet-radar.env
# (jen pro tohoto uživatele). Okno Terminálu musí zůstat otevřené — worker běží, dokud ho nezavřeš (Ctrl+C).
# Jedna smyčka na zkoušku:  bash agents/radar/start-mac.command rano
cd "$(dirname "$0")/../.." || exit 1
ENV_SOUBOR="$HOME/.ainet-radar.env"
if [ ! -f "$ENV_SOUBOR" ]; then
  echo "Radar: první spuštění — vlož obnovovací kód Radara (ze zprávy ve schránce Fabla, začíná d-):"
  read -r KOD
  case "$KOD" in d-*) ;; *) echo "Kód má začínat d- … zkus to znovu."; exit 1;; esac
  { echo "RADAR_OBNOVOVACI_KOD=$KOD"; echo "RADAR_ETAPA=1"; echo "RADAR_LIVE=0"; } > "$ENV_SOUBOR"
  chmod 600 "$ENV_SOUBOR"
  echo "Uloženo do $ENV_SOUBOR (etapa 1, živý účet vypnutý). Klíče Alpacy sem přidáš až pro etapu 3."
fi
set -a; . "$ENV_SOUBOR"; set +a
export AINET_BASE="${AINET_BASE:-https://ainet-1e2y.onrender.com}"
command -v python3 >/dev/null || { echo "Chybí python3 — macOS nabídne instalaci Command Line Tools, potvrď ji a spusť znovu."; exit 1; }
echo "Radar worker: etapa ${RADAR_ETAPA:-1}, živě=${RADAR_LIVE:-0}, síť $AINET_BASE — zastavíš Ctrl+C nebo zprávou STOP Radarovi."
exec python3 agents/radar/radar.py "$@"
