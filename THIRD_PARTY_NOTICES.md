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
