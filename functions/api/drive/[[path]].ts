import type { Env } from "../admin/_shared";
import { authenticate, handleError, json, unauthorized } from "../admin/_shared";

/**
 * 私人网盘 API（存储落在 Cloudflare R2）
 *
 * 端点（全部需要管理员登录，复用 /api/admin/login 写的 cookie）：
 *   GET    /api/drive/list?prefix=     列出文件
 *   GET    /api/drive/file?key=...     下载/预览（?download=1 走附件下载）
 *   POST   /api/drive/upload?name=...  上传（请求体是原始文件字节）
 *   DELETE /api/drive/delete?key=...   删除
 *   GET    /api/drive/usage            容量统计
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

type R2BucketLike = {
	list(options?: { prefix?: string; limit?: number; cursor?: string }): Promise<{
		objects: R2ObjectLike[];
		truncated: boolean;
		cursor?: string;
	}>;
	put(key: string, value: ArrayBuffer | ReadableStream, options?: unknown): Promise<R2ObjectLike>;
	get(key: string): Promise<R2ObjectLike | null>;
	delete(key: string): Promise<void>;
};

const MAX_UPLOAD_BYTES = 95 * 1024 * 1024; // Workers 请求体上限 100MB，留点余量
const KEY_PREFIX = "";

const CONTENT_TYPES: Record<string, string> = {
	jpg: "image/jpeg",
	jpeg: "image/jpeg",
	png: "image/png",
	webp: "image/webp",
	gif: "image/gif",
	avif: "image/avif",
	svg: "image/svg+xml",
	mp3: "audio/mpeg",
	m4a: "audio/mp4",
	flac: "audio/flac",
	wav: "audio/wav",
	ogg: "audio/ogg",
	mp4: "video/mp4",
	webm: "video/webm",
	pdf: "application/pdf",
	zip: "application/zip",
	txt: "text/plain; charset=utf-8",
	md: "text/markdown; charset=utf-8",
	json: "application/json; charset=utf-8",
};

function contentTypeFor(name: string) {
	const ext = name.split(".").pop()?.toLowerCase() || "";
	return CONTENT_TYPES[ext] || "application/octet-stream";
}

/** 只允许安全字符，禁止目录穿越 */
function safeKey(raw: string | null) {
	if (!raw) return null;
	let key = raw.trim().replace(/\\/g, "/");
	if (!key || key.length > 400) return null;
	if (key.includes("..") || key.startsWith("/")) return null;
	if (!/^[\p{L}\p{N}\p{Emoji} ._()\[\]&'+,@#%-]+$/u.test(key)) return null;
	return KEY_PREFIX + key;
}

function fileUrl(key: string, download = false) {
	const params = new URLSearchParams({ key });
	if (download) params.set("download", "1");
	return `/api/drive/file?${params.toString()}`;
}

function describe(object: R2ObjectLike) {
	const name = object.key;
	const isImage = /\.(jpe?g|png|webp|gif|avif)$/i.test(name);
	return {
		key: name,
		name,
		size: object.size,
		uploaded: object.uploaded instanceof Date ? object.uploaded.toISOString() : String(object.uploaded),
		type: object.httpMetadata?.contentType || contentTypeFor(name),
		isImage,
		url: fileUrl(name),
		download: fileUrl(name, true),
	};
}

function requireBucket(env: DriveEnv) {
	if (!env.DRIVE) {
		throw new Error("网盘还没有开通：请先在 Cloudflare 后台启用 R2，并给这个 Pages 项目绑定 DRIVE。");
	}
	return env.DRIVE;
}

export const onRequest = async ({ request, env }: { request: Request; env: DriveEnv }) => {
	const url = new URL(request.url);
	const action = url.pathname.replace(/^\/api\/drive\/?/, "").replace(/\/+$/, "") || "list";

	if (request.method === "OPTIONS") return new Response(null, { status: 204 });

	if (!(await authenticate(request, env))) return unauthorized();

	try {
		const bucket = requireBucket(env);

		if (action === "list" && request.method === "GET") {
			const prefix = url.searchParams.get("prefix") || undefined;
			const cursor = url.searchParams.get("cursor") || undefined;
			const result = await bucket.list({ prefix, cursor, limit: 200 });
			const files = result.objects
				.map((object) => describe(object))
				.sort((a, b) => b.uploaded.localeCompare(a.uploaded));
			return json({
				files,
				truncated: Boolean(result.truncated),
				cursor: result.cursor || null,
			});
		}

		if (action === "file" && request.method === "GET") {
			const key = safeKey(url.searchParams.get("key"));
			if (!key) return json({ error: "文件名不合法。" }, 400);
			const object = await bucket.get(key);
			if (!object) return json({ error: "找不到这个文件。" }, 404);
			const headers = new Headers();
			headers.set("content-type", object.httpMetadata?.contentType || contentTypeFor(key));
			headers.set("content-length", String(object.size));
			headers.set("etag", object.httpEtag || "");
			headers.set("cache-control", "private, max-age=0, must-revalidate");
			headers.set("x-content-type-options", "nosniff");
			const disposition = url.searchParams.get("download") ? "attachment" : "inline";
			const encoded = encodeURIComponent(key.split("/").pop() || key);
			headers.set("content-disposition", `${disposition}; filename*=UTF-8''${encoded}`);
			return new Response(object.body ?? (await object.arrayBuffer()), { headers });
		}

		if (action === "upload" && request.method === "POST") {
			const name = url.searchParams.get("name");
			const key = safeKey(name);
			if (!key) return json({ error: "文件名不合法（不能包含 / \\ .. 之类字符）。" }, 400);
			const declared = Number(request.headers.get("content-length") || "0");
			if (declared > MAX_UPLOAD_BYTES) {
				return json({ error: `文件太大了，单个文件上限 ${Math.round(MAX_UPLOAD_BYTES / 1024 / 1024)} MB。` }, 413);
			}
			const buffer = await request.arrayBuffer();
			if (buffer.byteLength === 0) return json({ error: "文件是空的。" }, 400);
			if (buffer.byteLength > MAX_UPLOAD_BYTES) {
				return json({ error: `文件太大了，单个文件上限 ${Math.round(MAX_UPLOAD_BYTES / 1024 / 1024)} MB。` }, 413);
			}
			const object = await bucket.put(key, buffer, {
				httpMetadata: { contentType: request.headers.get("content-type") || contentTypeFor(key) },
			});
			return json({ ok: true, file: describe({ ...object, key, size: buffer.byteLength } as R2ObjectLike) });
		}

		if (action === "delete" && request.method === "DELETE") {
			const key = safeKey(url.searchParams.get("key"));
			if (!key) return json({ error: "文件名不合法。" }, 400);
			await bucket.delete(key);
			return json({ ok: true });
		}

		if (action === "usage" && request.method === "GET") {
			let total = 0;
			let count = 0;
			let cursor: string | undefined;
			do {
				const page = await bucket.list({ cursor, limit: 1000 });
				for (const object of page.objects) {
					total += object.size;
					count += 1;
				}
				cursor = page.truncated ? page.cursor : undefined;
			} while (cursor);
			return json({ total, count });
		}

		return json({ error: "不支持的操作。" }, 404);
	} catch (error) {
		const message = error instanceof Error ? error.message : "网盘操作失败。";
		if (/还没有开通/.test(message)) return json({ error: message }, 503);
		return handleError(error);
	}
};
