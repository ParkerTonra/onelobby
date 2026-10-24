/**
 * Entry for the single-file bundles: `dist/onelobby.global.js` (sets `window.OneLobby`) and
 * `dist/onelobby.bundle.mjs` (the same, as one ES module). Whatever is exported here is what a `<script src>` page
 * sees as `OneLobby.*`. It includes the drop-in UI, so loading the bundle also registers `<one-lobby>`
 * (a no-op outside the browser).
 */
export * from "./index.js";
export * from "./ui/index.js";
