/**
 * Entry for the single-file bundles: `dist/keepalive.global.js` (sets `window.Keepalive`) and
 * `dist/keepalive.bundle.mjs` (the same, as one ES module). Whatever is exported here is what a `<script src>` page
 * sees as `Keepalive.*`.
 */
export * from "./index.js";
