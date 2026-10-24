# Third-party components (com.onelobby.unity)

| Component | How it gets here | Licence | Notes |
|---|---|---|---|
| libdatachannel v0.24.6 + libjuice (MPL-2.0), usrsctp (BSD-3-Clause), plog (MIT), Mbed TLS 3.6.7 (Apache-2.0) | One native library per platform in `Runtime/Plugins/<platform>/` (`datachannel.dll`, `libdatachannel.so`, `libdatachannel.dylib`), built unmodified by `clients/dotnet/OneLobby.DataChannel/native/` | as listed | Obligations for a game that ships them: `clients/dotnet/OneLobby.DataChannel/THIRD_PARTY.md`. Licence texts: `Runtime/Plugins/Licenses/`. |
| System.Text.Json 8.0.5, System.Text.Encodings.Web, Microsoft.Bcl.AsyncInterfaces, System.Runtime.CompilerServices.Unsafe | NuGet dependencies of `OneLobby.Core` (netstandard2.1), copied into `Runtime/Plugins/Dependencies` by `build-unity-package` | MIT (.NET Foundation) | Unity's .NET Standard 2.1 profile has no System.Text.Json. System.Memory, System.Buffers, System.Numerics.Vectors and System.Threading.Tasks.Extensions are deliberately not copied: Unity provides them. If another package in your project already ships one of these DLLs, delete the duplicate from `Runtime/Plugins/Dependencies`. |
| [Concentus](https://github.com/lostromb/concentus) 2.2.2 | NuGet dependency of `OneLobby.Opus`, copied into `Runtime/Plugins/Dependencies` | BSD-3-Clause | Managed Opus; see `clients/dotnet/THIRD_PARTY.md`. Reproduce its notice if you ship voice. |

Earlier versions of this package used Unity's `com.unity.webrtc` (Unity Companion License, deprecated by Unity); it is
no longer a dependency.
