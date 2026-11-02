'use strict';
const { spawn } = require('node:child_process');
const fs = require('node:fs/promises');
const path = require('node:path');
const os = require('node:os');
void (async () => {
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), 'pi-desktop-update-runtime-'));
  const root = path.join(__dirname, '..'), environment = { ...process.env, PI_DESKTOP_UPDATE_TEST_DIRECTORY: directory }; delete environment.ELECTRON_RUN_AS_NODE;
  const code = await new Promise((resolve, reject) => { const child = spawn(require('electron'), [path.join(root, 'test', 'updates-runtime.cjs')], { cwd: root, env: environment, stdio: 'inherit', windowsHide: true }); child.once('error', reject); child.once('exit', resolve); });
  if (path.dirname(path.resolve(directory)) !== path.resolve(os.tmpdir()) || !path.basename(directory).startsWith('pi-desktop-update-runtime-')) throw new Error('Unsafe test cleanup directory');
  await fs.rm(directory, { recursive: true, force: true }); process.exitCode = code || 0;
})().catch(error => { console.error(error); process.exitCode = 1; });
