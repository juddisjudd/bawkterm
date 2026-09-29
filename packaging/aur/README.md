# AUR package (bawkterm-bin)

The release workflow updates [bawkterm-bin](https://aur.archlinux.org/packages/bawkterm-bin) on the Arch User Repository after each tagged release. It repackages the release's `bawkterm-<version>.tar.gz`.

It only runs once the `AUR_SSH_PRIVATE_KEY` secret exists. Without it, the step prints a notice and skips.

## One-time setup

1. Create an account at [aur.archlinux.org](https://aur.archlinux.org).
2. Make a key just for this, without a passphrase (CI cannot type one):

   ```sh
   ssh-keygen -t ed25519 -f aur -C "bawkterm AUR" -N ""
   ```

3. Paste the contents of `aur.pub` into **My Account → SSH Public Key** on the AUR.
4. In this GitHub repository, open **Settings → Secrets and variables → Actions**. Add a secret named `AUR_SSH_PRIVATE_KEY` with the contents of `aur`.
5. Delete the local `aur` file, or keep it only in your password manager. If it ever leaks, make a new key and replace it on the AUR.

The next release creates the package on the AUR (the first push registers the name) and keeps it up to date after that.

## Test locally on Arch

```sh
packaging/aur/render.sh 0.3.2 <sha256 of bawkterm-0.3.2.tar.gz> /tmp/bawkterm-bin
cd /tmp/bawkterm-bin && makepkg -si
```

