export default async function handler(req, res) {
  res.setHeader('Access-Control-Allow-Origin', '*')
  res.setHeader('Access-Control-Allow-Methods', 'POST, OPTIONS')
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type')
  if (req.method === 'OPTIONS') return res.status(200).end()
  if (req.method !== 'POST') return res.status(405).json({ error: 'Method not allowed' })

  const { products } = req.body
  if (!Array.isArray(products) || products.length === 0) {
    return res.status(400).json({ error: 'Invalid products data' })
  }

  for (const p of products) {
    if (!p.article || !p.name || !p.barcode) {
      return res.status(400).json({ error: `Invalid product: missing fields` })
    }
  }

  const token = process.env.GH_TOKEN
  if (!token) return res.status(500).json({ error: 'Server misconfigured' })

  const owner = 'Monutor'
  const repo = 'warehouse-barcode-generator'
  const path = 'data/products.json'
  const apiBase = `https://api.github.com/repos/${owner}/${repo}/contents/${path}`
  const rawUrl = `https://raw.githubusercontent.com/${owner}/${repo}/main/${path}`
  const headers = { Authorization: `Bearer ${token}`, Accept: 'application/vnd.github.v3+json' }

  try {
    let sha
    let current

    {
      const ac = new AbortController()
      const t = setTimeout(() => ac.abort(), 5000)
      const metaRes = await fetch(`${apiBase}?ref=main`, { headers, signal: ac.signal })
      clearTimeout(t)
      if (!metaRes.ok) throw new Error(`GitHub metadata fetch failed: ${metaRes.status}`)
      const meta = await metaRes.json()
      sha = meta.sha
    }

    {
      const ac = new AbortController()
      const t = setTimeout(() => ac.abort(), 8000)
      const rawRes = await fetch(rawUrl, { signal: ac.signal })
      clearTimeout(t)
      if (!rawRes.ok) throw new Error(`Raw file fetch failed: ${rawRes.status}`)
      const text = await rawRes.text()
      current = JSON.parse(text)
    }

    const existingArticles = new Set(current.products.map(p => p.article))
    let added = 0
    for (const p of products) {
      if (!existingArticles.has(p.article)) {
        current.products.push(p)
        existingArticles.add(p.article)
        added++
      }
    }

    if (added === 0) {
      return res.json({ success: true, added: 0, total: current.products.length })
    }

    current.version = Date.now()
    current.updatedAt = new Date().toISOString()

    const newContent = Buffer.from(JSON.stringify(current, null, 2)).toString('base64')

    {
      const ac = new AbortController()
      const t = setTimeout(() => ac.abort(), 8000)
      const putRes = await fetch(apiBase, {
        method: 'PUT',
        headers,
        signal: ac.signal,
        body: JSON.stringify({
          message: `feat: merge ${added} new products from CSV upload`,
          content: newContent,
          sha
        })
      })
      clearTimeout(t)
      if (!putRes.ok) throw new Error(`GitHub PUT failed: ${putRes.status}`)
    }

    return res.json({ success: true, added, total: current.products.length })
  } catch (err) {
    if (err.name === 'AbortError') {
      return res.status(502).json({ error: 'GitHub API timeout — попробуйте загрузить меньшую порцию товаров' })
    }
    return res.status(502).json({ error: err.message })
  }
}
