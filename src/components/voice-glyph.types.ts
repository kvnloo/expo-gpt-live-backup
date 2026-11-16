export type VoiceGlyphName =
  'settings' | 'captions' | 'mic' | 'mic-off' | 'close' | 'waveform' | 'phone';

export type VoiceGlyphProps = {
  name: VoiceGlyphName;
  color: string;
  size?: number;
};
