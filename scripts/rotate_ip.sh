#!/usr/bin/env bash
set -e

DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
cd "$DIR"

echo "========================================================"
echo " Rotation d'Adresse IP (Passerelle ISP)"
echo "========================================================"

# Si un proxy avec rotation de session (ex: FlameProxies) est configuré
if grep -q "session-" .env 2>/dev/null; then
    NEW_SESSION="fresh$(head -c 4 /dev/urandom | od -An -tu2 | tr -d ' ')"
    echo "[*] Détection d'un fournisseur avec rotation de session."
    echo "[*] Génération de la nouvelle session : $NEW_SESSION"
    
    python3 -c "
from pathlib import Path
import re
env_file = Path('.env')
if env_file.exists():
    content = env_file.read_text()
    new_content = re.sub(r'session-[a-zA-Z0-9]+', 'session-$NEW_SESSION', content)
    env_file.write_text(new_content)
"
    ./scripts/switch_isp_proxy.sh
else
    echo "[*] Redémarrage de la passerelle pour renouveler la connexion..."
    docker compose -p "proxy_docker" restart gateway-isp
fi

echo ""
echo "[✓] Demande de rotation exécutée avec succès."
echo "[*] Vérification du nouveau statut dans 3 secondes :"
sleep 3
./scripts/status.sh
