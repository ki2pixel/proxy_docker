#!/usr/bin/env bash
# ==============================================================================
# Rotation de TOUS les secrets du .env
# Génère de nouvelles valeurs aléatoires pour chaque clé sensible et affiche
# les étapes manuelles à effectuer côté plateformes de monétisation.
# ==============================================================================
set -euo pipefail

DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
cd "$DIR"

ENV_FILE=".env"

if [ ! -f "$ENV_FILE" ]; then
    echo "[-] Fichier $ENV_FILE introuvable."
    exit 1
fi

echo "========================================================"
echo "🔄 Rotation des secrets du fichier .env"
echo "========================================================"
echo "[!] Avant de continuer :"
echo "    - Une sauvegarde automatique sera créée (.env.bak.<timestamp>)."
echo "    - Les anciens identifiants seront INVALIDÉS côté plateformes."
echo ""
read -r -p "Taper 'ROTATE' pour confirmer : " CONFIRM
if [ "$CONFIRM" != "ROTATE" ]; then
    echo "[-] Annulé."
    exit 1
fi

# Génération d'une valeur aléatoire
gen() {
    openssl rand -hex 24
}

# Sauvegarde de sécurité
BACKUP="${ENV_FILE}.bak.$(date +%s)"
cp "$ENV_FILE" "$BACKUP"
echo "[+] Sauvegarde : $BACKUP"

# Nouvelles valeurs
UPDATES_JSON=$(python3 -c "
import json, subprocess, sys
def gen():
    return subprocess.check_output(['openssl', 'rand', '-hex', '24']).decode().strip()
keys = [
    'DASHBOARD_TOKEN', 'DASHBOARD_SECRET',
    'ISP_PROXY_USER', 'ISP_PROXY_PASS',
    'EARNFM_TOKEN', 'HONEYGAIN_PASSWORD', 'PAWNS_PASSWORD',
    'PACKETSTREAM_CID', 'REPOCKET_API_KEY'
]
print(json.dumps({k: gen() for k in keys}))
")

python3 -c "
import json, sys
from pathlib import Path

env_path = Path('.env')
updates = json.loads(sys.stdin.read())

lines = env_path.read_text().splitlines()
out = []
done = set()
for line in lines:
    key = line.split('=', 1)[0]
    if key in updates:
        out.append(f'{key}=\"{updates[key]}\"')
        done.add(key)
    else:
        out.append(line)
for key, val in updates.items():
    if key not in done:
        out.append(f'{key}=\"{val}\"')
env_path.write_text('\n'.join(out) + '\n')
print(f'[✓] {len(updates)} clés mises à jour dans .env.')
" <<< "$UPDATES_JSON"

echo ""
echo "========================================================"
echo "✅ Rotation effectuée."
echo "========================================================"
echo "⚠️  Actions manuelles REQUISES :"
echo "  1. Proxy ISP (fournisseur amont) : mettre à jour ISP_PROXY_USER / ISP_PROXY_PASS"
echo "  2. EarnFM     : EARNFM_TOKEN → https://app.earn.fm (Settings → API Key)."
echo "  3. Honeygain   : HONEYGAIN_PASSWORD → https://dashboard.honeygain.com (profil)."
echo "  4. Pawns.app   : PAWNS_PASSWORD → https://pawns.app (profil)."
echo "  5. Repocket    : REPOCKET_API_KEY → https://app.repocket.com (API keys)."
echo "  6. Dashboard   : utilisez le nouveau DASHBOARD_TOKEN pour vous connecter."
echo ""
echo "[*] Puis redémarrez : docker compose -p proxy_docker up -d --build"
echo "[*] Sauvegarde de l'ancien .env : $BACKUP (à supprimer après validation)."
echo "========================================================"
