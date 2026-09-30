# Vendored libsodium archives

The `libsodium-sys-stable` crate builds libsodium from these files instead of downloading anything. `.cargo/config.toml` points its `SODIUM_DIST_DIR` at this folder. The crate's build script still checks every archive against the libsodium release key it pins (minisign `RWQf6LRCGA9i53mlYecO4IzT51TGPpvWucNSCh1CBM0QTaLn73Y7GFO3`), so a changed file fails the build.

| File | Used on | SHA-256 |
|---|---|---|
| `LATEST.tar.gz` | macOS, Linux (built from source) | `b20a92e7ec25b285eafa349d721a5bb27e3a8ba94c0816630a127883f1d1b3ab` |
| `LATEST.tar.gz.minisig` | | `2162883303fb903068519916871476b192d5cf31d5e412378db8ae05a0c05895` |
| `libsodium-1.0.22-stable-msvc.zip` | Windows (MSVC, prebuilt) | `4b310d0602b6217d68b3000df19af595841ba101910af8d335096f9c45c9f36a` |
| `libsodium-1.0.22-stable-msvc.zip.minisig` | | `5a4bf29a7e0f5ba01cb7c74424afee72187f4970369c13c319fbf703dfe18a83` |

- **`LATEST.tar.gz` and its signature** are the exact files shipped inside `libsodium-sys-stable` 1.24.0, which `Cargo.lock` pins by checksum.
- **The MSVC zip and its signature** were downloaded from `download.libsodium.org` on 2026-09-30, signed 2026-09-28. That file is replaced in place upstream, which is why it's committed here rather than downloaded during the build.

To update libsodium, bump `libsodium-sys-stable` deliberately, then replace these files and their checksums here in the same commit. The golden-vault and test-vector tests must still pass on every OS.
