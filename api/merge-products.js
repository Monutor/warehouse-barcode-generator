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
  const api = `https://api.github.com/repos/${owner}/${repo}/contents/${path}`
  const headers = { Authorization: `Bearer ${token}`, Accept: 'application/vnd.github.v3+json' }

  try {
    const getRes = await fetch(`${api}?ref=main`, { headers })
    if (!getRes.ok) throw new Error(`GitHub GET failed: ${getRes.status}`)
    const file = await getRes.json()
    const current = JSON.parse(Buffer.from(file.content, 'base64').toString())

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

    const putRes = await fetch(api, {
      method: 'PUT',
      headers,
      body: JSON.stringify({
        message: `feat: merge ${added} new products from CSV upload`,
        content: newContent,
        sha: file.sha
      })
    })
    if (!putRes.ok) throw new Error(`GitHub PUT failed: ${putRes.status}`)

    return res.json({ success: true, added, total: current.products.length })
  } catch (err) {
    return res.status(502).json({ error: err.message })
  }
}
