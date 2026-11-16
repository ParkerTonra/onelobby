#!/usr/bin/env node
import { main } from "../src/cli.js";

const code = await main(process.argv.slice(2));
process.exitCode = code;
// verify starts local servers (a TURN helper keeps sockets open): once its verdict is printed, do not wait for them
if (process.argv[2] === "verify") setTimeout(() => process.exit(code), 300).unref();
