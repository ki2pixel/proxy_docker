#!/usr/bin/env bash
set -euo pipefail

DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
source "$DIR/lib.sh"

cd "$PROJECT_ROOT"

echo "========================================================"
echo " Rotation d'Adresse IP (Passerelle ISP)"
echo "========================================================"

load_env
PROXY_USER=$(get_env ISP_PROXY_USER)

# Rotation de session : uniquement pour les proxys résidentiels à session
# (type FlameProxies "session-..."). Pour un proxy classique HOST:PORT:USER:PASS,
# il n'y a pas de session à faire tourner — on se contente de redémarrer la
# passerelle pour renouveler la connexion TCP.
if [[ "$PROXY_USER" == *"session-"* ]]; then
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
    echo "[*] Proxy classique (sans session résidentielle) : redémarrage du tunnel uniquement."
    docker compose -p "$PROJECT_NAME" restart gateway-isp
fi

echo ""
echo "[✓] Demande de rotation exécutée avec succès."
echo "[*] Vérification du nouveau statut dans 3 secondes :"
sleep 3
./scripts/status.sh
