# usage: bench.sh <label> <url> [extra oha args]
label=$1; url=$2; shift 2
oha -z 5s -c 32 --no-tui "$url" "$@" >/dev/null 2>&1   # warmup
oha -z 15s -c 32 --no-tui --output-format json "$url" "$@" > /tmp/oha-$label.json 2>/dev/null
jq -r --arg l "$label" '"\($l): rps=\(.summary.requestsPerSec|floor) p50=\((.latencyPercentiles.p50*1000*10|floor)/10)ms p99=\((.latencyPercentiles.p99*1000*10|floor)/10)ms codes=\(.statusCodeDistribution|tostring) errors=\(.errorDistribution|tostring)"' /tmp/oha-$label.json
