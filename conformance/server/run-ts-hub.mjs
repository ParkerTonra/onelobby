#!/usr/bin/env node
// Runs the conformance suite against the TypeScript hub (onelobby/direct, clients/js/packages/client/src/direct/hub.ts)
// behind its own WebSocket listener, in hosted mode (codes, list, all checks) with limits x20, the README's functional
// pass. Build the client first: npm run build -w onelobby (in clients/js).
//   node conformance/server/run-ts-hub.mjs [suite options, e.g. --only=resume]
import { pathToFileURL } from 'node:url';
import { resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { parseArgs, runSuite } from './run.mjs';

const here = dirname(fileURLToPath(import.meta.url));
const dist = resolve(here, '../../clients/js/packages/client/dist/direct/index.js');
const { DirectHubHost, defaultHubOptions } = await import(pathToFileURL(dist).href);

// Rate-limit pass (README): ONELOBBY_RATE_SCALE=1 node conformance/server/run-ts-hub.mjs --ratelimit --fresh
const rateScale = Number(process.env.ONELOBBY_RATE_SCALE ?? 20);
// --direct: a single-lobby hub (what a direct host runs), for the direct-hub tests only
const direct = process.argv.includes('--direct');
const host = await DirectHubHost.listen(0, { ...defaultHubOptions(), rateScale, singleLobby: direct }, { host: '127.0.0.1' });
const opts = parseArgs([`ws://127.0.0.1:${host.port}/ws`, ...process.argv.slice(2)]);
const r = await runSuite(opts);
await host.close();
process.exit(r.fatal ? 2 : r.failed ? 1 : 0);
