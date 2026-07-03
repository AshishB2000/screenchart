#!/usr/bin/env bash
#
# Create a STABLE self-signed code-signing identity for the Screenchart macOS
# build. A stable signature is what makes the macOS Screen Recording (TCC) grant
# stick across rebuilds — with ad-hoc signing (identity: null) every build gets a
# new signature, so the grant never persists.
#
# This is NOT an Apple Developer ID and is NOT notarized: users will still see
# Gatekeeper's "Apple could not verify…" warning and must right-click → Open
# (once). That tradeoff is intentional and documented on the download page.
#
# Run ONCE per machine:   bash scripts/make-signing-cert.sh
# Then build signed:      npm run dist:mac
#
# The identity name MUST match build.mac.identity in package.json.
set -euo pipefail

CN="Screenchart Code Signing"
KEYCHAIN="$HOME/Library/Keychains/login.keychain-db"
WORK="$(mktemp -d)"
trap 'rm -rf "$WORK"' EXIT

if [[ "$(uname)" != "Darwin" ]]; then
  echo "This script is macOS-only." >&2
  exit 1
fi

# Already present? Don't create a second one (that would change the signature).
if security find-identity -v -p codesigning | grep -qF "$CN"; then
  echo "✓ A code-signing identity named \"$CN\" already exists — nothing to do."
  security find-identity -v -p codesigning | grep -F "$CN"
  exit 0
fi

echo "Creating self-signed code-signing certificate \"$CN\"…"

# 1) Self-signed cert (10 years) with the Code Signing extended key usage.
cat > "$WORK/ext.cnf" <<EOF
[req]
distinguished_name = dn
x509_extensions    = v3
prompt             = no
[dn]
CN = $CN
[v3]
basicConstraints   = critical,CA:false
keyUsage           = critical,digitalSignature
extendedKeyUsage   = critical,codeSigning
EOF

openssl req -x509 -newkey rsa:2048 -nodes -days 3650 \
  -keyout "$WORK/key.pem" -out "$WORK/cert.pem" -config "$WORK/ext.cnf" 2>/dev/null

# 2) Bundle key+cert into a PKCS#12 (empty passphrase — local dev cert).
openssl pkcs12 -export -inkey "$WORK/key.pem" -in "$WORK/cert.pem" \
  -name "$CN" -out "$WORK/bundle.p12" -passout pass: 2>/dev/null

# 3) Import into the login keychain. -A lets codesign use the key without a
#    per-build keychain prompt (fine for a local self-signed dev cert).
security import "$WORK/bundle.p12" -k "$KEYCHAIN" -P "" -A

# 4) Trust the cert for code signing so `find-identity -v -p codesigning` (which
#    electron-builder uses to discover the identity) lists it as valid. User
#    trust domain — no sudo required.
security add-trusted-cert -r trustRoot -p codeSign -k "$KEYCHAIN" "$WORK/cert.pem"

echo
if security find-identity -v -p codesigning | grep -qF "$CN"; then
  echo "✓ Created and trusted \"$CN\":"
  security find-identity -v -p codesigning | grep -F "$CN"
  echo
  echo "Next:  npm run dist:mac    (signs with this identity)"
  echo "       Open Keychain Access if macOS prompts to allow codesign — click Always Allow."
else
  echo "⚠ Identity created but not showing as valid for code signing." >&2
  echo "  Open Keychain Access → find \"$CN\" → Get Info → Trust →" >&2
  echo "  set 'Code Signing' to 'Always Trust', then re-run this script." >&2
  exit 1
fi
