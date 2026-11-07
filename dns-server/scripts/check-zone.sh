#!/usr/bin/env bash
# Sanity-checks a zone on a running server with dig.
#   scripts/check-zone.sh <zone> [server=127.0.0.1] [port=53]
# Exit status is the number of failed checks.
set -u
ZONE=${1:?usage: check-zone.sh <zone> [server] [port]}
SERVER=${2:-127.0.0.1}
PORT=${3:-53}
fails=0

d() { dig @"$SERVER" -p "$PORT" +time=2 +tries=1 "$@"; }
status() { d +noall +comments "$@" | grep -o 'status: [A-Z]*' | head -1 | cut -d' ' -f2; }
flags() { d +noall +comments "$@" | grep -o 'flags: [a-z ]*' | head -1; }
ok()   { printf '  \033[32m✓\033[0m %s\n' "$1"; }
bad()  { printf '  \033[31m✗\033[0m %s\n' "$1"; fails=$((fails + 1)); }
check() { # check <description> <expected> <actual>
  if [ "$2" = "$3" ]; then ok "$1"; else bad "$1 (expected $2, got ${3:-nothing})"; fi
}

echo "Checking $ZONE on $SERVER:$PORT"

SOA=$(d +short "$ZONE" SOA)
[ -n "$SOA" ] && ok "SOA: $SOA" || bad "no SOA: the server does not answer for $ZONE"
check "answers authoritatively (aa flag)" "yes" "$(flags "$ZONE" SOA | grep -q ' aa' && echo yes || echo no)"
check "does not offer recursion (no ra flag)" "yes" "$(flags "$ZONE" SOA | grep -q ' ra' && echo no || echo yes)"

NS=$(d +short "$ZONE" NS); [ -n "$NS" ] && ok "NS: $(echo $NS)" || bad "no NS records"
for t in A AAAA MX TXT CAA; do
  v=$(d +short "$ZONE" $t | head -3 | tr '\n' ' ')
  [ -n "$v" ] && ok "$t: $v" || echo "  - no $t at the apex"
done

check "missing name gives NXDOMAIN" NXDOMAIN "$(status "does-not-exist-$RANDOM.$ZONE" A)"
check "existing name, missing type gives NOERROR (NODATA)" NOERROR "$(status "$ZONE" TYPE65280)"
check "a zone this server does not host is REFUSED" REFUSED "$(status "not-hosted-$RANDOM.invalid" A)"
check "case-insensitive (0x20) lookups work" "$(d +short "$ZONE" SOA)" "$(d +short "$(echo "$ZONE" | tr 'a-z' 'A-Z')" SOA)"

TCP=$(d +tcp +short "$ZONE" SOA)
check "TCP gives the same SOA as UDP" "$SOA" "$TCP"

AX=$(status "$ZONE" AXFR +tcp)
case "$AX" in
  NOERROR) ok "AXFR allowed from this machine ($(d +tcp +noall +answer "$ZONE" AXFR | wc -l | tr -d ' ') records)" ;;
  REFUSED) echo "  - AXFR refused from this machine (set ALLOW_AXFR_FROM to enable transfers)" ;;
  *)       bad "AXFR gave: ${AX:-no answer}" ;;
esac

echo
[ "$fails" -eq 0 ] && echo "All checks passed." || echo "$fails check(s) failed."
exit "$fails"
