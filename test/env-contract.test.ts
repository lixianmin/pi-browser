// @vitest-environment node
// Task 7：`FileSystem` 契约对照（上游对照，是 devDep `pi-durable` 的第一个消费者）。
//
// 与 equivalence.node.test.ts 的分工：那份比的是**行为等价表**（同一操作序列的逐条结果），这份比的是
// **方法集合 ⊇ 上游**——等价表只覆盖策展过的那几条，漏掉的成员要有一处兜底。方法名从上游实例上现取（不手抄）。
import { describe, it, expect } from 'vitest';
import { NodeExecutionEnv } from '@earendil-works/pi-durable/env/node';
import type { ExecutionEnv } from '../src/env/types';
import { createMemoryFileSystem } from '../src/env/backend-memory';
import { createBrowserExecutionEnv, createBrowserFileSystem } from '../src/index';

/** 一个对象上全部方法名：原型链上的（类的实现）+ 自身属性里的函数（对象字面量形式的实现） */
function methodNames(target: object): string[] {
	const skip = new Set(['constructor']);
	const names = new Set<string>();
	for (let proto = target; proto && proto !== Object.prototype; proto = Object.getPrototypeOf(proto)) {
		for (const key of Object.getOwnPropertyNames(proto)) {
			if (skip.has(key)) continue;
			if (typeof (target as Record<string, unknown>)[key] === 'function') names.add(key);
		}
	}
	for (const [key, value] of Object.entries(target)) {
		if (typeof value === 'function') names.add(key);
	}
	return [...names].sort();
}

const isolatedEnv = (): ExecutionEnv => createBrowserExecutionEnv({
	mounts: [
		{ prefix: '/', fs: createMemoryFileSystem('/') },
		{ prefix: '/tmp', fs: createMemoryFileSystem('/tmp') },
	],
});

describe('FileSystem 契约对照（vs pi-durable@1.0.0 NodeExecutionEnv）', () => {
	// 上游 `ExecutionEnv = FileSystem & Shell`，而 `cleanup` 两个接口都有——Shell 独有的只有 `exec`，
	// 所以「FileSystem 面 = ExecutionEnv 减 exec」。裸 fs 后端不该有 exec（那是 env 装配的事）。
	const shellOnly = new Set(['exec']);
	const upstreamEnv = methodNames(new NodeExecutionEnv({ cwd: '/' }));
	const upstreamFs = upstreamEnv.filter((name) => !shellOnly.has(name));

	it('上游方法名取到了（防探测本身失效）', () => {
		expect(upstreamEnv.length).toBeGreaterThan(10);
		expect(upstreamFs).toContain('readTextLines');
		expect(upstreamFs).not.toContain('exec');
	});

	it('本仓 ExecutionEnv 的方法集合 ⊇ 上游 ExecutionEnv', () => {
		const ours = methodNames(isolatedEnv());
		expect(upstreamEnv.filter((name) => !ours.includes(name))).toEqual([]);
	});

	it('本仓两个裸 fs 后端的方法集合 ⊇ 上游 FileSystem 面', () => {
		for (const fs of [createMemoryFileSystem(), createBrowserFileSystem({ memory: true })]) {
			const ours = methodNames(fs);
			expect(upstreamFs.filter((name) => !ours.includes(name))).toEqual([]);
		}
	});

	it('本仓后端也有 id 这条非方法契约', () => {
		for (const fs of [createMemoryFileSystem(), createBrowserFileSystem({ memory: true })]) {
			expect(typeof fs.id).toBe('string');
		}
		expect(typeof new NodeExecutionEnv({ cwd: '/' }).id).toBe('string');
	});
});
