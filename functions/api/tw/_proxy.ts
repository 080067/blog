/**
 * 把 /api/tw 下的请求反向代理到 Cloudflare Worker 上的 Twikoo 云函数。
 *
 * 为什么要代理：Twikoo 的 Cloudflare 部署落在 *.workers.dev，而 workers.dev
 * 在大陆存在 DNS 污染，直接作为 envId 会时通时不通。走自己域名同源转发后
 * 既没有跨域问题，也不受 workers.dev 解析影响。
 */
const TWIKOO_ORIGIN = "https://twi-39.2804249691.workers.dev";

const HOP_BY_HOP = [
	"host",
	"connection",
	"keep-alive",
	"proxy-authenticate",
	"proxy-authorization",
	"te",
	"trailer",
	"transfer-encoding",
	"upgrade",
	"cf-connecting-ip",
	"cf-ipcountry",
	"cf-ray",
	"cf-visitor",
	"x-forwarded-proto",
	"x-real-ip",
];

export const proxyToTwikoo = async (request: Request): Promise<Response> => {
	const incoming = new URL(request.url);
	const target = new URL(TWIKOO_ORIGIN);

	// /api/tw/xxx -> /xxx；/api/tw -> /
	const rest = incoming.pathname.replace(/^\/api\/tw/, "");
	target.pathname = rest.length > 0 ? rest : "/";
	target.search = incoming.search;

	const headers = new Headers(request.headers);
	for (const name of HOP_BY_HOP) headers.delete(name);

	const method = request.method.toUpperCase();
	const hasBody = method !== "GET" && method !== "HEAD";

	const upstream = await fetch(target.toString(), {
		method,
		headers,
		body: hasBody ? await request.arrayBuffer() : undefined,
		redirect: "manual",
	});

	const responseHeaders = new Headers(upstream.headers);
	responseHeaders.delete("content-encoding");
	responseHeaders.delete("content-length");
	responseHeaders.delete("transfer-encoding");

	return new Response(upstream.body, {
		status: upstream.status,
		statusText: upstream.statusText,
		headers: responseHeaders,
	});
};
