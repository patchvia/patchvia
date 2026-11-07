#!/usr/bin/env bash
# Compares a zone on two servers record by record (via AXFR), ignoring ordering, case and the SOA serial.
# Use it to prove a new server answers exactly like the old one before switching NS records.
#   scripts/compare-servers.sh <zone> <old-server[:port]> <new-server[:port]>
# Both servers must allow zone transfers to the machine you run this from.
set -u
ZONE=${1:?usage: compare-servers.sh <zone> <old[:port]> <new[:port]>}
OLD=${2:?old server}
NEW=${3:?new server}

dump() { # dump <host[:port]>
  local host=${1%%:*} port=53
  [[ "$1" == *:* ]] && port=${1##*:}
  dig @"$host" -p "$port" +tcp +noall +answer +time=5 +tries=1 "$ZONE" AXFR |
    awk '$4 == "SOA" { $7 = "<serial>" } { $1 = tolower($1); print $1, $2, $3, $4, tolower($5), tolower($6), tolower($7), tolower($8), tolower($9), tolower($10), tolower($11) }' |
    sed -E 's/ +$//' | sort -u
}

A=$(dump "$OLD"); B=$(dump "$NEW")
[ -z "$A" ] && { echo "could not transfer $ZONE from $OLD (is AXFR allowed from this machine?)"; exit 2; }
[ -z "$B" ] && { echo "could not transfer $ZONE from $NEW (is AXFR allowed from this machine?)"; exit 2; }

echo "$ZONE: $(echo "$A" | wc -l | tr -d ' ') records on $OLD, $(echo "$B" | wc -l | tr -d ' ') on $NEW"
if diff <(echo "$A") <(echo "$B") > /tmp/compare-servers.$$; then
  echo "Identical."; rm -f /tmp/compare-servers.$$; exit 0
fi
echo "Differences (< only on $OLD, > only on $NEW):"
sed 's/^/  /' /tmp/compare-servers.$$; rm -f /tmp/compare-servers.$$
exit 1
