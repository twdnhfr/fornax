#!/bin/bash
# deploytest <label> <url-base> <action-cmd>   — load on /up, probe /hello, run action at t=4s
label=$1; base=$2; action=$3
rm -f /tmp/probe-$label.log
oha -z 14s -c 16 --no-tui --output-format json "$base/up" > /tmp/oha-$label.json 2>/dev/null &
lp=$!
( end=$((SECONDS+14)); while [ $SECONDS -lt $end ]; do
    r=$(curl -s -m 5 -w " [%{http_code}]" -b "laravel_session=x" "$base/hello"); echo "$(date +%s.%N | cut -c1-14) $r" >> /tmp/probe-$label.log; sleep 0.05; done ) &
pp=$!
sleep 4
echo "action start $(date +%s.%N | cut -c1-14)"
bash -c "$action"
echo "action end   $(date +%s.%N | cut -c1-14)"
wait $lp $pp
jq -r --arg l "$label" '"\($l) load: rps=\(.summary.requestsPerSec|floor) codes=\(.statusCodeDistribution|tostring) errors=\(.errorDistribution|tostring) p99=\((.latencyPercentiles.p99*1000)|floor)ms max=\((.summary.slowest*1000)|floor)ms"' /tmp/oha-$label.json
echo "probe: $(wc -l < /tmp/probe-$label.log) requests; codes: $(grep -o '\[[0-9]*\]' /tmp/probe-$label.log | sort | uniq -c | tr '\n' ' ')"
echo "probe sequence of releases (collapsed):"; sed -E 's/.*release ([0-9]+).*/\1/; s/^[0-9.]+ //' /tmp/probe-$label.log | uniq -c | head -12
