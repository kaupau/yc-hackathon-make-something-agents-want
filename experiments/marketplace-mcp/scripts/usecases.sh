#!/bin/zsh
rpc(){ curl -s --max-time 300 -H 'content-type: application/json' -H 'accept: application/json, text/event-stream' -X POST http://localhost:3000/mcp -d "$1" | sed -n 's/^data: //p'; }
mkdir -p .cache/usecases
for q in "lululemon align leggings 25" "patagonia better sweater" "north face nuptse 1996 jacket" "carhartt detroit jacket" "coach tabby shoulder bag" "stanley quencher 40 oz tumbler" "nintendo switch oled" "apple airpods pro 2nd generation" "dyson airwrap" "new balance 990v6" "lego star wars millennium falcon 75192" "le creuset dutch oven 5.5"; do
  f=".cache/usecases/$(echo $q | tr ' ' '_').json"; t=$(date +%s)
  rpc "{\"jsonrpc\":\"2.0\",\"id\":1,\"method\":\"tools/call\",\"params\":{\"name\":\"arbitrage\",\"arguments\":{\"query\":\"$q\",\"limit\":3}}}" > "$f"
  echo "$q: $(( $(date +%s) - t ))s"
done
