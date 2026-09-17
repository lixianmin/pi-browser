import { run } from 'wasi-sh';
const chunks = [];
const r = await run({ args: ['busybox', '--list'], onOutput: (b) => chunks.push(b) });
const text = Buffer.concat(chunks.map((c) => Buffer.from(c))).toString();
console.log('exit', r.exitCode);
console.log(JSON.stringify(text.split(/\s+/).filter(Boolean).sort()));
