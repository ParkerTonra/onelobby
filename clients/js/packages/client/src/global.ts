/**
 * Entry for the single-file bundles: `dist/keepalive.global.js` (sets `window.Keepalive`) and
 * `dist/keepalive.bundle.mjs` (the same, as one ES module). Whatever is exported here is what a `<script src>` page
 * sees as `Keepalive.*`. It includes the drop-in UI, so loading the bundle also registers `<keepalive-lobby>`
 * (a no-op outside the browser).
 */
export * from "./index.js";
export * from "./ui/index.js";
