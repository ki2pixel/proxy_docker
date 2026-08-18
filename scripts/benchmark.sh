#!/usr/bin/env bash
set -e

DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
cd "$DIR"

echo "========================================================"
echo " Benchmark CPU / RAM : Multi-Fournisseurs Docker"
echo " Simulation de Charge & Analyse d'Éligibilité Render.com"
echo "========================================================"

MODE="${1:---all}"
DURATION="${2:-45}"

case "$MODE" in
  --all|-a|all)
    echo "[*] Mode : Activation de TOUS les fournisseurs (profil 'all')..."
    python3 scripts/benchmark.py --profile all --duration "$DURATION"
    ;;
  --current|-c|current)
    echo "[*] Mode : Profilage des conteneurs actuellement en cours d'exécution..."
    python3 scripts/benchmark.py --no-start --duration "$DURATION"
    ;;
  --help|-h)
    echo "Usage : ./scripts/benchmark.sh [MODE] [DUREE_SECONDES]"
    echo ""
    echo "Modes disponibles :"
    echo "  --all       (défaut) Démarre tous les providers et lance le benchmark"
    echo "  --current   Mesure les conteneurs actuellement en cours d'exécution"
    echo "  --help      Affiche cette aide"
    echo ""
    echo "Exemples :"
    echo "  ./scripts/benchmark.sh           # Test complet pendant 45s"
    echo "  ./scripts/benchmark.sh --all 60  # Test complet pendant 60s"
    echo "  ./scripts/benchmark.sh --current # Test de l'état actuel"
    exit 0
    ;;
  *)
    if [[ "$MODE" =~ ^[0-9]+$ ]]; then
      DURATION="$MODE"
      echo "[*] Mode : Activation de TOUS les fournisseurs pendant ${DURATION}s..."
      python3 scripts/benchmark.py --profile all --duration "$DURATION"
    else
      echo "[-] Option non reconnue : $MODE. Utilisez --help pour l'aide."
      exit 1
    fi
    ;;
esac
