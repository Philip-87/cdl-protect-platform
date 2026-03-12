import { buildCaseCsvTemplate } from '@/app/lib/server/case-csv'

export async function GET() {
  return new Response(buildCaseCsvTemplate(), {
    status: 200,
    headers: {
      'Content-Type': 'text/csv; charset=utf-8',
      'Content-Disposition': 'attachment; filename="cdl-protect-cases-template.csv"',
      'Cache-Control': 'no-store',
    },
  })
}
