#!/usr/bin/env python3
"""
Benchmark & Resource Profiler for Multi-Provider Docker Stack
Measures CPU, RAM (Usage/Peak), PIDs, and Network I/O for all containers.
Compares total usage against Render.com Free Tier limits (512 MB RAM, 0.1 CPU).
"""

import os
import sys
import time
import json
import argparse
import subprocess
from datetime import datetime
from statistics import mean, median

def parse_size_to_bytes(size_str: str) -> float:
    """Converts Docker memory size strings (e.g. '21.62MiB', '1.2GiB', '500kB') to bytes."""
    size_str = size_str.strip().replace(" ", "")
    units = {
        'b': 1,
        'k': 1000, 'kb': 1000, 'kib': 1024,
        'm': 1000**2, 'mb': 1000**2, 'mib': 1024**2,
        'g': 1000**3, 'gb': 1000**3, 'gib': 1024**3,
        't': 1000**4, 'tb': 1000**4, 'tib': 1024**4
    }
    
    # Extract number and unit
    num_part = ""
    unit_part = ""
    for char in size_str:
        if char.isdigit() or char in '.-+':
            num_part += char
        else:
            unit_part += char.lower()
            
    if not num_part:
        return 0.0
        
    try:
        val = float(num_part)
    except ValueError:
        return 0.0
        
    multiplier = units.get(unit_part, 1)
    return val * multiplier

def parse_cpu_perc(cpu_str: str) -> float:
    """Converts CPU percentage string (e.g. '4.45%') to float."""
    try:
        return float(cpu_str.strip().replace('%', ''))
    except (ValueError, AttributeError):
        return 0.0

def get_docker_stats():
    """Runs `docker stats --no-stream` and returns parsed list of container metrics."""
    format_str = '{"name":"{{.Name}}","id":"{{.ID}}","cpu":"{{.CPUPerc}}","mem_usage":"{{.MemUsage}}","mem_perc":"{{.MemPerc}}","net_io":"{{.NetIO}}","block_io":"{{.BlockIO}}","pids":"{{.PIDs}}"}'
    cmd = ["docker", "stats", "--no-stream", "--format", format_str]
    
    try:
        result = subprocess.run(cmd, capture_output=True, text=True, check=True)
    except subprocess.CalledProcessError as e:
        print(f"[-] Docker stats error: {e}", file=sys.stderr)
        return []
    except FileNotFoundError:
        print("[-] Docker is not installed or not in PATH", file=sys.stderr)
        return []
        
    containers = []
    for line in result.stdout.strip().split('\n'):
        line = line.strip()
        if not line:
            continue
        try:
            data = json.loads(line)
            # mem_usage is typically "21.62MiB / 62.67GiB"
            mem_raw = data.get("mem_usage", "0B / 0B")
            used_str = mem_raw.split('/')[0].strip() if '/' in mem_raw else mem_raw.strip()
            
            used_bytes = parse_size_to_bytes(used_str)
            cpu_val = parse_cpu_perc(data.get("cpu", "0%"))
            pids_val = 0
            try:
                pids_val = int(data.get("pids", 0))
            except (ValueError, TypeError):
                pids_val = 0
                
            containers.append({
                "name": data.get("name", "unknown"),
                "id": data.get("id", ""),
                "cpu": cpu_val,
                "mem_bytes": used_bytes,
                "mem_mib": used_bytes / (1024 * 1024),
                "mem_raw": used_str,
                "net_io": data.get("net_io", "0B / 0B"),
                "pids": pids_val
            })
        except Exception:
            continue
            
    return containers

def start_containers_with_profile(profile="all"):
    """Starts docker compose with specified profile."""
    print(f"[*] Démarrage des conteneurs avec COMPOSE_PROFILES={profile}...")
    env = os.environ.copy()
    env["COMPOSE_PROFILES"] = profile
    cmd = ["docker", "compose", "-p", "proxy_docker", "up", "-d"]
    subprocess.run(cmd, env=env, check=True)
    print("[*] Stabilisation des conteneurs (attente 8s)...")
    time.sleep(8)

def format_table_row(cols, widths, alignments=None):
    """Formats a row for terminal table printing."""
    if alignments is None:
        alignments = ['left'] * len(cols)
    out = []
    for col, width, align in zip(cols, widths, alignments):
        s = str(col)
        if len(s) > width:
            s = s[:width - 3] + "..."
        if align == 'right':
            out.append(s.rjust(width))
        elif align == 'center':
            out.append(s.center(width))
        else:
            out.append(s.ljust(width))
    return "| " + " | ".join(out) + " |"

def run_benchmark(duration_sec=45, interval_sec=1.0, render_ram_mb=512.0, render_cpu_share=10.0, filter_proxy_only=True):
    """
    Main benchmark sampling loop.
    render_ram_mb: 512 MB (Render Free Tier)
    render_cpu_share: 10% of 1 core (Render Free Tier 0.1 shared vCPU)
    """
    start_time = time.time()
    end_time = start_time + duration_sec
    
    # Store time series per container
    # container_name -> { 'cpu': [], 'mem_mib': [], 'pids': [], 'net_io': last }
    history = {}
    total_cpu_history = []
    total_mem_history = []
    
    sample_count = 0
    print(f"\n🚀 Lancement du benchmark pour {duration_sec}s (échantillonnage toutes les {interval_sec}s)...")
    print(f"⚙️  Plafonds Render.com comparés : RAM = {render_ram_mb} MiB | CPU = {render_cpu_share}% (0.1 vCPU)\n")
    
    known_project_containers = {
        "gateway-isp-1", "gateway-isp-2", "gateway-isp-3", "gateway-isp-4",
        "isp-dashboard",
        "antgain-1", "antgain-2", "antgain-3", "antgain-4",
        "honeygain-1", "honeygain-2", "honeygain-3", "honeygain-4",
        "packetstream-1", "packetstream-2", "packetstream-3", "packetstream-4",
        "pawns-1", "pawns-2", "pawns-3", "pawns-4",
        "repocket-1", "repocket-2", "repocket-3", "repocket-4"
    }

    try:
        while time.time() < end_time:
            now = time.time()
            elapsed = now - start_time
            remaining = max(0.0, end_time - now)
            
            stats = get_docker_stats()
            sample_count += 1
            
            # Filter if needed
            if filter_proxy_only:
                stats = [c for c in stats if c['name'] in known_project_containers or 'proxy' in c['name'] or 'isp' in c['name']]
                
            sample_total_cpu = sum(c['cpu'] for c in stats)
            sample_total_mem = sum(c['mem_mib'] for c in stats)
            
            total_cpu_history.append(sample_total_cpu)
            total_mem_history.append(sample_total_mem)
            
            for c in stats:
                name = c['name']
                if name not in history:
                    history[name] = {
                        'cpu': [],
                        'mem_mib': [],
                        'pids': [],
                        'net_io': c['net_io']
                    }
                history[name]['cpu'].append(c['cpu'])
                history[name]['mem_mib'].append(c['mem_mib'])
                history[name]['pids'].append(c['pids'])
                history[name]['net_io'] = c['net_io']
                
            # Progress bar on terminal
            progress_pct = min(100, int((elapsed / duration_sec) * 100))
            bar_len = 30
            filled = int((progress_pct / 100) * bar_len)
            bar = '█' * filled + '░' * (bar_len - filled)
            
            sys.stdout.write(
                f"\r[{bar}] {progress_pct:3d}% | Temps restant: {remaining:4.1f}s | "
                f"RAM actuelle: {sample_total_mem:6.1f} MiB ({sample_total_mem / render_ram_mb * 100:5.1f}% Render) | "
                f"CPU actuel: {sample_total_cpu:5.1f}% ({sample_total_cpu / render_cpu_share * 100:5.1f}% de 0.1 vCPU)"
            )
            sys.stdout.flush()
            
            time.sleep(interval_sec)
            
    except KeyboardInterrupt:
        print("\n[!] Benchmark interrompu par l'utilisateur.")
        
    print("\n\n" + "=" * 90)
    print("📊 RÉSULTATS DU BENCHMARK DE CONSOMMATION RESSOURCES")
    print("=" * 90)
    
    if not history:
        print("[-] Aucun conteneur Docker détecté pendant le benchmark.")
        return None
        
    # Compile summary per container
    results = []
    for name, data in sorted(history.items()):
        cpu_arr = data['cpu']
        mem_arr = data['mem_mib']
        pids_arr = data['pids']
        
        avg_cpu = mean(cpu_arr) if cpu_arr else 0.0
        peak_cpu = max(cpu_arr) if cpu_arr else 0.0
        min_mem = min(mem_arr) if mem_arr else 0.0
        avg_mem = mean(mem_arr) if mem_arr else 0.0
        peak_mem = max(mem_arr) if mem_arr else 0.0
        avg_pids = round(mean(pids_arr)) if pids_arr else 0
        
        results.append({
            'name': name,
            'avg_cpu': avg_cpu,
            'peak_cpu': peak_cpu,
            'min_mem': min_mem,
            'avg_mem': avg_mem,
            'peak_mem': peak_mem,
            'pids': avg_pids,
            'net_io': data['net_io']
        })
        
    # Print container breakdown table
    headers = ["Conteneur", "RAM Moy (MiB)", "RAM Pic (MiB)", "% Render 512M", "CPU Moy (%)", "CPU Pic (%)", "% Render 0.1vCPU", "PIDs"]
    widths = [18, 14, 14, 14, 12, 12, 18, 6]
    aligns = ['left', 'right', 'right', 'right', 'right', 'right', 'right', 'right']
    
    sep_line = "+-" + "-+-".join("-" * w for w in widths) + "-+"
    print(sep_line)
    print(format_table_row(headers, widths, aligns))
    print(sep_line)
    
    for r in results:
        row = [
            r['name'],
            f"{r['avg_mem']:.2f}",
            f"{r['peak_mem']:.2f}",
            f"{(r['avg_mem'] / render_ram_mb * 100):.1f}%",
            f"{r['avg_cpu']:.2f}%",
            f"{r['peak_cpu']:.2f}%",
            f"{(r['avg_cpu'] / render_cpu_share * 100):.1f}%",
            str(r['pids'])
        ]
        print(format_table_row(row, widths, aligns))
        
    print(sep_line)
    
    # Overall Stack Totals
    avg_total_mem = mean(total_mem_history) if total_mem_history else 0.0
    peak_total_mem = max(total_mem_history) if total_mem_history else 0.0
    avg_total_cpu = mean(total_cpu_history) if total_cpu_history else 0.0
    peak_total_cpu = max(total_cpu_history) if total_cpu_history else 0.0
    
    total_row = [
        "TOTAL STACK",
        f"{avg_total_mem:.2f}",
        f"{peak_total_mem:.2f}",
        f"{(avg_total_mem / render_ram_mb * 100):.1f}%",
        f"{avg_total_cpu:.2f}%",
        f"{peak_total_cpu:.2f}%",
        f"{(avg_total_cpu / render_cpu_share * 100):.1f}%",
        str(sum(r['pids'] for r in results))
    ]
    print(format_table_row(total_row, widths, aligns))
    print(sep_line)
    
    # Evaluation against Render Limits
    print("\n" + "=" * 90)
    print("🎯 ANALYSE D'ÉLIGIBILITÉ & VERDICT RENDER.COM (FREE TIER : 512 Mo RAM / 0.1 vCPU)")
    print("=" * 90)
    
    mem_status = "✅ CONFORME" if peak_total_mem < render_ram_mb * 0.85 else ("⚠️ LIMITE" if peak_total_mem < render_ram_mb else "❌ DÉPASSEMENT (OOM)")
    cpu_status = "✅ CONFORME" if avg_total_cpu < render_cpu_share else ("⚠️ THROTTLING PROBABLE" if avg_total_cpu < render_cpu_share * 2 else "❌ SATURATION CPU SÉVÈRE")
    
    print(f"1. Consommation RAM Totale : {avg_total_mem:.1f} MiB en moyenne (Pic: {peak_total_mem:.1f} MiB / {render_ram_mb:.0f} MiB max) -> [{mem_status}]")
    print(f"   - Ratio d'utilisation RAM Render : {(avg_total_mem / render_ram_mb * 100):.1f}% (Pic à {(peak_total_mem / render_ram_mb * 100):.1f}%)")
    print(f"2. Consommation CPU Totale : {avg_total_cpu:.2f}% en moyenne (Pic: {peak_total_cpu:.2f}% / 10.0% alloué par 0.1 vCPU) -> [{cpu_status}]")
    print(f"   - Ratio d'utilisation CPU Render : {(avg_total_cpu / render_cpu_share * 100):.1f}% de la capacité 0.1 vCPU")
    
    print("\n3. Contraintes d'Infrastructure Clés :")
    print("   ❌ Docker-in-Docker / Compose : Render ne fournit PAS de démon Docker dans un service Web.")
    print("   ❌ Support TUN & NET_ADMIN    : Render refuse les privilèges 'cap_add: NET_ADMIN' nécessaires à tun2socks.")
    print("   ❌ Mode Veille (Spin-down)    : Render Free Tier s'arrête après 15 min sans requête Web entrante.")
    print("   ❌ Type d'IP (Datacenter)     : Les régies de monétisation pénalisent ou bannissent les IP Datacenter de Render.")
    
    summary_data = {
        "timestamp": datetime.now().isoformat(),
        "duration_sec": duration_sec,
        "sample_count": sample_count,
        "render_limits": {
            "ram_mib": render_ram_mb,
            "cpu_share_pct": render_cpu_share
        },
        "totals": {
            "avg_ram_mib": avg_total_mem,
            "peak_ram_mib": peak_total_mem,
            "avg_cpu_pct": avg_total_cpu,
            "peak_cpu_pct": peak_total_cpu,
            "ram_usage_render_pct": (avg_total_mem / render_ram_mb * 100),
            "cpu_usage_render_pct": (avg_total_cpu / render_cpu_share * 100)
        },
        "containers": results
    }
    
    return summary_data

def export_markdown_report(summary_data, filepath="benchmark_report.md"):
    """Exports benchmark results to a formatted Markdown report."""
    if not summary_data:
        return
        
    t = summary_data["totals"]
    lim = summary_data["render_limits"]
    
    md = []
    md.append("# Rapport de Benchmark CPU & RAM - Multi-Fournisseurs Docker\n")
    md.append(f"**Date du test** : {summary_data['timestamp']}  ")
    md.append(f"**Durée d'échantillonnage** : {summary_data['duration_sec']}s ({summary_data['sample_count']} échantillons)  ")
    md.append(f"**Cible comparée** : Render.com Free Tier (RAM : {lim['ram_mib']} Mo | CPU : 0.1 vCPU / {lim['cpu_share_pct']}%)\n")
    
    md.append("## 1. Tableau Récapitulatif par Conteneur\n")
    md.append("| Conteneur | RAM Moy (MiB) | RAM Pic (MiB) | % Quota Render 512M | CPU Moy (%) | CPU Pic (%) | % 0.1 vCPU | PIDs | I/O Réseau |")
    md.append("| :--- | :---: | :---: | :---: | :---: | :---: | :---: | :---: | :---: |")
    
    for c in summary_data["containers"]:
        ram_render_pct = (c['avg_mem'] / lim['ram_mib']) * 100
        cpu_render_pct = (c['avg_cpu'] / lim['cpu_share_pct']) * 100
        md.append(
            f"| `{c['name']}` | **{c['avg_mem']:.2f}** | {c['peak_mem']:.2f} | {ram_render_pct:.1f}% | "
            f"**{c['avg_cpu']:.2f}%** | {c['peak_cpu']:.2f}% | {cpu_render_pct:.1f}% | {c['pids']} | {c['net_io']} |"
        )
        
    tot_ram_render_pct = (t['avg_ram_mib'] / lim['ram_mib']) * 100
    tot_cpu_render_pct = (t['avg_cpu_pct'] / lim['cpu_share_pct']) * 100
    md.append(
        f"| **TOTAL STACK** | **{t['avg_ram_mib']:.2f}** | **{t['peak_ram_mib']:.2f}** | **{tot_ram_render_pct:.1f}%** | "
        f"**{t['avg_cpu_pct']:.2f}%** | **{t['peak_cpu_pct']:.2f}%** | **{tot_cpu_render_pct:.1f}%** | **-** | **-** |\n"
    )
    
    md.append("## 2. Analyse de Faisabilité Render.com (512 Mo / 0.1 CPU)\n")
    
    if t['peak_ram_mib'] < lim['ram_mib'] * 0.8:
        md.append(f"- **Mémoire RAM** : ✅ **Théoriquement compatible** ({t['avg_ram_mib']:.1f} MiB moy, pic à {t['peak_ram_mib']:.1f} MiB sur 512 MiB dispo).")
    else:
        md.append(f"- **Mémoire RAM** : ⚠️ **Risque élevé de Crash OOM (Out-of-Memory)** (Pic observé à {t['peak_ram_mib']:.1f} MiB).")
        
    if t['avg_cpu_pct'] < lim['cpu_share_pct']:
        md.append(f"- **Processeur CPU** : ✅ **Charge modérée** ({t['avg_cpu_pct']:.2f}% sur les 10% alloués).")
    else:
        md.append(f"- **Processeur CPU** : ⚠️ **Surcharge CPU** ({t['avg_cpu_pct']:.2f}% dépasse les 10% alloués par 0.1 vCPU).")
        
    md.append("\n## 3. Verdict & Bloquants d'Architecture sur Render.com\n")
    md.append("> [!CAUTION]\n> Même si la mémoire totale pouvait tenir sous 512 Mo, le déploiement sur Render.com Free Tier **échouera** pour les raisons techniques suivantes :\n")
    md.append("1. **Pas de support TUN (`/dev/net/tun`) ni `CAP_NET_ADMIN`** : Le conteneur `gateway-isp` (`tun2socks`) ne peut pas monter de carte réseau virtuelle sur Render.")
    md.append("2. **Pas d'Orchestrateur Docker / Docker Compose** : Render exécute un conteneur unique et n'offre pas d'accès au socket Docker pour le dashboard.")
    md.append("3. **Mise en sommeil après 15 minutes** : Sans requêtes HTTP en continu, le conteneur gratuit s'endort automatiquement.")
    md.append("4. **IP Datacenter (Hosting)** : Les régies de monétisation (Pawns, Honeygain, Repocket) bloquent ou dévaluent drastiquement les nœuds hébergés sur des IP cloud comme Render (AWS/Cloudflare).\n")
    
    md.append("## 4. Recommandations d'Hébergement\n")
    md.append("- **VPS KVM Low-Cost (3€ - 4€/mois)** : Hetzner Cloud (CX22, 2 vCPU, 4GB RAM) ou OVHcloud VPS Starter. Offre un noyau Linux complet avec TUN natif, Docker Compose, et fonctionnement 24/7/365.")
    md.append("- **Oracle Cloud Always Free** : 4 OCPU ARM Ampere + 24 Go de RAM entièrement gratuits à vie avec support Docker natif et accès root.")
    
    with open(filepath, 'w', encoding='utf-8') as f:
        f.write("\n".join(md))
        
    print(f"\n[✓] Rapport Markdown exporté avec succès : {filepath}")

def main():
    parser = argparse.ArgumentParser(description="Benchmark Docker CPU/RAM & Analyse Render.com")
    parser.add_argument("-d", "--duration", type=int, default=45, help="Durée du benchmark en secondes (défaut: 45s)")
    parser.add_argument("-i", "--interval", type=float, default=1.0, help="Intervalle d'échantillonnage en secondes (défaut: 1.0s)")
    parser.add_argument("-p", "--profile", type=str, default=None, help="Lancer docker compose avec ce profil (ex: 'all') avant le benchmark")
    parser.add_argument("-o", "--output", type=str, default="benchmark_report.md", help="Fichier de sortie du rapport Markdown")
    parser.add_argument("--json", type=str, default=None, help="Fichier de sortie JSON des métriques")
    parser.add_argument("--no-start", action="store_true", help="Ne pas démarrer de conteneurs, profiler l'état existant")
    
    args = parser.parse_args()
    
    if args.profile and not args.no_start:
        start_containers_with_profile(args.profile)
        
    data = run_benchmark(
        duration_sec=args.duration,
        interval_sec=args.interval,
        render_ram_mb=512.0,
        render_cpu_share=10.0,
        filter_proxy_only=True
    )
    
    if data:
        export_markdown_report(data, args.output)
        if args.json:
            with open(args.json, 'w', encoding='utf-8') as jf:
                json.dump(data, jf, indent=2)
            print(f"[✓] Données JSON exportées vers : {args.json}")

if __name__ == "__main__":
    main()
