/**
 * 网盘签名直链：给 CDN 用的短期有效 URL。
 *
 * 为什么需要它：阿里云 CDN 要缓存才会加速，而缓存就意味着「共享」——
 * 直接把私有接口挂到 CDN 上会被别人读到（之前已经踩过一次）。
 * 所以这里给每个文件生成一个带 HMAC 签名、有有效期、且路径里带真实扩展名的 URL：
 *
 *   https://cdn.nihilism.cloud/f/<token>/<文件名>.<扩展名>
 *
 * - token = base64url("key|exp").hmacSHA256(secret, "key|exp")
 * - 扩展名留在路径里，是为了让 CDN 按默认的「文件后缀」规则缓存（jpg/png/mp3 命中的概率最高）
 * - 过期时间短（默认 6 小时），即使链接被转发出去，影响也有限
 */

export type R2ObjectLike = {
	key: string;
	size: number;
	uploaded: Date | string;
	httpEtag?: string;
	body?: ReadableStream | null;
	arrayBuffer(): Promise<ArrayBuffer>;
	httpMetadata?: { contentType?: string };
};

export type R2BucketLike = {
	get(key: string, options?: { range?: { offset: number; length: number } }): Promise<R2ObjectLike | null>;
	head(key: string): Promise<R2ObjectLike | null>;
};

export const SIGN_TTL_SECONDS = 6 * 3600;

function b64url(bytes: Uint8Array): string {
	let text = "";
	for (const byte of bytes) text += String.fromCharCode(byte);
	return btoa(text).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
}

function b64urlDecode(value: string): string | null {
	try {
		const normalized = value.replace(/-/g, "+").replace(/_/g, "/");
		return atob(normalized + "=".repeat((4 - (normalized.length % 4)) % 4));
	} catch {
		return null;
	}
}

async function hmac(secret: string, payload: string): Promise<string> {
	const key = await crypto.subtle.importKey(
		"raw",
		new TextEncoder().encode(secret),
		{ name: "HMAC", hash: "SHA-256" },
		false,
		["sign"],
	);
	const signature = await crypto.subtle.sign("HMAC", key, new TextEncoder().encode(payload));
	return b64url(new Uint8Array(signature));
}

export function signatureSecret(env: Record<string, unknown>): string | null {
	const secret = (env.ADMIN_SESSION_SECRET || env.ADMIN_PASSWORD || "") as string;
	return secret ? String(secret) : null;
}

/** 生成 token（含过期时间） */
export async function makeToken(secret: string, key: string, expiresAt: number): Promise<string> {
	const payload = `${key}|${expiresAt}`;
	return `${b64url(new TextEncoder().encode(payload))}.${await hmac(secret, payload)}`;
}

/** 校验 token，返回文件 key；失败返回 null */
export async function readToken(secret: string, token: string): Promise<string | null> {
	const [encoded, signature] = token.split(".");
	if (!encoded || !signature) return null;
	const payload = b64urlDecode(encoded);
	if (!payload) return null;
	if ((await hmac(secret, payload)) !== signature) return null;
	const separator = payload.lastIndexOf("|");
	if (separator <= 0) return null;
	const key = payload.slice(0, separator);
	const expiresAt = Number(payload.slice(separator + 1));
	if (!Number.isFinite(expiresAt) || expiresAt * 1000 < Date.now()) return null;
	return key;
}

/** 拼接 CDN 直链：带真实扩展名，方便 CDN 按后缀缓存 */
export async function signedUrl(
	secret: string,
	origin: string,
	key: string,
	download = false,
): Promise<string> {
	const expiresAt = Math.floor(Date.now() / 1000) + SIGN_TTL_SECONDS;
	const token = await makeToken(secret, key, expiresAt);
	const name = key.split("/").pop() || key;
	const query = download ? "?download=1" : "";
	return `${origin}/f/${token}/${encodeURIComponent(name)}${query}`;
}

const MIME: Record<string, string> = {
	png: "image/png",
	jpg: "image/jpeg",
	jpeg: "image/jpeg",
	gif: "image/gif",
	webp: "image/webp",
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
	md: "text/plain; charset=utf-8",
};

export function guessType(key: string): string {
	const ext = (key.split(".").pop() || "").toLowerCase();
	return MIME[ext] || "application/octet-stream";
}

function parseRange(header: string | null, size: number): { offset: number; length: number } | null | "invalid" {
	if (!header) return null;
	const match = /^bytes=(\d*)-(\d*)$/.exec(header.trim());
	if (!match) return "invalid";
	const [, startRaw, endRaw] = match;
	if (!startRaw && !endRaw) return "invalid";
	if (!startRaw) {
		const suffix = Number(endRaw);
		if (!Number.isFinite(suffix) || suffix <= 0) return "invalid";
		const length = Math.min(suffix, size);
		return { offset: size - length, length };
	}
	const offset = Number(startRaw);
	if (!Number.isFinite(offset) || offset >= size) return "invalid";
	const end = endRaw ? Math.min(Number(endRaw), size - 1) : size - 1;
	if (!Number.isFinite(end) || end < offset) return "invalid";
	return { offset, length: end - offset + 1 };
}

/**
 * 走 CDN 的公开读：内容按 public 缓存（默认 6 小时，和签名有效期一致），
 * 支持 Range，方便音视频拖进度条与断点续传。
 */
export async function serveSigned(
	bucket: R2BucketLike,
	key: string,
	request: Request,
): Promise<Response> {
	const url = new URL(request.url);
	const wantsDownload = Boolean(url.searchParams.get("download"));
	const rangeHeader = request.headers.get("range");
	const name = key.split("/").pop() || key;
	const headers = new Headers({
		"x-content-type-options": "nosniff",
		"accept-ranges": "bytes",
		"content-disposition": `${wantsDownload ? "attachment" : "inline"}; filename*=UTF-8''${encodeURIComponent(name)}`,
	});

	const range = rangeHeader ? parseRange(rangeHeader, Number.MAX_SAFE_INTEGER) : null;
	if (range === "invalid") {
		const head = await bucket.head(key);
		if (!head) return new Response("Not Found", { status: 404 });
		headers.set("content-range", `bytes */${head.size}`);
		return new Response(null, { status: 416, headers });
	}

	if (range && rangeHeader) {
		const head = await bucket.head(key);
		if (!head) return new Response("Not Found", { status: 404 });
		const sized = parseRange(rangeHeader, head.size);
		if (sized === "invalid" || sized === null) {
			headers.set("content-range", `bytes */${head.size}`);
			return new Response(null, { status: 416, headers });
		}
		const part = await bucket.get(key, { range: sized });
		if (!part) return new Response("Not Found", { status: 404 });
		headers.set("content-type", part.httpMetadata?.contentType || guessType(key));
		headers.set("content-length", String(sized.length));
		headers.set("content-range", `bytes ${sized.offset}-${sized.offset + sized.length - 1}/${head.size}`);
		headers.set("cache-control", `public, max-age=${SIGN_TTL_SECONDS}`);
		if (part.httpEtag) headers.set("etag", part.httpEtag);
		const body = part.body ?? (await part.arrayBuffer());
		return new Response(body, { status: 206, headers });
	}

	const object = await bucket.get(key);
	if (!object) return new Response("Not Found", { status: 404 });
	headers.set("content-type", object.httpMetadata?.contentType || guessType(key));
	headers.set("content-length", String(object.size));
	headers.set("cache-control", `public, max-age=${SIGN_TTL_SECONDS}`);
	if (object.httpEtag) headers.set("etag", object.httpEtag);
	const body = object.body ?? (await object.arrayBuffer());
	return new Response(body, { headers });
}
