import { proxyToTwikoo } from "./_proxy";

export const onRequest = async ({ request }: { request: Request }) => proxyToTwikoo(request);