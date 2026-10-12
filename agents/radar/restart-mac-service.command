#!/bin/bash
# restart-mac-service.command — restartuje službu TradeRadara (cz.ainet.radar) na Macu,
# aby po stažení nové verze z GitHubu běžela s novým kódem. Nic neinstaluje, nic nemaže.
# Dvojklik ve Finderu, nebo: bash agents/radar/restart-mac-service.command
cd "$(dirname "$0")/../.." || exit 1
SLUZBA="gui/$(id -u)/cz.ainet.radar"
echo "AInet — restart workeru TradeRadar"
echo "Verze v repozitáři: $(git log --oneline -1 2>/dev/null)"
if launchctl print "$SLUZBA" >/dev/null 2>&1; then
  if launchctl kickstart -k "$SLUZBA"; then
    sleep 4
    echo "✓ Služba restartována — běží s novým kódem."
    launchctl print "$SLUZBA" 2>/dev/null | grep -E "^\s*(state|pid) =" | head -2
    echo "--- konec logu (agents/radar/denik/worker.log):"
    tail -n 6 agents/radar/denik/worker.log 2>/dev/null
  else
    echo "✗ Restart se nepovedl."
  fi
else
  echo "✗ Služba cz.ainet.radar není nainstalovaná — spusť install-mac-service.command."
fi
echo
echo "Okno můžeš zavřít."
