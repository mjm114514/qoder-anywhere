#!/usr/bin/env bash
set -euo pipefail

BASE_URL="http://localhost:3001"
WS_URL="ws://localhost:3001"
TEST_CWD="/Users/jiamingmao/repos/test-lgtm-anywhere"
THIS_CWD="/Users/jiamingmao/repos/lgtm-anywhere"
SERVER_PID=""

# Colors
GREEN='\033[0;32m'
RED='\033[0;31m'
CYAN='\033[0;36m'
NC='\033[0m'

pass() { echo -e "${GREEN}✓ $1${NC}"; }
fail() { echo -e "${RED}✗ $1${NC}"; exit 1; }
section() { echo -e "\n${CYAN}=== $1 ===${NC}"; }

cleanup() {
  if [[ -n "$SERVER_PID" ]]; then
    echo -e "\n${CYAN}Stopping server (PID $SERVER_PID)...${NC}"
    kill "$SERVER_PID" 2>/dev/null || true
    wait "$SERVER_PID" 2>/dev/null || true
  fi
}
trap cleanup EXIT

# ────────────────────────────────────────
section "1. Starting server"
# ────────────────────────────────────────

cd "$(dirname "$0")"
npx tsx packages/server/src/index.ts &
SERVER_PID=$!

# Wait for server to be ready
for i in $(seq 1 30); do
  if curl -s "$BASE_URL/api/projects" > /dev/null 2>&1; then
    pass "Server started (PID $SERVER_PID)"
    break
  fi
  if [[ $i -eq 30 ]]; then
    fail "Server failed to start after 30s"
  fi
  sleep 1
done

# ────────────────────────────────────────
section "2. GET /api/projects"
# ────────────────────────────────────────

PROJECTS=$(curl -sf "$BASE_URL/api/projects")
COUNT=$(echo "$PROJECTS" | python3 -c "import sys,json; print(len(json.load(sys.stdin)))")
echo "  Found $COUNT projects"
echo "$PROJECTS" | python3 -m json.tool | head -20
pass "GET /api/projects"

# ────────────────────────────────────────
section "3. GET /api/sessions?cwd=..."
# ────────────────────────────────────────

ENCODED_CWD=$(python3 -c "import urllib.parse; print(urllib.parse.quote('$THIS_CWD', safe=''))")
SESSIONS=$(curl -sf "$BASE_URL/api/sessions?cwd=$ENCODED_CWD&limit=3")
echo "$SESSIONS" | python3 -m json.tool | head -30
pass "GET /api/sessions?cwd=..."

# ────────────────────────────────────────
section "4. GET /api/sessions/:session_id"
# ────────────────────────────────────────

SESSION_ID=$(echo "$SESSIONS" | python3 -c "import sys,json; s=json.load(sys.stdin); print(s[0]['sessionId'] if s else '')")
if [[ -n "$SESSION_ID" ]]; then
  DETAIL=$(curl -sf "$BASE_URL/api/sessions/$SESSION_ID?limit=3")
  echo "$DETAIL" | python3 -c "
import sys, json
d = json.load(sys.stdin)
print(f\"  sessionId: {d['sessionId']}\")
print(f\"  summary:   {d['summary'][:60]}...\")
print(f\"  state:     {d['state']}\")
print(f\"  messages:  {len(d['messages'])} (limit=3)\")
"
  pass "GET /api/sessions/:session_id"
else
  echo "  (skipped — no sessions found)"
fi

# ────────────────────────────────────────
section "5. POST /api/sessions?cwd=... (Create session)"
section "   Project: ~/repos/test-lgtm-anywhere"
# ────────────────────────────────────────

echo "  Creating new session..."

ENCODED_TEST_CWD=$(python3 -c "import urllib.parse; print(urllib.parse.quote('$TEST_CWD', safe=''))")
CREATE_RESPONSE=$(curl -sf \
  -H "Content-Type: application/json" \
  -d '{"message": "Say hello and tell me what directory you are in. Do not use any tools, just respond with text.", "maxTurns": 1}' \
  "$BASE_URL/api/sessions?cwd=$ENCODED_TEST_CWD")

echo "  Response: $CREATE_RESPONSE"

NEW_SESSION_ID=$(echo "$CREATE_RESPONSE" | python3 -c "import sys,json; print(json.load(sys.stdin)['sessionId'])")
if [[ -n "$NEW_SESSION_ID" ]]; then
  echo "  New session ID: $NEW_SESSION_ID"
  pass "POST /api/sessions?cwd=..."
else
  fail "POST /api/sessions?cwd=... — no sessionId returned"
fi

# ────────────────────────────────────────
section "6. WebSocket: Connect and receive streaming events"
# ────────────────────────────────────────

echo "  Connecting to WebSocket and waiting for events..."

WS_OUTPUT=$(mktemp)

# Use a small Node.js script to test WebSocket
node --input-type=module <<WSSCRIPT > "$WS_OUTPUT" 2>&1 || true
import WebSocket from 'ws';

const ws = new WebSocket('${WS_URL}/ws/sessions/${NEW_SESSION_ID}');
const timeout = setTimeout(() => {
  console.log('[timeout] Closing WS after 60s');
  ws.close();
  process.exit(0);
}, 60000);

let gotResult = false;

ws.on('open', () => {
  console.log('[ws] Connected');
});

ws.on('message', (raw) => {
  const msg = JSON.parse(raw.toString());
  console.log('[ws] event=' + msg.event + ' data=' + JSON.stringify(msg.data).substring(0, 200));
  if (msg.event === 'result') {
    gotResult = true;
    console.log('[ws] Got result, closing');
    clearTimeout(timeout);
    ws.close();
  }
});

ws.on('close', () => {
  console.log('[ws] Closed, gotResult=' + gotResult);
  process.exit(gotResult ? 0 : 1);
});

ws.on('error', (err) => {
  console.error('[ws] Error:', err.message);
  clearTimeout(timeout);
  process.exit(1);
});
WSSCRIPT

echo ""
echo "  --- WS events received ---"
head -50 "$WS_OUTPUT"
echo "  --- end ---"

HAS_RESULT=$(grep -c 'event=result' "$WS_OUTPUT" || true)
if [[ "$HAS_RESULT" -gt 0 ]]; then
  pass "WebSocket streaming events"
else
  echo "  Warning: No result event found in WS output"
  fail "WebSocket streaming events"
fi

# ────────────────────────────────────────
section "7. WebSocket: Send follow-up message"
# ────────────────────────────────────────

echo "  Sending follow-up message via WebSocket..."

# Give the session a moment to go idle
sleep 2

WS_OUTPUT2=$(mktemp)

node --input-type=module <<WSSCRIPT2 > "$WS_OUTPUT2" 2>&1 || true
import WebSocket from 'ws';

const ws = new WebSocket('${WS_URL}/ws/sessions/${NEW_SESSION_ID}');
const timeout = setTimeout(() => {
  console.log('[timeout] Closing WS after 60s');
  ws.close();
  process.exit(0);
}, 60000);

let gotResult = false;

ws.on('open', () => {
  console.log('[ws] Connected, sending message');
  ws.send(JSON.stringify({ type: 'message', message: 'Now say goodbye. Do not use any tools.' }));
});

ws.on('message', (raw) => {
  const msg = JSON.parse(raw.toString());
  console.log('[ws] event=' + msg.event + ' data=' + JSON.stringify(msg.data).substring(0, 200));
  if (msg.event === 'result') {
    gotResult = true;
    console.log('[ws] Got result, closing');
    clearTimeout(timeout);
    ws.close();
  }
});

ws.on('close', () => {
  console.log('[ws] Closed, gotResult=' + gotResult);
  process.exit(gotResult ? 0 : 1);
});

ws.on('error', (err) => {
  console.error('[ws] Error:', err.message);
  clearTimeout(timeout);
  process.exit(1);
});
WSSCRIPT2

echo ""
echo "  --- WS events received ---"
head -50 "$WS_OUTPUT2"
echo "  --- end ---"

HAS_RESULT2=$(grep -c 'event=result' "$WS_OUTPUT2" || true)
if [[ "$HAS_RESULT2" -gt 0 ]]; then
  pass "WebSocket follow-up message"
else
  echo "  Warning: No result event found in WS output"
  fail "WebSocket follow-up message"
fi

# ────────────────────────────────────────
section "8. PUT /api/sessions/:session_id"
# ────────────────────────────────────────

UPDATE=$(curl -sf -X PUT \
  -H "Content-Type: application/json" \
  -d '{"title": "Test Session", "model": "sonnet"}' \
  "$BASE_URL/api/sessions/$NEW_SESSION_ID")
echo "  $UPDATE"
pass "PUT /api/sessions/:session_id"

# ────────────────────────────────────────
section "9. DELETE /api/sessions/:session_id"
# ────────────────────────────────────────

DELETE=$(curl -sf -X DELETE \
  "$BASE_URL/api/sessions/$NEW_SESSION_ID")
echo "  $DELETE"
pass "DELETE /api/sessions/:session_id"

# ────────────────────────────────────────
section "All tests passed!"
# ────────────────────────────────────────

# Cleanup handled by trap
