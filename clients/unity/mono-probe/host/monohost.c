/* Minimal 64-bit host for Unity's embedded Mono runtime (Editor/Data/MonoBleedingEdge/EmbedRuntime/mono-2.0-bdwgc.dll,
 * the runtime the editor itself loads), with the unityjit-win32 class libraries. Unity's command-line mono.exe is
 * 32-bit and cannot load a 64-bit native plugin, hence this host.
 *   monohost.exe <Unity Editor/Data dir> <program.exe> [args...]
 * Build (x64 Native Tools prompt): cl /nologo /O2 monohost.c */
#include <windows.h>
#include <stdio.h>

typedef void (*set_dirs_t)(const char *, const char *);
typedef void (*set_paths_t)(const char *);
typedef void *(*jit_init_t)(const char *);
typedef void *(*open_t)(void *, const char *);
typedef int (*exec_t)(void *, void *, int, char **);
typedef void (*cleanup_t)(void *);
typedef int (*env_exit_t)(void);

int main(int argc, char **argv) {
    if (argc < 3) { fprintf(stderr, "usage: monohost <Editor/Data> <program.exe> [args]\n"); return 2; }
    char path[4096], lib[4096], etc[4096], asm_path[8192];
    snprintf(path, sizeof path, "%s/MonoBleedingEdge/EmbedRuntime/mono-2.0-bdwgc.dll", argv[1]);
    snprintf(lib, sizeof lib, "%s/MonoBleedingEdge/lib", argv[1]);
    snprintf(etc, sizeof etc, "%s/MonoBleedingEdge/etc", argv[1]);
    snprintf(asm_path, sizeof asm_path, "%s/mono/unityjit-win32;%s/mono/unityjit-win32/Facades", lib, lib);
    HMODULE m = LoadLibraryA(path);
    if (!m) { fprintf(stderr, "cannot load %s (%lu)\n", path, GetLastError()); return 2; }
    set_dirs_t set_dirs = (set_dirs_t)GetProcAddress(m, "mono_set_dirs");
    set_paths_t set_paths = (set_paths_t)GetProcAddress(m, "mono_set_assemblies_path");
    jit_init_t jit_init = (jit_init_t)GetProcAddress(m, "mono_jit_init");
    open_t open = (open_t)GetProcAddress(m, "mono_domain_assembly_open");
    exec_t exec = (exec_t)GetProcAddress(m, "mono_jit_exec");
    env_exit_t exit_code = (env_exit_t)GetProcAddress(m, "mono_environment_exitcode_get");
    if (!set_dirs || !set_paths || !jit_init || !open || !exec) { fprintf(stderr, "missing mono exports\n"); return 2; }
    set_dirs(lib, etc);
    set_paths(asm_path);
    void *domain = jit_init(argv[2]);
    void *assembly = open(domain, argv[2]);
    if (!assembly) { fprintf(stderr, "cannot open %s\n", argv[2]); return 2; }
    int rc = exec(domain, assembly, argc - 2, argv + 2);
    if (exit_code) { int e = exit_code(); if (e) rc = e; }
    fflush(stdout);
    ExitProcess((UINT)rc); /* skip mono_jit_cleanup: native threads may still be winding down */
}
