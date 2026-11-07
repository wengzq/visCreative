export type Scene = 'dawn' | 'lantern' | 'village' | 'sea' | 'friend' | 'title' | 'style' | 'sticker' | 'blockout'

const tree = (x: number, y: number, s = 1) => `<g transform="translate(${x} ${y}) scale(${s})"><path d="M0 10 3-93 11-98 7 12" fill="#172f36"/><path d="m6-110-49 49h30L-59-30h47L-66 4H70L26-30h40L28-61h26Z" fill="#204c50"/><path d="m6-110 1 107H70L26-30h40L28-61h26Z" fill="#193e45"/></g>`
const bird = (x: number, y: number, s = 1) => `<path d="M${x - s * 12} ${y}q${s * 7} ${-s * 8} ${s * 12} 0q${s * 6} ${-s * 8} ${s * 12} 0" fill="none" stroke="#36565b" stroke-width="2" stroke-linecap="round"/>`
const person = (x: number, y: number, s = 1, friend = false, lit = false) => `<g transform="translate(${x} ${y}) scale(${s})">
  <ellipse cx="0" cy="4" rx="28" ry="7" fill="#142f38" opacity=".2"/>
  <path d="m-12-44-3 41h10l6-32 7 32h10L13-44" fill="#233c46"/>
  <path d="m-16-96-16 51 15 5 4-29-1 38 32-1-4-40 12 22 11-7-22-41Z" fill="${friend ? '#d48f65' : lit ? '#4b9190' : '#307c83'}"/>
  <path d="m-14-97 14 9 16-9-4 22L-1-80Z" fill="#efc681"/>
  <path d="M-12-113q-8-27 11-30 24-3 22 22l-4 18-13 8-16-9Z" fill="#e7b58a"/>
  <path d="M-15-119q-8-27 15-29 24-2 24 23l-12-7-8 8-10-4-2 15Z" fill="#20353e"/>
  <path d="M-13-129q-3-17 13-20 13 1 17 10" fill="#20353e"/>
  <circle cx="10" cy="-115" r="1.8" fill="#22363e"/><path d="m10-106 6-1" stroke="#ac755c" stroke-width="1.6"/>
  <path d="m-21-82-11 32 8 2 9-27" fill="#e7b58a"/>
  ${lit ? '<ellipse cx="49" cy="-31" rx="110" ry="100" fill="url(#lantern-glow)"/><path d="m8-86 9 7 12 31-11 7-4-27 2 37H5Z" fill="#f4cf7f" opacity=".35"/>' : ''}
  ${friend ? '<path d="m22-70 8 12 7-4-10-15" fill="#e7b58a"/>' : '<path d="m24-66 21-9 3 7-23 14" fill="#e7b58a"/><path d="m49-70 0 20" stroke="#e2b877" stroke-width="2"/><ellipse cx="49" cy="-31" rx="19" ry="23" fill="#efba66" opacity=".14"/><path d="m39-49 20 0 4 30-29 0Z" fill="#f4cb7d" stroke="#bd814b" stroke-width="2"/><path d="m41-45 15 0 3 22-21 0Z" fill="#fff3bb"/><path d="m37-19 25 0m-22-30 19 0" stroke="#6e5743" stroke-width="4"/>'}
</g>`

function mountainScene(scene: Scene, variant: number) {
  if (scene === 'sea') return seaScene(variant)
  if (scene === 'village') return villageScene(variant)
  const warm = variant === 1
  return `<rect width="960" height="540" fill="url(#sky)"/>
  <circle cx="653" cy="170" r="57" fill="#f6ce89"/>
  <circle cx="653" cy="170" r="87" fill="#f6ce89" opacity=".1"/>
  <g fill="#f8e7bd" opacity=".5"><path d="M50 123q90-28 175-8t210-1q-123 24-236 20T50 123"/><path d="M544 78q81-19 159-4t179-6q-64 28-166 19T544 78"/></g>
  <path d="M0 303 103 205 166 243 290 101 412 252 488 187 580 276 699 143 834 278 960 189V540H0Z" fill="#759b9b"/>
  <path d="m227 173 63-72 71 87-57-28-22 15-20-18Z" fill="#d4d1af" opacity=".75"/>
  <path d="M0 367 125 274 222 333 386 201 512 350 642 249 756 342 905 239 960 304V540H0Z" fill="#416e76"/>
  <path d="M0 407q135-61 265-32t214-11 238 15 243-21v182H0Z" fill="#8fae9e"/>
  <path d="M400 361q140 13 98 50t-38 129H293q10-84 136-119t-29-60" fill="#dbd8b3"/>
  <path d="M0 464q120-51 281-20t264 96H0Z" fill="#345c5b"/>
  <g opacity=".3" fill="#e1dfbf"><path d="M0 337q220-17 461 12t499-8v14q-254 18-500-7T0 354Z"/><path d="M40 312q169-12 302 5t317-1l-4 10q-152 9-320-3T40 321Z"/></g>
  ${['lantern', 'friend'].includes(scene) ? `<path d="M329 540 362 457 472 416 573 441 668 466 657 504 758 540Z" fill="#254d50"/><path d="m362 457 110-41 101 25-82 8-67 33Z" fill="#5a7770"/>${variant === 2 ? '<ellipse cx="554" cy="443" rx="124" ry="24" fill="#edba6a" opacity=".35"/>' : ''}${person(488, 449, 1.35, false, variant === 2)}${scene === 'friend' ? person(405, 465, 1.05, true) : ''}` : ''}
  ${scene === 'dawn' || scene === 'style' ? person(346, 468, .56) : ''}
  ${tree(57, 540, 2.4)}${tree(154, 540, 1.35)}${tree(914, 548, 2.9)}${tree(812, 548, 1.4)}
  <path d="M0 523q129-32 246 17H0m960-30q-108-5-202 30h202" fill="#183b43"/>
  ${bird(477, 137, .8)}${bird(509, 149, .55)}${bird(441, 152, .5)}
  ${scene === 'title' ? `<rect width="960" height="540" fill="#14343e" opacity=".34"/><text x="480" y="243" fill="#f6dfac" text-anchor="middle" font-family="Georgia, 'Microsoft YaHei', serif" font-size="${warm ? 72 : 68}" letter-spacing="8">${warm ? '山海少年' : 'MOUNTAIN &amp; SEA'}</text><path d="M352 278h256" stroke="#c7ac75"/><text x="480" y="319" fill="#eedcb8" text-anchor="middle" font-family="Arial,'Microsoft YaHei',sans-serif" font-size="19" letter-spacing="5">${warm ? '第一集 · 晨光' : 'EPISODE 1 · FIRST LIGHT'}</text>` : ''}
  <rect width="960" height="540" filter="url(#grain)" opacity=".07"/>`
}

function seaScene(variant: number) {
  return `<rect width="960" height="540" fill="${variant ? '#827b8f' : '#738999'}"/>
  <path d="M0 190q210-20 390 18t570-9v341H0Z" fill="#285b6d"/>
  <circle cx="674" cy="169" r="49" fill="#edc887"/>
  <path d="M0 203 63 181 103 195 146 162 207 201 274 188 327 213H0Z" fill="#4e717c"/>
  <path d="M0 224q190-17 380 0t580-3" stroke="#c6b99a" stroke-width="3" fill="none" opacity=".5"/>
  ${Array.from({ length: 19 }, (_, i) => `<path d="M${(i * 97) % 250 - 130} ${245 + i * 16}q130-11 245 0t245-2 255 3 270-5" stroke="${i % 3 ? '#79a4a4' : '#d8bb8b'}" stroke-width="${i % 3 ? 2 : 3}" fill="none" opacity="${i % 3 ? .3 : .45}"/>`).join('')}
  <path d="m674 226-43 234h106l-43-234" fill="#eed3a0" opacity=".1"/>
  <g transform="translate(681 321)"><path d="M0-103V42" stroke="#d3bb8a" stroke-width="4"/><path d="M-5-100-71 26H-5Z" fill="#f0d3a0"/><path d="m6-80 51 104H6Z" fill="#c2b893"/><path d="m-88 35 157 0-26 25H-52Z" fill="#173b49"/><path d="m-79 36 139 0" stroke="#bdab81" stroke-width="3"/></g>
  <path d="M0 362 109 331 162 375 189 421 276 452 221 540H0Z" fill="#23464c"/>
  <path d="m0 362 109-31 53 44-78-10-84 38Z" fill="#4c6d63"/>
  ${tree(31, 361, 1.6)}${tree(107, 382, .7)}
  <path d="M820 514q74-39 140-19v45H770Z" fill="#1b414b"/>
  ${bird(389, 116, .9)}${bird(425, 128, .6)}${bird(461, 118, .5)}
  <rect width="960" height="540" filter="url(#grain)" opacity=".07"/>`
}

function villageScene(variant: number) {
  return `<rect width="960" height="540" fill="${variant ? '#c8bc9f' : '#b4bda4'}"/>
  <path d="M0 186 111 88 219 194 330 126 446 231 577 136 718 204 855 97 960 185v355H0" fill="#799792"/>
  <path d="M0 261q240-38 491 10t469-21v290H0Z" fill="#486f70"/>
  <path d="m436 284 74 0 231 256H181Z" fill="#c7b58e"/>
  <path d="m464 300-65 240m85-240 83 240m-193-95 240-1m-278 48 329-2m-266-78 187-2m-162-27 127-1" stroke="#a99f7d" stroke-width="3" fill="none"/>
  <g><path d="M0 126h262v414H0Z" fill="#ccbc91"/><path d="M262 126 350 208v332h-88Z" fill="#a89e78"/>
  <path d="M-34 133 111 39 284 121l79 92-105-63-264 4Z" fill="#254f56"/><path d="m-8 125 118-73 146 72" stroke="#7c998b" stroke-width="5" fill="none"/>
  <path d="M23 158v382m216-382v382M0 354h262" stroke="#a28d67" stroke-width="8"/>
  <path d="M58 207h60v83H58Zm93 0h60v83h-60Z" fill="#e6c887" stroke="#64776a" stroke-width="7"/>
  <path d="M72 377h126v163H72Z" fill="#536d62"/><path d="M129 379v161" stroke="#c0a97e" stroke-width="4"/>
  <path d="m7 330 238 0 52 25H-10Z" fill="#315a59"/>
  <path d="m274 232 46 28" stroke="#475b4e" stroke-width="5"/><path d="m310 254 0 22" stroke="#526254" stroke-width="3"/><ellipse cx="310" cy="295" rx="19" ry="27" fill="#cf8e5a"/><path d="m295 278 30 0m-30 33 30 0" stroke="#aa734d" stroke-width="4"/></g>
  <g><path d="M960 133H738v407h222Z" fill="#c5b38b"/><path d="M738 133 622 240v300h116Z" fill="#a59674"/>
  <path d="m985 139-143-93-127 89-110 112 133-78 238-10Z" fill="#234b53"/><path d="m966 127-123-68-110 76" stroke="#779487" stroke-width="5" fill="none"/>
  <path d="M759 172v368m176-368v368m-196-178h221" stroke="#9c8867" stroke-width="7"/>
  <path d="M786 215h47v82h-47Zm75 0h47v82h-47Z" fill="#edce8c" stroke="#667667" stroke-width="7"/>
  <path d="M791 395h101v145H791Z" fill="#47665d"/><path d="M681 287v253m-42-244 90-77" stroke="#5f6f5d" stroke-width="5"/>
  <path d="m641 283-43 21m10-13v26" stroke="#42584e" stroke-width="5"/><ellipse cx="607" cy="334" rx="16" ry="24" fill="#d69a61"/></g>
  <g transform="translate(358 252) scale(.55)"><path d="M0 0h156v240H0Z" fill="#d7c79f"/><path d="m-20 4 95-67L178 7Z" fill="#315a5d"/><path d="M53 104h48v136H53Z" fill="#667b6b"/><path d="M21 51h28v40H21Zm88 0h28v40h-28Z" fill="#edce87"/></g>
  ${person(460, 488, 1.1)}${person(558, 449, .82, true)}
  <path d="M0 530q40-22 82 10H0m878 0q42-30 82-9v9" fill="#526a58"/>
  <rect width="960" height="540" filter="url(#grain)" opacity=".07"/>`
}

export function sceneHtml(scene: Scene, variant = 0): string {
  const content = scene === 'blockout'
    ? `<rect width="960" height="540" fill="#c5cbd0"/><path d="M0 310 130 150 245 310 390 110 580 310 750 180 960 320V540H0Z" fill="#979fa6"/><path d="M0 375 140 270 280 365 420 250 610 365 790 265 960 375V540H0Z" fill="#78838c"/><path d="M0 400H960V540H0Z" fill="#b8bec2"/><g stroke="#919ba3" fill="none">${Array.from({ length: 9 }, (_, i) => `<path d="M480 330 ${i * 160 - 160} 540"/>`).join('')}<path d="M0 423H960M0 457H960M0 500H960"/></g><path d="m320 540 60-100 140-24 160 30 70 94Z" fill="#6a747d" stroke="#56616b" stroke-width="3"/><g fill="#d9dcdf" stroke="#707b85" stroke-width="3"><ellipse cx="492" cy="290" rx="22" ry="26"/><path d="m476 317-10 82 55 0-12-82Z"/><path d="m474 336-24 50 12 7 23-41m22-12 39 15-5 12-34-10M478 399l-12 53h17l13-42 9 42h18l-11-53"/><path d="M546 367v20m-10 0h24v32h-24Z"/></g>`
    : scene === 'sticker'
    ? `<rect width="960" height="540" fill="#e6d6ad"/><circle cx="480" cy="270" r="200" fill="#204b52"/><circle cx="480" cy="270" r="180" fill="none" stroke="#e6c88a" stroke-width="3"/><path d="m340 294 78-104 66 73 44-55 103 125H326" fill="#82a5a0"/><circle cx="565" cy="176" r="29" fill="#e6c88a"/><path d="M340 355q140-33 280 0m-260 23q120-24 240 0" stroke="#e6c88a" stroke-width="5" fill="none"/>`
    : mountainScene(scene, variant)
  return `<!doctype html><html><meta charset="utf-8"><style>html,body{margin:0;width:100%;height:100%;overflow:hidden;background:#204b52}svg{width:100%;height:100%;display:block}</style><svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 960 540">
  <defs><linearGradient id="sky" x2="0" y2="1"><stop stop-color="${scene === 'sea' ? '#577e91' : variant === 2 ? '#d3ba91' : variant === 1 ? '#b4b79b' : '#93b5b0'}"/><stop offset="1" stop-color="#f3d9a0"/></linearGradient>
  <radialGradient id="lantern-glow"><stop stop-color="#ffe4a2" stop-opacity=".85"/><stop offset=".35" stop-color="#ffcf70" stop-opacity=".4"/><stop offset="1" stop-color="#eaaa53" stop-opacity="0"/></radialGradient>
  <filter id="grain"><feTurbulence baseFrequency=".75" numOctaves="3" seed="12" stitchTiles="stitch"/><feColorMatrix type="saturate" values="0"/></filter></defs>
  <g id="scene">${content}</g></svg><script>window.vis={duration:4,seek:t=>{document.getElementById('scene').setAttribute('transform','translate('+(-t*1.4)+' 0) scale('+(1+t*.003)+')')}}</script></html>`
}
