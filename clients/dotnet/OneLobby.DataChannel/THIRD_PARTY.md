# Third-party components (OneLobby.DataChannel natives)

`OneLobby.DataChannel.dll` itself is MIT (this repo). The native library it loads (`datachannel.dll`,
`libdatachannel.so`, `libdatachannel.dylib`) is built by `native/build-*.{ps1,sh}` from the pinned sources below,
**unmodified** except for one Mbed TLS build option, and linked statically into that one file. Only binaries are shipped;
OneLobby does not redistribute the source. Licence texts: `native/licenses/` (the Unity package copies them into
`Runtime/Plugins/Licenses/`). Verified 2026-10-24 from the files in each source tree.

| Component | Version | Licence | Bundled? |
|---|---|---|---|
| [libdatachannel](https://github.com/paullouisageneau/libdatachannel) | v0.24.6 (tag, `versions.env`) | MPL-2.0 ("licensed under MPL 2.0 since version 0.18") | Yes |
| [libjuice](https://github.com/paullouisageneau/libjuice) (ICE) | submodule of v0.24.6 (`deps/libjuice` b89c792) | MPL-2.0 | Yes |
| [usrsctp](https://github.com/sctplab/usrsctp) (SCTP for data channels) | submodule (`deps/usrsctp` fec583d) | BSD-3-Clause (Randall Stewart, Michael Tuexen and contributors) | Yes |
| [plog](https://github.com/SergiusTheBest/plog) (logging, header-only) | submodule (`deps/plog` 94899e0) | MIT (Sergey Podobry) | Yes |
| [Mbed TLS](https://github.com/Mbed-TLS/mbedtls) (DTLS) | 3.6.7 LTS release tarball, SHA-256 pinned | Apache-2.0 OR GPL-2.0-or-later; OneLobby uses it under **Apache-2.0** | Yes, static |
| nlohmann/json, libSRTP | submodules | MIT, BSD-3-Clause | **No**: only used by examples (json) and media (libSRTP); built with `NO_EXAMPLES`, `NO_MEDIA` |

## What a game that ships these binaries must do

- **MPL-2.0 (libdatachannel, libjuice)** is file-level copyleft. Shipping the unmodified library in binary form is
  allowed in a closed-source game; the obligations are: tell recipients the library is under MPL-2.0 and where its source
  is (MPL s.3.2(a)), and do not restrict that. Put a line like "This game uses libdatachannel and libjuice (MPL-2.0),
  source at https://github.com/paullouisageneau/libdatachannel (tag v0.24.6)" plus the licence text in the credits or a
  third-party notices file. If you ever change their source files, you must publish those changed files under MPL-2.0;
  your own code stays yours.
- **Apache-2.0 (Mbed TLS)**: include the licence text and keep copyright notices. The build enables
  `MBEDTLS_SSL_DTLS_SRTP` in `include/mbedtls/mbedtls_config.h` (one line uncommented, needed by libdatachannel's DTLS
  transport, same as Godot's build); that changed file is not distributed, only the compiled library.
- **BSD-3-Clause (usrsctp)** and **MIT (plog)**: reproduce the copyright notice and licence text in the notices.

`native/licenses/` holds all five texts, so copying that folder next to your game's credits covers it. Nothing here is
GPL (Mbed TLS's GPL option is not used) and nothing restricts commercial use.
