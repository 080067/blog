import { proxyToTwikoo } from "./tw/_proxy";

export const onRequest = async ({ request }: { request: Request }) => proxyToTwikoo(request);
