# Rapport de Benchmark CPU & RAM - Multi-Fournisseurs Docker

**Date du test** : 2026-08-18T15:12:09.033010  
**Durée d'échantillonnage** : 45s (15 échantillons)  
**Cible comparée** : Render.com Free Tier (RAM : 512.0 Mo | CPU : 0.1 vCPU / 10.0%)

## 1. Tableau Récapitulatif par Conteneur

| Conteneur | RAM Moy (MiB) | RAM Pic (MiB) | % Quota Render 512M | CPU Moy (%) | CPU Pic (%) | % 0.1 vCPU | PIDs | I/O Réseau |
| :--- | :---: | :---: | :---: | :---: | :---: | :---: | :---: | :---: |
| `gateway-isp` | **22.08** | 25.71 | 4.3% | **2.85%** | 6.99% | 28.5% | 38 | 8.48MB / 542kB |
| `honeygain` | **10.84** | 12.62 | 2.1% | **0.26%** | 2.89% | 2.6% | 26 | 8.49MB / 547kB |
| `isp-dashboard` | **13.85** | 21.54 | 2.7% | **0.69%** | 5.09% | 6.9% | 13 | 14kB / 15.8kB |
| `packetstream` | **9.03** | 10.23 | 1.8% | **3.55%** | 10.42% | 35.5% | 14 | 8.49MB / 547kB |
| `pawns` | **7.13** | 7.30 | 1.4% | **0.04%** | 0.28% | 0.4% | 16 | 8.49MB / 547kB |
| `proxyrack-pop` | **30.46** | 35.38 | 5.9% | **1.02%** | 9.90% | 10.2% | 20 | 8.49MB / 547kB |
| `repocket` | **13.33** | 13.35 | 2.6% | **0.05%** | 0.76% | 0.5% | 11 | 8.49MB / 547kB |
| **TOTAL STACK** | **106.72** | **115.21** | **20.8%** | **8.46%** | **20.81%** | **84.6%** | **-** | **-** |

## 2. Analyse de Faisabilité Render.com (512 Mo / 0.1 CPU)

- **Mémoire RAM** : ✅ **Théoriquement compatible** (106.7 MiB moy, pic à 115.2 MiB sur 512 MiB dispo).
- **Processeur CPU** : ✅ **Charge modérée** (8.46% sur les 10% alloués).

## 3. Verdict & Bloquants d'Architecture sur Render.com

> [!CAUTION]
> Même si la mémoire totale pouvait tenir sous 512 Mo, le déploiement sur Render.com Free Tier **échouera** pour les raisons techniques suivantes :

1. **Pas de support TUN (`/dev/net/tun`) ni `CAP_NET_ADMIN`** : Le conteneur `gateway-isp` (`tun2socks`) ne peut pas monter de carte réseau virtuelle sur Render.
2. **Pas d'Orchestrateur Docker / Docker Compose** : Render exécute un conteneur unique et n'offre pas d'accès au socket Docker pour le dashboard.
3. **Mise en sommeil après 15 minutes** : Sans requêtes HTTP en continu, le conteneur gratuit s'endort automatiquement.
4. **IP Datacenter (Hosting)** : Les régies de monétisation (Pawns, Honeygain, Repocket) bloquent ou dévaluent drastiquement les nœuds hébergés sur des IP cloud comme Render (AWS/Cloudflare).

## 4. Recommandations d'Hébergement

- **VPS KVM Low-Cost (3€ - 4€/mois)** : Hetzner Cloud (CX22, 2 vCPU, 4GB RAM) ou OVHcloud VPS Starter. Offre un noyau Linux complet avec TUN natif, Docker Compose, et fonctionnement 24/7/365.
- **Oracle Cloud Always Free** : 4 OCPU ARM Ampere + 24 Go de RAM entièrement gratuits à vie avec support Docker natif et accès root.