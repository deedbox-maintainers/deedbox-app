// GET /brand/icon — the installation's browser-tab icon (uploaded, else DeedBox's).
import { serveBrandFile } from '@/lib/brandRoute'

export const dynamic = 'force-dynamic'

export async function GET(req: Request): Promise<Response> {
  return serveBrandFile('icon', req.url)
}
