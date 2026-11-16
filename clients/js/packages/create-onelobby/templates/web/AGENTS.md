Multiplayer settings live in `onelobby.json`: read it first, and change it there (runtime keys apply on reload, no rebuild).
Its schema (every key has a description): {{schemaUrl}}
Recipe for this setup: {{recipeUrl}}
The test command is `npx create-onelobby verify`: it loads `onelobby.json` through the real loader, runs `test/multiplayer.mjs` (two players, a message each way, frames) and prints one last line, `VERIFY_OK` or `VERIFY_FAIL <check>: <what to do>`. `npm test` runs just the test file.
