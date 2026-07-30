#!/usr/bin/env node
// CommonJS launcher whose only job is the Node version guard. It must stay
// parseable by ancient Node (no ?., ??, ESM syntax): the real entry is an ESM
// graph that old Node fails to *parse*, so a guard inside it can never run.
'use strict';

var major = parseInt(process.versions.node.split('.')[0], 10);
if (major < 22) {
  console.error(
    'tiktok-mcp-ai requires Node.js >= 22, but this is ' +
      process.versions.node +
      '.\nUse a newer runtime, e.g.: nvm install 24 && nvm use 24',
  );
  process.exit(1);
}

import('../build/src/index.js').catch(function (err) {
  console.error(err && err.stack ? err.stack : String(err));
  process.exit(1);
});
