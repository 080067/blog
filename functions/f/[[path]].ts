/**
 * 网盘文件的 CDN 直链：
 *   /f/<token>/<文件名>            预览（inline）
 *   /f/<token>/dl/<文件名>         下载（attachment，单独一段路径 = 单独的 CDN 缓存 key）
 *
 * token 里带着「文件 key + 过期时间 + HMAC 签名」，只有拿到列表的人才有链接；
 * 链接 6 小时后失效。响应是 public 缓存，所以阿里云 CDN 命中后不再回源，
 * 下载/看图就不再跨境慢慢拉了。
 */
import { readToken, serveSigned, signatureSecret, type R2BucketLike } from "../_lib/signed";

type Env = {
	DRIVE?: R2BucketLike;
	ADMIN_SESSION_SECRET?: string;
	ADMIN_PASSWORD?: string;
};

// 失败一律不缓存：否则一次误判的 403 会被 CDN 记 6 小时
function fail(message: string, status: number) {
	return new Response(message, {
		status,
		headers: { "cache-control": "no-store", "content-type": "text/plain; charset=utf-8" },
	});
}

export const onRequest = async ({ request, env, params }: { request: Request; env: Env; params: Record<string, string | string[]> }) => {
	if (request.method === "OPTIONS") return new Response(null, { status: 204 });
	if (request.method !== "GET" && request.method !== "HEAD") {
		return fail("Method Not Allowed", 405);
	}

	const secret = signatureSecret(env as unknown as Record<string, unknown>);
	if (!secret) return fail("网盘还没有配置签名密钥。", 503);
	if (!env.DRIVE) return fail("网盘还没有开通。", 503);

	// [[path]] = "<token>/<文件名>" 或 "<token>/dl/<文件名>"
	const raw = params.path;
	const path = Array.isArray(raw) ? raw.join("/") : String(raw || "");
	const segments = path.split("/").filter(Boolean);
	const token = segments[0];
	if (!token) return fail("链接不完整。", 400);
	const download = segments[1] === "dl";

	const key = await readToken(secret, token);
	if (!key) return fail("链接已失效，请回到网盘重新打开。", 403);

	const response = await serveSigned(env.DRIVE, key, request, { download });
	if (request.method === "HEAD") {
		return new Response(null, { status: response.status, headers: response.headers });
	}
	return response;
};
