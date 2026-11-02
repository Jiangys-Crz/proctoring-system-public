export const ROOM_VIDEO_MIN_SECONDS = 3;
export const ROOM_VIDEO_MAX_SECONDS = 15;

export function isValidRoomVideoDuration(duration: number | null | undefined): duration is number {
  return typeof duration === 'number' && Number.isFinite(duration)
    && duration >= ROOM_VIDEO_MIN_SECONDS && duration <= ROOM_VIDEO_MAX_SECONDS;
}
