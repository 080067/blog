import type { Env } from "../api/admin/_shared";
import { json } from "../api/admin/_shared";

/**
 * 公开分享链接：GET /s/<token>
 *
 * 故意不依赖 /api/drive 的实现（自包含），这样这个公开端点只需要
 * "读 _sys/meta.json 找 token → 把 R2 对象流出去"两件事，
 * 不会因为内部 API 改动把公开链接带崩。
 */

type R2ObjectLike = {
	key: string;
	size: number;
	uploaded: Date;
	httpMetadata?: { contentType?: string };
	body?: ReadableStream;
	arrayBuffer(): Promise<ArrayBuffer>;
};

type R2BucketLike = {
	get(key: string): Promise<R2ObjectLike | null>;
};

type ShareMeta = {
	shares?: Record<string, { key: string; created: number; expires: number | null }>;
};

const META_KEY = "_sys/meta.json";

const TYPES: Record<string, string> = {
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
	txt: "text/plain; charset=utf-8",
	md: "text/markdown; charset=utf-8",
	json: "application/json; charset=utf-8",
	zip: "application/zip",
};

function typeFor(name: string) {
	const ext = name.split(".").pop()?.toLowerCase() || "";
	return TYPES[ext] || "application/octet-stream";
}

function baseName(key: string) {
	return key.split("/").pop() || key;
}

export const onRequest = async ({ request, env, params }: { request: Request; env: Env & { DRIVE?: R2BucketLike }; params: { token?: string } }) => {
	if (request.method !== "GET" && request.method !== "HEAD") return json({ error: "只支持 GET。" }, 405);
	const bucket = env.DRIVE;
	if (!bucket) return json({ error: "网盘还没有开通。" }, 503);

	const token = params?.token || "";
	if (!/^[A-Za-z0-9]{6,32}$/.test(token)) return json({ error: "分享链接不合法。" }, 400);

	const metaObject = await bucket.get(META_KEY);
	if (!metaObject) return json({ error: "分享链接不存在。" }, 404);
	let meta: ShareMeta;
	try {
		meta = JSON.parse(await new Response(metaObject.body ?? (await metaObject.arrayBuffer())).text()) as ShareMeta;
	} catch {
		return json({ error: "分享信息损坏。" }, 500);
	}
	const share = meta.shares?.[token];
	if (!share) return json({ error: "这个分享链接不存在或已取消。" }, 404);
	if (share.expires && share.expires < Date.now()) return json({ error: "这个分享链接已经过期了。" }, 410);

	const object = await bucket.get(share.key);
	if (!object) return json({ error: "文件已经不在了。" }, 404);

	const url = new URL(request.url);
	const download = url.searchParams.get("download") === "1";
	const headers = new Headers();
	headers.set("content-type", object.httpMetadata?.contentType || typeFor(share.key));
	headers.set("content-length", String(object.size));
	headers.set("cache-control", "public, max-age=300");
	headers.set("x-content-type-options", "nosniff");
	headers.set("content-disposition", `${download ? "attachment" : "inline"}; filename*=UTF-8''${encodeURIComponent(baseName(share.key))}`);
	return new Response(object.body ?? (await object.arrayBuffer()), { headers });
};
