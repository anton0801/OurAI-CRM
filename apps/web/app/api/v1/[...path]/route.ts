import { dispatch } from '@/server/http/pipeline';
import '@/server/handlers';

export const dynamic = 'force-dynamic';
export const runtime = 'nodejs';

type Ctx = { params: Promise<{ path: string[] }> };

const handle = async (req: Request, ctx: Ctx) => {
  const { path } = await ctx.params;
  return dispatch(req, `/${path.map(encodeURIComponent).join('/')}`);
};

export const GET = handle;
export const POST = handle;
export const PATCH = handle;
export const PUT = handle;
export const DELETE = handle;
