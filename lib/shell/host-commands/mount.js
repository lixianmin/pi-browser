export function makeMount() {
    return (request) => {
        const mounts = request.mounts ?? [];
        if (mounts.length === 0) {
            // inline 路径没有挂载表可读（没有 store）——明确报错，不假装成功
            return { exitCode: 1, stderr: 'mount: 无挂载表可用（该命令只在 worker 路径可读）\n' };
        }
        return {
            exitCode: 0,
            stdout: `${mounts.map((m) => `${m.prefix} on browser-fs`).join('\n')}\n`,
        };
    };
}
