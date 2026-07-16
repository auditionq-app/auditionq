#!/usr/bin/env bash
set -euo pipefail

BASE_URL="${BASE_URL:-http://localhost:3000}"
TEST_USER="smoke-test-$(date +%s)"
VIDEO_PATH="${1:-}"

if [[ -z "${VIDEO_PATH}" ]]; then
  echo "Usage: $0 /path/to/test-video.mp4"
  exit 1
fi

if [[ ! -f "${VIDEO_PATH}" ]]; then
  echo "Error: Video file not found: ${VIDEO_PATH}"
  exit 1
fi

echo "=== Smoke Test ==="
echo "Base URL: ${BASE_URL}"
echo "Test User: ${TEST_USER}"
echo "Video: ${VIDEO_PATH}"
echo

# 1. Upload valid video
echo "1. Uploading valid video..."
upload_response=$(curl -sS -w "\n%{http_code}" -F "video=@${VIDEO_PATH};type=video/mp4" \
  "${BASE_URL}/api/upload/${TEST_USER}")
http_code=$(echo "${upload_response}" | tail -1)
response_body=$(echo "${upload_response}" | head -n -1)

if [[ "${http_code}" != "202" ]]; then
  echo "✗ Upload failed with status ${http_code}"
  echo "Response: ${response_body}"
  exit 1
fi

echo "Response: ${response_body}"
videoId=$(echo "${response_body}" | grep -o '"videoId":"[^"]*"' | cut -d'"' -f4 || true)

if [[ -z "${videoId}" ]]; then
  echo "✗ Could not extract videoId from response"
  exit 1
fi

echo "✓ Upload succeeded, videoId: ${videoId}"
echo

# 2. Poll until ready (max 120s)
echo "2. Polling for completion (timeout 120s)..."
start=$(date +%s)
poll_count=0

while true; do
  now=$(date +%s)
  elapsed=$((now - start))
  
  if (( elapsed > 120 )); then
    echo "✗ Timeout: Processing took too long (>120s)"
    exit 1
  fi
  
  status_response=$(curl -sS "${BASE_URL}/api/videos/${TEST_USER}")
  status=$(echo "${status_response}" | grep -o '"status":"[^"]*"' | cut -d'"' -f4 || echo "unknown")
  
  poll_count=$((poll_count + 1))
  echo "  Poll #${poll_count} (${elapsed}s): status=${status}"
  
  if [[ "${status}" == "ready" ]]; then
    echo "✓ Video ready after ${elapsed}s"
    break
  elif [[ "${status}" == "failed" ]]; then
    error_msg=$(echo "${status_response}" | grep -o '"errorMessage":"[^"]*"' | cut -d'"' -f4 || echo "unknown")
    echo "✗ Video processing failed: ${error_msg}"
    exit 1
  elif [[ "${status}" == "processing" ]]; then
    # Still processing, keep polling
    sleep 3
  else
    echo "✗ Unexpected status: ${status}"
    echo "Full response: ${status_response}"
    exit 1
  fi
done
echo

# 3. Load profile page
echo "3. Loading profile page..."
profile=$(curl -sS "${BASE_URL}/profile/${TEST_USER}")

if [[ "${profile}" == *"video"* ]] && [[ "${profile}" == *"controls"* ]]; then
  echo "✓ Profile page loaded with video player"
else
  echo "✗ Profile page missing video player"
  echo "Page snippet: ${profile:0:200}"
  exit 1
fi
echo

echo "=== ✓ Smoke Test Passed ==="
echo "Summary:"
echo "  - Valid video uploaded successfully"
echo "  - Worker processed video in ${elapsed}s"
echo "  - Profile page displays video with player"
