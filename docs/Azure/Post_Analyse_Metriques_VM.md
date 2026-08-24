# Post-analyse des métriques VM — ProxyMonetisation

## Contexte

Suite au déploiement du widget « Performance de la VM » (suivi temps réel CPU/RAM via le sidecar `metrics-host` + API Docker), analyse d'une fenêtre d'observation (~06:18 → 06:47, UTC+02:00) après un pic anormal de CPU et de RAM sur la VM Azure **ProxyMonetisation** (SKU Standard B2ats v2 — 2 vCPU, 1 GiB RAM).

## Synthèse des observations

| Métrique | Régime de croisière | Événement 06:39–06:41 | Situation actuelle |
| :--- | :--- | :--- | :--- |
| **Available Memory %** (Azure) | ~8–12 % (pression continue) | Pic à ~28,5 % (libération soudaine) | ~13 % |
| **CPU Percentage** (Azure) | ~8–14 % | Pic à ~36,5 % (brève hausse) | ~12 % |

## Cause racine du pic de 06:39 — conteneur orphelin en crash-loop

Hypothèses écartées :

- **Déploiement CI** : aucun run GitHub Actions dans la fenêtre (vérifié via l'API GitHub — seuls des runs à 16:37–16:38Z / 18:37–18:38 locale et la veille).
- **OOM killer** : `dmesg` vide, aucune trace de kill mémoire.
- **Conteneur de la stack** : `docker ps` ne montre que les 26 conteneurs légitimes, tous démarrés à 16:38Z avec 0 restart.

Cause confirmée via le journal système (`journalctl`) :

- Un conteneur inconnu (`78423263...`) tournait en **boucle de redémarrage toutes les ~60–75 s** (`restartCount=237+`, `exitCode=1` à chaque cycle).
- À chaque cycle : le daemon Docker tue le conteneur (libération brutale de RAM → pic « Available Memory % ») puis le relance (pic CPU à l'initialisation).
- Ce conteneur n'existe plus aujourd'hui — probablement nettoyé par le `docker compose up --remove-orphans` du workflow `deploy.yml` (18:38 locale).

**Conclusion : le pic était un artefact d'un conteneur orphelin d'une ancienne stack, sans lien avec la stack actuelle.**

## Point de vigilance — pression mémoire chronique

- **848 Mo de RAM** pour 4 passerelles + 20 conteneurs ; ~700 Mo utilisés en régime de croisière.
- **461 Mo de swap utilisés sur 1 Go** — la VM est en pression mémoire chronique (risque de *thrashing*).
- `/proc/pressure/memory` : pression soutenue (some avg10 ≈ 12,8).

## Décision — pas d'upgrade de VM pour l'instant

- Aucun plan Azure gratuit plus performant disponible dans la majorité des régions.
- La **Standard B2ats v2 (2 vCPU, 1 GiB)** reste stable avec 4 passerelles actives.
- Suivi des métriques Azure Monitor (Available Memory %, Percentage CPU) à conserver pour détecter une dégradation.

## Piste d'optimisation future — désactivation des monétiseurs peu rentables

- **Packetstream** est parmi les moins rémunérateurs observés (TraffMonetizer a été remplacé au profit de Antgain).
- Les désactiver libérerait **4 × 2 = 8 conteneurs** (un par passerelle × 4), réduisant la pression RAM de ~200–250 Mo et stabilisant la stack.
- Décision à prendre selon l'évolution des taux de rentabilité observés dans le widget.
