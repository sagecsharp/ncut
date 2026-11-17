/** the words of picture and sound. pure: reasons.ts spreads it first, so a text lives once */
export const SOUND_TEXT = {
  soundVideoFirst: 'select a video clip with sound first',
  noSoundInVideo: 'the selected video has no sound',
  alreadyApart: 'the sound of this video is already a clip of its own',
  soundPairFirst: 'select a picture or a sound that was separated first',
  soundOutOfSync: 'picture and sound are out of sync: move them into sync first',
  soundOtherSpeed: 'picture and sound play at different speeds',
  soundOtherLength: 'picture and sound have different lengths (a j or l cut): trim them to the same length first',
  soundOtherFades: 'picture and sound fade differently',
  soundMany: 'the picture has more than one sound clip',
  soundShared: 'the sound clip plays under more than one picture',
  soundTrackDiffers: 'the sound track and the picture track differ in mute, volume or pan',
  soundBeatLocked: 'an effect on a locked track pulses on the beat of the sound clip',
  inSync: 'picture and sound are already in sync',
  syncNoRoom: 'no room to move it into sync',
  slipTooShort: 'the media is too short to slip it into sync',
  trackLocked: 'the track is locked',
} as const;
