// debugger/src/devtools/devtools.ts —— DevTools 面板注册。
// minimum_chrome_version 95 的依据:chrome.scripting 的 world 参数(spec F2)。
chrome.devtools.panels.create('PI Browser', '', 'src/panel/panel.html');
