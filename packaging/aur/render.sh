#!/bin/sh
# Writes PKGBUILD and .SRCINFO for bawkterm-bin. Usage: render.sh <version> <sha256 of the release tar.gz> <output dir>
set -e
version="$1"
sha="$2"
out="${3:-.}"
here="$(cd "$(dirname "$0")" && pwd)"

sed -e "s/@VERSION@/${version}/" -e "s/@SHA256@/${sha}/" "$here/PKGBUILD.in" > "$out/PKGBUILD"

cp "$here/LICENSE" "$out/LICENSE"

# .SRCINFO mirrors PKGBUILD; written here so CI needs no Arch container for makepkg --printsrcinfo
cat > "$out/.SRCINFO" <<EOF
pkgbase = bawkterm-bin
	pkgdesc = SSH, SFTP, Docker and Remote Desktop client with an encrypted vault
	pkgver = ${version}
	pkgrel = 1
	url = https://github.com/juddisjudd/bawkterm
	arch = x86_64
	license = AGPL-3.0-only
	depends = alsa-lib
	depends = at-spi2-core
	depends = gtk3
	depends = libnotify
	depends = libsecret
	depends = libxss
	depends = libxtst
	depends = mesa
	depends = nss
	depends = util-linux-libs
	depends = xdg-utils
	optdepends = freerdp: open Remote Desktop hosts
	optdepends = gnome-keyring: remember the vault on this device
	optdepends = kwallet: remember the vault on this device
	provides = bawkterm
	conflicts = bawkterm
	options = !strip
	options = !debug
	source = bawkterm-${version}.tar.gz::https://github.com/juddisjudd/bawkterm/releases/download/v${version}/bawkterm-${version}.tar.gz
	sha256sums = ${sha}

pkgname = bawkterm-bin
EOF
