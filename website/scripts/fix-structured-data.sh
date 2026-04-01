#!/usr/bin/env bash
# Post-processes the auto-generated Root.js from @coffeecup_tech/docusaurus-plugin-structured-data.
#
# Fixes:
#   1. Path lookup: strips baseUrl prefix and handles trailing slash mismatch
#   2. Removes broken "image": "...undefined" entries
#   3. Fixes the intro page path (/docs/// -> /docs/)
#   4. Adds WebSite schema for homepage

set -euo pipefail

ROOT_JS="src/theme/Root.js"

if [[ ! -f "$ROOT_JS" ]]; then
  echo "Error: $ROOT_JS not found. Run 'npx docusaurus generate-structured-data' first."
  exit 1
fi

# 1. Fix path lookup — inject baseUrl stripping before schema resolution
sed -i '' "s|const contentData = schemas\[location\.pathname\];|// Normalize path: strip baseUrl prefix and match with/without trailing slash\n  const siteBaseUrl = '/nestjs-jetstream';\n  const strippedPath = location.pathname.startsWith(siteBaseUrl)\n    ? location.pathname.slice(siteBaseUrl.length) \|\| '/'\n    : location.pathname;\n  const contentData = schemas[strippedPath] \|\| schemas[strippedPath + '/'] \|\| schemas[strippedPath.replace(/\\\\\\\\\\/\$/, '')];|" "$ROOT_JS"

# 2. Remove image: undefined lines
sed -i '' '/"image": "https:\/\/horizonrepublic\.github\.io\/undefined"/d' "$ROOT_JS"

# 3. Fix intro page broken path
sed -i '' "s|'/docs///': {|'/docs/': {|" "$ROOT_JS"

# 4. Add WebSite schema to homepage instead of empty object
sed -i '' 's|schemas\[homePath\] = {};|schemas[homePath] = { "@type": "WebSite", "name": "@horizon-republic/nestjs-jetstream", "description": "Production-grade NestJS transport for NATS JetStream — events, broadcast, ordered delivery, and RPC." };|' "$ROOT_JS"

echo "Root.js patched successfully."
