import { handle } from '../../../src/server/api';
export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';
type Context = { params: Promise<{ segments: string[] }> };
export async function GET(request: Request, context: Context) { return handle(request, (await context.params).segments); }
export async function POST(request: Request, context: Context) { return handle(request, (await context.params).segments); }
