// Text-to-speech. Amazon Polly (neural) when AWS credentials are available;
// otherwise the browser falls back to the Web Speech API (speechSynthesis).
import { PollyClient, SynthesizeSpeechCommand } from '@aws-sdk/client-polly';
import type { Engine, VoiceId } from '@aws-sdk/client-polly';

export interface SpeechClient {
  readonly kind: 'polly' | 'browser';
  readonly voice: string;
  /** MP3 bytes, or null when the browser should speak the text itself. */
  synthesize(text: string): Promise<Uint8Array | null>;
}

export class PollySpeech implements SpeechClient {
  readonly kind = 'polly' as const;
  private readonly client: PollyClient;

  constructor(readonly voice: string, region: string, private readonly engine: string = 'neural') {
    this.client = new PollyClient({ region });
  }

  async synthesize(text: string): Promise<Uint8Array | null> {
    const out = await this.client.send(new SynthesizeSpeechCommand({
      Text: text.slice(0, 1500),
      OutputFormat: 'mp3',
      VoiceId: this.voice as VoiceId,
      Engine: this.engine as Engine
    }));
    if (!out.AudioStream) return null;
    return out.AudioStream.transformToByteArray();
  }
}

export class BrowserSpeech implements SpeechClient {
  readonly kind = 'browser' as const;
  readonly voice = 'browser-default';

  async synthesize(): Promise<Uint8Array | null> {
    return null;
  }
}
