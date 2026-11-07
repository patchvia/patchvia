# Deploying Patchvia DNS

Two images, built from this repository by CI and published publicly to GitHub Container Registry:

| Image | What it is |
| --- | --- |
| `ghcr.io/patchvia/patchvia-dns-server` | the DNS server and API (ports 53 and 8081) |
| `ghcr.io/patchvia/patchvia-dns-console` | the web console (port 3000) |

## Tags

| Tag | When it is published |
| --- | --- |
| `latest` | every push to `main` |
| `sha-<short commit>` | every push to `main` (pin a deployment to an exact commit) |
| `1.2.3`, `1.2` | when you push a git tag `v1.2.3` |

Pull requests build the images to prove they work but do not publish anything.

## Maintainers: package visibility

The images are built by the `images` job of `ci.yml` on every push to `main` and on version tags. Packages that a
workflow creates are private at first, so after the first publish of each image, set its visibility to **Public**:
the package page (github.com/orgs/patchvia/packages) → **Package settings** → **Change visibility**. Anyone can then pull
the images without a login. This is only needed once per image.

## Run on a server

You need Docker with the Compose plugin, a host with port 53 free (see the Ubuntu note below), and the `deploy/` folder
of this repository:

```sh
git clone https://github.com/patchvia/patchvia.git && cd patchvia/deploy
cp .env.example .env        # set ADMIN_PASSWORD and SESSION_SECRET (and the cluster settings, see CLUSTER.md)
docker compose pull
docker compose up -d --no-build
```

To update: `docker compose pull && docker compose up -d --no-build`. To pin a version, set `PATCHVIA_TAG` in `.env` (for example
`PATCHVIA_TAG=sha-1a2b3c4` or `PATCHVIA_TAG=1.2.0`); the default is `latest`. To use a different registry or account, set
`PATCHVIA_REGISTRY`.

Only `deploy/` is needed on a server: you do not need Node.js or the rest of the source, only Docker.

## Build locally instead

```sh
cd deploy && docker compose up -d --build     # builds from this checkout and tags the same image names
npm run docker:build                           # from the repository root: patchvia-dns-server:dev and patchvia-dns-console:dev
```

## Releasing a version

```sh
git tag v0.1.0 && git push origin v0.1.0       # CI publishes 0.1.0, 0.1 and a sha tag
```

## Forgot a password

Another admin can reset it in the console (Users → edit → new password), and you can change your own under Security. If
nobody can sign in, run the reset command where the server's database is. The server can keep running.

```sh
docker exec -it <dns-server container> node dist/cli.js reset-password admin
```

It asks for the new password twice, hidden. The password never goes on the command line, so it stays out of shell history
and the process list. Other forms:

```sh
... reset-password admin --generate                      # makes a random password and prints it once
printf '%s\n' "$NEW" | docker exec -i <container> node dist/cli.js reset-password admin --password-stdin
```

The user is signed out everywhere. In a cluster, run it on any one node: the others pick the change up on their next sync
(a few seconds). `ADMIN_PASSWORD` does not do this: it only creates the first `admin` on an empty database.

## Port 53 on an Ubuntu server

A DNS server has to answer on port 53, UDP and TCP (TCP carries large answers and zone transfers). Three things can stand in the way.

### 1. `systemd-resolved` already holds port 53

Ubuntu runs a small local resolver that listens on `127.0.0.53` and `127.0.0.54`. Docker then cannot publish port 53 and fails
with "address already in use". Check:

```sh
ss -lunpt 'sport = :53'        # lists systemd-resolve if it is the one in the way
```

Turn off only its stub listener. The server keeps resolving names for itself through its real upstream resolvers:

```sh
mkdir -p /etc/systemd/resolved.conf.d
printf '[Resolve]\nDNSStubListener=no\nDNS=1.1.1.1 8.8.8.8\n' > /etc/systemd/resolved.conf.d/patchvia.conf
ln -sf /run/systemd/resolve/resolv.conf /etc/resolv.conf
systemctl restart systemd-resolved
```

Both lines matter. The `DNS=` line pins real upstream resolvers. The `ln` line makes `/etc/resolv.conf` list those upstreams
instead of `127.0.0.53`. Once the container publishes port 53 on every address, whatever answers on `127.0.0.53` is your DNS
server, which refuses names it does not host. Anything still pointed at `127.0.0.53` then fails to resolve, the Docker daemon
included: `docker pull` reports `lookup ghcr.io on 127.0.0.53:53: server misbehaving`. Confirm with
`grep nameserver /etc/resolv.conf`, which must not show `127.0.0.53`. A Docker daemon that started while `resolv.conf`
still said `127.0.0.53` keeps using that address, so after changing it run `systemctl restart docker` once (everything on a
swarm node is down for about a minute; check `docker service ls` and the published ports afterwards).

Check that it worked, then restart the dns-server container:

```sh
ss -lunpt 'sport = :53'        # prints nothing now
getent hosts github.com        # still resolves
```

(Use `sudo` in front of each command if you are not root.)

### 2. Publish the port and open the firewalls

- Publish both `53/udp` and `53/tcp` for the dns-server container (`deploy/docker-compose.yml` already does). If the container
  runs under Docker Swarm, publish in `mode: host`: through the swarm ingress network every client appears as one internal
  address (such as `10.0.0.2`), which breaks per-client rate limiting and transfer allow-lists.
- Host firewall: Docker-published ports bypass UFW, so UFW normally needs nothing. If something else answers on 53 outside
  Docker, `ufw allow 53/udp && ufw allow 53/tcp`.
- Provider firewall: many hosts have their own firewall or security group in their control panel, and it blocks inbound
  53 whatever the server itself allows. Allow 53 UDP and TCP there. This is the most common reason for "it is open but
  nothing answers".
- Do not open the API port (8081) to the internet without TLS in front of it.

### 3. Test from another machine

```sh
dig @<server-public-ip> <a zone served here> SOA          # over UDP
dig @<server-public-ip> <a zone served here> SOA +tcp     # over TCP
```

`status: NOERROR` with the `aa` flag means it answers authoritatively. `REFUSED` for a zone that is not served here is normal
and means the port is open. A timeout means something is blocking it.

### Undo it

Puts `systemd-resolved` back the way Ubuntu ships it, with its stub listener on `127.0.0.53`:

```sh
rm /etc/systemd/resolved.conf.d/patchvia.conf
ln -sf /run/systemd/resolve/stub-resolv.conf /etc/resolv.conf
systemctl restart systemd-resolved
ss -lunpt 'sport = :53'        # systemd-resolve is listening on 127.0.0.53 again
```

Stop the dns-server container first (or unpublish port 53), because the stub listener cannot start while the container
holds port 53 on all addresses, and the container cannot start while the stub is up. Only one of the two can have port 53.
If name resolution on the server breaks at any point, `resolvectl status` shows which upstream resolvers it is using, and
`echo "nameserver 1.1.1.1" > /etc/resolv.conf` is a temporary way to get back online while you fix it.

## Restricting a port to specific IP addresses (Ubuntu)

The API port (8081) should be reachable only by the machines that need it: the other cluster nodes, and the console if it
runs elsewhere. Port 53 stays open to everyone. There are four layers, and using more than one is sensible.

### Why `ufw allow from <ip>` is not enough

Ports published by Docker bypass UFW: Docker writes its own iptables rules that come before UFW's. A UFW rule for 8081 looks
right in `ufw status` and still lets everyone in. Restrict published ports in one of the ways below.

### 1. Choose the interface the port listens on

In `deploy/.env`, `API_BIND` is the address the API port is published on. The default `127.0.0.1` is reachable only from the
machine itself, which is right for a single server with the console on the same host. For a cluster, set it to this
machine's **private** address (for example `10.0.0.5`) if the nodes share a private network, so the port is never on the
public address at all. If there is no private network, it has to be the public address, and layer 2 is needed.

### 2. Allow only chosen source addresses (the DOCKER-USER chain)

Docker leaves the `DOCKER-USER` chain for your own rules, evaluated before its own. Allow the peers, then drop everyone else
on the public interface. On each server, replace the values:

```sh
PORT=8081                                              # the API_PORT you publish
PEER=203.0.113.20                                      # the other node (repeat the ACCEPT line for more peers or the console host)
IFACE=$(ip -o -4 route show to default | awk '{print $5}')   # the public interface, for example eth0

# Order matters: the DROP is inserted first, then the ACCEPT goes above it.
iptables -I DOCKER-USER -i "$IFACE" -p tcp -m conntrack --ctorigdstport "$PORT" --ctdir ORIGINAL -j DROP
iptables -I DOCKER-USER -i "$IFACE" -p tcp -s "$PEER" -m conntrack --ctorigdstport "$PORT" --ctdir ORIGINAL -j ACCEPT
```

`--ctorigdstport` matches the port as the outside client used it, before Docker rewrites it for the container, so the rule
works even if the published port differs from the container's. Traffic between containers is not affected.

Check it:

```sh
iptables -S DOCKER-USER        # the ACCEPT line(s) must appear above the DROP line
```

Then test from a machine that is **not** allowed: `curl -m 5 http://<server-ip>:8081/v1/server/health` should time out. From
the allowed peer it should print `{"status":"ok"}`.

These rules vanish at reboot. Make them permanent:

```sh
apt update
apt install iptables-persistent        # answer yes to saving the current rules
netfilter-persistent save              # run again after every change to the rules
```

If apt says `Package 'iptables-persistent' has no installation candidate`, the package index is stale or the `universe`
repository is off: run `apt install -y software-properties-common && add-apt-repository universe && apt update`, then
install again.

After the first reboot, run `iptables -S DOCKER-USER` again and confirm the rules are there and the containers are up.
If your server has IPv6 and Docker publishes on it, repeat the rules with `ip6tables` and the peer's IPv6 address.

**Undo:** delete the same rules with `-D` and the same arguments, then save again:

```sh
iptables -D DOCKER-USER -i "$IFACE" -p tcp -s "$PEER" -m conntrack --ctorigdstport "$PORT" --ctdir ORIGINAL -j ACCEPT
iptables -D DOCKER-USER -i "$IFACE" -p tcp -m conntrack --ctorigdstport "$PORT" --ctdir ORIGINAL -j DROP
netfilter-persistent save
```

Be careful when testing over SSH: these rules touch only the published container port, not SSH, so they cannot lock you out
of the server. A mistake in them can cut the cluster nodes off from each other, which shows up in the console's Cluster page.

### 3. Let the server refuse other addresses itself

Independent of any firewall, the server can check who is calling. In `deploy/.env`:

```sh
CLUSTER_ALLOW_FROM=203.0.113.20        # addresses or CIDRs of the other nodes
```

Cluster requests from any other address are refused. Do not rely on it alone: it stops requests, not connections, and it sees
the address the container sees, which is only the real one when the port is not published through a Swarm ingress network.

### 4. The provider's firewall

If your hosting panel has a firewall or security group, restrict 8081 there as well, to the same addresses. It filters
before the traffic reaches the server, and it works the same whether or not Docker is involved.

### Other services on the host (SSH and so on)

Services that run directly on the host, not in Docker, do follow UFW:

```sh
ufw allow from 198.51.100.7 to any port 22 proto tcp     # SSH only from your address
ufw allow 53/udp && ufw allow 53/tcp                      # DNS from everywhere
ufw enable                                                # only after SSH is allowed, or you lock yourself out
```

## Notes

- The images are built for `linux/amd64`. If you deploy to ARM machines, add `platforms: linux/amd64,linux/arm64` to the
  build step in `.github/workflows/ci.yml` (it makes the build slower).
- The server image's SQLite database lives in the `dns-data` volume. It holds the DNSSEC private keys: back it up like a secret.
- Running a cluster of several servers: see [CLUSTER.md](CLUSTER.md). Each node runs the same images with its own `.env`.
