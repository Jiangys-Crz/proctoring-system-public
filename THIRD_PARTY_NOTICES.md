# Third-party notices

The application source is distributed under **GNU AGPL version 3 only** (`AGPL-3.0-only`), except for third-party material covered by its own license. The full application license is in [LICENSE](LICENSE). Existing third-party copyright and license notices are retained; this document does not replace those notices.

## Contest syntax comparison engine

The vendored comparison engine is distributed under GNU AGPL v3. Its source, bundled worker, parser assets and original license are preserved in [apps/web/vendor/contest-code-check](apps/web/vendor/contest-code-check/README.md).

- [Original engine license](apps/web/vendor/contest-code-check/LICENSE)
- [Tree-sitter runtime license](apps/web/vendor/contest-code-check/source/vendor/TREE-SITTER-LICENSE)
- [VS Code grammar distribution license](apps/web/vendor/contest-code-check/tokens/VSCODE-LICENSE)
- [Individual parser and grammar licenses](apps/web/vendor/contest-code-check/tokens/licenses)

## Browser automation and media tooling

- The browser deployment retains the [Playwright license](deployment/LICENSE.playwright).
- Desktop packaging uses FFmpeg binaries downloaded or prepared separately. The preserved [Windows FFmpeg license](apps/desktop/build/ffmpeg/win32-x64/ffmpeg.exe.LICENSE) and [upstream distribution documentation](apps/desktop/build/ffmpeg/win32-x64/ffmpeg.exe.README) accompany that build's instructions. Check the license, notices and source-distribution requirements of the exact FFmpeg build before redistributing an installer.

## Package dependencies and identity

JavaScript, native and mobile dependencies retain their own licenses. Package manifests, the pnpm lockfile, Swift package resolution and Android build definitions identify those dependencies. Preserve applicable notices when redistributing compiled applications.

The software license does not grant trademark rights to organizational names, school marks, logos or third-party product names. Use your own deployment identity and avoid implying an endorsement.

---

# Reaction integration notices

The Reaction integration and its recording changes were developed against
[proctoring-system-public](https://github.com/Jiangys-Crz/proctoring-system-public),
whose source is distributed under **AGPL-3.0-only**. The imported source retains
that license; the complete text is preserved in
[licenses/reaction/AGPL-3.0-only.txt](licenses/reaction/AGPL-3.0-only.txt).
Existing upstream copyright and license notices remain applicable. This notice
does not replace the separate licenses of dependencies or grant trademark rights.

## Optional ICPC generator

The worker invokes the separately installed
[ICPC reactions-generator](https://github.com/icpc/reactions-generator), tested at
revision `59fd21d50e8bf4c69bd6e4b5c19a60726f30a20b`. Its `pyproject.toml` declares MIT
and credits Azat Ismagilov; that revision does not contain a standalone project
license file. The source and official template assets are not vendored here.
Preserve upstream notices when redistributing the optional package.

Its Nimbus fonts retain `fonts/nimbus/LICENSE.OFL`. The upstream `example/README.md`
credits the CC0 sounds `notify.wav` and `critical_fail.wav` by martcraft
([success](https://freesound.org/s/651629/), [failure](https://freesound.org/s/651626/)).
The background, default badge, and missing-camera placeholder in this repository
are repository-owned SVG assets; organization badges are supplied by administrators.
Fonts installed on the host are not copied into the repository.

## ZIP and media tools

Reaction exports use [yazl](https://github.com/thejoshwolfe/yazl), MIT license,
copyright (c) 2014 Josh Wolfe. The installed package retains its original LICENSE.
MP4 files are stored in the archive without re-encoding.

FFmpeg remains a separate runtime dependency under the license of the exact build.
Desktop FFmpeg distributions retain their bundled license and source-distribution
notices. Playwright retains its license in `deployment/LICENSE.playwright`.
All other package dependencies retain their own licenses and notices.
