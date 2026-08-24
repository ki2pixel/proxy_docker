#!/usr/bin/env python3
"""
Serveur SOCKS5 avec chaînage vers un proxy parent (SOCKS5).
Relais pour la stack proxy_docker : les gateways Tierhive parlent SOCKS5,
chaque connexion est relayée vers le proxy parent Proxiware (IP ISP).

Usage : python3 microsocks_relay.py LISTEN_PORT PARENT_USER PARENT_PASS PARENT_HOST PARENT_PORT
Exemple : python3 microsocks_relay.py 10801 user pass 188.221.160.44 1337
"""
import socket
import sys
import select
import threading
import time

def socks5_handshake_parent(parent_sock, user, passwd, host, port):
    """Handshake SOCKS5 vers le proxy parent (user/pass + CONNECT host:port)."""
    # Méthode : user/pass (0x02)
    parent_sock.sendall(b"\x05\x01\x02")
    resp = parent_sock.recv(2)
    if len(resp) != 2 or resp[1] != 0x02:
        raise ValueError("parent ne supporte pas user/pass: %r" % resp)
    # Auth user/pass
    u = user.encode()
    p = passwd.encode()
    parent_sock.sendall(b"\x01" + bytes([len(u)]) + u + bytes([len(p)]) + p)
    a = parent_sock.recv(2)
    if len(a) != 2 or a[1] != 0x00:
        raise ValueError("auth parent échouée: %r" % a)
    # CONNECT host:port (ATYP=0x03 domaine)
    hostb = host.encode()
    parent_sock.sendall(b"\x05\x01\x00\x03" + bytes([len(hostb)]) + hostb + int(port).to_bytes(2, "big"))
    c = parent_sock.recv(10)
    if len(c) < 4 or c[1] != 0x00:
        raise ValueError("CONNECT parent échoué: %r" % c)


def handle_client(client_sock, parent_host, parent_port, parent_user, parent_pass):
    try:
        # Handshake SOCKS5 client (méthodes proposées : none ou user/pass)
        client_sock.settimeout(10)
        data = client_sock.recv(2)
        if len(data) != 2 or data[0] != 0x05:
            return
        nmethods = data[1]
        methods = client_sock.recv(nmethods)
        # On choisit user/pass (0x02) si proposé, sinon none (0x00) — pour rester
        # compatible avec tun2socks qui propose souvent none+userpwd.
        method = 0x02 if b"\x02" in methods else (0x00 if b"\x00" in methods else 0xFF)
        client_sock.sendall(bytes([0x05, method]))
        if method == 0x02:
            # Lire identifiants (mais on les ignore : l'auth parent a ses propres identifiants)
            v = client_sock.recv(1)
            ulen = v[0]
            client_sock.recv(ulen)
            plen = client_sock.recv(1)[0]
            client_sock.recv(plen)
            client_sock.sendall(b"\x01\x00")
        # Lire la requête CONNECT du client (on la relaye telle quelle)
        req = client_sock.recv(4)
        if len(req) != 4 or req[0] != 0x05:
            return
        atyp = req[3]
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
        socks5_handshake_parent(parent, parent_user, parent_pass, dest, dest_port)
        # Répondre succès au client
        client_sock.sendall(b"\x05\x00\x00\x01\x00\x00\x00\x00\x00\x00")

        # Bridge bidirectionnel
        sockets = [client_sock, parent]
        while True:
            r, _, _ = select.select(sockets, [], [], 60)
            if not r:
                # Timeout d'inactivité — fermeture propre
                break
            for s in r:
                data = s.recv(8192)
                if not data:
                    return
                other = parent if s is client_sock else client_sock
                other.sendall(data)
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
    print("Relais SOCKS5 %s:%s -> %s:%s (%s@%s)" % (parent_host, parent_port, listen_port, parent_port, parent_user, parent_host), flush=True)
    print("En écoute sur %d" % listen_port, flush=True)
    while True:
        client, addr = server.accept()
        print("Connexion depuis %s" % (addr,), flush=True)
        threading.Thread(target=handle_client, args=(client, parent_host, parent_port, parent_user, parent_pass), daemon=True).start()


if __name__ == "__main__":
    main()
