// Main-process copy: native dialogs shown before or outside the web UI. The UI packages keep their own dictionaries.
const zh = {
  startFailedTitle: 'visCreative 无法启动',
  startTimeout: (log: string) => `后台服务没有在预期时间内启动。\n\n日志：${log}`,
  startExited: (log: string) => `后台服务启动后立即退出。\n\n日志：${log}`,
  incompatibleRunning: (version: string) => `正在运行的后台服务（${version}）与这个版本的应用不兼容。请先退出旧版本应用并等待后台服务结束，然后重新打开。`,
  uiMissing: '找不到界面文件。从源码运行时请先执行 pnpm build。',
  quit: '退出',
  pickFolder: '选择文件夹',
}

const en: typeof zh = {
  startFailedTitle: 'visCreative could not start',
  startTimeout: log => `The background service did not start in time.\n\nLog: ${log}`,
  startExited: log => `The background service exited right after starting.\n\nLog: ${log}`,
  incompatibleRunning: version => `The background service that is running (${version}) is not compatible with this version of the app. Quit the older app, wait for its background service to stop, then open this one again.`,
  uiMissing: 'The interface files are missing. When running from source, run pnpm build first.',
  quit: 'Quit',
  pickFolder: 'Choose a folder',
}

export function desktopMessages(locale: string): typeof zh {
  return locale.toLowerCase().startsWith('zh') ? zh : en
}
