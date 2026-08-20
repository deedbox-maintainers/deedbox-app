// GET /brand/logo — the installation's lockup (uploaded, else DeedBox's).
import { serveBrandFile } from '@/lib/brandRoute'

export const dynamic = 'force-dynamic'

export async function GET(req: Request): Promise<Response> {
  return serveBrandFile('logo', req.url)
}
