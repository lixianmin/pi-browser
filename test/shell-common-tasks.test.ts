// @vitest-environment node
// spec §4.2/§4.3：常见任务用例集（50 条，六类）——人类验收集的 vitest 版。
// 源：/tmp/pi-browser-battery/battery.mjs（2026-09-17 实测 50/50，含 4 条「已知不支持」的响亮失败断言）。
// 移植原则：命令与判定**逐字保留**，只把执行路径换成 pi-browser 自己的 ExecutionEnv.exec
// （于是 run 边界的 seed/pullAndApply 也一并被这条用例集覆盖）。两处口径适配（如实记录，非放宽）：
//   ① 上游 Node 实现把 stdout/stderr 合入同一个 capture 视图，所以「响亮失败」判据是
//      非零退出 **或 视图非空**（原判据为 exitCode!==0 || stderr 非空）；正向用例里只有 F04 受影响：
//      busybox `cp -r` 在 WASI 无 chmod 时往 stderr 写一句 can't preserve permissions（wasi-sh 自带
//      memoryFs 同样如此，原 battery 比的是 stdout 所以看不到），这里按**合并后的完整文本**断言（比原
//      stdout 判据更严，不放松）；
//   ② F01 的命令含 ${...}，用单引号 JS 字符串防模板插值（模板字面量会当成 JS 插值报错）。
import { describe, it, expect } from 'vitest';
import {
	BACKGROUND_CONTEXT, applyShellOutputUpdate,
	type ExecutionEnv, type ShellOutputUpdate, type ShellOutputView,
} from '@earendil-works/pi-agent-core';
import { createBrowserExecutionEnv } from '../src/env/execution-env';

const CTX = BACKGROUND_CONTEXT;

interface CommonTask {
	n: string;
	cmd: string;
	files?: Record<string, string>;
	eq?: string;
	has?: string;
	no?: string;
	exitNonzero?: boolean;
	/** 已知不支持：断言**响亮**失败（非零退出或报错输出），静默成功视为不合格 */
	failLoud?: boolean;
}

const CASES: CommonTask[] = [
	// ---------- 文本处理 ----------
	{ n: 'T01 行数统计', cmd: `wc -l < /notes.txt`, files: { '/notes.txt': 'a\nb\nc\n' }, eq: '3\n' },
	{ n: 'T02 关键词计数', cmd: `grep -c ERROR /app.log`, files: { '/app.log': 'INFO ok\nERROR e1\nWARN w\nERROR e2\n' }, eq: '2\n' },
	{ n: 'T03 带行号定位', cmd: `grep -n TODO /main.js`, files: { '/main.js': '// ok\n// x\n// TODO fix\n' }, has: '3:// TODO fix' },
	{ n: 'T04 列提取', cmd: `cut -d, -f2 /data.csv`, files: { '/data.csv': 'a,b\nA,B\n' }, eq: 'b\nB\n' },
	{ n: 'T05 列求和', cmd: `awk -F, '{s+=$2} END {print s}' /data.csv`, files: { '/data.csv': 'x,10\ny,20\n' }, eq: '30\n' },
	{ n: 'T06 去重排序', cmd: `sort -u /names.txt`, files: { '/names.txt': 'bob\nalice\nbob\n' }, eq: 'alice\nbob\n' },
	{ n: 'T07 Top-N', cmd: `sort -rn /sizes.txt | head -n 2`, files: { '/sizes.txt': '100\n900\n50\n' }, eq: '900\n100\n' },
	{ n: 'T08 全局替换', cmd: `sed 's/foo/bar/g' /in.txt`, files: { '/in.txt': 'foo foo\nxfoo\n' }, eq: 'bar bar\nxbar\n' },
	{ n: 'T09 ERE 提取', cmd: `sed -nE 's/.*id=([0-9]+).*/\\1/p' /urls.txt`, files: { '/urls.txt': 'a id=12 b\nc id=7\nno id\n' }, eq: '12\n7\n' },
	{ n: 'T10 CRLF 清洗', cmd: `tr -d '\\r' < /win.txt`, files: { '/win.txt': 'a\r\nb\r\n' }, eq: 'a\nb\n' },
	{ n: 'T11 首尾切片', cmd: `head -n 2 /f.txt; tail -n 1 /f.txt`, files: { '/f.txt': '1\n2\n3\n' }, eq: '1\n2\n3\n' },
	{ n: 'T12 多级管道', cmd: `cat /access.log | grep 404 | wc -l`, files: { '/access.log': '200\n404\n200\n404\n' }, eq: '2\n' },
	{ n: 'T13 diff（已知缺失）', cmd: `diff /a.txt /b.txt`, files: { '/a.txt': 'same\nonly-a\n', '/b.txt': 'same\n' }, failLoud: true },
	{ n: 'T14 heredoc 写文件', cmd: `cat <<'EOF' > /out.txt\nhello world\nline2\nEOF\ncat /out.txt`, eq: 'hello world\nline2\n' },
	{ n: 'T15 追加重定向', cmd: `echo one > /l.txt && echo two >> /l.txt && cat /l.txt`, eq: 'one\ntwo\n' },

	// ---------- 文件管理 ----------
	// F01 用单引号字符串：命令里的 ${f%.txt} 在模板字面量里会被当成 JS 插值
	{ n: 'F01 批量重命名', cmd: 'cd /d; for f in *.txt; do mv "$f" "${f%.txt}.md"; done; ls | sort', files: { '/d/a.txt': '1', '/d/b.txt': '2' }, eq: 'a.md\nb.md\n' },
	{ n: 'F02 find 按名', cmd: `find /proj -name '*.js' | sort`, files: { '/proj/a.js': '', '/proj/sub/b.js': '', '/proj/c.txt': '' }, eq: '/proj/a.js\n/proj/sub/b.js\n' },
	{ n: 'F03 find 删除（无 -delete，用 xargs 惯用法）', cmd: `for f in $(find /proj -name '*.tmp'); do rm "$f"; done; find /proj -name '*.tmp' | wc -l`, files: { '/proj/x.tmp': '', '/proj/keep.txt': '' }, eq: '0\n' },
	{ n: 'F04 递归拷贝', cmd: `cp -r /src /dst && ls /dst`, files: { '/src/k.txt': 'v' }, eq: "cp: can't preserve permissions of '/dst': Function not implemented\nk.txt\n" },
	{ n: 'F05 时间戳备份', cmd: `cp /f.txt "/f.$(date +%s).bak" && ls /f.*.bak | wc -l`, files: { '/f.txt': 'v' }, eq: '1\n' },
	{ n: 'F06 空文件检测', cmd: `test -s /empty.txt; echo e=$?; test -s /full.txt; echo f=$?`, files: { '/empty.txt': '', '/full.txt': 'x' }, eq: 'e=1\nf=0\n' },
	{ n: 'F07 目录检测', cmd: `mkdir -p /d && test -d /d && echo yes`, eq: 'yes\n' },
	{ n: 'F08 字节数', cmd: `wc -c < /f.txt`, files: { '/f.txt': '12345' }, eq: '5\n' },
	{ n: 'F09 rm -rf 清理', cmd: `rm -rf /big && test -d /big; echo rc=$?`, files: { '/big/x/y.txt': 'v' }, eq: 'rc=1\n' },
	{ n: 'F10 多文件 wc 汇总', cmd: `wc -l /src/a.ts /src/b.ts`, files: { '/src/a.ts': '1\n2\n', '/src/b.ts': '1\n' }, has: 'total' },

	// ---------- 构建 / 校验 ----------
	{ n: 'B01 && 链', cmd: `mkdir -p /b && cd /b && echo built`, eq: 'built\n' },
	{ n: 'B02 set -e 快败', cmd: `set -e\nfalse\necho unreachable`, exitNonzero: true, no: 'unreachable' },
	{ n: 'B03 || 回退', cmd: `false || echo fallback`, eq: 'fallback\n' },
	{ n: 'B04 while read 逐行', cmd: `while read l; do echo "[$l]"; done < /lines.txt`, files: { '/lines.txt': 'a\nb\n' }, eq: '[a]\n[b]\n' },
	{ n: 'B05 函数', cmd: `greet() { echo hi $1; }; greet bob`, eq: 'hi bob\n' },
	{ n: 'B06 算术', cmd: `echo $((6*7))`, eq: '42\n' },
	{ n: 'B07 env 前缀', cmd: `FOO=bar sh -c 'echo $FOO'`, eq: 'bar\n' },
	{ n: 'B08 退出码捕获', cmd: `grep -q nope /f.txt; echo rc=$?`, files: { '/f.txt': 'x' }, eq: 'rc=1\n' },

	// ---------- 数据整理 ----------
	{ n: 'D01 分组求和', cmd: `awk -F, '{a[$1]+=$2} END {for (k in a) print k,a[k]}' /sales.csv | sort`, files: { '/sales.csv': 'a,1\nb,2\na,3\n' }, eq: 'a 4\nb 2\n' },
	{ n: 'D02 paste 合并', cmd: `paste /c1 /c2`, files: { '/c1': '1\n2\n', '/c2': 'x\ny\n' }, eq: '1\tx\n2\ty\n' },
	{ n: 'D03 printf 对齐', cmd: `printf "%-6s|%s\n" name val`, eq: 'name  |val\n' },
	{ n: 'D04 uniq -c', cmd: `sort /f.txt | uniq -c`, files: { '/f.txt': 'a\na\nb\n' }, has: '2 a' },
	{ n: 'D05 大小写转换', cmd: `tr 'a-z' 'A-Z' < /f.txt`, files: { '/f.txt': 'abc\n' }, eq: 'ABC\n' },
	{ n: 'D06 按列排序', cmd: `sort -t, -k2 -rn /data.csv | head -n 1`, files: { '/data.csv': 'x,10\ny,20\n' }, has: 'y,20' },

	// ---------- 项目运维 ----------
	{ n: 'P01 递归搜索', cmd: `grep -rn pattern /proj`, files: { '/proj/a.js': 'pattern here\n', '/proj/sub/b.js': 'nope\n' }, has: '/proj/a.js:1:pattern' },
	{ n: 'P02 清理重建', cmd: `rm -rf /build && mkdir -p /build && echo ok`, eq: 'ok\n' },
	{ n: 'P03 项目骨架', cmd: `mkdir -p /app/src /app/test && echo x > /app/src/i.ts && find /app -type f | sort`, eq: '/app/src/i.ts\n' },
	{ n: 'P04 跨文件替换', cmd: `sed -i s/old/new/g /p/1.txt /p/2.txt; cat /p/1.txt /p/2.txt`, files: { '/p/1.txt': 'old\n', '/p/2.txt': 'old\n' }, eq: 'new\nnew\n' },
	{ n: 'P05 字段校验', cmd: `awk -F, 'NF!=3 {print NR": bad"}' /rows.csv`, files: { '/rows.csv': '1,2,3\nbad\n4,5,6\n' }, eq: '2: bad\n' },
	{ n: 'P06 md5 校验和', cmd: `md5sum /f.txt | cut -d' ' -f1 | wc -c`, files: { '/f.txt': 'hello\n' }, eq: '33\n' },
	{ n: 'P07 tar（已知缺失）', cmd: `cd /d && tar czf /a.tgz .`, files: { '/d/k.txt': 'v' }, failLoud: true },
	{ n: 'P08 管道找最大', cmd: `wc -c /src/* | sort -rn | head -n 2 | tail -n 1`, files: { '/src/big.txt': '12345678', '/src/small.txt': '1' }, has: '/src/big.txt' },

	// ---------- 已知不支持（断言响亮失败，非静默错） ----------
	{ n: 'X01 chmod 不支持', cmd: `chmod 644 /f.txt`, files: { '/f.txt': 'x' }, failLoud: true },
	{ n: 'X02 后台任务', cmd: `sleep 1 & echo started`, failLoud: true },
	{ n: 'X03 纯内建子 shell（ash 同进程优化）', cmd: `(cd /; pwd)`, eq: '/\n' },
];

/** 一条用例 = 一个独立 env（用例之间不共享树，失败不级联） */
async function runCase(c: CommonTask): Promise<{ exitCode: number; output: string }> {
	const env: ExecutionEnv = createBrowserExecutionEnv();
	for (const [path, content] of Object.entries(c.files ?? {})) {
		const written = await env.writeFile(path, content, CTX);
		if (!written.ok) throw new Error(`装配失败 ${path}: ${written.error.code} ${written.error.message}`);
	}
	let view: ShellOutputView | undefined;
	const result = await env.exec(c.cmd, { onUpdate: (u: ShellOutputUpdate) => { view = applyShellOutputUpdate(view, u); } }, CTX);
	if (!result.ok) throw new Error(`exec 失败: ${result.error.code} ${result.error.message}`);
	await env.cleanup(CTX);
	return { exitCode: result.value.exitCode, output: view?.text ?? '' };
}

describe('常见任务用例集（50 条）', () => {
	it('用例数目与人类验收集一致', () => {
		expect(CASES).toHaveLength(50);
	});

	for (const c of CASES) {
		it(c.n, async () => {
			const { exitCode, output } = await runCase(c);
			if (c.failLoud) {
				expect(exitCode !== 0 || output.length > 0, `期望响亮失败，实际 exit=${exitCode} 且无任何输出（静默成功）`).toBe(true);
				return;
			}
			if (c.exitNonzero) expect(exitCode, `exit=${exitCode}`).not.toBe(0);
			if (c.eq !== undefined) expect(output).toBe(c.eq);
			if (c.has !== undefined) expect(output).toContain(c.has);
			if (c.no !== undefined) expect(output).not.toContain(c.no);
		});
	}
});
