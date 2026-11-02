import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { startServer } from '../server.mjs';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const sdkPath = path.resolve(process.env.PI_SDK_PATH || path.join(root, 'vendor/pi/packages/coding-agent/dist/index.js'));

if (!fs.existsSync(sdkPath)) {
  console.error('Pi SDK has not been built. Run npm --prefix vendor/pi ci --ignore-scripts, then npm --prefix vendor/pi run build.');
  process.exitCode = 1;
} else {
  try {
    const server = await startServer({ sdkPath, defaultCwd: root });
    console.log(`Pi Agent running at http://${server.address().address}:${server.address().port}/`);
    let stopping = false;
    const stop = async () => {
      if (stopping) return;
      stopping = true;
      try { await server.piWeb.close(); } catch (error) { console.error(error.message); process.exitCode = 1; }
    };
    process.on('SIGINT', stop);
    process.on('SIGTERM', stop);
  } catch (error) {
    console.error(error.message);
    process.exitCode = 1;
  }
}
