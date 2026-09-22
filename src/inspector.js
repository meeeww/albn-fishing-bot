const http = require('http')

const PORT = Number(process.env.PACKET_PORT) || 4789
const MAX_ROWS = 400

const EVENT_NAMES = {
    10: 'ActiveSpellEffectsUpdate',
    87: 'CharacterEquipmentChanged',
    355: 'Fishing state',
    360: 'Float',
    361: 'Minigame',
    362: 'Minigame sync',
    363: 'Fishing fame',
    377: 'Catch reward',
}

const REQUEST_NAMES = {
    21: 'Move (disables the bot)',
    22: 'Throw line',
    316: 'Bait hit the water (enables the bot)',
    318: 'Line confirmed',
    319: 'Start reel',
    320: 'Pull',
    321: 'Rest',
    322: 'Finish reel',
    323: 'Collect',
}

const STATE_NAMES = {
    3: 'THROW',
    4: 'TOUCH_WATER',
    5: 'HOOKED',
    7: 'PULL',
    8: 'REST',
    9: 'WIN',
    10: 'LOST',
    14: 'GET_AWAY',
    15: 'CANCEL',
}

const FISHING_CODES = new Set([
    10, 87, 21, 22, 316, 318, 319, 320, 321, 322, 323,
    355, 360, 361, 362, 363, 377,
])

const rows = []
const clients = new Set()
let nextId = 1
let showAll = false
const markers = []
let nextMarkerId = 1
let lastMarker = null

const BITE_RESULTS = {
    5: 'bite',
    9: 'caught',
    10: 'lost',
    14: 'got away',
    15: 'cancelled',
}

function plain(value, depth = 0) {
    if (typeof value === 'bigint') return value.toString()
    if (Buffer.isBuffer(value)) return value.toString('hex')
    if (Array.isArray(value)) {
        if (depth > 2) return `[${value.length} items]`
        const slice = value.slice(0, 16).map((item) => plain(item, depth + 1))
        if (value.length > 16) slice.push(`… ${value.length - 16} more`)
        return slice
    }
    if (value && typeof value === 'object') {
        if (depth > 3) return '{…}'
        const out = {}
        for (const [key, item] of Object.entries(value)) {
            if (key === 'raw') continue
            out[key] = plain(item, depth + 1)
        }
        return out
    }
    return value
}

function codeOf(kind, message) {
    const parameters = message?.parameters || {}
    if (kind === 'event') return parameters[252]
    if (kind === 'request') return parameters[253]
    return undefined
}

function shouldKeep(kind, code) {
    if (kind === 'bot') return true
    if (kind === 'request') return true
    if (FISHING_CODES.has(Number(code))) return true
    if (typeof code === 'number' && code >= 340 && code <= 380) return true
    return showAll
}

function pushRow(row) {
    rows.push(row)
    if (rows.length > MAX_ROWS) rows.shift()
    const payload = `data: ${JSON.stringify(row)}\n\n`
    for (const client of clients) client.write(payload)
}

function coordinatePair(value) {
    if (!Array.isArray(value) || value.length < 2) return null
    const x = Number(value[0])
    const y = Number(value[1])
    if (!Number.isFinite(x) || !Number.isFinite(y)) return null
    return [x, y]
}

function pushRadar(marker) {
    const payload = `event: radar\ndata: ${JSON.stringify(marker)}\n\n`
    for (const client of clients) client.write(payload)
}

function trackRadar(kind, message) {
    const parameters = message?.parameters || {}
    const code = Number(codeOf(kind, message))

    if (kind === 'request' && code === 22) {
        const spot = coordinatePair(parameters[3]) || coordinatePair(parameters[1])
        if (!spot) return
        const marker = {
            id: nextMarkerId++,
            t: Date.now(),
            x: spot[0],
            y: spot[1],
            result: 'cast',
        }
        markers.push(marker)
        if (markers.length > 200) markers.shift()
        lastMarker = marker
        pushRadar(marker)
        return
    }

    if (kind !== 'event' || code !== 355 || !lastMarker) return
    const result = BITE_RESULTS[Number(parameters[3])]
    if (!result || lastMarker.result === 'caught' || lastMarker.result === result) return
    lastMarker.result = result
    pushRadar(lastMarker)
}

function recordMessage(kind, message) {
    trackRadar(kind, message)
    const parameters = message?.parameters || {}
    const code = codeOf(kind, message)
    if (!shouldKeep(kind, code)) return

    const names = kind === 'request' ? REQUEST_NAMES : EVENT_NAMES
    const state = parameters[3]
    pushRow({
        id: nextId++,
        t: Date.now(),
        kind,
        code: code ?? null,
        name: names[code] || '',
        photonCode: kind === 'event' ? message.code : message.operationCode,
        player: plain(parameters[0]),
        p1: plain(parameters[1]),
        p2: plain(parameters[2]),
        p3: plain(state),
        state: STATE_NAMES[state] || '',
        parameters: plain(parameters),
        raw: Buffer.isBuffer(message.raw) ? message.raw.toString('hex') : '',
    })
}

function recordBot(text) {
    pushRow({
        id: nextId++,
        t: Date.now(),
        kind: 'bot',
        code: null,
        name: text,
        photonCode: null,
        player: '',
        p1: '',
        p2: '',
        p3: '',
        state: '',
        parameters: {},
        raw: '',
    })
}

function startInspector() {
    const server = http.createServer((req, res) => {
        const url = new URL(req.url, `http://127.0.0.1:${PORT}`)

        if (req.method === 'GET' && url.pathname === '/') {
            res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' })
            res.end(PAGE)
            return
        }

        if (req.method === 'GET' && url.pathname === '/radar') {
            res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' })
            res.end(RADAR_PAGE)
            return
        }

        if (req.method === 'GET' && url.pathname === '/api/radar') {
            res.writeHead(200, { 'Content-Type': 'application/json' })
            res.end(JSON.stringify({ markers }))
            return
        }

        if (req.method === 'GET' && url.pathname === '/api/recent') {
            res.writeHead(200, { 'Content-Type': 'application/json' })
            res.end(JSON.stringify({ showAll, rows }))
            return
        }

        if (req.method === 'GET' && url.pathname === '/stream') {
            res.writeHead(200, {
                'Content-Type': 'text/event-stream',
                'Cache-Control': 'no-cache',
                Connection: 'keep-alive',
            })
            res.write('\n')
            clients.add(res)
            req.on('close', () => clients.delete(res))
            return
        }

        if (req.method === 'POST' && url.pathname === '/api/mode') {
            showAll = url.searchParams.get('all') === '1'
            res.writeHead(204)
            res.end()
            return
        }

        if (req.method === 'POST' && url.pathname === '/api/clear') {
            rows.length = 0
            res.writeHead(204)
            res.end()
            return
        }

        if (req.method === 'POST' && url.pathname === '/api/radar/clear') {
            markers.length = 0
            lastMarker = null
            res.writeHead(204)
            res.end()
            return
        }

        res.writeHead(404)
        res.end()
    })

    server.listen(PORT, '127.0.0.1', () => {
        console.log(`Packet map: http://127.0.0.1:${PORT}`)
        console.log(`Bite radar: http://127.0.0.1:${PORT}/radar`)
    })
}

const PAGE = `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<title>Fishing packet map</title>
<style>
  :root { color-scheme: dark; }
  body { margin: 0; font: 14px/1.4 ui-sans-serif, sans-serif; background: #12140f; color: #e7e1d1; }
  header { padding: 16px 20px 8px; display: flex; gap: 16px; align-items: end; justify-content: space-between; }
  h1 { font-size: 18px; margin: 0 0 4px; font-weight: 600; }
  p { margin: 0; color: #b7b09d; }
  .controls { display: flex; gap: 8px; align-items: center; }
  button, input { background: #1d2118; color: inherit; border: 1px solid #3a4030; border-radius: 6px; padding: 6px 10px; }
  main { display: grid; grid-template-columns: 280px 1fr; gap: 16px; padding: 8px 20px 24px; }
  aside, section { background: #1a1e16; border: 1px solid #2e3426; border-radius: 10px; }
  aside { padding: 12px 14px; }
  aside h2 { font-size: 13px; margin: 12px 0 6px; }
  aside ul { margin: 0; padding-left: 18px; }
  aside li { margin: 2px 0; }
  code { font-family: ui-monospace, monospace; }
  table { width: 100%; border-collapse: collapse; }
  th, td { text-align: left; padding: 6px 8px; border-bottom: 1px solid #2a3024; vertical-align: top; font-variant-numeric: tabular-nums; }
  th { position: sticky; top: 0; background: #22281c; font-size: 12px; }
  tr { cursor: pointer; }
  tr.selected { background: #2a3320; }
  tr.bot td { color: #e2c56a; }
  .scroll { max-height: calc(100vh - 120px); overflow: auto; }
  #detail { padding: 12px 14px 20px; border-top: 1px solid #2e3426; }
  .bytes { display: flex; flex-wrap: wrap; gap: 4px; margin-top: 8px; }
  .byte { font: 12px/1.2 ui-monospace, monospace; background: #12140f; border-radius: 4px; padding: 4px 5px; min-width: 52px; }
  .byte b { display: block; color: #8f8874; font-weight: 500; }
  pre { white-space: pre-wrap; font: 12px/1.45 ui-monospace, monospace; }
</style>
</head>
<body>
<header>
  <div>
    <h1>Fishing packet map</h1>
    <p>Each row is one decoded game message. Select it to see every byte with its index and decimal value. <a href="/radar">Bite radar</a></p>
  </div>
  <div class="controls">
    <label><input id="all" type="checkbox"> Every event</label>
    <input id="filter" placeholder="Filter by code or name" />
    <button id="clear" type="button">Clear</button>
  </div>
</header>
<main>
  <aside>
    <h2>Event codes</h2>
    <ul>
      <li><code>355</code> fishing state — parameters[3] is throw, bite, pull, rest, or win</li>
      <li><code>361</code> minigame starts</li>
      <li><code>10</code> buffs, <code>87</code> equipment</li>
    </ul>
    <h2>Your actions (requests)</h2>
    <ul>
      <li><code>22</code> throw the line</li>
      <li><code>316</code> bait hit the water</li>
      <li><code>320</code> pull, <code>321</code> rest</li>
      <li><code>322</code> finish, <code>323</code> collect</li>
      <li><code>21</code> you moved</li>
    </ul>
    <h2>parameters[3] states</h2>
    <ul>
      <li><code>3</code> throw, <code>4</code> touch water</li>
      <li><code>5</code> hooked, <code>7</code> pull, <code>8</code> rest</li>
      <li><code>9</code> win, <code>10</code> lost</li>
      <li><code>14</code> got away, <code>15</code> cancel</li>
    </ul>
    <p>Byte 0 of the raw message is the signal. Byte 1 is the message type: 2 is a request, 4 is an event.</p>
  </aside>
  <section>
    <div class="scroll">
      <table>
        <thead>
          <tr>
            <th>Time</th><th>Kind</th><th>Code</th><th>Name</th><th>State</th><th>Player</th><th>p2</th><th>p3</th>
          </tr>
        </thead>
        <tbody id="rows"></tbody>
      </table>
    </div>
    <div id="detail"><p>Select a row.</p></div>
  </section>
</main>
<script>
const rows = []
const body = document.getElementById('rows')
const detail = document.getElementById('detail')
const filter = document.getElementById('filter')
let selected = null

function time(t) {
  const d = new Date(t)
  return d.toLocaleTimeString(undefined, { hour12: false }) + '.' + String(d.getMilliseconds()).padStart(3, '0')
}

function show(value) {
  if (value === undefined || value === null || value === '') return ''
  const text = typeof value === 'object' ? JSON.stringify(value) : String(value)
  return text.replace(/[&<>]/g, (ch) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;' }[ch]))
}

function matches(row) {
  const q = filter.value.trim().toLowerCase()
  if (!q) return true
  return [row.kind, row.code, row.name, row.state, row.player].join(' ').toLowerCase().includes(q)
}

function draw() {
  body.innerHTML = ''
  for (const row of rows) {
    if (!matches(row)) continue
    const tr = document.createElement('tr')
    if (row.kind === 'bot') tr.className = 'bot'
    if (selected && selected.id === row.id) tr.className += ' selected'
    tr.innerHTML = '<td>' + time(row.t) + '</td><td>' + row.kind + '</td><td>' + (row.code ?? '') + '</td><td>' + (row.name || '') + '</td><td>' + (row.state || '') + '</td><td>' + show(row.player) + '</td><td>' + show(row.p2) + '</td><td>' + show(row.p3) + '</td>'
    tr.onclick = () => { selected = row; draw(); renderDetail(row) }
    body.appendChild(tr)
  }
}

function renderDetail(row) {
  const bytes = (row.raw || '').match(/.{1,2}/g) || []
  const chips = bytes.map((hex, index) => {
    return '<span class="byte"><b>' + index + '</b>' + hex.toUpperCase() + ' ' + parseInt(hex, 16) + '</span>'
  }).join('')
  detail.innerHTML = '<p><b>' + row.kind + ' ' + (row.code ?? '') + ' ' + (row.name || '') + '</b> photon code ' + (row.photonCode ?? '') + '</p>'
    + '<pre>' + JSON.stringify(row.parameters, null, 2) + '</pre>'
    + (chips ? '<div class="bytes">' + chips + '</div>' : '<p>No raw bytes on this row.</p>')
}

function add(row) {
  rows.push(row)
  if (rows.length > 400) rows.shift()
  draw()
}

filter.oninput = draw
document.getElementById('clear').onclick = async () => {
  await fetch('/api/clear', { method: 'POST' })
  rows.length = 0
  selected = null
  detail.innerHTML = '<p>Select a row.</p>'
  draw()
}
document.getElementById('all').onchange = (event) => {
  fetch('/api/mode?all=' + (event.target.checked ? '1' : '0'), { method: 'POST' })
}

fetch('/api/recent').then((res) => res.json()).then((data) => {
  document.getElementById('all').checked = data.showAll
  for (const row of data.rows) add(row)
})

const source = new EventSource('/stream')
source.onmessage = (event) => add(JSON.parse(event.data))
</script>
</body>
</html>`

const RADAR_PAGE = `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<title>Bite radar</title>
<style>
  :root { color-scheme: dark; }
  body { margin: 0; font: 14px/1.4 ui-sans-serif, sans-serif; background: #12140f; color: #e7e1d1; }
  header { padding: 16px 20px; display: flex; justify-content: space-between; align-items: end; gap: 16px; }
  h1 { font-size: 18px; margin: 0 0 4px; font-weight: 600; }
  p, a { color: #b7b09d; }
  a { color: #e2c56a; }
  button { background: #1d2118; color: inherit; border: 1px solid #3a4030; border-radius: 6px; padding: 6px 10px; }
  main { display: grid; grid-template-columns: 640px 1fr; gap: 16px; padding: 0 20px 24px; }
  canvas { background: #1a1e16; border: 1px solid #2e3426; border-radius: 10px; width: 640px; height: 640px; }
  aside { background: #1a1e16; border: 1px solid #2e3426; border-radius: 10px; padding: 12px 14px; max-height: 640px; overflow: auto; }
  li { margin: 6px 0; font-variant-numeric: tabular-nums; }
  .cast { color: #8f8874; } .bite { color: #e2c56a; } .caught { color: #7dcea0; } .lost, .away, .cancelled { color: #d36b6b; }
</style>
</head>
<body>
<header>
  <div>
    <h1>Bite radar</h1>
    <p>Each dot is a cast. It turns gold on a bite and green when the fish is caught. <a href="/">Packet map</a></p>
  </div>
  <button id="clear" type="button">Clear</button>
</header>
<main>
  <canvas id="map" width="640" height="640"></canvas>
  <aside>
    <ul id="list"></ul>
  </aside>
</main>
<script>
const markers = []
const canvas = document.getElementById('map')
const ctx = canvas.getContext('2d')
const list = document.getElementById('list')
const colors = { cast: '#8f8874', bite: '#e2c56a', caught: '#7dcea0', lost: '#d36b6b', 'got away': '#d36b6b', cancelled: '#d36b6b' }

function upsert(marker) {
  const index = markers.findIndex((item) => item.id === marker.id)
  if (index === -1) markers.push(marker)
  else markers[index] = marker
  draw()
}

function draw() {
  ctx.clearRect(0, 0, 640, 640)
  ctx.strokeStyle = '#2e3426'
  ctx.strokeRect(24, 24, 592, 592)
  ctx.beginPath()
  ctx.arc(320, 320, 220, 0, Math.PI * 2)
  ctx.stroke()

  if (!markers.length) {
    ctx.fillStyle = '#b7b09d'
    ctx.font = '14px sans-serif'
    ctx.fillText('No casts yet. Throw the line.', 32, 48)
    list.innerHTML = ''
    return
  }

  let minX = Infinity, maxX = -Infinity, minY = Infinity, maxY = -Infinity
  for (const marker of markers) {
    minX = Math.min(minX, marker.x)
    maxX = Math.max(maxX, marker.x)
    minY = Math.min(minY, marker.y)
    maxY = Math.max(maxY, marker.y)
  }
  const span = Math.max(maxX - minX, maxY - minY, 20)
  const scale = 520 / span
  const midX = (minX + maxX) / 2
  const midY = (minY + maxY) / 2

  list.innerHTML = ''
  markers.forEach((marker, index) => {
    const px = 320 + (marker.x - midX) * scale
    const py = 320 - (marker.y - midY) * scale
    ctx.beginPath()
    ctx.fillStyle = colors[marker.result] || '#e7e1d1'
    ctx.arc(px, py, marker.result === 'cast' ? 5 : 8, 0, Math.PI * 2)
    ctx.fill()
    if (index === markers.length - 1) {
      ctx.strokeStyle = '#e7e1d1'
      ctx.stroke()
    }
    const item = document.createElement('li')
    item.className = marker.result === 'got away' ? 'away' : marker.result
    const time = new Date(marker.t).toLocaleTimeString(undefined, { hour12: false })
    item.textContent = time + '  ' + marker.result + '  ' + marker.x.toFixed(1) + ', ' + marker.y.toFixed(1)
    list.appendChild(item)
  })
}

document.getElementById('clear').onclick = async () => {
  await fetch('/api/radar/clear', { method: 'POST' })
  markers.length = 0
  draw()
}

fetch('/api/radar').then((res) => res.json()).then((data) => {
  for (const marker of data.markers) upsert(marker)
  if (!data.markers.length) draw()
})

const source = new EventSource('/stream')
source.addEventListener('radar', (event) => upsert(JSON.parse(event.data)))
</script>
</body>
</html>`

module.exports = {
    startInspector,
    recordMessage,
    recordBot,
}
