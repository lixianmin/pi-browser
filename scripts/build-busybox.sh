#!/bin/sh
# 重编 pi-browser 自带的 busybox.wasm（含 find 选项、SHOW_USAGE、常用 applet；参见 scripts/busybox.config 的注释）。
#
#   sh scripts/build-busybox.sh
#
# 前置：wasi-sh 已装（node_modules/wasi-sh），且 PATH 上有 zig（brew install zig）。
# 产物：src/shell/busybox.wasm（提交进仓库；npm install 不会覆盖它）。
#
# 为什么需要这个脚本而不是直接用上游 wasm：
#   1. 上游 busybox.config 裁掉了 -path/-maxdepth/-mtime/-size 等 find 选项，且 SHOW_USAGE 关闭
#      （`--help` 静默 exit 0）。这些对 agent 是硬伤。
#   2. 「打开了更多 applet」会引入 wasi-libc / wasi-sh 都没实现的符号，而链接用 --import-undefined
#      会把未定义符号留成 wasm import，实例化时抛 "function import requires a callable"。
#      所以还要链接进 scripts/pi-wasi-stubs.c 提供这些符号。
set -e
here=$(cd "$(dirname "$0")" && pwd)
pkg=$(cd "$here/.." && pwd)
WS="$pkg/node_modules/wasi-sh"

[ -d "$WS" ] || { echo "找不到 $WS：先在 $pkg 跑一次 npm install" >&2; exit 1; }
command -v zig >/dev/null 2>&1 || { echo "找不到 zig：brew install zig" >&2; exit 1; }

cp "$here/busybox.config" "$WS/build/busybox.config"
cp "$here/pi-wasi-stubs.c" "$WS/build/shim/pi_wasi_stubs.c"

# build.sh 没有「额外源码文件」的钩子，只能就地插入两步：编译桩 + 把它加进最终链接。
# 幂等：已经插过就跳过；插不进去（上游改了行）就报错，不静默产出一个缺桩的 wasm。
BS="$WS/build/build.sh"
if ! grep -q pi_wasi_stubs "$BS"; then
	sed -i.bak \
		-e 's|^zcc -O2 -c "\$SHIM/ppoll.c"     -o "\$work/ppoll.o"$|zcc -O2 -c "$SHIM/ppoll.c"     -o "$work/ppoll.o"\nzcc -O2 -c "$SHIM/pi_wasi_stubs.c" -o "$work/pi_wasi_stubs.o"|' \
		-e 's|"\$work/wasistubs.o" "\$work/ppoll.o" "\$work/rt.o"|"$work/wasistubs.o" "$work/ppoll.o" "$work/pi_wasi_stubs.o" "$work/rt.o"|' \
		"$BS"
	rm -f "$BS.bak"
	grep -q pi_wasi_stubs "$BS" || { echo "打补丁失败：build.sh 的行与预期不符，看 $BS" >&2; exit 1; }
fi

sh "$WS/build/build.sh"

cp "$WS/dist/busybox.wasm" "$pkg/src/shell/busybox.wasm"
echo "-> $pkg/src/shell/busybox.wasm ($(wc -c < "$pkg/src/shell/busybox.wasm") bytes)"
echo "记得：跑测试（bunx vitest run）后再提交。"
