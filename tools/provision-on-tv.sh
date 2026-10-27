#!/bin/bash
# One-time provisioning for TizenTube on Samsung Tizen TVs. RUN AS ROOT ON THE TV, after installing the widget.
#
# Creates, on the TV only:
#  - a private local CA plus leaf certificates for youtube.com / www.youtube.com
#    (leaf keys stay in the app's private data dir, mode 0600; the CA private key is deleted);
#  - upstream-ca.pem built from Cobalt's own bundled roots (used to verify the real YouTube);
#  - a copy of Cobalt's content directory with the local CA added, used via --content=...
#    (the original read-only Cobalt files and the system trust store are not modified);
#  - onboot/autorestart flags for this package's service only (guarded single-row update);
#  - disables prelaunch.support on the native YouTube app (9Ur5IzDKqV) if present so launching
#    TizenTube does not resume an unproxied background Cobalt instance.
#
# Obtaining root on a Samsung TV is device specific and out of scope. Review before running.
set -eu
umask 077
printf System > /proc/self/attr/current 2>/dev/null || true

PKG="${PKG:-TizenTubeS}"
case "$PKG" in *[!A-Za-z0-9]*|"") echo "bad PKG"; exit 1;; esac
test "${#PKG}" -eq 10 || { echo "PKG must be the 10-character Tizen package id"; exit 1; }
SERVICE_ID="$PKG.StandaloneService"
APP=/opt/usr/apps/$PKG/res/wgt
DATA=/opt/usr/home/owner/apps_rw/$PKG/data
BASE=/opt/usr/share/tizentube
CONTENT=/home/owner/share/tizentube-content
SRC=/usr/apps/com.samsung.tv.cobalt/content/app/cobalt/content

test -f "$APP/service/local-proxy.js" || { echo "widget $PKG is not installed"; exit 1; }
grep -q -- "--content=$CONTENT" "$APP/config.xml" || { echo "config.xml --content does not match $CONTENT"; exit 1; }
test -d "$DATA" && test -d "$SRC"
test ! -e "$BASE" && test ! -e "$CONTENT"
for h in www.youtube.com youtube.com; do test ! -e "$DATA/$h.key"; done

mkdir -m 700 "$BASE" "$BASE/cert-tmp"
TMP="$BASE/cert-tmp"
trap 'rm -f "$TMP"/*; rmdir "$TMP" 2>/dev/null || true' EXIT
cat > "$TMP/ca.cnf" <<'CFG'
[req]
distinguished_name=dn
x509_extensions=v3ca
prompt=no
[dn]
CN=TizenTube Local CA
[v3ca]
basicConstraints=critical,CA:TRUE
keyUsage=critical,keyCertSign,cRLSign
subjectKeyIdentifier=hash
CFG
openssl req -x509 -newkey rsa:2048 -nodes -sha256 -days 3650 -config "$TMP/ca.cnf" -keyout "$TMP/ca.key" -out "$TMP/ca.crt" > "$BASE/certificate-generation.log" 2>&1
cp "$TMP/ca.crt" "$DATA/ca.crt"
serial=1001
for h in www.youtube.com youtube.com; do
  openssl req -new -newkey rsa:2048 -nodes -sha256 -subj "/CN=$h" -keyout "$DATA/$h.key" -out "$TMP/$h.csr" >> "$BASE/certificate-generation.log" 2>&1
  printf 'basicConstraints=critical,CA:FALSE\nkeyUsage=critical,digitalSignature,keyEncipherment\nextendedKeyUsage=serverAuth\nsubjectAltName=DNS:%s\n' "$h" > "$TMP/leaf.cnf"
  openssl x509 -req -in "$TMP/$h.csr" -CA "$TMP/ca.crt" -CAkey "$TMP/ca.key" -set_serial "$serial" -days 825 -sha256 -extfile "$TMP/leaf.cnf" -out "$DATA/$h.crt" >> "$BASE/certificate-generation.log" 2>&1
  serial=$((serial+1))
done
rm -f "$TMP/ca.key"

: > "$DATA/upstream-ca.pem"
for f in "$SRC"/ssl/certs/*; do
  test -f "$f" || continue
  awk '/-----BEGIN CERTIFICATE-----/{p=1} p{print} /-----END CERTIFICATE-----/{p=0}' "$f" >> "$DATA/upstream-ca.pem"
done
test -s "$DATA/upstream-ca.pem"

cp -a "$SRC" "$CONTENT"
find "$CONTENT" -exec chsmack -a User '{}' ';'
for opt in -subject_hash -subject_hash_old; do
  dest="$CONTENT/ssl/certs/$(openssl x509 -in "$DATA/ca.crt" -noout "$opt").0"
  test ! -e "$dest" && cp "$DATA/ca.crt" "$dest" && chmod 644 "$dest" && chsmack -a User "$dest"
done
chmod 755 "$CONTENT"

OWNER="$(stat -c '%u:%g' "$DATA")"
for f in ca.crt upstream-ca.pem www.youtube.com.key www.youtube.com.crt youtube.com.key youtube.com.crt; do
  chmod 600 "$DATA/$f"; chown "$OWNER" "$DATA/$f"; chsmack -a "User::Pkg::$PKG" "$DATA/$f"
done

if [ -f /opt/usr/apps/9Ur5IzDKqV/res/config.xml ]; then
  if [ ! -f "$BASE/9Ur5IzDKqV-config.xml.bak" ]; then
    cp -a /opt/usr/apps/9Ur5IzDKqV/res/config.xml "$BASE/9Ur5IzDKqV-config.xml.bak"
  fi
  if grep -q 'prelaunch.support" value="true"' /opt/usr/apps/9Ur5IzDKqV/res/config.xml 2>/dev/null; then
    sed -i 's/prelaunch.support" value="true"/prelaunch.support" value="false"/g' /opt/usr/apps/9Ur5IzDKqV/res/config.xml || true
  fi
fi

DB=/opt/dbspace/.pkgmgr_parser.db
sqlite3 "$DB" ".timeout 15000" ".backup $BASE/pkgmgr.before-onboot.db"
sqlite3 -bail "$DB" <<SQL
.timeout 15000
BEGIN IMMEDIATE;
CREATE TEMP TABLE guard(ok INTEGER CHECK(ok=1));
INSERT INTO guard SELECT count(*)=1 FROM package_app_info WHERE app_id='$SERVICE_ID' AND package='$PKG' AND app_disable='false';
UPDATE package_app_info SET app_onboot='true',app_autorestart='true' WHERE app_id='$SERVICE_ID' AND package='$PKG';
UPDATE package_app_app_metadata SET md_value='false' WHERE app_id='9Ur5IzDKqV.TizenYouTube' AND md_key='http://samsung.com/tv/metadata/prelaunch.support';
DROP TABLE guard;
COMMIT;
SQL
app_launcher -s "$SERVICE_ID" || true
openssl x509 -in "$DATA/ca.crt" -noout -fingerprint -sha256
echo PROVISIONED
