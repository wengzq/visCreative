const { app, BrowserWindow } = require('electron')
const { mkdir, readFile, writeFile } = require('node:fs/promises')
const { join } = require('node:path')

app.setPath('userData', process.env.VIS_ICON_PROFILE)
app.commandLine.appendSwitch('force-device-scale-factor', '1')
app.disableHardwareAcceleration()

app.whenReady().then(async () => {
  app.dock?.hide()
  const source = await readFile(process.env.VIS_ICON_SOURCE)
  const output = process.env.VIS_ICON_OUTPUT
  const iconset = join(output, 'app.iconset')
  await mkdir(iconset, { recursive: true })
  const win = new BrowserWindow({ width: 1024, height: 1024, useContentSize: true, show: false, transparent: true, frame: false, webPreferences: { offscreen: true, sandbox: true, contextIsolation: true, nodeIntegration: false } })
  async function rasterize(canvas, body) {
    win.setContentSize(canvas, canvas)
    const inset = (canvas - body) / 2
    // Embed the original SVG unchanged: platform sizing must not fork the artwork.
    const html = `<html style="background:transparent"><body style="margin:0;background:transparent"><img style="position:absolute;left:${inset}px;top:${inset}px;width:${body}px;height:${body}px" src="data:image/svg+xml;base64,${source.toString('base64')}"></body></html>`
    await win.loadURL(`data:text/html;charset=utf-8,${encodeURIComponent(html)}`)
    await win.webContents.executeJavaScript('Promise.all([...document.images].map(image => image.decode()))')
    const image = await win.webContents.capturePage()
    if (image.getSize().width !== canvas || image.getSize().height !== canvas) throw new Error('Icon capture has the wrong pixel size')
    return image
  }
  const mac = await rasterize(1024, 824)
  await writeFile(join(output, 'app.png'), mac.toPNG())
  for (const size of [16, 32, 128, 256, 512]) {
    await writeFile(join(iconset, `icon_${size}x${size}.png`), mac.resize({ width: size, height: size, quality: 'best' }).toPNG())
    await writeFile(join(iconset, `icon_${size}x${size}@2x.png`), mac.resize({ width: size * 2, height: size * 2, quality: 'best' }).toPNG())
  }
  const windows = await rasterize(256, 256)
  await writeFile(join(output, 'app-win.png'), windows.toPNG())
  win.destroy()
  app.quit()
}).catch(error => {
  console.error(error)
  app.exit(1)
})
