export const codeRender = `
# Code-rendered video

For charts, typography and motion graphics where exact numbers and text matter, use code rendering rather than a generative model. Render through the built-in render provider: the HTML stays on the canvas, so the user and other agents can edit and rerender it, and the video records its source.

three.js is available as an ES module at /lib/three.module.js, including its relative imports.

Read the previz guide before using storyboard panels or deciding how their pictures link to shots.

1. Write a complete HTML document to a canvas text node with format: 'code'. Coordinates can be omitted for server placement.
2. Submit with gen_submit, kind: 'video', provider: 'render', and a nonempty prompt describing the intended result. prompt is required even though the HTML supplies the frames; do not omit it. Put the HTML text slot first in inputs, followed by optional image asset slots. params can specify width, height (default 1920×1080), fps (default 30) durationMs and transparent (default false). For transparent WebM, pass transparent: true and leave the page background transparent. Do not launch Chrome yourself: the Agent sandbox blocks its files; a blocked local attempt is a reason to use this provider, not to report rendering as impossible.
3. Define window.vis = { duration: seconds, seek(t) }. seek sets the complete image at time t in seconds, regardless of previous seeks. Plain JavaScript that computes styles, canvas drawings or scene transforms directly from t is an equal option to a library. Do not use timers, requestAnimationFrame, wall-clock time or unseeded randomness to advance the page.
4. Pages have no network access. Load anime.js with <script src="/lib/anime.js"></script>, hand-drawn lines with /lib/rough.js, or three.js as described above. Anime.js uses milliseconds: disable its main loop, create a paused timeline with explicit starting values, and convert seconds in seek. For example:

<div id="box" style="width:40px;height:40px;background:red"></div>
<script src="/lib/anime.js"></script>
<script>
  anime.engine.useDefaultMainLoop = false
  anime.engine.pause()
  anime.engine.timeUnit = 'ms'
  const timeline = anime.createTimeline({ autoplay: false })
    .add('#box', { x: [0, 260], duration: 1000, ease: 'linear' }, 0)
  window.vis = { duration: 1, seek(t) { timeline.seek(t * 1000, true) } }
</script>

The second seek argument mutes callbacks, so onUpdate, onBegin and timeline.call do not run during this seek. If drawing depends on them, pass false instead of true.

Asset input number n is /input/<n>, counted from zero using only asset inputs. Use system fonts. An author-installed library at /lib/<name>.js may be used only when the author explicitly says it is available. Never fetch, install or copy a library for the author, and never write into render-libs. A missing library fails with render.lib_missing; explain that the author must provide it or offer plain JavaScript or a built-in library.
5. A page error produces a failed job with details in error.message. Fix the HTML before submitting again. After success, extract frames with asset_frames and inspect them to verify the result.
`.trim()
