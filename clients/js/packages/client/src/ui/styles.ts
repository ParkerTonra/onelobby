/** Shadow-DOM styles for `<one-lobby>`. Theme with CSS custom properties on the element (see docs/no-code.md). */
export const LOBBY_CSS = `
:host {
  --onelobby-bg: #ffffff;
  --onelobby-fg: #1b1f24;
  --onelobby-muted: #57606a;
  --onelobby-border: #d0d7de;
  --onelobby-accent: #0b5cad;
  --onelobby-accent-fg: #ffffff;
  --onelobby-danger: #b42318;
  --onelobby-field: #f6f8fa;
  --onelobby-radius: 12px;
  --onelobby-font: system-ui, -apple-system, "Segoe UI", Roboto, sans-serif;
  display: block;
  max-width: 28rem;
  font-family: var(--onelobby-font);
  color: var(--onelobby-fg);
  line-height: 1.4;
}
:host([theme="dark"]) {
  --onelobby-bg: #161b22; --onelobby-fg: #e6edf3; --onelobby-muted: #9da7b3; --onelobby-border: #30363d;
  --onelobby-accent: #4c9be8; --onelobby-accent-fg: #0d1117; --onelobby-danger: #ff7b72; --onelobby-field: #0d1117;
}
@media (prefers-color-scheme: dark) {
  :host([theme="auto"]), :host(:not([theme])) {
    --onelobby-bg: #161b22; --onelobby-fg: #e6edf3; --onelobby-muted: #9da7b3; --onelobby-border: #30363d;
    --onelobby-accent: #4c9be8; --onelobby-accent-fg: #0d1117; --onelobby-danger: #ff7b72; --onelobby-field: #0d1117;
  }
}
[hidden] { display: none !important; }
.card {
  background: var(--onelobby-bg);
  border: 1px solid var(--onelobby-border);
  border-radius: var(--onelobby-radius);
  padding: 1rem;
  display: grid;
  gap: 0.75rem;
}
.status { font-size: 1rem; margin: 0; }
.status.error { color: var(--onelobby-danger); font-weight: 600; }
.hint { margin: 0; color: var(--onelobby-muted); }
label { display: grid; gap: 0.25rem; font-size: 0.9rem; color: var(--onelobby-muted); }
input {
  font: inherit; font-size: 1rem; color: var(--onelobby-fg); background: var(--onelobby-field);
  border: 1px solid var(--onelobby-border); border-radius: 8px; padding: 0.6rem 0.7rem; min-height: 44px; box-sizing: border-box; width: 100%;
}
#code { text-transform: uppercase; letter-spacing: 0.15em; font-family: ui-monospace, Consolas, monospace; }
button {
  font: inherit; font-size: 1rem; min-height: 44px; padding: 0.5rem 1rem; border-radius: 8px; cursor: pointer;
  border: 1px solid var(--onelobby-border); background: var(--onelobby-field); color: var(--onelobby-fg);
}
button.primary { background: var(--onelobby-accent); color: var(--onelobby-accent-fg); border-color: var(--onelobby-accent); font-weight: 600; }
button:disabled { opacity: 0.55; cursor: not-allowed; }
button:focus-visible, input:focus-visible { outline: 3px solid var(--onelobby-accent); outline-offset: 2px; }
.row { display: flex; gap: 0.5rem; flex-wrap: wrap; align-items: end; }
.row > label { flex: 1 1 10rem; }
.or { text-align: center; color: var(--onelobby-muted); font-size: 0.9rem; }
.codebox { display: grid; gap: 0.5rem; justify-items: start; }
.code {
  font-family: ui-monospace, Consolas, monospace; font-size: clamp(2rem, 9vw, 2.75rem); font-weight: 700;
  letter-spacing: 0.12em; user-select: all;
}
h3 { margin: 0; font-size: 0.9rem; color: var(--onelobby-muted); font-weight: 600; }
ul { list-style: none; margin: 0; padding: 0; display: grid; gap: 0.25rem; }
li { display: flex; gap: 0.5rem; align-items: center; }
.tag { font-size: 0.75rem; border: 1px solid var(--onelobby-border); border-radius: 999px; padding: 0 0.5rem; color: var(--onelobby-muted); }
.bar { display: flex; gap: 0.5rem; flex-wrap: wrap; align-items: center; justify-content: space-between; }
.sr { position: absolute; width: 1px; height: 1px; overflow: hidden; clip: rect(0 0 0 0); white-space: nowrap; }
`;
