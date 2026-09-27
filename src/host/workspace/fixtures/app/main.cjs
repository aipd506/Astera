// The agent workspace e2e fixture (src/host/workspace/desktop.e2e.test.ts): one window whose page
// records what reaches it in window.events, which the test reads over its own CDP connection.
const { app, BrowserWindow } = require('electron')

const HTML = `<!doctype html><html><head><meta charset="utf-8"><title>Astera workspace fixture</title></head><body>
<textarea id="t"></textarea>
<button id="b" onclick="document.getElementById('out').textContent = 'clicked'">Click</button>
<div id="out"></div>
<div id="src" draggable="true" style="width:80px;height:40px;background:#88f">drag me</div>
<div id="dst" style="width:200px;height:80px;background:#8f8">drop here</div>
<div id="drop" style="width:200px;height:80px;background:#f88">files here</div>
<script>
window.events = []
const note = (e) => window.events.push(e)
const t = document.getElementById('t')
t.addEventListener('paste', (e) => note({ kind: 'paste', trusted: e.isTrusted, text: e.clipboardData.getData('text/plain') }))
document.getElementById('src').addEventListener('dragstart', (e) => e.dataTransfer.setData('text/plain', 'card-1'))
const dst = document.getElementById('dst')
dst.addEventListener('dragover', (e) => e.preventDefault())
dst.addEventListener('drop', (e) => { e.preventDefault(); note({ kind: 'drop', text: e.dataTransfer.getData('text/plain') }) })
const drop = document.getElementById('drop')
drop.addEventListener('dragover', (e) => e.preventDefault())
drop.addEventListener('drop', (e) => { e.preventDefault(); note({ kind: 'files', names: Array.from(e.dataTransfer.files).map((f) => f.name) }) })
</script></body></html>`

app.whenReady().then(() => {
  const w = new BrowserWindow({ width: 900, height: 700, title: 'Astera workspace fixture' })
  w.loadURL('data:text/html;charset=utf-8,' + encodeURIComponent(HTML))
})
app.on('window-all-closed', () => app.quit())
