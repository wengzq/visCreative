import { createHash } from 'node:crypto'

export function createWav(prompt: string, duration: number, sfx: boolean): Buffer {
  const sampleRate = 22050
  const samples = Math.round(duration * sampleRate)
  const wav = Buffer.alloc(44 + samples * 2)
  wav.write('RIFF', 0)
  wav.writeUInt32LE(wav.length - 8, 4)
  wav.write('WAVEfmt ', 8)
  wav.writeUInt32LE(16, 16)
  wav.writeUInt16LE(1, 20)
  wav.writeUInt16LE(1, 22)
  wav.writeUInt32LE(sampleRate, 24)
  wav.writeUInt32LE(sampleRate * 2, 28)
  wav.writeUInt16LE(2, 32)
  wav.writeUInt16LE(16, 34)
  wav.write('data', 36)
  wav.writeUInt32LE(samples * 2, 40)
  const hash = createHash('sha256').update(prompt).digest()
  const beatSeconds = 60 / (80 + hash[0]! % 61)
  const notes = [0, 2, 4, 7, 9]
  let phase = 0
  for (let i = 0; i < samples; i++) {
    const time = i / sampleRate
    const beat = Math.floor(time / beatSeconds)
    const frequency = sfx
      ? (200 + hash[1]! * 4) * (1 + time / duration)
      : 220 * 2 ** ((notes[hash[1 + beat % 31]! % notes.length]! + hash[2]! % 12) / 12)
    phase += 2 * Math.PI * frequency / sampleRate
    const envelope = Math.min(1, time * 40, (duration - time) * 40) * Math.exp(-(time % beatSeconds) * (sfx ? 12 : 4))
    wav.writeInt16LE(Math.round(Math.sin(phase) * envelope * 12000), 44 + i * 2)
  }
  return wav
}
