// debugger/src/background/background.ts —— MV3 service worker 入口(esm)。
// 只做 chrome.* 接线,决策在 router.ts。
import { chromeRouter, createMessageHandler } from './router';

chrome.runtime.onMessage.addListener(createMessageHandler(chromeRouter(chrome.scripting)));
