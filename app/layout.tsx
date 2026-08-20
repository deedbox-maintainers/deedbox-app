import type { Metadata } from 'next'
import { readBrand, brandCssVars } from '@/lib/brand'
import './globals.css'

// The browser tab, bookmark and page titles carry the installation's brand
// (DeedBox unless the firm has white-labelled it) — see lib/brand.ts.
export async function generateMetadata(): Promise<Metadata> {
  const brand = await readBrand()
  return {
    title: brand.name,
    description: 'Practice management with a spine.',
    icons: { icon: brand.iconHref },
  }
}

export default async function RootLayout({
  children,
}: Readonly<{ children: React.ReactNode }>) {
  const brand = await readBrand()
  return (
    <html lang="en" style={brandCssVars(brand) as React.CSSProperties}>
      <body className="antialiased">{children}</body>
    </html>
  )
}
