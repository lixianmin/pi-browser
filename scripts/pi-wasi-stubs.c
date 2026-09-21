/* pi-browser: wasi-sh 链接用 --import-undefined，任何未定义符号都会留成 wasm import，
 * 而 wasi-sh 的 JS shim 只实现了一部分 WASI 导入——残留的 import 会让
 * WebAssembly.instantiate() 抛 "function import requires a callable"。
 *
 * 这里给 busybox applet 用到、但 wasi-libc / wasi-sh 都没提供的符号一个定义：
 *   - 能正确做的正确做（pread / inet_ntoa）；
 *   - wasi 语义上做不到的返回错误（不静默成功，让 applet 响亮报错）；
 *   - 纯副作用无意义的（fsync/tzset）做成无操作成功——wasi-sh 的 fd_write 已即时落盘。
 *
 * pread 是必需的：libbb 的 xfuncs_printf.o 引用 mmap，链接器据此拉进 libc.a(mman.o)，
 * 而 mman.o 引用 pread——所以即便不开 dd/shred，这个 import 也躲不掉。
 */
#include <unistd.h>
#include <errno.h>
#include <stdio.h>
#include <sys/types.h>
#include <netdb.h>
#include <arpa/inet.h>

/* ---- 正确实现 ---- */

/* wasi-libc 没有 pread：用 lseek + read 模拟（读后恢复原偏移）。 */
ssize_t pread(int fd, void *buf, size_t count, off_t offset)
{
	off_t cur = lseek(fd, 0, SEEK_CUR);
	ssize_t n;
	int saved;
	if (cur < 0)
		return -1;
	if (lseek(fd, offset, SEEK_SET) < 0)
		return -1;
	n = read(fd, buf, count);
	saved = errno;
	lseek(fd, cur, SEEK_SET);
	errno = saved;
	return n;
}

/* inet_ntoa：静态缓冲的地址转换，语义与 libc 一致。 */
char *inet_ntoa(struct in_addr in)
{
	static char buf[sizeof("255.255.255.255")];
	unsigned char *b = (unsigned char *)&in.s_addr;
	sprintf(buf, "%u.%u.%u.%u", b[0], b[1], b[2], b[3]);
	return buf;
}

/* ---- 无操作成功（wasi-sh 的写入即时落盘；wasi 里时区恒为 UTC）---- */

int fsync(int fd) { (void)fd; return 0; }
int fdatasync(int fd) { (void)fd; return 0; }
void tzset(void) { }

/* ---- 返回错误：wasi 没有主机名/域名解析，静默成功才是说谎 ---- */

static int pi_h_errno;

int *__h_errno_location(void)
{
	return &pi_h_errno;
}

int sethostname(const char *name, size_t len)
{
	(void)name; (void)len;
	errno = ENOSYS;
	return -1;
}

struct hostent *gethostbyname(const char *name)
{
	(void)name;
	pi_h_errno = HOST_NOT_FOUND;
	return NULL;
}

const char *hstrerror(int err)
{
	(void)err;
	return "host not found";
}
