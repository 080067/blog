// 构建后处理：把 HTML / CSS 里对本站静态资源目录的引用改写到 CDN 域名。
// 这样页面 HTML 依旧同源（接口不受影响），而图片、音频这些大块头走阿里云香港节点。
// 用法：node scripts/cdn-rewrite.mjs [dist目录] [CDN 前缀]
import { readdir, readFile, writeFile } from "node:fs/promises";
import { join, extname } from "node:path";

const dist = process.argv[2] || "dist";
const prefix = (process.argv[3] || "https://cdn.nihilism.cloud").replace(/\/+$/, "");
// 只改写这些目录，别碰 /api/（私有接口必须直连源站）
const dirs = ["/images/", "/audio/", "/vendor/"];

const files = [];
async function walk(dir) {
	for (const entry of await readdir(dir, { withFileTypes: true })) {
		const p = join(dir, entry.name);
		if (entry.isDirectory()) await walk(p);
		else if ([".html", ".css"].includes(extname(entry.name))) files.push(p);
	}
}
await walk(dist);

let changed = 0;
let hits = 0;
for (const file of files) {
	let text = await readFile(file, "utf8");
	const before = text;
	for (const d of dirs) {
		// 只处理「站点内绝对路径」的写法："/images/xxx、'/images/xxx、(/images/xxx
		const pattern = new RegExp(`(["'(])${d.replace(/\//g, "\\/")}`, "g");
		text = text.replace(pattern, (_m, quote) => {
			hits += 1;
			return `${quote}${prefix}${d}`;
		});
	}
	if (text !== before) {
		await writeFile(file, text, "utf8");
		changed += 1;
	}
}

console.log(`[cdn-rewrite] 扫描 ${files.length} 个文件，改写 ${changed} 个，替换 ${hits} 处 -> ${prefix}`);
