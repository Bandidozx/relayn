#!/usr/bin/env bash
# End-to-end smoke test against a running server. Defaults to the dev server on :3200;
# override with BASE=https://... to run it against a deployment.
# Exercises the real HTTP surface: register -> login -> key create -> gateway call (both the
# OpenAI and the Anthropic dialect, buffered and streamed) -> usage row -> IDOR probe ->
# revoke -> logout. No mocks, no direct DB access.
set -u

BASE="${BASE:-http://localhost:3200}"
# A single-process dev server must enforce the rate limit exactly; a multi-instance
# deployment cannot, until RateLimitStore is backed by Redis. Section 13 grades accordingly.
case "$BASE" in
  *localhost*|*127.0.0.1*) LOCAL_TARGET=yes ;;
  *) LOCAL_TARGET=no ;;
esac
A_JAR=$(mktemp) ; B_JAR=$(mktemp)
A_MAIL="e2e-a-$RANDOM@relayn.test" ; B_MAIL="e2e-b-$RANDOM@relayn.test"
PASS="Correct-Horse-9"
FAILED=0

csrf() { awk '$6=="relayn_csrf"{print $7}' "$1" | tail -1; }

# check <label> <expected-status> <actual-status>
check() {
  if [ "$2" = "$3" ]; then printf 'PASS  %-46s %s\n' "$1" "$3"
  else printf 'FAIL  %-46s got %s want %s\n' "$1" "$3" "$2"; FAILED=$((FAILED+1)); fi
}

# post <jar> <path> <json> ; sets $BODY / $CODE
post() {
  local jar=$1 path=$2 data=$3 method=${4:-POST}
  local out
  out=$(curl -s -X "$method" "$BASE$path" -b "$jar" -c "$jar" \
    -H "content-type: application/json" -H "origin: $BASE" \
    -H "x-csrf-token: $(csrf "$jar")" \
    ${data:+-d "$data"} -w '\n%{http_code}')
  CODE=${out##*$'\n'} ; BODY=${out%$'\n'*}
}

get() {
  local out
  out=$(curl -s "$BASE$2" -b "$1" -c "$1" -H "accept: application/json" -w '\n%{http_code}')
  CODE=${out##*$'\n'} ; BODY=${out%$'\n'*}
}

# jq_ <js-expression-over-o> — reads JSON on stdin, prints the value or "".
jq_() {
  node -e "let s='';process.stdin.on('data',d=>s+=d).on('end',()=>{let v;try{const o=JSON.parse(s);v=eval(process.argv[1])}catch(e){v=''}console.log(v===undefined||v===null?'':v)})" "$1"
}

# reqid <header-dump-file> — the x-request-id the gateway assigned to that call. Usage rows
# are looked up by it rather than by "newest row", so an assertion cannot be satisfied by
# some other request that happened to land last.
reqid() { tr -d '\r' < "$1" | awk 'tolower($1)=="x-request-id:"{print $2}' | tail -1; }

HDR=$(mktemp)

echo "== 1. CSRF cookie issuance =="
CODE=$(curl -s -o /dev/null -w '%{http_code}' "$BASE/login" -c "$A_JAR")
check "GET /login" 200 "$CODE"
[ -n "$(csrf "$A_JAR")" ] && echo "PASS  relayn_csrf cookie present" || { echo "FAIL  no csrf cookie"; FAILED=$((FAILED+1)); }

echo
echo "== 2. Registration =="
post "$A_JAR" /api/auth/register "{\"name\":\"E2E A\",\"email\":\"$A_MAIL\",\"password\":\"$PASS\"}"
check "POST /api/auth/register" 200 "$CODE"
echo "      $BODY"
grep -q relayn_session "$A_JAR" && echo "PASS  session cookie set" || { echo "FAIL  no session cookie"; FAILED=$((FAILED+1)); }

echo
echo "== 3. CSRF is actually enforced =="
CODE=$(curl -s -o /dev/null -w '%{http_code}' -X POST "$BASE/api/keys" -b "$A_JAR" \
  -H "content-type: application/json" -H "origin: $BASE" -d '{"name":"no-token"}')
check "POST /api/keys without x-csrf-token" 403 "$CODE"
CODE=$(curl -s -o /dev/null -w '%{http_code}' -X POST "$BASE/api/keys" -b "$A_JAR" \
  -H "content-type: application/json" -H "origin: https://evil.example" \
  -H "x-csrf-token: $(csrf "$A_JAR")" -d '{"name":"cross-site"}')
check "POST /api/keys from foreign Origin" 403 "$CODE"

echo
echo "== 4. Protected pages =="
CODE=$(curl -s -o /dev/null -w '%{http_code}' "$BASE/dashboard" -b "$A_JAR")
check "GET /dashboard signed in" 200 "$CODE"
CODE=$(curl -s -o /dev/null -w '%{http_code}' "$BASE/admin")
check "GET /admin anonymous" 307 "$CODE"
CODE=$(curl -s -o /dev/null -w '%{http_code}' "$BASE/admin" -b "$A_JAR")
check "GET /admin as non-admin user" 307 "$CODE"
get "$A_JAR" /api/admin/stats
check "GET /api/admin/stats as non-admin" 403 "$CODE"

echo
echo "== 5. API key creation =="
post "$A_JAR" /api/keys '{"name":"e2e-key"}'
check "POST /api/keys" 201 "$CODE"
SECRET=$(printf '%s' "$BODY" | jq_ 'o.secret')
KEY_ID=$(printf '%s' "$BODY" | jq_ 'o.key.id')
echo "      id=$KEY_ID secret=${SECRET:0:16}...${SECRET: -4}"
case "$SECRET" in rly_live_*) echo "PASS  secret carries rly_live_ prefix";; *) echo "FAIL  unexpected secret shape"; FAILED=$((FAILED+1));; esac
get "$A_JAR" /api/keys
printf '%s' "$BODY" | grep -q "$SECRET" && { echo "FAIL  plaintext secret returned on relist"; FAILED=$((FAILED+1)); } || echo "PASS  secret not returned again by GET /api/keys"

echo
echo "== 6. Gateway call =="
get "$A_JAR" /api/metrics/overview
BEFORE_REMAINING=$(printf '%s' "$BODY" | jq_ 'o.cards.tokensRemaining')
BEFORE_REQUESTS=$(printf '%s' "$BODY" | jq_ 'o.cards.requestsToday')
echo "      before: tokensRemaining=$BEFORE_REMAINING requestsToday=$BEFORE_REQUESTS"
MODEL=$(curl -s "$BASE/v1/models" -H "authorization: Bearer $SECRET" | jq_ 'o.data[0].id')
echo "      model=$MODEL"
OUT=$(curl -s -X POST "$BASE/v1/chat/completions" \
  -H "authorization: Bearer $SECRET" -H "content-type: application/json" \
  -d "{\"model\":\"$MODEL\",\"messages\":[{\"role\":\"user\",\"content\":\"ping from the e2e script\"}]}" \
  -w '\n%{http_code}')
CODE=${OUT##*$'\n'} ; BODY=${OUT%$'\n'*}
check "POST /v1/chat/completions" 200 "$CODE"
echo "      $(printf '%s' "$BODY" | cut -c1-400)"
TOTAL=$(printf '%s' "$BODY" | jq_ 'o.usage.total_tokens')
echo "      total_tokens=$TOTAL"

CODE=$(curl -s -o /dev/null -w '%{http_code}' -X POST "$BASE/v1/chat/completions" \
  -H "authorization: Bearer rly_live_definitely-not-a-real-key" -H "content-type: application/json" \
  -d "{\"model\":\"$MODEL\",\"messages\":[{\"role\":\"user\",\"content\":\"x\"}]}")
check "gateway with a bogus key" 401 "$CODE"
CODE=$(curl -s -o /dev/null -w '%{http_code}' -X POST "$BASE/v1/chat/completions" \
  -H "content-type: application/json" -d '{"model":"x","messages":[]}')
check "gateway with no Authorization header" 401 "$CODE"

echo
echo "== 7. Usage was recorded =="
get "$A_JAR" "/api/usage?pageSize=5"
check "GET /api/usage?pageSize=5 (below the min of 10)" 400 "$CODE"
get "$A_JAR" "/api/usage?pageSize=10&sort=createdAt&direction=desc"
check "GET /api/usage" 200 "$CODE"
USAGE_ID=$(printf '%s' "$BODY" | jq_ 'o.rows[0].id')
ROW_TOKENS=$(printf '%s' "$BODY" | jq_ 'o.rows[0].totalTokens')
echo "      newest row: $(printf '%s' "$BODY" | jq_ '[o.rows[0].modelId,o.rows[0].endpoint,o.rows[0].status,o.rows[0].totalTokens+" tok",o.rows[0].latencyMs+"ms",o.rows[0].requestId].join(" / ")')"
echo "      total rows for user A: $(printf '%s' "$BODY" | jq_ 'o.total')  id=$USAGE_ID"
check "usage row totalTokens matches the API response" "$TOTAL" "$ROW_TOKENS"
get "$A_JAR" "/api/usage/$USAGE_ID"
check "GET /api/usage/:id as owner" 200 "$CODE"

get "$A_JAR" /api/metrics/overview
check "GET /api/metrics/overview" 200 "$CODE"
AFTER_REMAINING=$(printf '%s' "$BODY" | jq_ 'o.cards.tokensRemaining')
AFTER_REQUESTS=$(printf '%s' "$BODY" | jq_ 'o.cards.requestsToday')
echo "      after: tokensRemaining=$AFTER_REMAINING requestsToday=$AFTER_REQUESTS tokensUsedToday=$(printf '%s' "$BODY" | jq_ 'o.cards.tokensUsedToday') successRate=$(printf '%s' "$BODY" | jq_ 'o.cards.successRate') avgLatency=$(printf '%s' "$BODY" | jq_ 'o.cards.avgLatencyMs')"
check "requestsToday incremented by one" "$((BEFORE_REQUESTS + 1))" "$AFTER_REQUESTS"
check "tokensRemaining fell by exactly total_tokens" "$((BEFORE_REMAINING - TOTAL))" "$AFTER_REMAINING"

echo
echo "== 8. IDOR probe with a second account =="
curl -s -o /dev/null "$BASE/register" -c "$B_JAR"
post "$B_JAR" /api/auth/register "{\"name\":\"E2E B\",\"email\":\"$B_MAIL\",\"password\":\"$PASS\"}"
check "register second user" 200 "$CODE"
get "$B_JAR" "/api/usage/$USAGE_ID"
check "user B reads user A's usage row" 404 "$CODE"
post "$B_JAR" "/api/keys/$KEY_ID" '' DELETE
check "user B revokes user A's API key" 404 "$CODE"
get "$B_JAR" "/api/usage?pageSize=10"
echo "      user B usage rows: $(printf '%s' "$BODY" | jq_ 'o.total')"

echo
echo "== 9. Key limits and revocation =="
post "$A_JAR" /api/keys '{"name":"second-key"}'
check "second key on the Free plan (max 1)" 409 "$CODE"
post "$A_JAR" "/api/keys/$KEY_ID" '' DELETE
check "DELETE /api/keys/:id as owner" 200 "$CODE"
CODE=$(curl -s -o /dev/null -w '%{http_code}' -X POST "$BASE/v1/chat/completions" \
  -H "authorization: Bearer $SECRET" -H "content-type: application/json" \
  -d "{\"model\":\"$MODEL\",\"messages\":[{\"role\":\"user\",\"content\":\"x\"}]}")
check "revoked key is rejected by the gateway" 401 "$CODE"

echo
echo "== 10. Logout and log back in =="
post "$A_JAR" /api/auth/logout ''
check "POST /api/auth/logout" 200 "$CODE"
CODE=$(curl -s -o /dev/null -w '%{http_code}' "$BASE/dashboard" -b "$A_JAR")
check "GET /dashboard after logout" 307 "$CODE"
curl -s -o /dev/null "$BASE/login" -c "$A_JAR"
post "$A_JAR" /api/auth/login "{\"email\":\"$A_MAIL\",\"password\":\"wrong-$PASS\"}"
check "POST /api/auth/login with a bad password" 401 "$CODE"
post "$A_JAR" /api/auth/login "{\"email\":\"$A_MAIL\",\"password\":\"$PASS\"}"
check "POST /api/auth/login" 200 "$CODE"
CODE=$(curl -s -o /dev/null -w '%{http_code}' "$BASE/dashboard" -b "$A_JAR")
check "GET /dashboard after logging back in" 200 "$CODE"

echo
echo "== 11. Model authorisation and streaming =="
post "$A_JAR" /api/keys '{"name":"verify-key"}'
check "POST /api/keys after revoking the first" 201 "$CODE"
RL_SECRET=$(printf '%s' "$BODY" | jq_ 'o.secret')
RL_KEY_ID=$(printf '%s' "$BODY" | jq_ 'o.key.id')

LISTED=$(curl -s "$BASE/v1/models" -H "authorization: Bearer $RL_SECRET")
echo "      /v1/models returns $(printf '%s' "$LISTED" | jq_ 'o.data.length') models for a Free key"
printf '%s' "$LISTED" | grep -q relayn-sandbox-coder \
  && { echo "FAIL  a Pro-only model is listed to a Free key"; FAILED=$((FAILED+1)); } \
  || echo "PASS  Pro-only model absent from /v1/models on a Free key"

OUT=$(curl -s -X POST "$BASE/v1/chat/completions" \
  -H "authorization: Bearer $RL_SECRET" -H "content-type: application/json" \
  -d '{"model":"relayn-sandbox-coder","messages":[{"role":"user","content":"x"}]}' -w '\n%{http_code}')
CODE=${OUT##*$'\n'} ; BODY=${OUT%$'\n'*}
check "calling a Pro-only model on the Free plan" 403 "$CODE"
echo "      $(printf '%s' "$BODY" | jq_ 'o.error.code+": "+o.error.message')"

CODE=$(curl -s -o /dev/null -w '%{http_code}' -X POST "$BASE/v1/chat/completions" \
  -H "authorization: Bearer $RL_SECRET" -H "content-type: application/json" \
  -d '{"model":"no-such-model","messages":[{"role":"user","content":"x"}]}')
check "calling a model that does not exist" 404 "$CODE"
CODE=$(curl -s -o /dev/null -w '%{http_code}' -X POST "$BASE/v1/chat/completions" \
  -H "authorization: Bearer $RL_SECRET" -H "content-type: application/json" \
  -d '{"model":"relayn-sandbox-chat","messages":[]}')
check "calling with an empty messages array" 400 "$CODE"

STREAM=$(curl -s -N -D "$HDR" -X POST "$BASE/v1/chat/completions" \
  -H "authorization: Bearer $RL_SECRET" -H "content-type: application/json" \
  -d "{\"model\":\"$MODEL\",\"messages\":[{\"role\":\"user\",\"content\":\"stream please\"}],\"stream\":true}")
STREAM_REQ=$(reqid "$HDR")
CHUNKS=$(printf '%s\n' "$STREAM" | grep -c '^data: ')
printf '%s' "$STREAM" | grep -q 'data: \[DONE\]' \
  && echo "PASS  streaming response terminates with data: [DONE]" \
  || { echo "FAIL  no [DONE] sentinel in the stream"; FAILED=$((FAILED+1)); }
[ "$CHUNKS" -gt 2 ] && echo "PASS  stream delivered $CHUNKS SSE events" \
  || { echo "FAIL  stream delivered only $CHUNKS events"; FAILED=$((FAILED+1)); }
# Looked up by request id, and with no sleep: the gateway must commit the usage row before
# it closes the stream. Awaiting it after the close works on a long-lived server but is
# lost on serverless, where the instance may freeze the moment the response ends — this
# assertion is the regression guard for exactly that.
get "$A_JAR" "/api/usage?pageSize=10&search=$STREAM_REQ"
check "streamed completion was metered (by request id)" 1 "$(printf '%s' "$BODY" | jq_ 'o.total')"
check "streamed row carries streamed=true" true "$(printf '%s' "$BODY" | jq_ 'o.rows[0].streamed')"
check "streamed row endpoint" /v1/chat/completions "$(printf '%s' "$BODY" | jq_ 'o.rows[0].endpoint')"
check "streamed row tokens were counted" true "$(printf '%s' "$BODY" | jq_ 'o.rows[0].totalTokens > 0')"

echo
echo "== 12. Anthropic dialect (/v1/messages) =="
OUT=$(curl -s -D "$HDR" -X POST "$BASE/v1/messages" \
  -H "x-api-key: $RL_SECRET" -H "content-type: application/json" \
  -d "{\"model\":\"$MODEL\",\"max_tokens\":64,\"system\":\"Be brief.\",\"messages\":[{\"role\":\"user\",\"content\":\"ping from the e2e script\"}]}" \
  -w '\n%{http_code}')
CODE=${OUT##*$'\n'} ; BODY=${OUT%$'\n'*}
MSG_REQ=$(reqid "$HDR")
check "POST /v1/messages authenticated with x-api-key" 200 "$CODE"
echo "      $(printf '%s' "$BODY" | cut -c1-320)"
check "envelope type" message "$(printf '%s' "$BODY" | jq_ 'o.type')"
check "role" assistant "$(printf '%s' "$BODY" | jq_ 'o.role')"
check "first content block is text" text "$(printf '%s' "$BODY" | jq_ 'o.content[0].type')"
check "stop_reason is Anthropic-shaped" end_turn "$(printf '%s' "$BODY" | jq_ 'o.stop_reason')"
MSG_TOTAL=$(printf '%s' "$BODY" | jq_ 'o.usage.input_tokens + o.usage.output_tokens')
echo "      input+output tokens=$MSG_TOTAL request=$MSG_REQ"

# Same pipeline, so the Anthropic dialect must produce the same usage_logs row.
get "$A_JAR" "/api/usage?pageSize=10&search=$MSG_REQ"
check "/v1/messages call was metered (by request id)" 1 "$(printf '%s' "$BODY" | jq_ 'o.total')"
check "row endpoint" /v1/messages "$(printf '%s' "$BODY" | jq_ 'o.rows[0].endpoint')"
check "row totalTokens matches the reported usage" "$MSG_TOTAL" "$(printf '%s' "$BODY" | jq_ 'o.rows[0].totalTokens')"
check "row is not marked streamed" false "$(printf '%s' "$BODY" | jq_ 'o.rows[0].streamed')"

CODE=$(curl -s -o /dev/null -w '%{http_code}' -X POST "$BASE/v1/messages" \
  -H "x-api-key: $RL_SECRET" -H "content-type: application/json" \
  -d "{\"model\":\"$MODEL\",\"messages\":[{\"role\":\"user\",\"content\":\"x\"}]}")
check "/v1/messages without max_tokens (required by Anthropic)" 400 "$CODE"
OUT=$(curl -s -X POST "$BASE/v1/messages" \
  -H "x-api-key: rly_live_definitely-not-a-real-key" -H "content-type: application/json" \
  -d "{\"model\":\"$MODEL\",\"max_tokens\":16,\"messages\":[{\"role\":\"user\",\"content\":\"x\"}]}" \
  -w '\n%{http_code}')
CODE=${OUT##*$'\n'} ; BODY=${OUT%$'\n'*}
check "/v1/messages with a bogus key" 401 "$CODE"
check "error envelope is Anthropic-shaped" error "$(printf '%s' "$BODY" | jq_ 'o.type')"
check "error type" authentication_error "$(printf '%s' "$BODY" | jq_ 'o.error.type')"

STREAM=$(curl -s -N -D "$HDR" -X POST "$BASE/v1/messages" \
  -H "x-api-key: $RL_SECRET" -H "content-type: application/json" \
  -d "{\"model\":\"$MODEL\",\"max_tokens\":128,\"messages\":[{\"role\":\"user\",\"content\":\"stream please\"}],\"stream\":true}")
MSG_STREAM_REQ=$(reqid "$HDR")
for EV in message_start content_block_start content_block_delta content_block_stop message_delta message_stop; do
  N=$(printf '%s\n' "$STREAM" | grep -c "^event: $EV$")
  [ "$N" -ge 1 ] && printf 'PASS  %-46s %s\n' "SSE event $EV" "x$N" \
    || { printf 'FAIL  %-46s missing\n' "SSE event $EV"; FAILED=$((FAILED+1)); }
done
printf '%s' "$STREAM" | grep -q '"stop_reason":"end_turn"' \
  && echo "PASS  message_delta reports stop_reason=end_turn" \
  || { echo "FAIL  no terminal stop_reason in the stream"; FAILED=$((FAILED+1)); }
get "$A_JAR" "/api/usage?pageSize=10&search=$MSG_STREAM_REQ"
check "streamed /v1/messages was metered (by request id)" 1 "$(printf '%s' "$BODY" | jq_ 'o.total')"
check "streamed row carries streamed=true" true "$(printf '%s' "$BODY" | jq_ 'o.rows[0].streamed')"
check "streamed row tokens were counted" true "$(printf '%s' "$BODY" | jq_ 'o.rows[0].totalTokens > 0')"

echo
echo "== 13. Gateway rate limiting (Free plan: 20 req/min) =="
# The headers are read off the throttled response itself, not off a follow-up request. On
# serverless the window lives in the instance that served it (see the Redis seam in
# src/lib/security/rate-limit.ts), so a second call can land on a cold instance and be
# allowed — asserting against a fresh request would fail for the wrong reason.
LAST=0 ; HITS=0 ; RL_HEADERS=""
for i in $(seq 1 25); do
  RL_HEADERS=$(curl -s -o /dev/null -D - -X POST "$BASE/v1/chat/completions" \
    -H "authorization: Bearer $RL_SECRET" -H "content-type: application/json" \
    -d "{\"model\":\"$MODEL\",\"messages\":[{\"role\":\"user\",\"content\":\"burst $i\"}],\"max_tokens\":16}" \
    | tr -d '\r')
  LAST=$(printf '%s\n' "$RL_HEADERS" | awk 'tolower($1) ~ /^http/ {print $2; exit}')
  [ "$LAST" = "429" ] && { HITS=$i; break; }
done
if [ "$LAST" = "429" ]; then
  echo "PASS  a burst of requests eventually returns 429     throttled on request #$HITS"
  echo "$RL_HEADERS" | grep -qi '^retry-after:' \
    && echo "PASS  429 carries a Retry-After header" \
    || { echo "FAIL  no Retry-After on the throttled response"; FAILED=$((FAILED+1)); }
  echo "      $(echo "$RL_HEADERS" | grep -iE '^x-ratelimit' | paste -sd' ' -)"
elif [ "$LOCAL_TARGET" = "yes" ]; then
  echo "FAIL  a burst of 25 requests was never throttled              got $LAST want 429"
  FAILED=$((FAILED+1))
else
  # Not a failure against a deployment: the fixed windows live in each instance's memory, so
  # a burst spread over n warm instances has an effective ceiling of n x the configured one.
  # Quota enforcement is unaffected (that is a database counter). Wire RateLimitStore in
  # src/lib/security/rate-limit.ts to Redis if the 429s must be exact.
  echo "KNOWN a burst of 25 was not throttled on $BASE"
  echo "      per-instance in-memory windows on serverless — advisory, not authoritative"
fi

echo
echo "== 14. Real upstream (opt-in) =="
# Skipped unless a model id is named, so the suite never depends on a third-party credential
# being funded. Point it at something the test account's plan can actually call, e.g.
#   E2E_UPSTREAM_MODEL=jerouter/f/deepseek-v4-flash npm run test:e2e
if [ -z "${E2E_UPSTREAM_MODEL:-}" ]; then
  echo "SKIP  set E2E_UPSTREAM_MODEL=<provider/model> to exercise a live upstream"
else
  # A fresh key on a fresh rate-limit window: section 13 deliberately burned $RL_SECRET's.
  # The Free plan allows one active key, so the old one is revoked first.
  post "$A_JAR" "/api/keys/$RL_KEY_ID" '' DELETE
  post "$A_JAR" /api/keys '{"name":"e2e upstream"}'
  check "fresh key for the upstream call" 201 "$CODE"
  UP_SECRET=$(printf '%s' "$BODY" | jq_ 'o.secret')
  echo "      model=$E2E_UPSTREAM_MODEL"

  OUT=$(curl -s -D "$HDR" -X POST "$BASE/v1/chat/completions" \
    -H "authorization: Bearer $UP_SECRET" -H "content-type: application/json" \
    -d "{\"model\":\"$E2E_UPSTREAM_MODEL\",\"messages\":[{\"role\":\"user\",\"content\":\"Reply with exactly: RELAYN-OK\"}],\"max_tokens\":256}" \
    -w '\n%{http_code}')
  CODE=${OUT##*$'\n'} ; BODY=${OUT%$'\n'*} ; UP_REQ=$(reqid "$HDR")
  check "buffered call to a real upstream" 200 "$CODE"
  echo "      usage=$(printf '%s' "$BODY" | jq_ 'JSON.stringify(o.usage)') request=$UP_REQ"
  get "$A_JAR" "/api/usage?pageSize=10&search=$UP_REQ"
  check "upstream call was metered (by request id)" 1 "$(printf '%s' "$BODY" | jq_ 'o.total')"
  check "row status" success "$(printf '%s' "$BODY" | jq_ 'o.rows[0].status')"
  check "row counted input tokens" true "$(printf '%s' "$BODY" | jq_ 'o.rows[0].inputTokens > 0')"

  STREAM=$(curl -s -N -D "$HDR" -X POST "$BASE/v1/chat/completions" \
    -H "authorization: Bearer $UP_SECRET" -H "content-type: application/json" \
    -d "{\"model\":\"$E2E_UPSTREAM_MODEL\",\"messages\":[{\"role\":\"user\",\"content\":\"Count from one to eight in words.\"}],\"max_tokens\":256,\"stream\":true}")
  UP_STREAM_REQ=$(reqid "$HDR")
  printf '%s' "$STREAM" | grep -q 'data: \[DONE\]' \
    && echo "PASS  upstream stream terminates with data: [DONE]" \
    || { echo "FAIL  no [DONE] sentinel in the upstream stream"; FAILED=$((FAILED+1)); }
  get "$A_JAR" "/api/usage?pageSize=10&search=$UP_STREAM_REQ"
  check "streamed upstream call was metered" 1 "$(printf '%s' "$BODY" | jq_ 'o.total')"
  # The regression guard for reconcileUsage: some gateways publish completion_tokens=0 in the
  # terminal chunk while streaming a full answer, and metering that verbatim would under-debit
  # the caller's allocation.
  check "streamed row counted output tokens" true "$(printf '%s' "$BODY" | jq_ 'o.rows[0].outputTokens > 0')"
  echo "      in=$(printf '%s' "$BODY" | jq_ 'o.rows[0].inputTokens') out=$(printf '%s' "$BODY" | jq_ 'o.rows[0].outputTokens') latency=$(printf '%s' "$BODY" | jq_ 'o.rows[0].latencyMs')ms"
fi

echo
if [ "$FAILED" -eq 0 ]; then echo "ALL CHECKS PASSED"; else echo "$FAILED CHECK(S) FAILED"; fi
rm -f "$A_JAR" "$B_JAR" "$HDR"
exit "$FAILED"
