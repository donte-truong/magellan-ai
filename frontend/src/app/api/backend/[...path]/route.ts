import { proxyRequest } from "@/lib/proxy";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

type Context = { params: Promise<{ path: string[] }> };
async function handler(request: Request, { params }: Context) {
  return proxyRequest(request, (await params).path);
}

export { handler as GET, handler as POST };
