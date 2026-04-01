#!/usr/bin/env bash
# Post-processes the auto-generated Root.js from @coffeecup_tech/docusaurus-plugin-structured-data.
#
# Fixes:
#   1. Path lookup: strips baseUrl prefix and handles trailing slash mismatch
#   2. Removes broken "image": "...undefined" entries
#   3. Fixes the intro page path (/docs/// -> /docs/)
#   4. Adds WebSite schema for homepage

set -euo pipefail

# macOS (BSD) vs Linux (GNU) sed compatibility
if [[ "$(uname)" == "Darwin" ]]; then
  sedi() { sed -i '' "$@"; }
else
  sedi() { sed -i "$@"; }
fi

ROOT_JS="src/theme/Root.js"

if [[ ! -f "$ROOT_JS" ]]; then
  echo "Error: $ROOT_JS not found. Run 'npx docusaurus generate-structured-data' first."
  exit 1
fi

# 1. Fix path lookup — inject baseUrl stripping before schema resolution
perl -i -pe 's|const contentData = schemas\[location\.pathname\];|// Normalize path: strip baseUrl prefix and match with/without trailing slash
  const siteBaseUrl = \x27/nestjs-jetstream\x27;
  const strippedPath = location.pathname.startsWith(siteBaseUrl)
    ? location.pathname.slice(siteBaseUrl.length) \|\| \x27/\x27
    : location.pathname;
  const contentData = schemas[strippedPath] \|\| schemas[strippedPath + \x27/\x27] \|\| schemas[strippedPath.replace(/\\/\$/, \x27\x27)];|' "$ROOT_JS"

# 2. Remove image: undefined lines
sedi '/"image": "https:\/\/horizonrepublic\.github\.io\/undefined"/d' "$ROOT_JS"

# 3. Fix intro page broken path
sedi "s|'/docs///': {|'/docs/': {|" "$ROOT_JS"

# 4. Add WebSite schema to homepage instead of empty object
sedi 's|schemas\[homePath\] = {};|schemas[homePath] = { "@type": "WebSite", "name": "@horizon-republic/nestjs-jetstream", "description": "Production-grade NestJS transport for NATS JetStream — events, broadcast, ordered delivery, and RPC." };|' "$ROOT_JS"

# 5. Fix missing semicolons and useless conditional (flagged by code quality bots)
perl -i -0777 -pe '
  # Add semicolon to schemas object closing brace (before for loop)
  s/(\n  \})\n(  for \(const homePath)/\1;\n\2/;
  # Add semicolon to graphData assignment closing brace
  s/(\x27\@graph\x27: graphContent\n    \})\n/\1;\n/;
  # Remove useless graphData conditional and fix script tag quotes
  s/\{graphData && \(\n\s*<script type=\x27application\/ld\+json\x27>/<script type="application\/ld+json">/;
  s/\n\s*\)\}//;
' "$ROOT_JS"

# 6. Validate patches applied correctly
errors=0
grep -q "const siteBaseUrl = '/nestjs-jetstream'" "$ROOT_JS" || { echo "Error: baseUrl path patch did not apply."; errors=$((errors + 1)); }
grep -q "schemas\[homePath\] = { \"@type\": \"WebSite\"" "$ROOT_JS" || { echo "Error: homepage schema patch did not apply."; errors=$((errors + 1)); }
grep -q "'/docs/': {" "$ROOT_JS" || { echo "Error: intro path patch did not apply."; errors=$((errors + 1)); }

if [ $errors -gt 0 ]; then
  echo "Root.js patching failed with $errors error(s)."
  exit 1
fi

echo "Root.js patched successfully."
