import { renderSound, SOUND_NAMES } from './synth';

interface WorkerScope {
  postMessage(message: unknown, transfer: Transferable[]): void;
}

const scope = self as unknown as WorkerScope;

for (const name of SOUND_NAMES) {
  const sound = renderSound(name);
  scope.postMessage(
    { name, sampleRate: sound.sampleRate, channels: sound.channels },
    sound.channels.map((channel) => channel.buffer as ArrayBuffer),
  );
}
