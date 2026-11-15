import type { Env } from "../admin/_shared";
import { authenticate, handleError, json, unauthorized } from "../admin/_shared";

/**
 * 私人网盘 API（存储落在 Cloudflare R2）
 *
 * 端点（全部需要管理员登录，复用 /api/admin/login 写的 cookie）：
 *   GET    /api/drive/list?prefix=&q=          按目录列文件（delimiter 分目录，q 走全量搜索）
 *   GET    /api/drive/file?key=&download=1     预览 / 下载
 *   GET    /api/drive/usage                    容量统计
 *   POST   /api/drive/upload?key=...           小文件直传（请求体是原始字节，上限 95MB）
 *   POST   /api/drive/mp-init?key=...          大文件分片：开始
 *   POST   /api/drive/mp-part?key=&id=&n=      大文件分片：上传第 n 片（请求体是该片字节）
 *   POST   /api/drive/mp-done?key=&id=         大文件分片：合并（body 是 parts 数组）
 *   POST   /api/drive/mkdir    { prefix, name }
 *   POST   /api/drive/move     { from, to }
 *   POST   /api/drive/rename   { key, name }
 *   DELETE /api/drive/delete?key=&hard=1       删除（默认进回收站）
 *   GET    /api/drive/trash                    回收站列表
 *   POST   /api/drive/restore  { id }
 *   POST   /api/drive/purge    { id }
 *   POST   /api/drive/empty-trash
 *   GET    /api/drive/meta                     收藏 + 分享
 *   POST   /api/drive/favorite { key, on }
 *   POST   /api/drive/share    { key, expiresIn }
 *   POST   /api/drive/unshare  { token }
 */

type DriveEnv = Env & { DRIVE?: R2BucketLike };

// 只声明用到的 R2 方法，避免依赖 @cloudflare/workers-types
type R2ObjectLike = {
	key: string;
	size: number;
	uploaded: Date;
	httpEtag?: string;
	httpMetadata?: { contentType?: string };
	body?: ReadableStream;
	writeHttpMetadata?: (headers: Headers) => void;
	arrayBuffer(): Promise<ArrayBuffer>;
};

type R2MultipartLike = {
	uploadId: string;
	uploadPart(partNumber: number, value: ArrayBuffer): Promise<{ partNumber: number; etag: string }>;
	complete(parts: { partNumber: number; etag: string }[]): Promise<R2ObjectLike>;
	abort(): Promise<void>;
};

type R2BucketLike = {
	list(options?: { prefix?: string; limit?: number; cursor?: string; delimiter?: string }): Promise<{
		objects: R2ObjectLike[];
		truncated: boolean;
		cursor?: string;
		delimitedPrefixes?: string[];
	}>;
	put(key: string, value: ArrayBuffer | ReadableStream, options?: unknown): Promise<R2ObjectLike>;
	get(key: string, options?: { range?: { offset?: number; length?: number } }): Promise<R2ObjectLike | null>;
	head(key: string): Promise<R2ObjectLike | null>;
	delete(key: string): Promise<void>;
	createMultipartUpload(key: string, options?: unknown): Promise<R2MultipartLike>;
	resumeMultipartUpload(key: string, uploadId: string): R2MultipartLike;
};

const MAX_UPLOAD_BYTES = 95 * 1024 * 1024; // Workers 请求体上限 100MB，留点余量
/* 面板上显示的配额（R2 免费额度是 10GB，超出部分按量计费，这里只作占用参考） */
const DRIVE_LIMIT_BYTES = 200 * 1024 * 1024 * 1024;
const SYS = "_sys/";
const META_KEY = `${SYS}meta.json`;
const TRASH_KEY = `${SYS}trash.json`;
const MAX_LIMIT = 1000;

const CONTENT_TYPES: Record<string, string> = {
	jpg: "image/jpeg",
	jpeg: "image/jpeg",
	png: "image/png",
	webp: "image/webp",
	gif: "image/gif",
	avif: "image/avif",
	svg: "image/svg+xml",
	bmp: "image/bmp",
	mp3: "audio/mpeg",
	m4a: "audio/mp4",
	flac: "audio/flac",
	wav: "audio/wav",
	ogg: "audio/ogg",
	opus: "audio/opus",
	aac: "audio/aac",
	mp4: "video/mp4",
	webm: "video/webm",
	mov: "video/quicktime",
	mkv: "video/x-matroska",
	pdf: "application/pdf",
	zip: "application/zip",
	rar: "application/vnd.rar",
	"7z": "application/x-7z-compressed",
	txt: "text/plain; charset=utf-8",
	md: "text/markdown; charset=utf-8",
	json: "application/json; charset=utf-8",
	csv: "text/csv; charset=utf-8",
	html: "text/html; charset=utf-8",
	css: "text/css; charset=utf-8",
	js: "text/javascript; charset=utf-8",
	ts: "text/plain; charset=utf-8",
	yml: "text/plain; charset=utf-8",
	yaml: "text/plain; charset=utf-8",
	ini: "text/plain; charset=utf-8",
	log: "text/plain; charset=utf-8",
};

function extOf(name: string) {
	return name.split(".").pop()?.toLowerCase() || "";
}

function contentTypeFor(name: string) {
	return CONTENT_TYPES[extOf(name)] || "application/octet-stream";
}

function kindOf(name: string): "image" | "audio" | "video" | "pdf" | "text" | "other" {
	const ext = extOf(name);
	if (["jpg", "jpeg", "png", "webp", "gif", "avif", "svg", "bmp"].includes(ext)) return "image";
	if (["mp3", "m4a", "flac", "wav", "ogg", "opus", "aac"].includes(ext)) return "audio";
	if (["mp4", "webm", "mov", "mkv"].includes(ext)) return "video";
	if (ext === "pdf") return "pdf";
	if (["txt", "md", "json", "csv", "log", "yml", "yaml", "ini", "html", "css", "js", "ts"].includes(ext)) return "text";
	return "other";
}

/** 只允许安全字符，禁止目录穿越；允许 a/b/c 这种子路径（每段单独校验） */
function safeKey(raw: string | null, { allowEmpty = false, allowTrailingSlash = false } = {}) {
	if (raw === null || raw === undefined) return null;
	let key = raw.trim().replace(/\\/g, "/").replace(/^\/+/, "").replace(/\/{2,}/g, "/");
	let trailing = "";
	if (allowTrailingSlash && /\/$/.test(key)) {
		trailing = "/";
		key = key.replace(/\/+$/, "");
	}
	if (!key) return allowEmpty ? "" : null;
	if (key.length > 400) return null;
	if (key.split("/").some((part) => part === ".." || part === "." || part === "")) return null;
	if (!/^[\p{L}\p{N}\p{Emoji} ._()\[\]&'+,@#%!~$-]+$/u.test(key.replace(/\//g, ""))) return null;
	if (key.startsWith(SYS)) return null;
	return key + trailing;
}

function isReserved(key: string) {
	return key.startsWith(SYS);
}

function baseName(key: string) {
	const clean = key.replace(/\/+$/, "");
	return clean.split("/").pop() || clean;
}

function parentOf(key: string) {
	const clean = key.replace(/\/+$/, "");
	const index = clean.lastIndexOf("/");
	return index === -1 ? "" : clean.slice(0, index + 1);
}

function fileUrl(key: string, download = false) {
	const params = new URLSearchParams({ key });
	if (download) params.set("download", "1");
	return `/api/drive/file?${params.toString()}`;
}

function describe(object: R2ObjectLike, favorites?: Set<string>) {
	const key = object.key;
	const uploaded = object.uploaded instanceof Date ? object.uploaded.toISOString() : String(object.uploaded);
	return {
		key,
		name: baseName(key),
		size: object.size,
		uploaded,
		type: object.httpMetadata?.contentType || contentTypeFor(key),
		kind: kindOf(key),
		favorite: favorites ? favorites.has(key) : false,
		url: fileUrl(key),
		download: fileUrl(key, true),
	};
}

function requireBucket(env: DriveEnv) {
	if (!env.DRIVE) {
		throw new Error("网盘还没有开通：请先在 Cloudflare 后台启用 R2，并给这个 Pages 项目绑定 DRIVE。");
	}
	return env.DRIVE;
}

type Meta = {
	favorites: string[];
	shares: Record<string, { key: string; created: number; expires: number | null }>;
};

type TrashEntry = {
	id: string;
	key: string;
	name: string;
	size: number;
	uploaded: string;
	deletedAt: number;
};

async function readJson<T>(bucket: R2BucketLike, key: string, fallback: T): Promise<T> {
	const object = await bucket.get(key);
	if (!object) return fallback;
	try {
		return JSON.parse(await new Response(object.body ?? (await object.arrayBuffer())).text()) as T;
	} catch {
		return fallback;
	}
}

async function writeJson(bucket: R2BucketLike, key: string, value: unknown) {
	await bucket.put(key, new TextEncoder().encode(JSON.stringify(value)), {
		httpMetadata: { contentType: "application/json; charset=utf-8" },
	});
}

async function loadMeta(bucket: R2BucketLike): Promise<Meta> {
	const meta = await readJson<Meta>(bucket, META_KEY, { favorites: [], shares: {} });
	return {
		favorites: Array.isArray(meta.favorites) ? meta.favorites : [],
		shares: meta.shares && typeof meta.shares === "object" ? meta.shares : {},
	};
}

async function loadTrash(bucket: R2BucketLike) {
	const list = await readJson<TrashEntry[]>(bucket, TRASH_KEY, []);
	return Array.isArray(list) ? list : [];
}

function randomId() {
	return crypto.randomUUID().replace(/-/g, "").slice(0, 24);
}

function streamOf(object: R2ObjectLike) {
	return object.body ?? null;
}

/* 解析 Range 头，支持 bytes=0-1023 / bytes=1000- / bytes=-500 */
function parseRange(header: string | null, size: number): { offset: number; length: number } | null | "invalid" {
	if (!header) return null;
	const match = /^bytes=(\d*)-(\d*)$/.exec(header.trim());
	if (!match) return "invalid";
	const [, startRaw, endRaw] = match;
	if (!startRaw && !endRaw) return "invalid";
	let offset: number;
	let length: number;
	if (!startRaw) {
		// 后缀范围：最后 N 字节
		const suffix = Number(endRaw);
		if (!Number.isFinite(suffix) || suffix <= 0) return "invalid";
		length = Math.min(suffix, size);
		offset = size - length;
	} else {
		offset = Number(startRaw);
		if (!Number.isFinite(offset) || offset >= size) return "invalid";
		const end = endRaw ? Math.min(Number(endRaw), size - 1) : size - 1;
		if (!Number.isFinite(end) || end < offset) return "invalid";
		length = end - offset + 1;
	}
	return { offset, length };
}

async function serveObject(
	bucket: R2BucketLike,
	key: string,
	url: URL,
	{ publicView = false, rangeHeader = null }: { publicView?: boolean; rangeHeader?: string | null } = {},
) {
	const wantsDownload = Boolean(url.searchParams.get("download"));
	const disposition = wantsDownload ? "attachment" : "inline";
	const baseHeaders = () => {
		const headers = new Headers();
		headers.set("x-content-type-options", "nosniff");
		headers.set("accept-ranges", "bytes");
		// 允许同站内嵌预览
		headers.set("content-disposition", `${disposition}; filename*=UTF-8''${encodeURIComponent(baseName(key))}`);
		return headers;
	};

	if (rangeHeader) {
		const head = await bucket.head(key);
		if (!head) return json({ error: "找不到这个文件。" }, 404);
		const range = parseRange(rangeHeader, head.size);
		if (range === "invalid") {
			const headers = baseHeaders();
			headers.set("content-range", `bytes */${head.size}`);
			return new Response(null, { status: 416, headers });
		}
		if (range) {
			const part = await bucket.get(key, { range });
			if (!part) return json({ error: "找不到这个文件。" }, 404);
			const headers = baseHeaders();
			headers.set("content-type", part.httpMetadata?.contentType || contentTypeFor(key));
			headers.set("content-length", String(range.length));
			headers.set("content-range", `bytes ${range.offset}-${range.offset + range.length - 1}/${head.size}`);
			if (part.httpEtag) headers.set("etag", part.httpEtag);
			headers.set("cache-control", publicView ? "public, max-age=300" : "private, max-age=86400");
			const body = streamOf(part);
			return new Response(body ?? (await part.arrayBuffer()), { status: 206, headers });
		}
	}

	const object = await bucket.get(key);
	if (!object) return json({ error: "找不到这个文件。" }, 404);
	const headers = baseHeaders();
	headers.set("content-type", object.httpMetadata?.contentType || contentTypeFor(key));
	headers.set("content-length", String(object.size));
	if (object.httpEtag) headers.set("etag", object.httpEtag);
	// 浏览器缓存一天：同一张图、同一首歌再点开就不用重新走网络了
	headers.set("cache-control", publicView ? "public, max-age=300" : "private, max-age=86400");
	const body = streamOf(object);
	return new Response(body ?? (await object.arrayBuffer()), { headers });
}

export const onRequest = async ({ request, env }: { request: Request; env: DriveEnv }) => {
	const url = new URL(request.url);
	const action = url.pathname.replace(/^\/api\/drive\/?/, "").replace(/\/+$/, "") || "list";

	if (request.method === "OPTIONS") return new Response(null, { status: 204 });

	if (!(await authenticate(request, env))) return unauthorized();

	try {
		const bucket = requireBucket(env);
		const method = request.method;

		if (action === "list" && method === "GET") {
			const rawPrefix = url.searchParams.get("prefix") ?? "";
			const prefix = safeKey(rawPrefix, { allowEmpty: true, allowTrailingSlash: true });
			if (prefix === null) return json({ error: "目录不合法。" }, 400);
			const query = (url.searchParams.get("q") || "").trim().toLowerCase();
			const meta = await loadMeta(bucket);
			const favorites = new Set(meta.favorites);

			if (query) {
				// 全量搜索：最多扫描 5000 个对象
				const files: ReturnType<typeof describe>[] = [];
				let cursor: string | undefined;
				let scanned = 0;
				do {
					const page = await bucket.list({ cursor, limit: 1000 });
					for (const object of page.objects) {
						scanned += 1;
						if (isReserved(object.key)) continue;
						if (baseName(object.key).toLowerCase().includes(query)) files.push(describe(object, favorites));
					}
					cursor = page.truncated ? page.cursor : undefined;
				} while (cursor && scanned < 5000);
				files.sort((a, b) => a.key.localeCompare(b.key, "zh-Hans-CN"));
				return json({ prefix, folders: [], files, cursor: null, truncated: scanned >= 5000 });
			}

			const result = await bucket.list({ prefix, delimiter: "/", limit: MAX_LIMIT });
			const files = result.objects
				.filter((object) => !isReserved(object.key) && !baseName(object.key).startsWith("."))
				.map((object) => describe(object, favorites))
				.sort((a, b) => a.name.localeCompare(b.name, "zh-Hans-CN"));
			const folders = (result.delimitedPrefixes || [])
				.filter((item) => !isReserved(item))
				.map((item) => ({ prefix: item, name: baseName(item) }))
				.sort((a, b) => a.name.localeCompare(b.name, "zh-Hans-CN"));
			return json({ prefix, folders, files, cursor: result.cursor || null, truncated: Boolean(result.truncated) });
		}

		if (action === "file" && method === "GET") {
			const key = safeKey(url.searchParams.get("key"));
			if (!key) return json({ error: "文件名不合法。" }, 400);
			return serveObject(bucket, key, url, { rangeHeader: request.headers.get("range") });
		}

		if (action === "usage" && method === "GET") {
			let total = 0;
			let count = 0;
			let cursor: string | undefined;
			do {
				const page = await bucket.list({ cursor, limit: 1000 });
				for (const object of page.objects) {
					if (isReserved(object.key)) continue;
					// 文件夹占位文件（.keep）不计入用量
					if (baseName(object.key) === ".keep") continue;
					total += object.size;
					count += 1;
				}
				cursor = page.truncated ? page.cursor : undefined;
			} while (cursor);
			return json({ total, count, limit: DRIVE_LIMIT_BYTES });
		}

		if (action === "upload" && method === "POST") {
			const key = safeKey(url.searchParams.get("key") ?? url.searchParams.get("name"));
			if (!key) return json({ error: "文件名不合法（不能包含 .. 之类字符）。" }, 400);
			const declared = Number(request.headers.get("content-length") || "0");
			if (declared > MAX_UPLOAD_BYTES) {
				return json({ error: `文件太大，单次直传上限 ${Math.round(MAX_UPLOAD_BYTES / 1024 / 1024)} MB。` }, 413);
			}
			const buffer = await request.arrayBuffer();
			if (buffer.byteLength === 0) return json({ error: "文件是空的。" }, 400);
			if (buffer.byteLength > MAX_UPLOAD_BYTES) {
				return json({ error: `文件太大，单次直传上限 ${Math.round(MAX_UPLOAD_BYTES / 1024 / 1024)} MB。` }, 413);
			}
			await bucket.put(key, buffer, {
				httpMetadata: { contentType: request.headers.get("content-type") || contentTypeFor(key) },
			});
			const meta = await loadMeta(bucket);
			return json({ ok: true, file: describe({ key, size: buffer.byteLength, uploaded: new Date() } as R2ObjectLike, new Set(meta.favorites)) });
		}

		// ---- 大文件分片（R2 multipart）----
		if (action === "mp-init" && method === "POST") {
			const key = safeKey(url.searchParams.get("key"));
			if (!key) return json({ error: "文件名不合法。" }, 400);
			const upload = await bucket.createMultipartUpload(key, {
				httpMetadata: { contentType: request.headers.get("content-type") || contentTypeFor(key) },
			});
			return json({ ok: true, uploadId: upload.uploadId, key });
		}

		if (action === "mp-part" && method === "POST") {
			const key = safeKey(url.searchParams.get("key"));
			const uploadId = url.searchParams.get("id");
			const partNumber = Number(url.searchParams.get("n"));
			if (!key || !uploadId || !Number.isInteger(partNumber) || partNumber < 1) {
				return json({ error: "分片参数不合法。" }, 400);
			}
			const chunk = await request.arrayBuffer();
			if (!chunk.byteLength) return json({ error: "分片是空的。" }, 400);
			const upload = bucket.resumeMultipartUpload(key, uploadId);
			const part = await upload.uploadPart(partNumber, chunk);
			return json({ ok: true, partNumber: part.partNumber, etag: part.etag });
		}

		if (action === "mp-done" && method === "POST") {
			const key = safeKey(url.searchParams.get("key"));
			const uploadId = url.searchParams.get("id");
			if (!key || !uploadId) return json({ error: "分片参数不合法。" }, 400);
			const body = (await request.json()) as { parts?: { partNumber: number; etag: string }[] };
			if (!Array.isArray(body.parts) || body.parts.length === 0) return json({ error: "缺少分片列表。" }, 400);
			const upload = bucket.resumeMultipartUpload(key, uploadId);
			const object = await upload.complete(body.parts);
			const meta = await loadMeta(bucket);
			return json({ ok: true, file: describe(object, new Set(meta.favorites)) });
		}

		if (action === "mp-abort" && method === "POST") {
			const key = safeKey(url.searchParams.get("key"));
			const uploadId = url.searchParams.get("id");
			if (key && uploadId) {
				try {
					await bucket.resumeMultipartUpload(key, uploadId).abort();
				} catch {
					/* 忽略：已经不存在 */
				}
			}
			return json({ ok: true });
		}

		if (action === "mkdir" && method === "POST") {
			const body = (await request.json()) as { prefix?: string; name?: string };
			const prefix = safeKey(body.prefix ?? "", { allowEmpty: true, allowTrailingSlash: true });
			if (prefix === null) return json({ error: "目录不合法。" }, 400);
			const name = (body.name || "").trim().replace(/[\\/]+/g, "");
			if (!name) return json({ error: "文件夹名不能为空。" }, 400);
			const key = safeKey(`${prefix}${name}/.keep`);
			if (!key) return json({ error: "文件夹名不合法。" }, 400);
			await bucket.put(key, new Uint8Array(0), { httpMetadata: { contentType: "application/x-empty" } });
			return json({ ok: true, prefix: `${prefix}${name}/` });
		}

		if (action === "move" && method === "POST") {
			const body = (await request.json()) as { from?: string; to?: string };
			const from = safeKey(body.from ?? null);
			const to = safeKey(body.to ?? null);
			if (!from || !to) return json({ error: "路径不合法。" }, 400);
			const object = await bucket.get(from);
			if (!object) return json({ error: "找不到要移动的文件。" }, 404);
			await bucket.put(to, object.body ?? (await object.arrayBuffer()), {
				httpMetadata: { contentType: object.httpMetadata?.contentType || contentTypeFor(to) },
			});
			await bucket.delete(from);
			return json({ ok: true, key: to });
		}

		if (action === "rename" && method === "POST") {
			const body = (await request.json()) as { key?: string; name?: string };
			const key = safeKey(body.key ?? null);
			const name = (body.name || "").trim().replace(/[\\/]+/g, "");
			if (!key || !name) return json({ error: "参数不合法。" }, 400);
			const target = safeKey(`${parentOf(key)}${name}`);
			if (!target) return json({ error: "名称不合法。" }, 400);
			if (target === key) return json({ ok: true, key });
			const object = await bucket.get(key);
			if (!object) return json({ error: "找不到文件。" }, 404);
			await bucket.put(target, object.body ?? (await object.arrayBuffer()), {
				httpMetadata: { contentType: object.httpMetadata?.contentType || contentTypeFor(target) },
			});
			await bucket.delete(key);
			return json({ ok: true, key: target });
		}

		if (action === "delete" && method === "DELETE") {
			const key = safeKey(url.searchParams.get("key"));
			if (!key) return json({ error: "文件名不合法。" }, 400);
			const object = await bucket.get(key);
			if (!object) {
				// 可能是个"空文件夹"（只有 .keep）
				const dirKey = safeKey(`${key.replace(/\/+$/, "")}/.keep`);
				if (dirKey) {
					await bucket.delete(dirKey);
					return json({ ok: true, folder: true });
				}
				return json({ error: "找不到这个文件。" }, 404);
			}
			if (url.searchParams.get("hard")) {
				await bucket.delete(key);
				return json({ ok: true });
			}
			const id = randomId();
			await bucket.put(`${SYS}trash/${id}`, object.body ?? (await object.arrayBuffer()), {
				httpMetadata: { contentType: object.httpMetadata?.contentType || contentTypeFor(key) },
			});
			const trash = await loadTrash(bucket);
			trash.unshift({
				id,
				key,
				name: baseName(key),
				size: object.size,
				uploaded: object.uploaded instanceof Date ? object.uploaded.toISOString() : String(object.uploaded),
				deletedAt: Date.now(),
			});
			await writeJson(bucket, TRASH_KEY, trash);
			await bucket.delete(key);
			const favs = await loadMeta(bucket);
			if (favs.favorites.includes(key)) {
				favs.favorites = favs.favorites.filter((item) => item !== key);
				await writeJson(bucket, META_KEY, favs);
			}
			return json({ ok: true, trashed: id });
		}

		if (action === "delete-folder" && method === "POST") {
			const body = (await request.json()) as { prefix?: string };
			const prefix = safeKey(body.prefix ?? null, { allowTrailingSlash: true });
			if (!prefix || !prefix.endsWith("/")) return json({ error: "文件夹路径不合法。" }, 400);
			const trash = await loadTrash(bucket);
			let moved = 0;
			let cursor: string | undefined;
			do {
				const page = await bucket.list({ prefix, cursor, limit: 200 });
				for (const summary of page.objects) {
					if (isReserved(summary.key)) continue;
					const object = await bucket.get(summary.key);
					if (!object) continue;
					const id = randomId();
					await bucket.put(`${SYS}trash/${id}`, object.body ?? (await object.arrayBuffer()), {
						httpMetadata: { contentType: object.httpMetadata?.contentType || contentTypeFor(summary.key) },
					});
					trash.unshift({
						id,
						key: summary.key,
						name: baseName(summary.key),
						size: summary.size,
						uploaded: summary.uploaded instanceof Date ? summary.uploaded.toISOString() : String(summary.uploaded),
						deletedAt: Date.now(),
					});
					await bucket.delete(summary.key);
					moved += 1;
				}
				cursor = page.truncated ? page.cursor : undefined;
			} while (cursor);
			await writeJson(bucket, TRASH_KEY, trash);
			return json({ ok: true, moved });
		}

		if (action === "trash" && method === "GET") {
			const trash = await loadTrash(bucket);
			return json({ items: trash });
		}

		if (action === "restore" && method === "POST") {
			const body = (await request.json()) as { id?: string };
			const trash = await loadTrash(bucket);
			const entry = trash.find((item) => item.id === body.id);
			if (!entry) return json({ error: "回收站里没有这一项。" }, 404);
			const object = await bucket.get(`${SYS}trash/${entry.id}`);
			if (!object) return json({ error: "文件内容已经不在了。" }, 404);
			await bucket.put(entry.key, object.body ?? (await object.arrayBuffer()), {
				httpMetadata: { contentType: object.httpMetadata?.contentType || contentTypeFor(entry.key) },
			});
			await bucket.delete(`${SYS}trash/${entry.id}`);
			await writeJson(bucket, TRASH_KEY, trash.filter((item) => item.id !== entry.id));
			return json({ ok: true, key: entry.key });
		}

		if (action === "purge" && method === "POST") {
			const body = (await request.json()) as { id?: string };
			const trash = await loadTrash(bucket);
			const entry = trash.find((item) => item.id === body.id);
			if (!entry) return json({ error: "回收站里没有这一项。" }, 404);
			await bucket.delete(`${SYS}trash/${entry.id}`);
			await writeJson(bucket, TRASH_KEY, trash.filter((item) => item.id !== entry.id));
			return json({ ok: true });
		}

		if (action === "empty-trash" && method === "POST") {
			const trash = await loadTrash(bucket);
			for (const entry of trash) await bucket.delete(`${SYS}trash/${entry.id}`);
			await writeJson(bucket, TRASH_KEY, []);
			return json({ ok: true, removed: trash.length });
		}

		if (action === "favorites" && method === "GET") {
			const meta = await loadMeta(bucket);
			const favorites = new Set(meta.favorites);
			const files = [];
			for (const key of meta.favorites) {
				const object = await bucket.head(key);
				if (object) files.push(describe(object, favorites));
			}
			return json({ files });
		}

		if (action === "meta" && method === "GET") {
			const meta = await loadMeta(bucket);
			const now = Date.now();
			const shares = Object.entries(meta.shares)
				.map(([token, item]) => ({
					token,
					key: item.key,
					name: baseName(item.key),
					created: item.created,
					expires: item.expires,
					expired: item.expires ? item.expires < now : false,
					url: `/s/${token}`,
				}))
				.sort((a, b) => b.created - a.created);
			return json({ favorites: meta.favorites, shares });
		}

		if (action === "favorite" && method === "POST") {
			const body = (await request.json()) as { key?: string; on?: boolean };
			const key = safeKey(body.key ?? null);
			if (!key) return json({ error: "文件名不合法。" }, 400);
			const meta = await loadMeta(bucket);
			const set = new Set(meta.favorites);
			if (body.on === false) set.delete(key);
			else set.add(key);
			meta.favorites = [...set];
			await writeJson(bucket, META_KEY, meta);
			return json({ ok: true, favorite: set.has(key) });
		}

		if (action === "share" && method === "POST") {
			const body = (await request.json()) as { key?: string; expiresIn?: number | null };
			const key = safeKey(body.key ?? null);
			if (!key) return json({ error: "文件名不合法。" }, 400);
			const meta = await loadMeta(bucket);
			const token = randomId().slice(0, 16);
			const days = typeof body.expiresIn === "number" && body.expiresIn > 0 ? body.expiresIn : null;
			meta.shares[token] = { key, created: Date.now(), expires: days ? Date.now() + days * 86400000 : null };
			await writeJson(bucket, META_KEY, meta);
			return json({ ok: true, token, url: `/s/${token}` });
		}

		if (action === "unshare" && method === "POST") {
			const body = (await request.json()) as { token?: string };
			if (!body.token) return json({ error: "缺少 token。" }, 400);
			const meta = await loadMeta(bucket);
			delete meta.shares[body.token];
			await writeJson(bucket, META_KEY, meta);
			return json({ ok: true });
		}

		return json({ error: "不支持的操作。" }, 404);
	} catch (error) {
		const message = error instanceof Error ? error.message : "网盘操作失败。";
		if (/还没有开通/.test(message)) return json({ error: message }, 503);
		return handleError(error);
	}
};

export async function serveShared(env: DriveEnv, token: string, url: URL) {
	const bucket = requireBucket(env);
	const meta = await loadMeta(bucket);
	const share = meta.shares[token];
	if (!share) return json({ error: "这个分享链接不存在或已取消。" }, 404);
	if (share.expires && share.expires < Date.now()) return json({ error: "这个分享链接已经过期了。" }, 410);
	return serveObject(bucket, share.key, url, { publicView: true });
}
