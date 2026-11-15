/**
 * 全局 Functions 中间件。
 *
 * 背景：Cloudflare Pages 的接口（/api/*）是带登录态的私有数据，绝对不能经过
 * 阿里云 CDN 之类的中间缓存。之前 `cdn.nihilism.cloud` 把 `/api/drive/list`
 * 的 200 响应缓存下来并返回给了未登录的请求（Age 几百秒），属于真实的数据泄露。
 *
 * 这里做一道兜底：只要请求是经 CDN 回源的（阿里云回源会带 `Via: ens-cache...`），
 * 直接 403，把私有接口限制在源站域名上。
 */
export const onRequest: PagesFunction = async (context) => {
	const { request } = context;
	const url = new URL(request.url);
	const isApi = url.pathname === "/api" || url.pathname.startsWith("/api/");

	if (isApi) {
		const via = (request.headers.get("via") || "").toLowerCase();
		const forwardedHost = (request.headers.get("x-forwarded-host") || "").toLowerCase();
		const proxied = via.includes("ens-cache") || via.includes("tengine") || (forwardedHost !== "" && !forwardedHost.endsWith("nihilism.cloud"));

		if (proxied) {
			return new Response(
				JSON.stringify({ error: "私有接口不支持加速域名，请直接访问 https://nihilism.cloud 。" }),
				{
					status: 403,
					headers: {
						"content-type": "application/json; charset=utf-8",
						"cache-control": "no-store, no-cache, must-revalidate",
						pragma: "no-cache",
					},
				},
			);
		}
	}

	return context.next();
};
