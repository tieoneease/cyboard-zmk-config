import { main } from './server.mjs';

main().catch(error => { console.error(error.message); process.exitCode = 1; });
