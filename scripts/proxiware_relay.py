#!/usr/bin/env python3
"""
Serveur SOCKS5 avec chaînage vers un proxy parent (SOCKS5).
Relais pour la stack proxy_docker : les gateways Tierhive parlent SOCKS5 (TCP + UDP ASSOCIATE),
chaque connexion est relayée vers le proxy parent Proxiware (IP ISP).

Usage : python3 proxiware_relay.py LISTEN_PORT PARENT_USER PARENT_PASS PARENT_HOST PARENT_PORT
Exemple : python3 proxiware_relay.py 10801 user pass 188.221.160.44 1337
"""
import socket
import sys
import select
import threading
import time

def socks5_auth_parent(parent_sock, user, passwd):
    """Authentifie la connexion SOCKS5 auprès du proxy parent."""
    parent_sock.sendall(b"\x05\x01\x02")
    resp = parent_sock.recv(2)
    if len(resp) != 2 or resp[1] != 0x02:
        raise ValueError("parent ne supporte pas user/pass: %r" % resp)
    u = user.encode()
    p = passwd.encode()
    parent_sock.sendall(b"\x01" + bytes([len(u)]) + u + bytes([len(p)]) + p)
    a = parent_sock.recv(2)
    if len(a) != 2 or a[1] != 0x00:
        raise ValueError("auth parent échouée: %r" % a)


def socks5_connect_parent(parent_sock, user, passwd, host, port):
    """Handshake SOCKS5 CONNECT vers le proxy parent."""
    socks5_auth_parent(parent_sock, user, passwd)
    hostb = host.encode()
    parent_sock.sendall(b"\x05\x01\x00\x03" + bytes([len(hostb)]) + hostb + int(port).to_bytes(2, "big"))
    c = parent_sock.recv(10)
    if len(c) < 4 or c[1] != 0x00:
        raise ValueError("CONNECT parent échoué: %r" % c)


def socks5_udp_associate_parent(parent_sock, user, passwd):
    """Handshake SOCKS5 UDP ASSOCIATE vers le proxy parent.
    Retourne (parent_udp_ip, parent_udp_port)."""
    socks5_auth_parent(parent_sock, user, passwd)
    parent_sock.sendall(b"\x05\x03\x00\x01\x00\x00\x00\x00\x00\x00")
    resp = parent_sock.recv(4)
    if len(resp) < 4 or resp[1] != 0x00:
        raise ValueError("UDP ASSOCIATE parent échoué: %r" % resp)
    atyp = resp[3]
    if atyp == 0x01:  # IPv4
        addr = socket.inet_ntoa(parent_sock.recv(4))
    elif atyp == 0x03:  # Domaine
        dlen = parent_sock.recv(1)[0]
        addr = parent_sock.recv(dlen).decode()
    elif atyp == 0x04:  # IPv6
        addr = socket.inet_ntop(socket.AF_INET6, parent_sock.recv(16))
    else:
        raise ValueError("ATYP non supporté pour UDP ASSOCIATE parent: %d" % atyp)
    port = int.from_bytes(parent_sock.recv(2), "big")
    return addr, port


def handle_udp_associate(client_sock, parent_host, parent_port, parent_user, parent_pass, listen_port):
    """Gère une association SOCKS5 UDP pour un client."""
    parent_tcp = None
    udp_sock = None
    try:
        parent_tcp = socket.create_connection((parent_host, int(parent_port)), timeout=20)
        parent_udp_ip, parent_udp_port = socks5_udp_associate_parent(parent_tcp, parent_user, parent_pass)
        print("  [UDP] Parent bound sur %s:%d" % (parent_udp_ip, parent_udp_port), flush=True)

        udp_sock = socket.socket(socket.AF_INET, socket.SOCK_DGRAM)
        udp_sock.setsockopt(socket.SOL_SOCKET, socket.SO_REUSEADDR, 1)
        try:
            udp_sock.setsockopt(socket.SOL_SOCKET, socket.SO_REUSEPORT, 1)
        except (AttributeError, OSError):
            pass

        # Tenter d'écouter sur le port listen_port UDP, sinon port dynamique
        bound_port = listen_port
        try:
            udp_sock.bind(("0.0.0.0", listen_port))
        except OSError:
            udp_sock.bind(("0.0.0.0", 0))
            bound_port = udp_sock.getsockname()[1]

        # Répondre succès au client avec l'IP 0.0.0.0 et le port UDP assigné
        client_sock.sendall(b"\x05\x00\x00\x01\x00\x00\x00\x00" + bound_port.to_bytes(2, "big"))

        client_udp_addr = None
        parent_target = (parent_udp_ip, parent_udp_port)

        while True:
            # On surveille la déconnexion TCP du client et les paquets UDP
            r, _, _ = select.select([client_sock, udp_sock], [], [], 300)
            if not r:
                # Timeout d'inactivité
                break
            if client_sock in r:
                data = client_sock.recv(1024)
                if not data:
                    # Le client a fermé la connexion de contrôle TCP -> fin de l'association UDP
                    break
            if udp_sock in r:
                pkt, src_addr = udp_sock.recvfrom(65535)
                if not pkt:
                    continue
                if src_addr == parent_target:
                    # Paquet venant du proxy parent -> envoyer au client
                    if client_udp_addr:
                        udp_sock.sendto(pkt, client_udp_addr)
                else:
                    # Paquet venant du client -> envoyer au proxy parent
                    client_udp_addr = src_addr
                    udp_sock.sendto(pkt, parent_target)
    except Exception as e:
        print("  [UDP] Erreur association: %s" % e, flush=True)
    finally:
        if udp_sock:
            try:
                udp_sock.close()
            except OSError:
                pass
        if parent_tcp:
            try:
                parent_tcp.close()
            except OSError:
                pass


def handle_client(client_sock, parent_host, parent_port, parent_user, parent_pass, listen_port):
    try:
        # Handshake SOCKS5 client (méthodes proposées : none ou user/pass)
        client_sock.settimeout(10)
        data = client_sock.recv(2)
        if len(data) != 2 or data[0] != 0x05:
            return
        nmethods = data[1]
        methods = client_sock.recv(nmethods)
        # On choisit user/pass (0x02) si proposé, sinon none (0x00)
        method = 0x02 if b"\x02" in methods else (0x00 if b"\x00" in methods else 0xFF)
        client_sock.sendall(bytes([0x05, method]))
        if method == 0x02:
            # Lire identifiants (ignorés : l'auth parent a ses propres identifiants)
            v = client_sock.recv(1)
            ulen = v[0]
            client_sock.recv(ulen)
            plen = client_sock.recv(1)[0]
            client_sock.recv(plen)
            client_sock.sendall(b"\x01\x00")

        # Lire la requête (CMD: 0x01=CONNECT, 0x03=UDP ASSOCIATE)
        req = client_sock.recv(4)
        if len(req) != 4 or req[0] != 0x05:
            return
        cmd = req[1]
        atyp = req[3]

        if cmd == 0x03:
            # Commande UDP ASSOCIATE
            if atyp == 0x01:
                client_sock.recv(4)
            elif atyp == 0x03:
                dlen = client_sock.recv(1)[0]
                client_sock.recv(dlen)
            elif atyp == 0x04:
                client_sock.recv(16)
            client_sock.recv(2) # Port
            handle_udp_associate(client_sock, parent_host, parent_port, parent_user, parent_pass, listen_port)
            return

        if cmd != 0x01:
            # Commande non supportée
            client_sock.sendall(b"\x05\x07\x00\x01\x00\x00\x00\x00\x00\x00")
            return

        # Commande CONNECT (TCP)
        if atyp == 0x01:  # IPv4
            dest = socket.inet_ntoa(client_sock.recv(4))
            dest_port = int.from_bytes(client_sock.recv(2), "big")
        elif atyp == 0x03:  # Domaine
            dlen = client_sock.recv(1)[0]
            dest = client_sock.recv(dlen).decode()
            dest_port = int.from_bytes(client_sock.recv(2), "big")
        elif atyp == 0x04:  # IPv6
            dest = socket.inet_ntop(socket.AF_INET6, client_sock.recv(16))
            dest_port = int.from_bytes(client_sock.recv(2), "big")
        else:
            return

        # Ouvrir vers le proxy parent (qui fera le CONNECT vers la destination réelle)
        parent = socket.create_connection((parent_host, int(parent_port)), timeout=20)
        parent.settimeout(20)
        socks5_connect_parent(parent, parent_user, parent_pass, dest, dest_port)
        # Répondre succès au client
        client_sock.sendall(b"\x05\x00\x00\x01\x00\x00\x00\x00\x00\x00")

        # Bridge bidirectionnel TCP
        sockets = [client_sock, parent]
        while True:
            r, _, _ = select.select(sockets, [], [], 60)
            if not r:
                break
            for s in r:
                bdata = s.recv(8192)
                if not bdata:
                    return
                other = parent if s is client_sock else client_sock
                other.sendall(bdata)
    except (TimeoutError, ValueError, ConnectionError, OSError):
        pass
    finally:
        try:
            client_sock.close()
        except OSError:
            pass


def main():
    if len(sys.argv) != 6:
        print("Usage: %s LISTEN_PORT PARENT_USER PARENT_PASS PARENT_HOST PARENT_PORT" % sys.argv[0])
        sys.exit(1)
    listen_port = int(sys.argv[1])
    parent_user = sys.argv[2]
    parent_pass = sys.argv[3]
    parent_host = sys.argv[4]
    parent_port = sys.argv[5]

    server = socket.socket(socket.AF_INET, socket.SOCK_STREAM)
    server.setsockopt(socket.SOL_SOCKET, socket.SO_REUSEADDR, 1)
    server.bind(("0.0.0.0", listen_port))
    server.listen(128)
    print("Relais SOCKS5 (TCP+UDP) %s:%s -> %s:%s (%s@%s)" % (parent_host, parent_port, listen_port, parent_port, parent_user, parent_host), flush=True)
    print("En écoute sur %d" % listen_port, flush=True)
    while True:
        client, addr = server.accept()
        threading.Thread(target=handle_client, args=(client, parent_host, parent_port, parent_user, parent_pass, listen_port), daemon=True).start()


if __name__ == "__main__":
    main()
