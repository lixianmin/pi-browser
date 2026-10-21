/**
 * 上游 `defineTool` 同名同形：保留参数推断。
 * 为什么需要：把工具赋给变量或放进数组时，上下文类型会把 `TParams` 拓宽回默认值（`params` 变成 `unknown`），
 * 调用方就得手写泛型——pi 用这个辅助函数顶住推断，我们照抄。
 */
export function defineTool(definition) {
    return definition;
}
/**
 * 注册期校验：声明期能查清的事一律响亮抛错（缺 `description` 模型就选不准工具、缺 `parameters`
 * 上游没法校验入参、缺 `execute` 工具就是空的、缺 `label` 与上游形状不符）。
 * 错误消息带工具名——静默失效比报错更糟。
 */
export function validateToolDefinition(def) {
    const name = typeof def?.name === 'string' ? def.name.trim() : '';
    const where = name === '' ? '（工具名缺失）' : `"${name}"`;
    const bad = (why) => {
        throw new Error(`registerTool${where}：${why}`);
    };
    if (name === '')
        bad('`name` 不能为空');
    if (typeof def.label !== 'string' || def.label.trim() === '')
        bad('`label` 不能为空（pi 必填，不做缺省归一）');
    if (typeof def.description !== 'string' || def.description.trim() === '')
        bad('`description` 不能为空（模型靠它选工具）');
    if (def.parameters === undefined || def.parameters === null)
        bad('`parameters` 缺失（typebox schema）');
    if (typeof def.execute !== 'function')
        bad('`execute` 必须是函数');
}
