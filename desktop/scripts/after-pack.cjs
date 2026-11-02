'use strict';
const path = require('node:path');
module.exports = async context => {
  if (context.electronPlatformName !== 'win32') return;
  const { rcedit } = await import('rcedit');
  await rcedit(path.join(context.appOutDir, 'PiConsole.exe'), { icon: path.join(__dirname, '..', 'assets', 'icon.ico'), 'file-version': context.packager.appInfo.version, 'product-version': context.packager.appInfo.version, 'requested-execution-level': 'asInvoker', 'version-string': { ProductName: 'PiConsole', FileDescription: 'PiConsole 企业智能体工作台', CompanyName: 'PiConsole', OriginalFilename: 'PiConsole.exe' } });
};
