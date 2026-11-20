#!/bin/sh
# Inject mobile.css and mobile.js into ttyd's web client template, before it
# is built (Dockerfile, ttyd-client stage). Usage: inject.sh <template.html>
#
# The template is rendered by html-webpack-plugin as a lodash template, so the
# injected files must not contain "<%" or "${" - checked below so a future
# edit fails the build instead of producing a broken page.
set -eu

TEMPLATE="$1"
DIR=$(dirname "$0")

for f in "$DIR/mobile.css" "$DIR/mobile.js"; do
    if grep -q -e '<%' -e '\${' "$f"; then
        echo "inject.sh: $f contains '<%' or '\${', which breaks the lodash template" >&2
        exit 1
    fi
done

grep -q '</head>' "$TEMPLATE" || { echo "inject.sh: no </head> in $TEMPLATE" >&2; exit 1; }

# viewport-fit=cover exposes the safe-area insets (iPhone home bar) to CSS.
sed -i 's|<meta name="viewport" content="[^"]*">|<meta name="viewport" content="width=device-width, initial-scale=1, viewport-fit=cover, interactive-widget=resizes-content">|' "$TEMPLATE"

{
    printf '<style>\n'
    cat "$DIR/mobile.css"
    printf '</style>\n<script>\n'
    cat "$DIR/mobile.js"
    printf '</script>\n'
} > /tmp/cc-inject.html

awk -v inject=/tmp/cc-inject.html '
    !done && /<\/head>/ { while ((getline line < inject) > 0) print line; done = 1 }
    { print }
' "$TEMPLATE" > /tmp/cc-template.html
mv /tmp/cc-template.html "$TEMPLATE"

grep -q 'cc-keybar' "$TEMPLATE" || { echo "inject.sh: injection failed" >&2; exit 1; }
echo "inject.sh: mobile tweaks injected into $TEMPLATE"
