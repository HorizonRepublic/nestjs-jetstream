#!/usr/bin/env bash
# Post-processes the auto-generated Root.js from @coffeecup_tech/docusaurus-plugin-structured-data.
#
# Fixes:
#   1. Path lookup: strips baseUrl prefix and handles trailing slash mismatch
#   2. Removes broken "image": "...undefined" entries
#   3. Fixes the intro page path (/docs/// -> /docs/)
#   4. Adds WebSite schema for homepage
#   5. Moves the JSON-LD into <Head> so it is server-rendered, not hydration-only
#   6. Mounts CommandPalette here. Docusaurus allows exactly one theme/Root, so a
#      second one shadowed this file and silently dropped every schema on the site.

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

# 1. Fix path lookup — handle trailing slash mismatch (baseUrl is now root, so no prefix to strip)
perl -i -pe 's|const contentData = schemas\[location\.pathname\];|// Normalize path: match with/without trailing slash
  const strippedPath = location.pathname \|\| \x27/\x27;
  const contentData = schemas[strippedPath] \|\| schemas[strippedPath + \x27/\x27] \|\| schemas[strippedPath.replace(/\\/\$/, \x27\x27)];|' "$ROOT_JS"

# 2. Remove image: undefined lines (matches any host since we may switch domains)
sedi '/"image": "https:\/\/[^"]*\/undefined"/d' "$ROOT_JS"

# 3. Fix intro page broken path
sedi "s|'/docs///': {|'/docs/': {|" "$ROOT_JS"

# 4. The home page needs no page-level schema: WebSite now comes from baseSchema
#    and lands in the graph on every route, so injecting a second one here would
#    duplicate the node.

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

# 6. Render the JSON-LD through <Head>, and mount CommandPalette in the same tree.
#    A bare <script> only reaches the DOM after hydration, and a second theme/Root
#    would shadow this file entirely.
perl -i -0777 -pe '
  s|import \{ useLocation \} from \x27\@docusaurus/router\x27;|import { useLocation } from \x27\@docusaurus/router\x27;\nimport Head from \x27\@docusaurus/Head\x27;\nimport CommandPalette from \x27\@site/src/components/CommandPalette\x27;|;
  s|<script type="application/ld\+json">\s*\{JSON\.stringify\(graphData\)\}\s*</script>|<CommandPalette />\n      <Head>\n        <script type="application/ld+json">{JSON.stringify(graphData)}</script>\n      </Head>|;
' "$ROOT_JS"

# 7. Credit the organization as author. The generator points every Article at a
#    #person node, and this graph has none, so the reference resolved to nothing.
perl -i -0777 -pe "s|contentData\.author = \{\n        '\@id': \`\\\$\{baseUrl\}/#person\`\n      \};|contentData.author = {\n        '\@id': \`\\\${baseUrl}/#organization\`\n      };|" "$ROOT_JS"

# 8. Validate patches applied correctly
errors=0
grep -q '#person' "$ROOT_JS" && { echo "Error: dangling #person reference survived."; errors=$((errors + 1)); }
grep -q "import Head from '@docusaurus/Head';" "$ROOT_JS" || { echo "Error: Head import patch did not apply."; errors=$((errors + 1)); }
grep -q "<Head>" "$ROOT_JS" || { echo "Error: Head wrapper patch did not apply."; errors=$((errors + 1)); }
grep -q "<CommandPalette />" "$ROOT_JS" || { echo "Error: CommandPalette mount patch did not apply."; errors=$((errors + 1)); }
if [[ -e "src/theme/Root.jsx" ]] || [[ -e "src/theme/Root/index.jsx" ]]; then
  echo "Error: a second theme/Root exists and will shadow this file."
  errors=$((errors + 1))
fi
grep -q "const strippedPath = location.pathname" "$ROOT_JS" || { echo "Error: path-normalization patch did not apply."; errors=$((errors + 1)); }
grep -q "'/docs/': {" "$ROOT_JS" || { echo "Error: intro path patch did not apply."; errors=$((errors + 1)); }

if [ $errors -gt 0 ]; then
  echo "Root.js patching failed with $errors error(s)."
  exit 1
fi

echo "Root.js patched successfully."
