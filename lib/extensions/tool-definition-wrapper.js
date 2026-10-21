/** 把一份扩展工具声明适配成 core 直接可注册的工具。 */
export function wrapToolDefinition(definition, ctxFactory) {
    return {
        name: definition.name,
        label: definition.label,
        description: definition.description,
        parameters: definition.parameters,
        execute: (toolCallId, params, signal, onUpdate) => definition.execute(toolCallId, params, signal, onUpdate, ctxFactory(toolCallId, signal)),
    };
}
