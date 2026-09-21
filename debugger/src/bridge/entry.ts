// debugger/src/bridge/entry.ts —— bridge.js 的 iife 唯一入口。
// 被 background 经 chrome.scripting.executeScript({world:'MAIN', files:['bridge.js']})
// 注入页面;注入即执行安装(模块体副作用,幂等由 installBridge 保证)。
import { installBridge } from './install';

installBridge();
