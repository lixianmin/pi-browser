// test/helpers/extension-context.ts —— 工具测试用的最小 `ExtensionContext`。
//
// P3 换注入模型后 `createExtensionContext` 吃的是「宿主注入的 contextActions」而不是 `lane` +
// `Context`（src/extensions/context.ts），所以工具测试的 ctx 也要跟着换绑。工具定义件只读
// `ctx.cwd`（P2b/P2c 的 cwd 覆盖用例），所以这里的注入全是空动作——不造假的可观测行为。
import type { ExtensionContext } from '../../src/extensions/context';
import { createExtensionContext } from '../../src/extensions/context';

const noopContextActions = {
	getModel: () => undefined,
	getSignal: () => undefined,
	abort: () => {},
	compact: () => {},
};

export function extensionCtx(cwd: string): ExtensionContext {
	return createExtensionContext({ cwd, contextActions: noopContextActions, assertActive: () => {} });
}
