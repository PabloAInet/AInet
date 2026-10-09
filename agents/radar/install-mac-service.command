#!/bin/bash
# install-mac-service.command — nainstaluje worker Radara na Macu jako službu (LaunchAgent):
# běží na pozadí hned po přihlášení uživatele, po pádu se sám znovu spustí, nepotřebuje otevřený Terminál.
# Dvojklik ve Finderu, nebo: bash agents/radar/install-mac-service.command
# Odinstalace:  launchctl bootout gui/$(id -u)/cz.ainet.radar && rm ~/Library/LaunchAgents/cz.ainet.radar.plist
# Log:          agents/radar/denik/worker.log
cd "$(dirname "$0")/../.." || exit 1
REPO="$(pwd)"
ENV_SOUBOR="$HOME/.ainet-radar.env"
if [ ! -f "$ENV_SOUBOR" ]; then
  echo "Radar: vlož obnovovací kód Radara (ze zprávy ve schránce Fabla, začíná d-):"
  read -r KOD
  case "$KOD" in d-*) ;; *) echo "Kód má začínat d- … zkus to znovu."; exit 1;; esac
  { echo "RADAR_OBNOVOVACI_KOD=$KOD"; echo "RADAR_ETAPA=1"; echo "RADAR_LIVE=0"; } > "$ENV_SOUBOR"
  chmod 600 "$ENV_SOUBOR"
  echo "Uloženo do $ENV_SOUBOR (etapa 1, živý účet vypnutý)."
fi
command -v python3 >/dev/null || { echo "Chybí python3 — macOS nabídne instalaci Command Line Tools, potvrď ji a spusť znovu."; exit 1; }
PLIST="$HOME/Library/LaunchAgents/cz.ainet.radar.plist"
mkdir -p "$HOME/Library/LaunchAgents" "$REPO/agents/radar/denik"
cat > "$PLIST" <<EOF
<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0"><dict>
  <key>Label</key><string>cz.ainet.radar</string>
  <key>ProgramArguments</key><array><string>/bin/bash</string><string>$REPO/agents/radar/start-mac.command</string></array>
  <key>WorkingDirectory</key><string>$REPO</string>
  <key>RunAtLoad</key><true/>
  <key>KeepAlive</key><true/>
  <key>ThrottleInterval</key><integer>60</integer>
  <key>StandardOutPath</key><string>$REPO/agents/radar/denik/worker.log</string>
  <key>StandardErrorPath</key><string>$REPO/agents/radar/denik/worker.log</string>
</dict></plist>
EOF
launchctl bootout "gui/$(id -u)/cz.ainet.radar" 2>/dev/null
if launchctl bootstrap "gui/$(id -u)" "$PLIST"; then
  sleep 3
  echo "✓ Radar worker běží jako služba cz.ainet.radar (etapa 1). Log: agents/radar/denik/worker.log"
  tail -n 5 "$REPO/agents/radar/denik/worker.log" 2>/dev/null
  echo "Pozn.: Mac nesmí usínat — Systémová nastavení → Energie → zabránit automatickému uspání."
else
  echo "✗ Službu se nepodařilo spustit. Zkus ručně: bash $REPO/agents/radar/start-mac.command"
fi
