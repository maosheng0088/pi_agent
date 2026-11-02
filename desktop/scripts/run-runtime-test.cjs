'use strict';
const { spawn } = require('node:child_process');
const fs = require('node:fs/promises');
const path = require('node:path');
const os = require('node:os');
void (async () => {
  const temporary = await fs.mkdtemp(path.join(os.tmpdir(), 'pi-desktop-runtime-'));
  const root = path.join(__dirname, '..'), environment = { ...process.env, PI_DESKTOP_TEST_DIRECTORY: temporary }; delete environment.ELECTRON_RUN_AS_NODE;
  const code = await new Promise((resolve, reject) => { const child = spawn(require('electron'), [path.join(root, 'test', 'runtime.cjs')], { cwd: root, env: environment, stdio: 'inherit', windowsHide: true }); child.once('error', reject); child.once('exit', resolve); });
  if (path.dirname(path.resolve(temporary)) !== path.resolve(os.tmpdir()) || !path.basename(temporary).startsWith('pi-desktop-runtime-')) throw new Error('Unsafe test cleanup directory');
  await fs.rm(temporary, { recursive: true, force: true }); process.exitCode = code || 0;
})().catch(error => { console.error(error); process.exitCode = 1; });
