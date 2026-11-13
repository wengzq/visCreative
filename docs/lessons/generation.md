# Generation lessons

## Encoder pipe failure does not prove process closure

- **Symptom:** cancelling a render stuck in `seek` fails with EBUSY on its partial MP4, leaves a locked temporary directory, and rejects the serial render queue on Windows.
- **Cause:** killing ffmpeg can reject the encoding promise through stdin's error event before the child closes. Awaiting that rejected promise therefore does not wait for the output handle to be released; Chrome's abort close was also started without awaiting it before cleanup.
- **Instead:** track encoder `close` independently of encoding errors and share an awaited Chrome close promise. Remove partial output only after both close, with bounded Windows EBUSY/EPERM retries; catch a permanent cleanup failure so the cancelled job cannot strand subsequent jobs. Regress stdin error and process exit before close, delayed Chrome closure, and a cleanup failure, while retaining the real stuck-seek queue test.
- **Found in:** [render cancellation regression](../../packages/generation/src/providers/render/render-cancellation.test.ts), [RFC 0022 render teardown](../rfc/0022-windows.md#7-render-provider), 2026-11-13.
