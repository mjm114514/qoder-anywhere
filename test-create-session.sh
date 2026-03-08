#!/usr/bin/env bash
curl -sf \
  -H "Content-Type: application/json" \
  -d '{"message": "Say hello and tell me what directory you are in. Do not use any tools, just respond with text.", "maxTurns": 1}' \
  "http://localhost:3001/api/sessions?cwd=/Users/jiamingmao/repos/test-lgtm-anywhere"
